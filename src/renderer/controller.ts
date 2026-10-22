import { effectiveProps } from "../shared/chrome";
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg, type UiCommand } from "../shared/protocol";
import { CanvasFrameHost } from "./canvasFrame";
import { noSession, reduce, useUi } from "./store";
import { saveHub, savedHub, transport, type HubLogin } from "./transport";

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
const projectFromUrl = () => new URLSearchParams(location.search).get("p") ?? undefined;

function setUrl(params: { p?: string; s?: string }) {
  const url = new URL(location.href);
  for (const k of ["p", "s"] as const) {
    const v = params[k];
    if (v) url.searchParams.set(k, v);
    else url.searchParams.delete(k);
  }
  if (url.href !== location.href) history.replaceState(null, "", url);
}

// ---------------------------------------------------------------- hub: join, projects, artifacts

/** Join with a saved or newly entered login. */
export function hubJoin(login: HubLogin) {
  saveHub(login);
  useUi.setState({ hubError: undefined });
  send({ t: "hub.join", name: login.name, token: login.token });
}

/** Desktop app: connect this window to a hub (or, with no login, back to this machine). */
export function connectHub(login: HubLogin | undefined) {
  saveHub(login);
  useUi.setState({ ...noSession, phase: "connecting", hubError: undefined, project: undefined, me: undefined });
  setUrl({});
  transport.setHub?.(login?.url);
}

/** Leave the open artifact, if any, without a round trip. */
function leaveArtifact() {
  if (useUi.getState().phase === "session") send({ t: "artifact.leave" });
  useUi.setState(noSession);
}

export function openProjects() {
  leaveArtifact();
  useUi.setState({ phase: "projects", project: undefined, artifacts: [] });
  setUrl({});
  send({ t: "project.list" });
}

export function openProject(projectId: string) {
  leaveArtifact();
  const same = useUi.getState().project?.id === projectId;
  useUi.setState({ phase: "project", ...(!same && { project: undefined, artifacts: [] }) });
  setUrl({ p: projectId });
  send({ t: "project.open", projectId });
}

export function createProject(name: string) {
  leaveArtifact();
  useUi.setState({ phase: "project", project: undefined, artifacts: [] });
  send({ t: "project.create", name });
}

export function createArtifact() {
  const p = useUi.getState().project;
  if (p) send({ t: "artifact.create", projectId: p.id });
}

/** Open (or switch to) an artifact in this window. */
export const openArtifact = (artifactId: string) => send({ t: "hello", v: PROTOCOL_VERSION, sessionId: artifactId });

export const listRevisions = () => send({ t: "revisions.list" });
export const restoreRevision = (commit: string) => send({ t: "revisions.restore", commit });

/** After joining: the artifact or project in the URL, else the project list. */
function afterJoin() {
  const s = sessionFromUrl() ?? useUi.getState().sessionId;
  const p = projectFromUrl();
  if (s) return openArtifact(s);
  if (p) return openProject(p);
  openProjects();
}

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
  // On a hub the window switches to it (a new window would be a local one).
  if (useUi.getState().phase !== "session" || useUi.getState().hub)
    return send({ t: "hello", v: PROTOCOL_VERSION, sessionId });
  const url = new URL(location.href);
  url.searchParams.set("s", sessionId);
  if (!window.open(url, "_blank")) location.assign(url);
  useUi.setState({ toast: undefined });
}

function onMessage(msg: ServerMsg) {
  reduce(msg);
  if (msg.t === "welcome") {
    if (!msg.hub)
      return send({ t: "hello", v: PROTOCOL_VERSION, sessionId: useUi.getState().sessionId ?? sessionFromUrl() });
    const login = savedHub();
    if (login) send({ t: "hub.join", name: login.name, token: login.token });
    else useUi.setState({ phase: "join" });
    return;
  }
  if (msg.t === "hub.joined") return afterJoin();
  if (msg.t === "artifact.file") return download(msg.name, msg.data);
  if (msg.t === "artifact.opened") return openSession(msg.sessionId);
  if (msg.t === "artifact.created") return openArtifact(msg.artifactId);
  if (msg.t === "session.snapshot") {
    const st = useUi.getState();
    setUrl({ p: st.hub ? st.project?.id : undefined, s: msg.session.id });
    reportViewport();
  } else if (msg.t === "session.none" && sessionFromUrl()) {
    const st = useUi.getState();
    setUrl({ p: st.hub ? (st.project?.id ?? projectFromUrl()) : undefined });
    if (st.hub) {
      if (st.project) openProject(st.project.id);
      else if (projectFromUrl()) openProject(projectFromUrl()!);
      else openProjects();
    }
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
    // The core's `welcome` says whether it is this machine or a hub; `hello` (or joining) follows it.
    () => useUi.setState({ connected: true }),
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
