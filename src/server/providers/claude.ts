import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CANVAS_TOOL_NAMES, EFFORTS, type ProviderInfo } from "../../shared/protocol";
import { createCanvasMcpServer, mcpToolName } from "../canvasTools";
import type { AgentProvider, AgentRun, ProviderContext } from "./types";

const BUILTIN_TOOLS = ["Read", "Glob", "Grep"];

/** Push-based async iterable used as the SDK's streaming input. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  push(text: string) {
    this.items.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage);
    this.wake?.();
  }
  close() {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}

export class ClaudeProvider implements AgentProvider {
  info(): ProviderInfo {
    return {
      id: "claude",
      label: "Claude (Agent SDK)",
      enabled: true,
      models: [
        { id: "", label: "Default" },
        { id: "claude-opus-5-5", label: "Opus 5.5" },
        { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
        { id: "claude-fable-5-1", label: "Fable 5.1" },
        { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
      ],
      efforts: [...EFFORTS],
    };
  }

  start(ctx: ProviderContext): AgentRun {
    const input = new InputQueue();
    const { config } = ctx;
    const q = query({
      prompt: input,
      options: {
        cwd: config.cwd,
        model: config.model || undefined,
        effort: config.effort || undefined,
        systemPrompt: ctx.systemPrompt,
        resume: ctx.resumeId,
        includePartialMessages: true,
        settingSources: [],
        tools: BUILTIN_TOOLS,
        mcpServers: { canvas: createCanvasMcpServer(ctx.tools) },
        allowedTools: [...BUILTIN_TOOLS, ...CANVAS_TOOL_NAMES.map(mcpToolName)],
        // Anything not pre-approved is denied rather than prompting (there is no approval UI yet).
        permissionMode: "dontAsk",
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "agent-canvas/0.1" },
      },
    });

    let closed = false;
    const state: StreamState = { msgId: "", streamed: new Set() };
    (async () => {
      try {
        for await (const msg of q) handle(msg, ctx, state);
      } catch (e: any) {
        if (!closed) ctx.emit({ type: "fatal", error: e?.message ?? String(e) });
      }
    })();

    return {
      send: (text) => {
        ctx.emit({ type: "turn-start" });
        input.push(text);
      },
      interrupt: async () => {
        await q.interrupt();
      },
      close: () => {
        closed = true;
        input.close();
        q.close();
      },
    };
  }

}

interface StreamState {
  msgId: string;
  /** Message ids whose text arrived as stream deltas (skip their full-message copy). */
  streamed: Set<string>;
}

function handle(msg: SDKMessage, ctx: ProviderContext, st: StreamState) {
    const { emit } = ctx;
    // Ignore subagent traffic; only the main thread is shown.
    if ("parent_tool_use_id" in msg && msg.parent_tool_use_id) return;
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") emit({ type: "session-id", id: msg.session_id });
        return;
      case "stream_event": {
        const ev = msg.event as any;
        if (ev.type === "message_start") st.msgId = ev.message.id;
        else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          st.streamed.add(st.msgId);
          emit({ type: "text-delta", messageId: `${st.msgId}:${ev.index}`, text: ev.delta.text });
        } else if (ev.type === "content_block_start" && ev.content_block?.type === "thinking")
          emit({ type: "thinking", messageId: `${st.msgId}:${ev.index}`, text: "" });
        else if (ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta")
          emit({ type: "thinking", messageId: `${st.msgId}:${ev.index}`, text: ev.delta.thinking });
        return;
      }
      case "assistant": {
        const content = msg.message.content as any[];
        content.forEach((block, i) => {
          if (block.type === "text" && !st.streamed.has(msg.message.id)) emit({ type: "text", messageId: `${msg.message.id}:${i}`, text: block.text });
          else if (block.type === "tool_use") emit({ type: "tool-start", id: block.id, name: block.name, input: block.input });
        });
        if (msg.error) emit({ type: "fatal", error: `assistant error: ${msg.error}` });
        return;
      }
      case "user": {
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content as any[]) {
          if (block.type !== "tool_result") continue;
          const text = Array.isArray(block.content)
            ? block.content.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
            : String(block.content ?? "");
          emit({ type: "tool-end", id: block.tool_use_id, result: text, isError: Boolean(block.is_error) });
        }
        return;
      }
      case "result":
        emit({
          type: "turn-end",
          ok: !msg.is_error && msg.subtype === "success",
          error: msg.subtype === "success" ? (msg.is_error ? msg.result : undefined) : msg.errors?.join("; ") || msg.subtype,
          durationMs: msg.duration_ms,
          costUsd: msg.total_cost_usd,
        });
        return;
    }
}
