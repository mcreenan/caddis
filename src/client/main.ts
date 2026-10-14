import { CHROME_LIMITS, CHROME_Z, SAFE_Z, clampRect, isSafeColour, type Rect } from "../shared/chrome";
import {
  PROTOCOL_VERSION,
  type AgentStatus,
  type ChromeComponent,
  type ChromeProps,
  type ChromeState,
  type ClientMsg,
  type HistoryItem,
  type ProviderInfo,
  type ServerMsg,
  type SessionSnapshot,
  type UndoInfo,
} from "../shared/protocol";
import { CanvasHost } from "./canvasHost";
import { HistoryView } from "./historyView";

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

// ------------------------------------------------------------------ state

let providers: ProviderInfo[] = [];
let session: SessionSnapshot | undefined;
let chrome: ChromeState = { prompt: {}, history: {} };
let undo: UndoInfo = { canvasUndo: 0, canvasRedo: 0, chromeUndo: 0 };
let status: AgentStatus = "idle";
let statusDetail = "";
let ws: WebSocket | undefined;
let pendingStart: ClientMsg | undefined;

const els = {
  chrome: $("#chrome"),
  start: $<HTMLFormElement>("#start"),
  startInput: $<HTMLTextAreaElement>("#start-input"),
  startErr: $("#start-err"),
  optProvider: $<HTMLSelectElement>("#opt-provider"),
  optModel: $<HTMLInputElement>("#opt-model"),
  modelList: $("#model-list"),
  optEffort: $<HTMLSelectElement>("#opt-effort"),
  optCwd: $<HTMLInputElement>("#opt-cwd"),
  history: $("#history"),
  historyItems: $("#history .h-items"),
  historyStatus: $("#history .h-status"),
  mini: $<HTMLButtonElement>("#mini"),
  prompt: $<HTMLFormElement>("#prompt"),
  promptInput: $<HTMLTextAreaElement>("#prompt textarea"),
  stop: $<HTMLButtonElement>("#prompt .stop"),
  safe: $("#safe"),
  safeToggle: $<HTMLButtonElement>("#safe-toggle"),
  safeHistory: $("#safe .safe-history"),
  safePrompt: $<HTMLFormElement>("#safe .safe-prompt"),
};
els.chrome.style.zIndex = String(CHROME_Z);
els.safe.style.zIndex = String(SAFE_Z);
els.safeToggle.style.zIndex = String(SAFE_Z + 1);

const historyView = new HistoryView(els.historyItems);
const safeHistoryView = new HistoryView(els.safeHistory);

const canvas = new CanvasHost($("#stage"), {
  // Frame reports only matter once a session exists (the start screen renders a blank canvas).
  rendered: (version) => session && send({ t: "canvas.rendered", version }),
  console: (entries) => session && send({ t: "canvas.console", entries }),
  result: (requestId, r) => session && send({ t: "canvas.result", requestId, ...r }),
  escape: () => toggleSafe(),
});

// ------------------------------------------------------------------ websocket

function send(msg: ClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

let retry = 0;
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => (retry = 0);
  ws.onmessage = (e) => onServer(JSON.parse(e.data));
  ws.onclose = () => {
    setStatus("error", "disconnected — reconnecting");
    setTimeout(connect, Math.min(5000, 300 * 2 ** retry++));
  };
}

const sessionIdFromUrl = () => new URLSearchParams(location.search).get("s") ?? undefined;

function onServer(m: ServerMsg) {
  switch (m.t) {
    case "welcome":
      providers = m.providers;
      fillStartOptions(m.defaultCwd);
      if (pendingStart) {
        send(pendingStart);
        pendingStart = undefined;
      } else send({ t: "hello", v: PROTOCOL_VERSION, sessionId: session?.id ?? sessionIdFromUrl() });
      return;
    case "session.none":
      if (m.sessionId) history.replaceState(null, "", "/");
      showStart();
      return;
    case "session.snapshot":
      loadSession(m.session);
      return;
    case "history.append":
      session?.history.push(m.item);
      historyView.append(m.item);
      safeHistoryView.append(m.item);
      if (session?.history.length === 1) layout();
      return;
    case "history.update": {
      const item = session?.history.find((x) => x.id === m.id);
      if (!item) return;
      Object.assign(item, m.patch);
      if (m.appendText && (item.kind === "assistant" || item.kind === "thinking")) item.text += m.appendText;
      historyView.update(m.id, item);
      safeHistoryView.update(m.id, item);
      return;
    }
    case "status":
      setStatus(m.status, m.detail);
      return;
    case "canvas.state":
      if (session) session.canvas = m.canvas;
      setUndo(m.undo);
      canvas.render(m.canvas);
      return;
    case "canvas.patch":
      if (session) session.canvas = m.canvas;
      setUndo(m.undo);
      canvas.patch(m.patch, m.canvas);
      return;
    case "canvas.request":
      if (m.kind === "eval") canvas.request({ type: "eval", id: m.requestId, js: m.js });
      else canvas.request({ type: "snapshot", id: m.requestId, maxWidth: m.maxWidth });
      return;
    case "chrome.state":
      chrome = m.chrome;
      setUndo(m.undo);
      layout();
      return;
    case "error":
      if (!session) {
        els.startErr.textContent = m.message;
        els.start.classList.remove("busy");
      } else addLocalNotice(m.message);
      return;
  }
}

