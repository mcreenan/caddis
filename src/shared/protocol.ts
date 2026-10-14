/**
 * Agent Canvas protocol, version 1.
 *
 * Three channels:
 *   1. WebSocket  client <-> server   (ClientMsg / ServerMsg), path `/ws`
 *   2. postMessage parent <-> canvas iframe (ToFrameMsg / FromFrameMsg)
 *   3. Agent tools (CANVAS_TOOLS) exposed to the model via MCP
 *
 * The server is the source of truth for canvas documents and chrome overrides.
 * See docs/PROTOCOL.md for the prose version.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const FRAME_CHANNEL = "agent-canvas";

// ---------------------------------------------------------------------------
// Canvas document
// ---------------------------------------------------------------------------

export const CANVAS_MODES = ["html", "canvas", "3d"] as const;
export type CanvasMode = (typeof CANVAS_MODES)[number];
export const CANVAS_CONTEXTS = ["2d", "webgl", "webgl2"] as const;
export type CanvasContextKind = (typeof CANVAS_CONTEXTS)[number];

export interface CanvasDoc {
  /** Monotonic; bumped on every change (write, patch, mode, undo). */
  version: number;
  mode: CanvasMode;
  /** Body markup. In canvas/3d modes it is an overlay above the drawing surface. */
  html: string;
  css: string;
  /** JS run as an async function body after the mode runtime is ready. */
  script: string;
  /** canvas mode only: which context `ctx` is. */
  context: CanvasContextKind;
  updatedAt: number;
}

export const emptyCanvas = (): CanvasDoc => ({
  version: 0,
  mode: "html",
  html: "",
  css: "",
  script: "",
  context: "2d",
  updatedAt: Date.now(),
});

export const PATCH_OPS = [
  "replace", // outerHTML
  "inner", // innerHTML
  "append", // beforeend
  "prepend", // afterbegin
  "before", // beforebegin
  "after", // afterend
  "remove",
  "attr", // content = JSON object of attributes; null value removes
  "style", // content = CSS declarations appended to style attribute
  "text", // textContent
] as const;
export type PatchOp = (typeof PATCH_OPS)[number];

export interface CanvasPatch {
  selector: string;
  op: PatchOp;
  content?: string;
  /** Apply to every match instead of the first. */
  all?: boolean;
}

export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error";
  message: string;
  ts: number;
  /** Canvas version that produced it. */
  version: number;
}

// ---------------------------------------------------------------------------
// Chrome (the two undeletable overlays)
// ---------------------------------------------------------------------------

export const CHROME_COMPONENTS = ["prompt", "history"] as const;
export type ChromeComponent = (typeof CHROME_COMPONENTS)[number];

/** Props the agent may set. All optional; absent = base default. */
export interface ChromeProps {
  /** CSS px from viewport left/top. Clamped client-side so >= 80% stays on-screen. */
  x?: number;
  y?: number;
  width?: number;
  /** history only (prompt height follows its content). */
  height?: number;
  /** 0.6 .. 1 */
  opacity?: number;
  accent?: string;
  background?: string;
  foreground?: string;
  /** backdrop blur px, 0 .. 40 */
  blur?: number;
  /** border radius px, 0 .. 32 */
  radius?: number;
  /** history only: collapse to the activity button. */
  mini?: boolean;
}

export type ChromeState = Record<ChromeComponent, ChromeProps>;
export const emptyChrome = (): ChromeState => ({ prompt: {}, history: {} });

// ---------------------------------------------------------------------------
// Session + history
// ---------------------------------------------------------------------------

export type ProviderId = "claude" | "codex";
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface SessionConfig {
  provider: ProviderId;
  /** Empty = provider default. */
  model: string;
  effort: Effort | "";
  cwd: string;
}

export type AgentStatus = "idle" | "thinking" | "tool" | "error";

