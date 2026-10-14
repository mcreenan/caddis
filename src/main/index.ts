import { BrowserWindow, Menu, app, dialog, ipcMain, protocol, session as electronSession, type WebContents } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../core/manager";
import type { Client } from "../core/session";
import { FRAME_HEADERS, createFrameFiles } from "../core/static";
import type { CanvasStats, ClientMsg, ServerMsg } from "../shared/protocol";

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
  { scheme: "canvas", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true } },
]);

const manager = new SessionManager(DATA, undefined, "electron");
const serveFrame = createFrameFiles(ROOT);
const conns = new Map<number, ReturnType<SessionManager["connect"]>>();

function rendererUrl(sessionId?: string) {
  const q = sessionId ? `?s=${encodeURIComponent(sessionId)}` : "";
  if (process.env.ELECTRON_RENDERER_URL) return `${process.env.ELECTRON_RENDERER_URL}${q}`;
  return `file://${path.join(HERE, "../renderer/index.html")}${q}`;
}

function createWindow(sessionId?: string) {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#0e0f13",
    title: "Caddis",
    autoHideMenuBar: true,
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
    if (mod && input.shift && input.key === "Escape") {
      e.preventDefault();
      wc.send("ac:ui", "escape");
    } else if (mod && !input.shift && input.key.toLowerCase() === "n") {
      e.preventDefault();
      createWindow();
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
    async processStats(): Promise<CanvasStats["process"]> {
      const frame = canvasFrame(wc);
      if (!frame) return undefined;
      const pid = frame.osProcessId;
      const m = app.getAppMetrics().find((x) => x.pid === pid);
      return {
        pid,
        memoryMB: m ? Math.round(m.memory.workingSetSize / 1024) : undefined,
        cpu: m ? Math.round(m.cpu.percentCPUUsage * 10) / 10 : undefined,
        separateFromHost: pid !== wc.mainFrame.osProcessId,
      };
    },
  };
}

ipcMain.handle("ac:connect", (e) => {
  dropConn(e.sender);
  conns.set(e.sender.id, manager.connect(clientFor(e.sender)));
});
ipcMain.on("ac:msg", (e, msg: ClientMsg) => void conns.get(e.sender.id)?.receive(msg));
ipcMain.on("ac:newWindow", () => createWindow());
ipcMain.handle("ac:pickDir", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await (win ? dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] }) : dialog.showOpenDialog({ properties: ["openDirectory"] }));
  return r.canceled ? undefined : r.filePaths[0];
});

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [{ label: "New Window", accelerator: "CmdOrCtrl+N", click: () => createWindow() }, { role: "close" }, { role: "quit" }],
      },
      { role: "editMenu" },
      { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }] },
    ]),
  );
}

app.whenReady().then(() => {
  protocol.handle("canvas", (req) => {
    const url = new URL(req.url);
    const f = url.host === "app" && url.pathname.startsWith("/frame/") ? serveFrame(url.pathname.slice("/frame/".length)) : undefined;
    if (!f) return new Response("not found", { status: 404, headers: FRAME_HEADERS });
    return new Response(new Uint8Array(typeof f.body === "string" ? Buffer.from(f.body) : f.body), { headers: { ...FRAME_HEADERS, "content-type": f.mime } });
  });
  // Canvases may use the network, but not device permissions.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "clipboard-sanitized-write" || permission === "fullscreen"));
  buildMenu();
  void manager.discover();
  const arg = process.argv.find((a) => a.startsWith("--session="));
  createWindow(arg?.slice("--session=".length) || process.env.CADDIS_SESSION);
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => manager.shutdown());