function addLocalNotice(text: string) {
  const item: HistoryItem = { id: `local-${Date.now()}`, ts: Date.now(), kind: "notice", level: "error", text };
  historyView.append(item);
  safeHistoryView.append(item);
}

// ------------------------------------------------------------------ start screen

function fillStartOptions(defaultCwd: string) {
  if (els.optProvider.options.length) return;
  for (const p of providers) {
    const o = new Option(p.label + (p.note ? ` (${p.note})` : ""), p.id);
    o.disabled = !p.enabled;
    els.optProvider.add(o);
  }
  els.optProvider.value = providers.find((p) => p.enabled)?.id ?? "claude";
  els.optCwd.value = localStorage.getItem("ac.cwd") ?? defaultCwd;
  els.optModel.value = localStorage.getItem("ac.model") ?? "";
  onProviderChange();
  els.optEffort.value = localStorage.getItem("ac.effort") ?? "";
}

function onProviderChange() {
  const p = providers.find((x) => x.id === els.optProvider.value);
  if (!p) return;
  els.modelList.replaceChildren(...p.models.filter((m) => m.id).map((m) => new Option(m.label, m.id)));
  els.optEffort.replaceChildren(new Option("default", ""), ...p.efforts.map((e) => new Option(e, e)));
}
els.optProvider.addEventListener("change", onProviderChange);

function showStart() {
  session = undefined;
  els.start.hidden = false;
  els.prompt.hidden = els.history.hidden = els.mini.hidden = true;
  canvas.render({ version: 0, mode: "html", html: "", css: "", script: "", context: "2d", updatedAt: 0 });
  els.startInput.focus();
}

els.start.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.startInput.value.trim();
  if (!text) return els.startInput.focus();
  const config = {
    provider: els.optProvider.value as "claude",
    model: els.optModel.value.trim(),
    effort: els.optEffort.value as "",
    cwd: els.optCwd.value.trim(),
  };
  localStorage.setItem("ac.cwd", config.cwd);
  localStorage.setItem("ac.model", config.model);
  localStorage.setItem("ac.effort", config.effort);
  els.startErr.textContent = "";
  els.start.classList.add("busy");
  const msg: ClientMsg = { t: "session.start", config, prompt: text };
  if (ws?.readyState === WebSocket.OPEN) send(msg);
  else pendingStart = msg;
});
els.startInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    els.start.requestSubmit();
  }
});

// ------------------------------------------------------------------ session

function loadSession(s: SessionSnapshot) {
  session = s;
  chrome = s.chrome;
  setUndo(s.undo);
  if (sessionIdFromUrl() !== s.id) history.replaceState(null, "", `/?s=${s.id}`);
  document.title = `Agent Canvas · ${s.history.find((h) => h.kind === "user")?.text.slice(0, 40) ?? s.id.slice(0, 8)}`;
  els.start.hidden = true;
  els.start.classList.remove("busy");
  els.prompt.hidden = false;
  historyView.reset(s.history);
  safeHistoryView.reset(s.history);
  if (canvas.version !== s.canvas.version || s.canvas.version === 0) canvas.render(s.canvas);
  setStatus(s.status, s.statusDetail);
  layout();
  els.promptInput.focus();
}

function setUndo(u: UndoInfo) {
  undo = u;
  for (const el of document.querySelectorAll<HTMLElement>("[data-count]")) {
    const n = undo[el.dataset.count as keyof UndoInfo];
    el.textContent = n ? `(${n})` : "";
    (el.parentElement as HTMLButtonElement).disabled = !n;
  }
}

function setStatus(s: AgentStatus, detail?: string) {
  status = s;
  statusDetail = detail ?? "";
  for (const el of [els.history, els.mini, els.safeToggle]) {
    el.classList.remove("st-idle", "st-thinking", "st-tool", "st-error");
    el.classList.add(`st-${s}`);
  }
  const label = { idle: "idle", thinking: "thinking…", tool: `running ${statusDetail}`, error: `error${statusDetail ? `: ${statusDetail}` : ""}` }[s];
  els.historyStatus.textContent = label;
  els.mini.title = `Session — ${label}`;
  els.stop.hidden = !(s === "thinking" || s === "tool");
}

// ------------------------------------------------------------------ prompt

const LINE = 22;
const MAX_LINES = 8;
function autogrow(ta: HTMLTextAreaElement) {
  ta.style.height = "auto";
  const max = LINE * MAX_LINES + 12;
  ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
  ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  layout();
}

function submitPrompt(ta: HTMLTextAreaElement) {
  const text = ta.value.trim();
  if (!text || !session) return;
  send({ t: "prompt", text });
  ta.value = "";
  autogrow(ta);
}

els.promptInput.addEventListener("input", () => autogrow(els.promptInput));
els.promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitPrompt(els.promptInput);
  }
});
els.prompt.addEventListener("submit", (e) => {
  e.preventDefault();
  submitPrompt(els.promptInput);
});
els.stop.addEventListener("click", () => send({ t: "interrupt" }));