export type HistoryItem =
  | { id: string; ts: number; kind: "user"; text: string }
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
  | { id: string; ts: number; kind: "turn"; ok: boolean; durationMs?: number; costUsd?: number; error?: string }
  | { id: string; ts: number; kind: "notice"; level: "info" | "error"; text: string };

export interface SessionSnapshot {
  id: string;
  config: SessionConfig;
  status: AgentStatus;
  statusDetail?: string;
  history: HistoryItem[];
  canvas: CanvasDoc;
  chrome: ChromeState;
  undo: UndoInfo;
}

export interface UndoInfo {
  canvasUndo: number;
  canvasRedo: number;
  chromeUndo: number;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  enabled: boolean;
  note?: string;
  models: { id: string; label: string }[];
  efforts: Effort[];
}

// ---------------------------------------------------------------------------
// WebSocket: client -> server
// ---------------------------------------------------------------------------

export type ClientMsg =
  | { t: "hello"; v: number; sessionId?: string }
  | { t: "session.start"; config: SessionConfig; prompt: string }
  | { t: "prompt"; text: string }
  | { t: "interrupt" }
  /** Reply to a server `canvas.request`. */
  | { t: "canvas.result"; requestId: string; ok: boolean; value?: string; error?: string; image?: { data: string; mimeType: string } }
  /** Iframe finished (re)building `version`. */
  | { t: "canvas.rendered"; version: number }
  | { t: "canvas.console"; entries: ConsoleEntry[] }
  | { t: "canvas.undo" }
  | { t: "canvas.redo" }
  | { t: "canvas.clear" }
  /** User-originated chrome change (e.g. restoring the mini panel). Unclamped props are normalised server-side. */
  | { t: "chrome.set"; component: ChromeComponent; props: ChromeProps }
  | { t: "chrome.undo" }
  | { t: "chrome.reset" };

// ---------------------------------------------------------------------------
// WebSocket: server -> client
// ---------------------------------------------------------------------------

export type ServerMsg =
  | { t: "welcome"; v: number; providers: ProviderInfo[]; defaultCwd: string }
  | { t: "session.snapshot"; session: SessionSnapshot }
  | { t: "session.none"; sessionId?: string }
  | { t: "history.append"; item: HistoryItem }
  | { t: "history.update"; id: string; patch: Partial<HistoryItem>; appendText?: string }
  | { t: "status"; status: AgentStatus; detail?: string }
  | { t: "canvas.state"; canvas: CanvasDoc; undo: UndoInfo }
  /** Live-apply `patch` if the client is at canvas.version - 1, else rebuild from `canvas`. */
  | { t: "canvas.patch"; patch: CanvasPatch; canvas: CanvasDoc; undo: UndoInfo }
  /** Ask the live iframe to do something and reply with `canvas.result`. */
  | { t: "canvas.request"; requestId: string; kind: "eval"; js: string }
  | { t: "canvas.request"; requestId: string; kind: "snapshot"; maxWidth: number }
  | { t: "chrome.state"; chrome: ChromeState; undo: UndoInfo }
  | { t: "error"; message: string };

// ---------------------------------------------------------------------------
// postMessage: parent <-> sandboxed canvas iframe. Every message carries
// { ch: FRAME_CHANNEL, v: PROTOCOL_VERSION }. The parent only accepts
// messages whose event.source is the iframe's contentWindow.
// ---------------------------------------------------------------------------

export type ToFrameMsg =
  | { type: "eval"; id: string; js: string }
  | { type: "snapshot"; id: string; maxWidth: number }
  | { type: "patch"; patch: CanvasPatch; version: number };

export type FromFrameMsg =
  | { type: "ready"; version: number }
  | { type: "result"; id: string; ok: boolean; value?: string; error?: string; image?: { data: string; mimeType: string } }
  | { type: "console"; entries: Omit<ConsoleEntry, "version">[]; version: number }
  /** The escape-hatch hotkey was pressed while focus was inside the canvas. */
  | { type: "escape" };

