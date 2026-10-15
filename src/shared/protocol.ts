/**
 * Caddis protocol, version 2.
 *
 * Three hops:
 *   1. host transport  UI <-> session core  (ClientMsg / ServerMsg)
 *        web: WebSocket `/ws` (JSON)   electron: IPC channel `ac:msg` (structured clone)
 *   2. frame channel   UI <-> canvas iframe (ToFrameMsg / FromFrameMsg), postMessage
 *   3. agent tools     session core -> model, in-process MCP server "canvas" (src/core/tools.ts)
 *
 * The session core is the source of truth for resources, data, chrome and history.
 * See docs/PROTOCOL.md for the prose version.
 */

export const PROTOCOL_VERSION = 2;
export const FRAME_CHANNEL = "caddis";

// ---------------------------------------------------------------------------
// Canvas: a mode plus a set of named resources, all applied live
// ---------------------------------------------------------------------------

export const CANVAS_MODES = ["html", "canvas", "3d"] as const;
export type CanvasMode = (typeof CANVAS_MODES)[number];

/** `index.html` is the body markup; `*.css` stylesheets; `*.js` ES modules; anything else is an asset. */
export type ResourceKind = "html" | "css" | "js" | "asset";

export interface Resource {
  name: string;
  kind: ResourceKind;
  /** Text content (html/css/js and text assets). */
  text?: string;
  /** Binary assets, base64. */
  base64?: string;
  mime: string;
  /** Canvas rev at which this resource last changed. */
  rev: number;
  size: number;
  updatedAt: number;
}

export interface CanvasState {
  mode: CanvasMode;
  /** Monotonic; bumped on every canvas change (resource, mode, dom op, undo). */
  rev: number;
  resources: Record<string, Resource>;
}

export const emptyCanvas = (): CanvasState => ({ mode: "html", rev: 0, resources: {} });

export function resourceKind(name: string): ResourceKind {
  if (name === "index.html") return "html";
  if (name.endsWith(".css")) return "css";
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "js";
  return "asset";
}

export const RESOURCE_NAME_RE = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]{0,99}$/;

export const DOM_OPS = [
  "replace",
  "inner",
  "append",
  "prepend",
  "before",
  "after",
  "remove",
  "attr",
  "style",
  "text",
] as const;
export type DomOp = (typeof DOM_OPS)[number];
export interface DomPatch {
  selector: string;
  op: DomOp;
  content?: string;
  all?: boolean;
}

export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error";
  message: string;
  ts: number;
  rev: number;
}

// ---------------------------------------------------------------------------
// Data store + canvas events
// ---------------------------------------------------------------------------

export type DataSource = "agent" | "canvas" | "user";

/** One entry in the session's activity log (data writes and emitted events). */
export interface CanvasEvent {
  seq: number;
  ts: number;
  source: DataSource;
  type: "emit" | "data.set" | "data.delete";
  /** emit: event name; data.*: key. */
  name: string;
  payload?: unknown;
}

// ---------------------------------------------------------------------------
// Runtime stats + watchdog
// ---------------------------------------------------------------------------

