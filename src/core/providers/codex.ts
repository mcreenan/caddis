import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { ModelInfo, ProviderInfo } from "../../shared/protocol";
import type { McpHost } from "../mcpHttp";
import { findExecutable, withTimeout } from "./exec";
import type { AgentProvider, AgentRun, ProviderContext, ProviderEvent } from "./types";

/**
 * Codex via `codex app-server` (JSON-RPC over stdio), driving the user's
 * installed CLI so its own login (ChatGPT plan or API key) is used.
 *
 * Commands and edits run in Codex's workspace-write sandbox with network
 * access and no approval prompts, matching what Claude gets. The canvas tools
 * reach Codex as an MCP server over loopback HTTP.
 */

const EFFORT_LABELS: Record<string, string> = { none: "None", minimal: "Minimal", ultra: "Ultra" };

export function resolveCodexExecutable(): string | undefined {
  return process.env.CADDIS_CODEX_EXECUTABLE || findExecutable("codex");
}

/** Newline-delimited JSON-RPC as `codex app-server` speaks it (no "jsonrpc" field). */
class AppServer {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  readonly proc: ChildProcess;
  private stderr = "";
  onNotification?: (method: string, params: any) => void;
  onRequest?: (method: string, params: any) => Promise<unknown>;
  onExit?: (detail: string) => void;