// ---------------------------------------------------------------------------
// Agent tools. Names are exposed to Claude as mcp__canvas__<name>.
// ---------------------------------------------------------------------------

// Wrapped in a pure IIFE so the browser bundle can drop zod entirely.
export const CANVAS_TOOLS = /* @__PURE__ */ (() => {
const colour = z.string().max(64).describe("CSS colour: #hex, rgb()/rgba(), hsl()/hsla(), oklch() or a named colour");

const chromePropsShape = {
  x: z.number().optional().describe("left, CSS px"),
  y: z.number().optional().describe("top, CSS px"),
  width: z.number().optional(),
  height: z.number().optional().describe("history only"),
  opacity: z.number().optional().describe("0.6..1"),
  accent: colour.optional(),
  background: colour.optional(),
  foreground: colour.optional(),
  blur: z.number().optional().describe("backdrop blur px 0..40"),
  radius: z.number().optional().describe("border radius px 0..32"),
  mini: z.boolean().optional().describe("history only: collapse to a small activity button"),
};

return {
  canvas_set_mode: {
    description:
      "Switch canvas mode: html (document), canvas (fullscreen 2D/WebGL <canvas>), 3d (three.js scene). Keeps html/css, clears script.",
    shape: {
      mode: z.enum(CANVAS_MODES),
      context: z.enum(CANVAS_CONTEXTS).optional().describe("canvas mode: context type for ctx (default 2d)"),
    },
  },
  canvas_write: {
    description:
      "Replace the whole canvas document. Omitted fields become empty. Returns render status and any errors.",
    shape: {
      mode: z.enum(CANVAS_MODES).optional().describe("default: keep current mode"),
      html: z.string().optional().describe("body markup (overlay in canvas/3d modes)"),
      css: z.string().optional(),
      script: z.string().optional().describe("JS async function body run after setup; see system prompt for in-scope names"),
      context: z.enum(CANVAS_CONTEXTS).optional().describe("canvas mode only"),
    },
  },
  canvas_patch: {
    description:
      "Targeted edit of the html markup by CSS selector, applied live without reloading. op: replace|inner|append|prepend|before|after|remove|attr (content=JSON object)|style (content=CSS decls)|text.",
    shape: {
      selector: z.string(),
      op: z.enum(PATCH_OPS),
      content: z.string().optional(),
      all: z.boolean().optional().describe("apply to all matches (default first)"),
    },
  },
  canvas_eval: {
    description:
      "Run JS in the live canvas (same scope helpers as script, as an async function body) and return the JSON-serialised return value. Not persisted.",
    shape: { js: z.string() },
  },
  canvas_get_state: {
    description: "Return the current canvas source (mode, html, css, script, version) and recent console output/errors.",
    shape: {},
  },
  canvas_snapshot: {
    description: "Capture a PNG of the canvas as the user currently sees it.",
    shape: { maxWidth: z.number().optional().describe("default 768") },
  },
  chrome_update: {
    description:
      "Restyle/move the floating prompt or history overlay. Values are clamped (min size, >=80% on-screen, opacity>=0.6); they cannot be hidden.",
    shape: { component: z.enum(CHROME_COMPONENTS), props: z.object(chromePropsShape) },
  },
  chrome_reset: {
    description: "Reset chrome overrides to defaults (one component or both).",
    shape: { component: z.enum(CHROME_COMPONENTS).optional() },
  },
} as const;
})();

export type CanvasToolName = keyof typeof CANVAS_TOOLS;
export const CANVAS_TOOL_NAMES: CanvasToolName[] = [
  "canvas_set_mode",
  "canvas_write",
  "canvas_patch",
  "canvas_eval",
  "canvas_get_state",
  "canvas_snapshot",
  "chrome_update",
  "chrome_reset",
];
export const MCP_SERVER_NAME = "canvas";
