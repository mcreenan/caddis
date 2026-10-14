import type { ProviderInfo } from "../../shared/protocol";
import type { AgentProvider, AgentRun, ProviderContext } from "./types";

/**
 * Stub. A real implementation would run `codex exec --json` (or `codex
 * app-server`) and expose the canvas tools to it as a streamable-HTTP MCP
 * server backed by runCanvasTool(). Not wired up yet.
 */
export class CodexProvider implements AgentProvider {
  info(): ProviderInfo {
    return {
      id: "codex",
      label: "Codex",
      enabled: false,
      note: "not implemented yet",
      models: [{ id: "", label: "Default" }],
      efforts: ["low", "medium", "high"],
    };
  }

  start(ctx: ProviderContext): AgentRun {
    queueMicrotask(() => ctx.emit({ type: "fatal", error: "The Codex provider is not implemented yet." }));
    return { send() {}, async interrupt() {}, close() {} };
  }
}
