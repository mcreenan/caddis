import { query, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Effort, ProviderInfo } from "../../shared/protocol";
import { createCanvasMcpServer, MCP_SERVER_NAME, mcpToolName } from "../tools";
import type { AgentProvider, AgentRun, ProviderContext } from "./types";

/**
 * Claude via the Agent SDK, driving the user's installed `claude` CLI so the
 * CLI's own login (Pro/Max subscription or `CLAUDE_CODE_OAUTH_TOKEN` from
 * `claude setup-token`) is used. We never set ANTHROPIC_API_KEY.
 */

/** Built-in tools that run without prompting; anything else follows the user's settings or is denied (no approval UI yet). */
const PREAPPROVED = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"];

export function resolveClaudeExecutable(): string | undefined {
  const override = process.env.CADDIS_CLAUDE_EXECUTABLE;
  if (override) return override;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  // GUI launches often get a minimal PATH; include the installer's usual spots.
  dirs.push(path.join(os.homedir(), ".local/bin"), path.join(os.homedir(), ".claude/local"), "/usr/local/bin", "/opt/homebrew/bin");
  for (const d of dirs) {
    const p = path.join(d, process.platform === "win32" ? "claude.exe" : "claude");
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  return undefined;
}

function baseOptions(): Options {
  const exe = resolveClaudeExecutable();
  return {
    pathToClaudeCodeExecutable: exe,
    settingSources: ["user", "project", "local"],
    persistSession: true,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "caddis/0.2" },
  };
}

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

const never: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };

export class ClaudeProvider implements AgentProvider {
  async discover(): Promise<ProviderInfo> {
    const info: ProviderInfo = { id: "claude", label: "Claude", enabled: false, models: [] };
    const exe = resolveClaudeExecutable();
    if (!exe) return { ...info, note: "claude CLI not found on PATH (set CADDIS_CLAUDE_EXECUTABLE)" };
    // Ask the CLI itself which models and effort levels this login supports.
    const q = query({ prompt: never, options: { ...baseOptions(), cwd: os.homedir() } });
    try {
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out asking the claude CLI for models")), 20000));
      const [account, models] = await Promise.race([Promise.all([q.accountInfo(), q.supportedModels()]), timeout]);
      const who = account.subscriptionType ? `${account.subscriptionType} subscription` : (account.apiKeySource ?? account.tokenSource ?? account.apiProvider ?? "unknown auth");
      return {
        ...info,
        enabled: true,
        auth: `${who}${account.email ? ` (${account.email})` : ""}`,
        models: models.map((m) => ({
          id: m.value === "default" ? "" : m.value,
          label: m.displayName,
          efforts: (m.supportsEffort === false ? [] : (m.supportedEffortLevels ?? [])) as Effort[],
          description: m.description,
        })),
      };
    } catch (e: any) {
      return { ...info, note: `claude CLI did not respond: ${e?.message ?? e}` };
    } finally {
      q.close();
    }
  }

  start(ctx: ProviderContext): AgentRun {
    const input = new InputQueue();
    const { config } = ctx;
    const canvasTools = ctx.tools.defs.map((t) => mcpToolName(t.name));
    const q = query({
      prompt: input,
      options: {
        ...baseOptions(),
        cwd: config.cwd,
        model: config.model || undefined,
        effort: config.effort || undefined,
        systemPrompt: ctx.systemPrompt,
        resume: ctx.resumeId,
        includePartialMessages: true,
        mcpServers: { [MCP_SERVER_NAME]: createCanvasMcpServer(ctx.tools) },
        allowedTools: [...PREAPPROVED, ...canvasTools],
        // Edits are auto-accepted in the working directory. Bash runs in Claude Code's sandbox
        // (writes confined to cwd, network allowed) and is auto-approved there.
        permissionMode: (process.env.CADDIS_PERMISSION_MODE as Options["permissionMode"]) ?? "acceptEdits",
        sandbox: {
          enabled: process.env.CADDIS_SANDBOX !== "0",
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          network: { allowedDomains: ["*"], allowLocalBinding: true },
        },
      },
    });

    let closed = false;
    const st: StreamState = { msgId: "", streamed: new Set() };
    (async () => {
      try {
        for await (const msg of q) handle(msg, ctx, st);
      } catch (e: any) {
        if (!closed) ctx.emit({ type: "fatal", error: e?.message ?? String(e) });
      }
    })();

    return {
      send: (text) => input.push(text),
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
