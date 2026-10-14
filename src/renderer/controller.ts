import { effectiveProps } from "../shared/chrome";
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg, type UiCommand } from "../shared/protocol";
import { CanvasFrameHost } from "./canvasFrame";
import { reduce, useUi } from "./store";
import { transport } from "./transport";

/** Glue between the transport, the store and the canvas frame. */

let frame: CanvasFrameHost | undefined;

export const send = (msg: ClientMsg) => transport.send(msg);

export const toggleOverlay = () => useUi.setState((s) => ({ overlayHidden: !s.overlayHidden }));

/** Height of the host titlebar; the canvas and the overlay live below it. Matches `--tb` in styles.css. */
export const TITLEBAR_H = 36;

/** The history panel's effective mode: the agent's overrides on top of the base. */
export const historyMini = (s = useUi.getState()) => effectiveProps("history", s.chrome.history).mode === "mini";

/** A user change like any other chrome edit: clamped, persisted and undoable. */
export const setHistoryMode = (mode: "full" | "mini") =>
  send({ t: "chrome.set", component: "history", props: { mode } });

export function uiCommand(cmd: UiCommand) {
  if (cmd === "overlay") return toggleOverlay();
  if (useUi.getState().phase !== "session") return;
  if (cmd === "resetOverlay") {
    useUi.setState({ overlayHidden: false });
    return send({ t: "chrome.reset" });
  }
  if (cmd === "history") {
    useUi.setState({ overlayHidden: false });
    return setHistoryMode(historyMini() ? "full" : "mini");
  }
  if (cmd === "rename") return useUi.setState({ renaming: true });
  if (cmd === "undo" || cmd === "redo") return send({ t: cmd });
  if (cmd === "reloadCanvas") return send({ t: "canvas.reload" });
  if (cmd === "clearCanvas") return send({ t: "canvas.clear" });
}

const sessionFromUrl = () => new URLSearchParams(location.search).get("s") ?? undefined;

// ---------------------------------------------------------------- File: new / open / save

export const fileNew = () => transport.newWindow();

/** Rename the session; an empty title goes back to the automatic one. */
export const renameSession = (title: string) => send({ t: "title.set", title });

export function fileOpen() {
  if (transport.file) return transport.file("open");
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".caddis";
  input.onchange = () => {
    const f = input.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      useUi.setState({ toast: `Opening ${f.name}…` });
      send({ t: "artifact.import", data: (reader.result as string).replace(/^data:[^,]*,/, ""), name: f.name });
    };
    reader.readAsDataURL(f);
  };
  input.click();
}

export function fileSave(saveAs = false) {
  if (transport.file) return transport.file(saveAs ? "saveAs" : "save");
  if (useUi.getState().phase !== "session") return;
  useUi.setState({ toast: "Preparing download…" });
  send({ t: "artifact.export" });
}

function download(name: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  useUi.setState({ toast: `Downloaded ${name}` });
}

function openSession(sessionId: string) {
  // A window still on the start card takes the session; otherwise it gets its own window/tab.
  if (useUi.getState().phase !== "session") return send({ t: "hello", v: PROTOCOL_VERSION, sessionId });
  const url = new URL(location.href);
  url.searchParams.set("s", sessionId);
  if (!window.open(url, "_blank")) location.assign(url);
  useUi.setState({ toast: undefined });
}

function onMessage(msg: ServerMsg) {
  reduce(msg);
  if (msg.t === "artifact.file") return download(msg.name, msg.data);
  if (msg.t === "artifact.opened") return openSession(msg.sessionId);
  if (msg.t === "session.snapshot") {
    const url = new URL(location.href);
    if (url.searchParams.get("s") !== msg.session.id) {
      url.searchParams.set("s", msg.session.id);
      history.replaceState(null, "", url);
    }
    reportViewport();
  } else if (msg.t === "session.none" && sessionFromUrl()) {
    const url = new URL(location.href);
    url.searchParams.delete("s");
    history.replaceState(null, "", url);
  }
  frame?.onServer(msg);
}

let vpTimer: number | undefined;
function reportViewport() {
  clearTimeout(vpTimer);
  vpTimer = window.setTimeout(() => send({ t: "viewport", width: innerWidth, height: innerHeight - TITLEBAR_H }), 100);
}

export function startController() {
  transport.start(
    onMessage,
    () => {
      useUi.setState({ connected: true });
      send({ t: "hello", v: PROTOCOL_VERSION, sessionId: useUi.getState().sessionId ?? sessionFromUrl() });
    },
    () => useUi.setState({ connected: false }),
  );
  window.caddis?.onUi(uiCommand);
  pollProcessStats();
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (!e.shiftKey && !e.altKey && e.code === "Backslash") {
        e.preventDefault();
        toggleOverlay();
      } else if (!e.altKey && (e.key.toLowerCase() === "s" || (e.key.toLowerCase() === "o" && !e.shiftKey))) {
        // In Electron, main usually catches these first (before-input-event), so this only sees synthetic input.
        e.preventDefault();
        if (e.key.toLowerCase() === "o") fileOpen();
        else fileSave(e.shiftKey);
      }
    },
    true,
  );
  window.addEventListener("resize", () => useUi.getState().phase === "session" && reportViewport());
}

/** Electron: memory/CPU of the canvas process for the titlebar status. */
function pollProcessStats() {
  const b = window.caddis;
  if (!b) return;
  setInterval(() => {
    if (useUi.getState().phase !== "session" || document.hidden) return;
    b.processStats()
      .then((proc) => useUi.setState({ proc }))
      .catch(() => {});
  }, 2000);
}

/** Called by the Stage component once its element exists. */
export function attachStage(el: HTMLElement) {
  frame?.dispose();
  frame = new CanvasFrameHost(el, transport.frameUrl, send, (key) => key === "overlay" && toggleOverlay());
  frame.mount();
  return () => {
    frame?.dispose();
    frame = undefined;
  };
}