  constructor(exe: string, args: string[], cwd: string) {
    this.proc = spawn(exe, ["app-server", ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stderr!.on("data", (d) => (this.stderr = (this.stderr + d).slice(-4000)));
    this.proc.stdin!.on("error", () => {});
    readline.createInterface({ input: this.proc.stdout! }).on("line", (l) => this.receive(l));
    const fail = (why: string) => {
      const detail = `${why}${this.stderr.trim() ? `: ${this.stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`;
      for (const p of this.pending.values()) p.reject(new Error(detail));
      this.pending.clear();
      this.onExit?.(detail);
    };
    this.proc.on("error", (e) => fail(`codex failed to start (${e.message})`));
    this.proc.on("exit", (code, sig) => fail(`codex app-server exited (${sig ?? code})`));
  }

  private write(msg: object) {
    if (this.proc.stdin!.writable) this.proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  private receive(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.method && m.id !== undefined) {
      const answer = this.onRequest?.(m.method, m.params) ?? Promise.reject(new Error("unsupported"));
      answer.then(
        (result) => this.write({ id: m.id, result }),
        (e) => this.write({ id: m.id, error: { code: -32601, message: String(e?.message ?? e) } }),
      );
    } else if (m.method) this.onNotification?.(m.method, m.params);
    else if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
      else p?.resolve(m.result);
    }
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "caddis", title: "Caddis", version: "0.2" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    this.notify("initialized");
  }

  kill() {
    this.proc.stdin?.end();
    this.proc.kill();
  }
}

function describeAccount(r: any): string | undefined {
  const a = r?.account;
  if (!a) return undefined;
  if (a.type === "chatgpt") {
    const plan = a.planType && a.planType !== "unknown" ? `ChatGPT ${a.planType} plan` : "ChatGPT account";
    return `${plan}${a.email ? ` (${a.email})` : ""}`;
  }
  if (a.type === "apiKey") return "OpenAI API key";
  if (a.type === "amazonBedrock") return "Amazon Bedrock";
  return a.type;
}

export class CodexProvider implements AgentProvider {
  constructor(private readonly mcp: McpHost) {}

  async discover(): Promise<ProviderInfo> {
    const info: ProviderInfo = { id: "codex", label: "Codex", enabled: false, models: [], effortLabels: EFFORT_LABELS };
    const exe = resolveCodexExecutable();
    if (!exe) return { ...info, note: "codex CLI not found on PATH (set CADDIS_CODEX_EXECUTABLE)" };
    const server = new AppServer(exe, [], os.homedir());
    try {
      return await withTimeout(
        (async () => {
          await server.initialize();
          const account = await server.request("account/read", {});
          const auth = describeAccount(account);
          if (!auth && account?.requiresOpenaiAuth) return { ...info, note: "Not signed in: run `codex login`" };
          const rows: any[] = [];
          let cursor: string | null = null;
          do {
            const page: any = await server.request("model/list", { cursor });
            rows.push(...page.data);
            cursor = page.nextCursor;
          } while (cursor && rows.length < 200);
          const models: ModelInfo[] = rows
            .filter((m) => !m.hidden)
            .map((m) => ({
              id: m.id,
              label: m.displayName || m.id,
              efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort),
              defaultEffort: m.defaultReasoningEffort ?? undefined,
              description: m.description || undefined,
            }));
          const def = rows.find((m) => m.isDefault)?.id ?? models[0]?.id;
          return { ...info, enabled: models.length > 0, auth, models, defaultModel: def };
        })(),
        20_000,
        "asking the codex CLI for models",
      );
    } catch (e: any) {
      return { ...info, note: `codex CLI did not respond: ${e?.message ?? e}` };
    } finally {
      server.kill();
    }
  }

  start(ctx: ProviderContext): AgentRun {
    return new CodexRun(ctx, this.mcp);
  }
}

class CodexRun implements AgentRun {
  private server?: AppServer;
  private threadId?: string;
  private turnId?: string;
  private turnStarted = 0;
  private readonly queue: string[] = [];
  private closed = false;
  private readonly ready: Promise<void>;
  private disposeMcp?: () => void;
  /** Agent message items whose text streamed as deltas. */
  private readonly streamed = new Set<string>();

  constructor(
    private readonly ctx: ProviderContext,
    mcp: McpHost,
  ) {
    this.ready = this.boot(mcp).catch((e) => this.fatal(e?.message ?? String(e)));
  }

  private emit(e: ProviderEvent) {
    if (!this.closed) this.ctx.emit(e);
  }

  private fatal(error: string) {
    this.emit({ type: "fatal", error });
    this.close();
  }

  private async boot(mcp: McpHost) {
    const exe = resolveCodexExecutable();
    if (!exe) throw new Error("codex CLI not found on PATH (set CADDIS_CODEX_EXECUTABLE)");
    const endpoint = await mcp.register(this.ctx.tools);
    this.disposeMcp = () => endpoint.dispose();
    if (this.closed) return endpoint.dispose();
    const { config } = this.ctx;
    const toml = (v: unknown) => JSON.stringify(v);
    const server = new AppServer(
      exe,
      [
        "-c",
        `mcp_servers.${endpoint.name}.url=${toml(endpoint.url)}`,
        "-c",
        `mcp_servers.${endpoint.name}.tool_timeout_sec=120`,
        "-c",
        `mcp_servers.${endpoint.name}.startup_timeout_sec=30`,
        "-c",
        `mcp_servers.${endpoint.name}.default_tools_approval_mode="approve"`,
      ],
      config.cwd,
    );
    this.server = server;
    server.onExit = (detail) => {
      if (!this.closed) this.fatal(detail);
    };
    server.onNotification = (m, p) => this.onNotification(m, p);
    server.onRequest = (m, p) => this.onRequest(m, p);
    await server.initialize();

    const sandboxOff = process.env.CADDIS_SANDBOX === "0";
    const overrides = {
      model: config.model || null,
      cwd: config.cwd,
      approvalPolicy: "never",
      sandbox: sandboxOff ? "danger-full-access" : "workspace-write",
      config: sandboxOff ? null : { "sandbox_workspace_write.network_access": true },
      developerInstructions: this.ctx.systemPrompt,
    };
    let res: any;
    if (this.ctx.resumeId) {
      try {
        res = await server.request(this.ctx.fork ? "thread/fork" : "thread/resume", {
          threadId: this.ctx.resumeId,
          ...overrides,
          excludeTurns: true,
        });
      } catch (e: any) {
        this.emit({
          type: "notice",
          level: "info",
          text: `Codex couldn't resume its earlier conversation (${e?.message ?? e}), so it starts fresh.`,
        });
      }
    }
    res ??= await server.request("thread/start", { ...overrides, serviceName: "caddis" });
    this.threadId = res.thread.id;
    this.emit({ type: "session-id", id: res.thread.id });
    this.pump();
  }

  private async onRequest(method: string, p: any): Promise<unknown> {
    switch (method) {
      // approvalPolicy "never" means these shouldn't come; decline anything that does.
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "mcpServer/elicitation/request":
        // Codex asks before calling MCP tools it hasn't been told to trust; the canvas server is ours.
        return p?.serverName === "canvas" && p?.mode === "form"
          ? { action: "accept", content: {}, _meta: null }
          : { action: "decline", content: null, _meta: null };
      case "item/tool/requestUserInput":
        return { answers: {} };
    }
    throw new Error(`caddis does not handle ${method}`);
  }

