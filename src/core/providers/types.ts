import type { Author, PromptTarget, ProviderInfo, SessionConfig } from "../../shared/protocol";
import type { ToolSet } from "../tools";

/**
 * Normalised events a provider emits; the Session turns them into history.
 * `by` attributes them on a hub, where several people's agents share a session.
 */
export type ProviderEvent = (
  | { type: "session-id"; id: string }
  | { type: "text-delta"; messageId: string; text: string }
  | { type: "text"; messageId: string; text: string }
  | { type: "thinking"; messageId: string; text: string }
  | { type: "tool-start"; id: string; name: string; input: unknown }
  /** `input` replaces the tool's input when it was only known once the call finished. */
  | { type: "tool-end"; id: string; result: string; isError: boolean; input?: unknown }
  /** Shown in the history without ending the turn (e.g. a resume that fell back to a fresh conversation). */
  | { type: "notice"; level: "info" | "error"; text: string }
  | { type: "turn-end"; ok: boolean; error?: string; durationMs?: number; costUsd?: number }
  /** A turn started without a prompt from this session's UI (a queued turn on a hub). */
  | { type: "busy"; detail?: string }
  | { type: "fatal"; error: string }
) & { by?: Author };

/** Who a message is from and which agent should act on it (hub sessions; local providers ignore it). */
export interface TurnMeta {
  by?: Author;
  to?: PromptTarget;
}

export interface ProviderContext {
  config: SessionConfig;
  systemPrompt: string;
  /** Provider-native session id to resume, if any. */
  resumeId?: string;
  /** Resume `resumeId` into a new provider session rather than continuing it (an imported artifact). */
  fork?: boolean;
  /** Canvas tools, provider-agnostic; each provider exposes them its own way. */
  tools: ToolSet;
  emit: (e: ProviderEvent) => void;
}

export interface AgentRun {
  send(text: string, meta?: TurnMeta): void;
  interrupt(): Promise<void>;
  close(): void;
}

export interface AgentProvider {
  /**
   * Probe availability, auth and models from the host (cached by the caller).
   * Slow details may be filled into the returned info later, followed by `onUpdate`.
   */
  discover(onUpdate?: () => void): Promise<ProviderInfo>;
  start(ctx: ProviderContext): AgentRun;
}
