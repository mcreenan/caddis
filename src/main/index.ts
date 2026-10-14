import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  protocol,
  session as electronSession,
  type WebContents,
} from "electron";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_EXT } from "../core/artifact";
import { SessionManager } from "../core/manager";
import type { Client } from "../core/session";
import { FRAME_HEADERS, createFrameFiles } from "../core/static";
import type { FileCommand } from "../shared/bridge";
import type { CanvasStats, ClientMsg, ServerMsg, UiCommand } from "../shared/protocol";

/**
 * Electron main: hosts the session core in-process (the same SessionManager the
 * web server uses). Each BrowserWindow is one session. The host renderer draws
 * the chrome; the canvas is an iframe on the privileged `canvas://` scheme,
 * a different site from the host, so Chromium puts it in its own process (OOPIF).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = app.getAppPath();
const DATA = path.resolve(process.env.CADDIS_DATA_DIR ?? path.join(app.getPath("userData"), "data"));

protocol.registerSchemesAsPrivileged([
  {
    scheme: "canvas",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true },
  },
]);

const manager = new SessionManager(DATA, undefined, "electron");
const serveFrame = createFrameFiles(ROOT);
const conns = new Map<number, ReturnType<SessionManager["connect"]>>();

function rendererUrl(sessionId?: string) {
  const q = sessionId ? `?s=${encodeURIComponent(sessionId)}` : "";
  if (process.env.VITE_DEV_SERVER_URL) return `${process.env.VITE_DEV_SERVER_URL}${q}`;
  return `file://${path.join(HERE, "../renderer/index.html")}${q}`;
}

/** Height of the host-drawn titlebar; keep in sync with `--tb` in the renderer's styles.css. */
const TITLEBAR_H = 36;
const MAC = process.platform === "darwin";

function createWindow(sessionId?: string) {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#0e0f13",
    title: "Caddis",
    autoHideMenuBar: true,
    // The renderer draws the titlebar; the OS keeps its window controls (traffic lights / overlay buttons).
    titleBarStyle: "hidden",
    ...(MAC
      ? { trafficLightPosition: { x: 13, y: (TITLEBAR_H - 16) / 2 } }
      : { titleBarOverlay: { color: "#0e0f13", symbolColor: "#c9cad3", height: TITLEBAR_H } }),
    webPreferences: {
      preload: path.join(HERE, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const wc = win.webContents;
  const home = rendererUrl(sessionId);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e, url) => {
    if (url.split("?")[0] !== home.split("?")[0]) e.preventDefault();
  });
  // Shortcuts that must work even while the canvas (another process) has focus.
  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const mod = input.control || input.meta;
    if (mod && !input.alt && !input.shift && input.code === "Backslash") {
      e.preventDefault();
      wc.send("ac:ui", "overlay" satisfies UiCommand);
    } else if (mod && !input.alt) {
      const cmd = SHORTCUTS[`${input.shift ? "shift+" : ""}${input.key.toLowerCase()}`];
      if (cmd) {
        e.preventDefault();
        void fileCommand(cmd, win);
      }
    }
  });
  wc.on("render-process-gone", () => dropConn(wc));
  win.on("closed", () => dropConn(wc));
  void win.loadURL(home);
  return win;
}

function dropConn(wc: WebContents) {
  conns.get(wc.id)?.close();
  conns.delete(wc.id);
}

function canvasFrame(wc: WebContents) {
  return wc.mainFrame.framesInSubtree.find((f) => f.url.startsWith("canvas://"));
}

function clientFor(wc: WebContents): Client {
  return {
    id: `wc-${wc.id}`,
    kind: "electron",
    send: (msg: ServerMsg) => {
      if (!wc.isDestroyed()) wc.send("ac:msg", msg);
    },
    async capture(maxWidth) {
      if (wc.isDestroyed()) return undefined;
      let img = await wc.capturePage();
      const { width } = img.getSize();
      if (width > maxWidth) img = img.resize({ width: maxWidth, quality: "good" });
      return { data: img.toPNG().toString("base64"), mimeType: "image/png" };
    },
    processStats: async () => processStats(wc),
  };
}

