import type { ProviderInfo, SessionConfig } from "../../shared/protocol";
import type { ToolSet } from "../tools";

/** Normalised events a provider emits; the Session turns them into history. */
export type ProviderEvent =
  | { type: "session-id"; id: string }
  | { type: "text-delta"; messageId: string; text: string }
  | { type: "text"; messageId: string; text: string }
  | { type: "thinking"; messageId: string; text: string }
  | { type: "tool-start"; id: string; name: string; input: unknown }
  | { type: "tool-end"; id: string; result: string; isError: boolean }
  | { type: "turn-end"; ok: boolean; error?: string; durationMs?: number; costUsd?: number }
  | { type: "fatal"; error: string };

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
  send(text: string): void;
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
