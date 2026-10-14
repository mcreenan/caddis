import { create } from "zustand";
import {
  emptyCanvas,
  emptyChrome,
  type AgentStatus,
  type CanvasState,
  type CanvasStats,
  type ChromeState,
  type HistoryItem,
  type ProviderInfo,
  type ServerMsg,
  type SessionConfig,
  type SessionTitle,
  type UndoInfo,
} from "../shared/protocol";

export interface UiState {
  connected: boolean;
  welcomed: boolean;
  providers: ProviderInfo[];
  defaultCwd: string;
  phase: "connecting" | "start" | "session";
  sessionId?: string;
  config?: SessionConfig;
  status: AgentStatus;
  statusDetail?: string;
  history: HistoryItem[];
  canvas: CanvasState;
  data: Record<string, unknown>;
  chrome: ChromeState;
  undo: UndoInfo;
  stats?: CanvasStats;
  error?: string;
  /** The prompt and history overlay is hidden (titlebar toggle, Ctrl/Cmd+Backslash). */
  overlayHidden: boolean;
  /** Electron: the canvas process's memory/CPU, polled while a session is open. */
  proc?: CanvasStats["process"];
  /** Artifact file this session was saved to or opened from. */
  file?: string;
  title?: SessionTitle;
  /** The titlebar's title is being edited. */
  renaming: boolean;
  /** Short-lived notice ("Saved x.caddis"). */
  toast?: string;
}

export const useUi = create<UiState>(() => ({
  connected: false,
  welcomed: false,
  providers: [],
  defaultCwd: "",
  phase: "connecting",
  renaming: false,
  status: "idle",
  history: [],
  canvas: emptyCanvas(),
  data: {},
  chrome: emptyChrome(),
  undo: { undo: 0, redo: 0 },
  overlayHidden: false,
}));

const set = useUi.setState;

/** Apply a core message to UI state. Canvas/frame relaying is done by the CanvasFrame host. */
export function reduce(msg: ServerMsg) {
  switch (msg.t) {
    case "welcome":
      return set({ welcomed: true, providers: msg.providers, defaultCwd: msg.defaultCwd });
    case "providers":
      return set({ providers: msg.providers });
    case "session.none":
      return set({ phase: "start", sessionId: undefined });
    case "session.snapshot": {
      const s = msg.session;
      return set({
        phase: "session",
        sessionId: s.id,
        config: s.config,
        status: s.status,
        statusDetail: s.statusDetail,
        history: s.history,
        canvas: s.canvas,
        data: s.data,
        chrome: s.chrome,
        undo: s.undo,
        stats: s.stats,
        file: s.file,
        title: s.title,
        error: undefined,
      });
    }
    case "title":
      return set({ title: msg.title });
    case "history.append":
      return set((st) => ({ history: [...st.history, msg.item] }));
    case "history.update":
      return set((st) => ({
        history: st.history.map((h) => {
          if (h.id !== msg.id) return h;
          const next = { ...h, ...msg.patch } as HistoryItem;
          if (msg.appendText && "text" in next)
            (next as { text: string }).text = (h as { text: string }).text + msg.appendText;
          return next;
        }),
      }));
    case "status":
      return set({ status: msg.status, statusDetail: msg.detail });
    case "canvas.mode":
      return set((st) => ({ canvas: { ...st.canvas, mode: msg.mode, rev: msg.rev } }));
    case "canvas.resource":
      return set((st) => ({
        canvas: {
          ...st.canvas,
          rev: msg.rev,
          resources: { ...st.canvas.resources, [msg.resource.name]: msg.resource },
        },
      }));
    case "canvas.delete":
      return set((st) => {
        const resources = { ...st.canvas.resources };
        delete resources[msg.name];
        return { canvas: { ...st.canvas, rev: msg.rev, resources } };
      });
    case "canvas.state":
      return set({ canvas: msg.canvas });
    case "canvas.reload":
      return set({ canvas: msg.canvas });
    case "data.changed":
      return set((st) => {
        const data = { ...st.data };
        if (msg.deleted) delete data[msg.key];
        else data[msg.key] = msg.value;
        return { data };
      });
    case "chrome.state":
      return set({ chrome: msg.chrome });
    case "undo.state":
      return set({ undo: msg.undo });
    case "stats":
      return set({ stats: msg.stats });
    case "artifact.saved":
      return set({ file: msg.name, toast: `Saved ${msg.name}` });
    case "error":
      return set({ error: msg.message });
  }
}