function processStats(wc: WebContents): CanvasStats["process"] {
  const frame = wc.isDestroyed() ? undefined : canvasFrame(wc);
  if (!frame) return undefined;
  const pid = frame.osProcessId;
  const m = app.getAppMetrics().find((x) => x.pid === pid);
  return {
    pid,
    memoryMB: m ? Math.round(m.memory.workingSetSize / 1024) : undefined,
    cpu: m ? Math.round(m.cpu.percentCPUUsage * 10) / 10 : undefined,
    separateFromHost: pid !== wc.mainFrame.osProcessId,
  };
}

ipcMain.handle("ac:connect", (e) => {
  dropConn(e.sender);
  conns.set(e.sender.id, manager.connect(clientFor(e.sender)));
});
ipcMain.on("ac:msg", (e, msg: ClientMsg) => void conns.get(e.sender.id)?.receive(msg));
ipcMain.on("ac:newWindow", () => createWindow());
ipcMain.handle("ac:processStats", (e) => processStats(e.sender));
ipcMain.on("ac:file", (e, cmd: FileCommand) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && FILE_COMMANDS.includes(cmd)) void fileCommand(cmd, win);
});
ipcMain.handle("ac:pickDir", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await (win
    ? dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] })
    : dialog.showOpenDialog({ properties: ["openDirectory"] }));
  return r.canceled ? undefined : r.filePaths[0];
});

// ---------------------------------------------------------------- File: new / open / save (.caddis artifacts)

const FILE_COMMANDS: readonly FileCommand[] = ["new", "open", "save", "saveAs"];
/** Handled in before-input-event so they work while the canvas (another process) has focus. */
const SHORTCUTS: Record<string, FileCommand> = { n: "new", o: "open", s: "save", "shift+s": "saveAs" };
const FILTERS = [{ name: "Caddis artifact", extensions: [ARTIFACT_EXT] }];
let lastDir: string | undefined;

function fileCommand(cmd: FileCommand, win?: BrowserWindow | null) {
  win ??= BrowserWindow.getFocusedWindow();
  if (cmd === "new") return void createWindow();
  if (cmd === "open") return openArtifact(win);
  if (win) return saveArtifact(win, cmd === "saveAs");
}

async function saveArtifact(win: BrowserWindow, saveAs: boolean) {
  const s = conns.get(win.webContents.id)?.session;
  if (!s)
    return void dialog.showMessageBox(win, {
      type: "info",
      message: "Nothing to save yet",
      detail: "Start a session in this window first.",
    });
  let file = saveAs ? undefined : s.artifactPath;
  if (!file) {
    const r = await dialog.showSaveDialog(win, {
      title: "Save Caddis artifact",
      defaultPath: path.join(lastDir ?? app.getPath("documents"), s.artifactName),
      filters: FILTERS,
    });
    if (r.canceled || !r.filePath) return;
    file = r.filePath.endsWith(`.${ARTIFACT_EXT}`) ? r.filePath : `${r.filePath}.${ARTIFACT_EXT}`;
  }
  try {
    const { buffer } = await s.exportArtifact();
    await writeFile(`${file}.tmp`, buffer);
    await rename(`${file}.tmp`, file);
    lastDir = path.dirname(file);
    s.setArtifactPath(file);
  } catch (e: any) {
    dialog.showErrorBox(
      "Couldn't save",
      `${file}

${e?.message ?? e}`,
    );
  }
}

