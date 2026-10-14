import type { ProviderInfo, SessionConfig } from "../../shared/protocol";
import type { CanvasToolHost } from "../canvasTools";

/** Normalised events a provider emits; the Session turns them into history. */
export type ProviderEvent =
  | { type: "session-id"; id: string }
  | { type: "turn-start" }
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
  /** Provider-native session id to resume (e.g. Claude session UUID), if any. */
  resumeId?: string;
  tools: CanvasToolHost;
  emit: (e: ProviderEvent) => void;
}

export interface AgentRun {
  send(text: string): void;
  interrupt(): Promise<void>;
  close(): void;
}

export interface AgentProvider {
  info(): ProviderInfo;
  start(ctx: ProviderContext): AgentRun;
}