// ------------------------------------------------------------------ chrome layout (clamped)

const DEFAULTS = {
  accent: "#7c9cff",
  background: "rgba(18, 19, 24, 0.82)",
  foreground: "#e8e8ec",
  blur: 16,
  radius: 14,
  opacity: 1,
};

function applyStyle(el: HTMLElement, p: ChromeProps) {
  const colour = (v: string | undefined, d: string) => (v && isSafeColour(v) ? v : d);
  const n = (v: number | undefined, d: number, lo: number, hi: number) => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  el.style.setProperty("--accent", colour(p.accent, DEFAULTS.accent));
  el.style.setProperty("--bg", colour(p.background, DEFAULTS.background));
  el.style.setProperty("--fg", colour(p.foreground, DEFAULTS.foreground));
  el.style.setProperty("--blur", `${n(p.blur, DEFAULTS.blur, ...CHROME_LIMITS.blur)}px`);
  el.style.setProperty("--radius", `${n(p.radius, DEFAULTS.radius, ...CHROME_LIMITS.radius)}px`);
  el.style.opacity = String(n(p.opacity, DEFAULTS.opacity, ...CHROME_LIMITS.opacity));
}

function place(el: HTMLElement, component: ChromeComponent, want: Rect, setHeight: boolean) {
  const r = clampRect(component, want, innerWidth, innerHeight);
  el.style.left = `${r.x}px`;
  el.style.top = `${r.y}px`;
  el.style.width = `${r.width}px`;
  if (setHeight) el.style.height = `${r.height}px`;
  return r;
}

function layout() {
  if (!session) return;
  const vw = innerWidth;
  const vh = innerHeight;
  const P = chrome.prompt;
  const H = chrome.history;

  // Prompt: bottom-centre by default; height follows content.
  applyStyle(els.prompt, P);
  const pw = P.width ?? Math.min(720, vw - 32);
  els.prompt.style.width = `${Math.min(pw, vw)}px`;
  const ph = els.prompt.offsetHeight || 52;
  place(els.prompt, "prompt", { x: P.x ?? (vw - pw) / 2, y: P.y ?? vh - ph - 20, width: pw, height: ph }, false);

  // History: hidden until there is something in it.
  const hasHistory = session.history.length > 0;
  applyStyle(els.history, H);
  applyStyle(els.mini, H);
  const hw = H.width ?? Math.min(400, Math.max(CHROME_LIMITS.minWidth.history, vw * 0.32));
  const hh = H.height ?? Math.max(CHROME_LIMITS.minHeight.history, vh - 32 - (ph + 40));
  const rect = place(els.history, "history", { x: H.x ?? vw - hw - 16, y: H.y ?? 16, width: hw, height: hh }, true);
  const mini = Boolean(H.mini);
  els.history.hidden = !hasHistory || mini;
  els.mini.hidden = !hasHistory || !mini;
  if (mini) {
    const size = 40;
    els.mini.style.left = `${Math.min(vw - size - 4, Math.max(4, rect.x + rect.width - size))}px`;
    els.mini.style.top = `${Math.min(vh - size - 4, Math.max(4, rect.y))}px`;
  }
}
addEventListener("resize", layout);

$("#history-mini").addEventListener("click", () => send({ t: "chrome.set", component: "history", props: { mini: true } }));
els.mini.addEventListener("click", () => send({ t: "chrome.set", component: "history", props: { mini: false } }));

// ------------------------------------------------------------------ safe mode (immutable base chrome)

let canvasHidden = false;
function toggleSafe(force?: boolean) {
  const open = force ?? els.safe.hidden;
  els.safe.hidden = !open;
  if (open) {
    els.safeHistory.scrollTop = els.safeHistory.scrollHeight;
    $<HTMLTextAreaElement>("textarea", els.safePrompt).focus();
  }
}

els.safeToggle.addEventListener("click", () => toggleSafe());
addEventListener(
  "keydown",
  (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "Escape" || e.code === "Escape")) {
      e.preventDefault();
      toggleSafe();
    } else if (e.key === "Escape" && !els.safe.hidden) {
      toggleSafe(false);
    }
  },
  true,
);

els.safe.addEventListener("click", (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
  switch (act) {
    case "close":
      return toggleSafe(false);
    case "hide-canvas":
      canvasHidden = !canvasHidden;
      canvas.setHidden(canvasHidden);
      (e.target as HTMLElement).closest("button")!.textContent = canvasHidden ? "Show canvas" : "Hide canvas";
      return;
    case "interrupt":
      return send({ t: "interrupt" });
    case "chrome.reset":
    case "chrome.undo":
    case "canvas.undo":
    case "canvas.redo":
    case "canvas.clear":
      return send({ t: act });
  }
});

const safeTa = $<HTMLTextAreaElement>("textarea", els.safePrompt);
els.safePrompt.addEventListener("submit", (e) => {
  e.preventDefault();
  submitPrompt(safeTa);
});
safeTa.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitPrompt(safeTa);
  }
});

connect();
