import { create } from "zustand";
import {
  emptyCanvas,
  emptyChrome,
  type AgentInfo,
  type AgentStatus,
  type ArtifactInfo,
  type CanvasState,
  type CanvasStats,
  type ChromeState,
  type HistoryItem,
  type HubUser,
  type ProjectInfo,
  type ProviderInfo,
  type Revision,
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
  /** `join`, `projects` and `project` only happen on a hub. */
  phase: "connecting" | "start" | "session" | "join" | "projects" | "project";
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

  // hub (docs/HUB.md)
  /** Set while connected to a hub. */
  hub?: { name: string };
  me?: HubUser;
  hubError?: string;
  agents: AgentInfo[];
  projects: ProjectInfo[];
  /** The open project, and its artifacts. */
  project?: ProjectInfo;
  artifacts: ArtifactInfo[];
  /** People viewing the open artifact. */
  viewers: HubUser[];
  revisions?: Revision[];
  /** Who the prompt goes to: "room", or "<agent id>:<provider>". Unset: the person's own agent. */
  target?: string;
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
  agents: [],
  projects: [],
  artifacts: [],
  viewers: [],
}));

/** Session state reset when leaving an artifact (hub). */
export const noSession = {
  sessionId: undefined,
  config: undefined,
  status: "idle",
  statusDetail: undefined,
  history: [],
  canvas: emptyCanvas(),
  data: {},
  chrome: emptyChrome(),
  undo: { undo: 0, redo: 0 },
  stats: undefined,
  file: undefined,
  title: undefined,
  viewers: [],
  revisions: undefined,
} satisfies Partial<UiState>;

const set = useUi.setState;

/** Apply a core message to UI state. Canvas/frame relaying is done by the CanvasFrame host. */
export function reduce(msg: ServerMsg) {
  switch (msg.t) {
    case "welcome":
      return set({
        welcomed: true,
        providers: msg.providers,
        defaultCwd: msg.defaultCwd,
        hub: msg.hub,
        ...(!msg.hub && { me: undefined, agents: [], projects: [], project: undefined, artifacts: [] }),
      });
    case "hub.joined":
      return set({ me: msg.user, agents: msg.agents, hubError: undefined });
    case "hub.denied":
      return set({ phase: "join", hubError: msg.message, me: undefined });
    case "agents":
      return set({ agents: msg.agents });
    case "projects":
      return set({ projects: msg.projects });
    case "project":
      return set({ project: msg.project, artifacts: msg.artifacts });
    case "presence":
      return set({ viewers: msg.users });
    case "revisions":
      return set({ revisions: msg.revisions });
    case "providers":
      return set({ providers: msg.providers });
    case "session.none":
      return set((st) =>
        st.hub
          ? { ...noSession, phase: st.project ? "project" : "projects" }
          : { phase: "start", sessionId: undefined },
      );
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

/** Agents connected to the hub that belong to me. */
export const useMyAgents = () => {
  const me = useUi((s) => s.me);
  const agents = useUi((s) => s.agents);
  return me ? agents.filter((a) => a.owner.id === me.id) : [];
};

/** The open session's provider info, if discovery knows it. */
export const useSessionProvider = () =>
  useUi((s) => s.providers.find((p) => p.id === (s.config?.provider ?? "claude")));