  private onNotification(method: string, p: any) {
    if (p?.threadId && p.threadId !== this.threadId) return; // sub-agent threads
    switch (method) {
      case "turn/started":
        this.turnId = p.turn.id;
        return;
      case "item/agentMessage/delta":
        this.streamed.add(p.itemId);
        this.emit({ type: "text-delta", messageId: p.itemId, text: p.delta });
        return;
      case "item/reasoning/summaryTextDelta":
        this.emit({ type: "thinking", messageId: `${p.itemId}:${p.summaryIndex}`, text: p.delta });
        return;
      case "item/reasoning/summaryPartAdded":
        this.emit({ type: "thinking", messageId: `${p.itemId}:${p.summaryIndex}`, text: "" });
        return;
      case "item/started":
        return this.itemStarted(p.item);
      case "item/completed":
        return this.itemCompleted(p.item);
      case "turn/completed": {
        const t = p.turn;
        if (this.turnId && this.turnId !== "starting" && t.id !== this.turnId) return;
        this.turnId = undefined;
        this.emit({
          type: "turn-end",
          ok: t.status === "completed",
          error:
            t.status === "completed"
              ? undefined
              : (t.error?.message ?? (t.status === "interrupted" ? "interrupted" : t.status)),
          durationMs: t.durationMs ?? Date.now() - this.turnStarted,
        });
        this.pump();
        return;
      }
    }
  }

  private itemStarted(item: any) {
    const tool = describeTool(item);
    if (tool) this.emit({ type: "tool-start", id: item.id, name: tool.name, input: tool.input });
  }

  private itemCompleted(item: any) {
    if (item.type === "agentMessage") {
      if (!this.streamed.has(item.id) && item.text) this.emit({ type: "text", messageId: item.id, text: item.text });
      return;
    }
    if (!describeTool(item)) return;
    const { result, isError } = toolResult(item);
    this.emit({ type: "tool-end", id: item.id, result, isError });
  }

  /** Start the next queued prompt once the thread is ready and idle. */
  private pump() {
    if (!this.server || !this.threadId || this.turnId || !this.queue.length || this.closed) return;
    const text = this.queue.shift()!;
    this.turnId = "starting";
    this.turnStarted = Date.now();
    this.server
      .request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text, text_elements: [] }],
        effort: this.ctx.config.effort || null,
      })
      .then((r: any) => {
        if (this.turnId === "starting") this.turnId = r.turn.id;
      })
      .catch((e) => {
        this.turnId = undefined;
        this.emit({ type: "turn-end", ok: false, error: e?.message ?? String(e) });
        this.pump();
      });
  }

  send(text: string) {
    this.queue.push(text);
    void this.ready.then(() => this.pump());
  }

  async interrupt() {
    this.queue.length = 0;
    if (this.server && this.threadId && this.turnId && this.turnId !== "starting")
      await this.server.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.server?.kill();
    this.disposeMcp?.();
  }
}

/** Codex items shown as tool calls, named like Claude's tools so the history's icons and summaries apply. */
function describeTool(item: any): { name: string; input: unknown } | undefined {
  switch (item.type) {
    case "commandExecution":
      return { name: "Bash", input: { command: item.command } };
    case "fileChange": {
      const changes = item.changes ?? [];
      return {
        name: changes.length === 1 && changes[0].kind?.type === "add" ? "Write" : "Edit",
        input:
          changes.length > 1
            ? { file_path: changes[0].path, files: changes.map((c: any) => c.path) }
            : { file_path: changes[0]?.path },
      };
    }
    case "mcpToolCall":
      return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments };
    case "dynamicToolCall":
      return { name: item.tool, input: item.arguments };
    case "webSearch":
      return { name: "WebSearch", input: { query: item.query } };
    case "imageView":
      return { name: "Read", input: { file_path: item.path } };
    case "collabAgentToolCall":
      return { name: "Agent", input: { prompt: item.prompt } };
  }
  return undefined;
}

function toolResult(item: any): { result: string; isError: boolean } {
  switch (item.type) {
    case "commandExecution":
      return {
        result: `${item.aggregatedOutput ?? ""}${item.exitCode ? `\n(exit ${item.exitCode})` : ""}`.trim(),
        isError: item.status !== "completed" || Boolean(item.exitCode),
      };
    case "fileChange":
      return {
        result: (item.changes ?? [])
          .map((c: any) => `${c.kind?.type ?? "update"} ${path.basename(c.path)}\n${c.diff}`)
          .join("\n"),
        isError: item.status !== "completed",
      };
    case "mcpToolCall":
      if (item.error) return { result: item.error.message, isError: true };
      return {
        result: (item.result?.content ?? []).map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n"),
        isError: item.status === "failed",
      };
    case "dynamicToolCall":
      return {
        result: (item.contentItems ?? []).map((c: any) => (c.type === "inputText" ? c.text : `[${c.type}]`)).join("\n"),
        isError: item.success === false,
      };
  }
  return { result: "", isError: item.status === "failed" };
}