async function openArtifact(win?: BrowserWindow | null, file?: string) {
  if (!file) {
    const opts = {
      title: "Open Caddis artifact",
      defaultPath: lastDir,
      filters: FILTERS,
      properties: ["openFile" as const],
    };
    const r = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    if (r.canceled || !r.filePaths[0]) return;
    file = r.filePaths[0];
  }
  try {
    const s = await manager.importArtifact(await readFile(file), { path: file });
    lastDir = path.dirname(file);
    // Reuse a window that is still on the start card; otherwise open a new one.
    if (win && !win.isDestroyed() && conns.has(win.webContents.id) && !conns.get(win.webContents.id)?.session)
      win.webContents.send("ac:msg", { t: "artifact.opened", sessionId: s.id } satisfies ServerMsg);
    else createWindow(s.id);
  } catch (e: any) {
    dialog.showErrorBox(
      "Couldn't open artifact",
      `${file}

${e?.message ?? e}`,
    );
  }
}

/** Commands main forwards to the focused window's renderer (native menu items, shortcuts caught while the canvas has focus). */
const ui = (cmd: UiCommand) => () => BrowserWindow.getFocusedWindow()?.webContents.send("ac:ui", cmd);

/**
 * The native menu. macOS shows it in the system menu bar; on Windows/Linux it stays hidden
 * (the titlebar's menu button mirrors it) but still provides the accelerators.
 */
function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(MAC ? [{ role: "appMenu" as const }] : []),
      {
        label: "File",
        submenu: [
          { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => fileCommand("new") },
          { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => fileCommand("open") },
          { type: "separator" },
          { label: "Save", accelerator: "CmdOrCtrl+S", click: () => fileCommand("save") },
          { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: () => fileCommand("saveAs") },
          { label: "Rename…", click: ui("rename") },
          { type: "separator" },
          { role: "close" },
          ...(MAC ? [] : [{ role: "quit" as const }]),
        ],
      },
      { role: "editMenu" },
      {
        label: "Canvas",
        submenu: [
          // No accelerators: Cmd+Z belongs to text fields (the prompt) and to the canvas page itself.
          { label: "Undo Change", click: ui("undo") },
          { label: "Redo Change", click: ui("redo") },
          { type: "separator" },
          { label: "Reload Canvas", click: ui("reloadCanvas") },
          { label: "Clear Canvas", click: ui("clearCanvas") },
        ],
      },
      {
        label: "View",
        submenu: [
          { label: "Show/Hide Overlay", accelerator: "CmdOrCtrl+\\", click: ui("overlay") },
          { label: "Expand/Minimise History", click: ui("history") },
          { label: "Reset Overlay Style", click: ui("resetOverlay") },
          { type: "separator" },
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
      ...(MAC ? [{ role: "windowMenu" as const }] : []),
    ]),
  );
}

// macOS: double-clicked or dropped `.caddis` files.
let pendingOpen: string | undefined;
app.on("open-file", (e, file) => {
  e.preventDefault();
  if (app.isReady()) void openArtifact(undefined, file);
  else pendingOpen = file;
});

void app.whenReady().then(() => {
  protocol.handle("canvas", (req) => {
    const url = new URL(req.url);
    const f =
      url.host === "app" && url.pathname.startsWith("/frame/")
        ? serveFrame(url.pathname.slice("/frame/".length))
        : undefined;
    if (!f) return new Response("not found", { status: 404, headers: FRAME_HEADERS });
    return new Response(new Uint8Array(typeof f.body === "string" ? Buffer.from(f.body) : f.body), {
      headers: { ...FRAME_HEADERS, "content-type": f.mime },
    });
  });
  // Canvases may use the network, but not device permissions.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === "clipboard-sanitized-write" || permission === "fullscreen"),
  );
  buildMenu();
  void manager.discover();
  const arg = process.argv.find((a) => a.startsWith("--session="));
  const artifact = pendingOpen ?? process.argv.slice(1).find((a) => a.endsWith(`.${ARTIFACT_EXT}`));
  if (artifact) void openArtifact(undefined, path.resolve(artifact));
  else createWindow(arg?.slice("--session=".length) || process.env.CADDIS_SESSION);
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => manager.shutdown());