export interface CanvasStats {
  ts: number;
  mode: CanvasMode;
  fps: number;
  frameMs: number;
  frameMsMax: number;
  heapMB?: number;
  dom: number;
  modules: number;
  timers: number;
  rafs: number;
  listeners: number;
  webglContexts: number;
  swaps: number;
  three?: { geometries: number; textures: number; programs: number; calls: number; triangles: number; objects: number };
  /** Electron only: the canvas frame's OS process. */
  process?: { pid: number; memoryMB?: number; cpu?: number; separateFromHost: boolean };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Chrome: the two floating components the agent may restyle but not remove
// ---------------------------------------------------------------------------

export const CHROME_COMPONENTS = ["prompt", "history"] as const;
export type ChromeComponent = (typeof CHROME_COMPONENTS)[number];
export const ANCHORS = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;
export type Anchor = (typeof ANCHORS)[number];
export const FONTS = ["system", "serif", "mono", "rounded"] as const;
export const SHADOWS = ["none", "soft", "strong", "glow"] as const;

/** Props the agent may set. All optional; absent = base value. */
export interface ChromeProps {
  anchor?: Anchor;
  /** Offset in px from the anchored position. */
  x?: number;
  y?: number;
  width?: number;
  /** history only (prompt height follows its content). */
  height?: number;
  opacity?: number;
  accent?: string;
  background?: string;
  foreground?: string;
  blur?: number;
  radius?: number;
  font?: (typeof FONTS)[number];
  fontSize?: number;
  shadow?: (typeof SHADOWS)[number];
  /** history only. */
  mode?: "full" | "mini";
}

export type ChromeState = Record<ChromeComponent, ChromeProps>;
export const emptyChrome = (): ChromeState => ({ prompt: {}, history: {} });

export interface ChromeApplyResult {
  component: ChromeComponent;
  /** Effective props after clamping (base merged with overrides). */
  applied: Required<Omit<ChromeProps, "height" | "mode">> & { height?: number; mode?: "full" | "mini" };
  /** Effective on-screen rect for the current viewport. */
  rect?: { x: number; y: number; width: number; height: number };
  notes: string[];
}

// ---------------------------------------------------------------------------
// Session + history
// ---------------------------------------------------------------------------

/** "claude", "codex", or "acp-<agent>" for Agent Client Protocol agents. */
export type ProviderId = string;
/** Reasoning effort as the provider names it (Claude: low…max; Codex: minimal…ultra; ACP: the agent's own levels). */
export type Effort = string;

export interface ModelInfo {
  id: string;
  label: string;
  efforts: Effort[];
  /** The effort the CLI uses for this model when none is chosen; filled in after discovery. */
  defaultEffort?: Effort;
  description?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  enabled: boolean;
  /** Discovery hasn't finished yet; a `providers` message follows. */
  pending?: boolean;
  /** e.g. "Claude Max subscription (you@example.com)". */
  auth?: string;
  note?: string;
  models: ModelInfo[];
  /** Id of the model the CLI uses when none is chosen. */
  defaultModel?: string;
  /** Labels for effort ids the UI doesn't know. */
  effortLabels?: Record<string, string>;
}

export interface SessionConfig {
  provider: ProviderId;
  /** Empty = provider default. */
  model: string;
  /** Empty = provider default. */
  effort: Effort;
  cwd: string;
}

export type AgentStatus = "idle" | "thinking" | "tool" | "error";

export type HistoryItem =
  | { id: string; ts: number; kind: "user"; text: string; attached?: string }
  | { id: string; ts: number; kind: "assistant"; text: string }
  | { id: string; ts: number; kind: "thinking"; text: string }
  | {
      id: string;
      ts: number;
      kind: "tool";
      name: string;
      input: unknown;
      state: "running" | "done" | "error";
      result?: string;
    }
  | { id: string; ts: number; kind: "turn"; ok: boolean; error?: string; durationMs?: number; costUsd?: number }
  | { id: string; ts: number; kind: "notice"; level: "info" | "error"; text: string };

export interface UndoInfo {
  undo: number;
  redo: number;
  /** Label of the change the next undo reverts. */
  next?: string;
}

/** A name for the session. A user-chosen title is never replaced by the agent. */
export interface SessionTitle {
  text: string;
  by: "agent" | "user";
}

export const TITLE_MAX = 60;

export interface SessionSnapshot {
  id: string;
  config: SessionConfig;
  status: AgentStatus;
  statusDetail?: string;
  history: HistoryItem[];
  canvas: CanvasState;
  data: Record<string, unknown>;
  chrome: ChromeState;
  undo: UndoInfo;
  stats?: CanvasStats;
  /** File name of the `.caddis` artifact this session was last saved to or opened from. */
  file?: string;
  title?: SessionTitle;
}

// ---------------------------------------------------------------------------
// Hop 1: UI <-> session core
// ---------------------------------------------------------------------------

export type FrameRequest =
  | { kind: "eval"; js: string }
  | { kind: "view"; outline: boolean; selector?: string; screenshot: boolean; maxWidth: number }
  | { kind: "stats" }
  | { kind: "dom"; patch: DomPatch };

export interface FrameResult {
  ok: boolean;
  value?: string;
  error?: string;
  image?: { data: string; mimeType: string };
  stats?: CanvasStats;
}

export type ClientMsg =
  | { t: "hello"; v: number; sessionId?: string }
  | { t: "session.start"; config: SessionConfig; prompt: string }
  | { t: "prompt"; text: string }
  | { t: "interrupt" }
  | { t: "viewport"; width: number; height: number }
  // canvas frame -> core (relayed by the UI)
  | { t: "frame.ready"; rev: number }
  | { t: "frame.applied"; rev: number; errors: string[]; warnings: string[] }
  | { t: "frame.console"; entries: ConsoleEntry[] }
  | { t: "frame.result"; requestId: string; result: FrameResult }
  | { t: "frame.data"; key: string; value?: unknown; deleted?: boolean }
  | { t: "frame.emit"; name: string; payload?: unknown }
  | {
      t: "frame.chrome";
      requestId: string;
      component: ChromeComponent;
      props?: Record<string, unknown>;
      reset?: boolean;
    }
  | { t: "frame.stats"; stats: CanvasStats }
  // user actions (titlebar and menu)
  | { t: "chrome.set"; component: ChromeComponent; props: Record<string, unknown> }
  | { t: "chrome.reset"; component?: ChromeComponent }
  | { t: "undo" }
  | { t: "redo" }
  | { t: "canvas.clear" }
  | { t: "canvas.reload" }
  /** Rename the session; an empty title goes back to the automatic one. */
  | { t: "title.set"; title: string }
  // artifacts (web; Electron main reads and writes files itself)
  | { t: "artifact.export" }
  /** A `.caddis` file as base64. Opens as a new session; the reply is `artifact.opened`. */
  | { t: "artifact.import"; data: string; name?: string };

export type ServerMsg =
  /** `defaultCwd` is empty when each new session gets its own temporary directory. */
  | { t: "welcome"; v: number; providers: ProviderInfo[]; defaultCwd: string; platform: "web" | "electron" }
  /** Provider info changed after `welcome` (e.g. per-model default efforts arrived). */
  | { t: "providers"; providers: ProviderInfo[] }
  | { t: "session.snapshot"; session: SessionSnapshot }
  | { t: "session.none"; sessionId?: string }
  | { t: "history.append"; item: HistoryItem }
  | { t: "history.update"; id: string; patch: Partial<HistoryItem>; appendText?: string }
  | { t: "status"; status: AgentStatus; detail?: string }
  | { t: "canvas.mode"; mode: CanvasMode; rev: number }
  | { t: "canvas.resource"; resource: Resource; rev: number }
  | { t: "canvas.delete"; name: string; rev: number }
  /** Full state (undo/redo/clear). The frame diffs and applies in place. */
  | { t: "canvas.state"; canvas: CanvasState }
  | { t: "canvas.reload"; canvas: CanvasState }
  | { t: "data.changed"; key: string; value?: unknown; deleted?: boolean; source: DataSource }
  | { t: "frame.request"; requestId: string; request: FrameRequest }
  | { t: "frame.chrome.result"; requestId: string; result: ChromeApplyResult | { error: string } }
  | { t: "chrome.state"; chrome: ChromeState }
  | { t: "undo.state"; undo: UndoInfo }
  | { t: "title"; title?: SessionTitle }
  | { t: "stats"; stats: CanvasStats }
  /** Reply to `artifact.export`: a `.caddis` file (base64) to download. */
  | { t: "artifact.file"; name: string; data: string }
  | { t: "artifact.opened"; sessionId: string }
  /** Electron: the session was saved to `name`. */
  | { t: "artifact.saved"; name: string }
  | { t: "error"; message: string };

// ---------------------------------------------------------------------------
// Hop 2: UI <-> canvas iframe (postMessage; every message has {ch, v})
// ---------------------------------------------------------------------------

export type ToFrameMsg =
  | { type: "init"; canvas: CanvasState; data: Record<string, unknown> }
  | { type: "state"; canvas: CanvasState }
  | { type: "data"; key: string; value?: unknown; deleted?: boolean }
  | { type: "request"; id: string; request: FrameRequest }
  | { type: "chrome.result"; id: string; result: unknown };

/** Titlebar/menu actions. Electron main sends them to the focused window for native menu items and shortcuts. */
export type UiCommand =
  | "overlay"
  | "history"
  | "resetOverlay"
  | "undo"
  | "redo"
  | "reloadCanvas"
  | "clearCanvas"
  | "rename";

export type FromFrameMsg =
  | { type: "hello" }
  | { type: "ready"; rev: number }
  | { type: "applied"; rev: number; errors: string[]; warnings: string[] }
  | { type: "console"; entries: { level: ConsoleEntry["level"]; message: string; ts: number }[] }
  | { type: "result"; id: string; result: FrameResult }
  | { type: "data"; key: string; value?: unknown; deleted?: boolean }
  | { type: "emit"; name: string; payload?: unknown }
  | { type: "chrome"; id: string; component: ChromeComponent; props?: Record<string, unknown>; reset?: boolean }
  | { type: "stats"; stats: CanvasStats }
  /** A host shortcut pressed while the canvas has focus (only reaches the host this way on the web). */
  | { type: "hotkey"; key: "overlay" };
