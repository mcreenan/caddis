import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { ModelInfo, ProviderInfo } from "../../shared/protocol";
import type { McpEndpoint, McpHost } from "../mcpHttp";
import { mcpToolName, type ToolSet } from "../tools";
import { findExecutable, withTimeout } from "./exec";
import type { AgentProvider, AgentRun, ProviderContext, ProviderEvent } from "./types";

/**
 * Any agent that speaks the Agent Client Protocol (https://agentclientprotocol.com)
 * over stdio. Known agents are offered when their CLI is installed; more can be
 * declared in `acp-agents.json` in the data directory or `CADDIS_ACP_AGENTS`.
 *
 * The canvas tools reach the agent as an MCP server (HTTP when the agent
 * supports it, else a stdio bridge). ACP has no system prompt, so the canvas
 * instructions open the first message of a new conversation.
 */

export interface AcpAgentDef {
  /** Becomes the provider id `acp-<id>`. */
  id: string;
  label: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export const KNOWN_ACP_AGENTS: AcpAgentDef[] = [
  {
    id: "opencode",
    label: "opencode",
    command: "opencode",
    args: ["acp"],
    // Its question tool has no ACP handler here.
    env: { OPENCODE_CLIENT: "acp", OPENCODE_ENABLE_QUESTION_TOOL: "false" },
  },
  { id: "gemini", label: "Gemini CLI", command: "gemini", args: ["--acp"] },
  { id: "cursor", label: "Cursor", command: "cursor-agent", args: ["acp"] },
  { id: "grok", label: "Grok Build", command: "grok", args: ["agent", "stdio"] },
  { id: "omp", label: "omp", command: "omp", args: ["acp"] },
  { id: "hermes-agent", label: "Hermes Agent", command: "hermes", args: ["acp"] },
];

/** Agents declared by the user: a JSON array (or `{ "agents": [...] }`) inline in `CADDIS_ACP_AGENTS`, or in a file. */
export function loadCustomAcpAgents(dataDir: string): { agents: AcpAgentDef[]; errors: string[] } {
  const agents: AcpAgentDef[] = [];
  const errors: string[] = [];
  const sources: [string, string][] = [];
  const env = process.env.CADDIS_ACP_AGENTS?.trim();
  if (env) sources.push(env.startsWith("[") || env.startsWith("{") ? ["CADDIS_ACP_AGENTS", env] : [env, ""]);
  const file = path.join(dataDir, "acp-agents.json");
  if (existsSync(file)) sources.push([file, ""]);
  for (const [where, inline] of sources) {
    try {
      const raw = JSON.parse(inline || readFileSync(where, "utf8"));
      const list = Array.isArray(raw) ? raw : raw?.agents;
      if (!Array.isArray(list)) throw new Error("expected an array of agents");
      for (const a of list) {
        if (!a || typeof a.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(a.id))
          throw new Error(`agent id must be lowercase letters, digits and dashes: ${JSON.stringify(a?.id)}`);
        if (typeof a.command !== "string" || !a.command) throw new Error(`agent ${a.id} needs a command`);
        agents.push({
          id: a.id,
          label: typeof a.label === "string" && a.label ? a.label : a.id,
          command: a.command,
          args: Array.isArray(a.args) ? a.args.map(String) : [],
          env:
            a.env && typeof a.env === "object"
              ? Object.fromEntries(Object.entries(a.env).map(([k, v]) => [k, String(v)]))
              : {},
        });
      }
    } catch (e: any) {
      errors.push(`${where}: ${e?.message ?? e}`);
    }
  }
  return { agents, errors };
}

/** A connected agent process. */
class AgentProcess {
  readonly proc: ChildProcess;
  readonly conn: acp.ClientSideConnection;
  private stderr = "";
  readonly exited: Promise<string>;

  constructor(exe: string, def: AcpAgentDef, cwd: string, client: acp.Client) {
    this.proc = spawn(exe, def.args ?? [], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...def.env },
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(exe),
    });
    this.proc.stderr!.on("data", (d) => (this.stderr = (this.stderr + d).slice(-4000)));
    this.proc.stdin!.on("error", () => {});
    this.exited = new Promise((resolve) => {
      this.proc.on("error", (e) => resolve(`${def.label} failed to start (${e.message})`));
      this.proc.on("exit", (code, sig) => resolve(`${def.label} exited (${sig ?? code})${this.tail()}`));
    });
    const stream = acp.ndJsonStream(
      Writable.toWeb(this.proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(this.proc.stdout!) as ReadableStream<Uint8Array>,
    );
    this.conn = new acp.ClientSideConnection(() => client, stream);
  }

  private tail() {
    const t = this.stderr.trim();
    return t ? `: ${t.split("\n").slice(-3).join(" ")}` : "";
  }

  /** Reject when the process dies first, so a hung or crashed agent never stalls a request. */
  call<T>(p: Promise<T>): Promise<T> {
    return Promise.race([p, this.exited.then((why) => Promise.reject(new Error(why)))]);
  }

  initialize() {
    return this.call(
      this.conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "caddis", title: "Caddis", version: "0.2" },
      }),
    );
  }

  kill() {
    this.proc.stdin?.end();
    this.proc.kill();
  }
}

type ConfigOption = acp.SessionConfigOption & { type: "select"; currentValue?: string; options?: any[] };

function selectOptions(o: ConfigOption | undefined): { value: string; name: string; description?: string | null }[] {
  if (!o || o.type !== "select") return [];
  return (o.options ?? []).flatMap((x: any) => (Array.isArray(x?.options) ? x.options : [x]));
}

const optionByCategory = (opts: acp.SessionConfigOption[] | null | undefined, cat: string) =>
  (opts ?? []).find((o) => o.category === cat && o.type === "select") as ConfigOption | undefined;

/** JSON-RPC errors often say just "Internal error" and put the cause in `data`. */
function errorText(e: any): string {
  const msg = String(e?.message ?? e);
  const d = e?.data;
  const detail = typeof d === "string" ? d : (d?.message ?? d?.details ?? d?.error);
  return detail && !msg.includes(String(detail)) ? `${msg}: ${detail}` : msg;
}

export class AcpProvider implements AgentProvider {
  readonly id: string;

  constructor(
    readonly def: AcpAgentDef,
    private readonly mcp: McpHost,
  ) {
    this.id = `acp-${def.id}`;
  }

  /** Start the agent and open a throwaway session to learn its auth state, models and reasoning levels. */
  async discover(): Promise<ProviderInfo> {
    const { def } = this;
    const info: ProviderInfo = { id: this.id, label: def.label, enabled: false, models: [] };
    const exe = findExecutable(def.command);
    if (!exe) return { ...info, note: `${def.command} not found on PATH` };
    const dir = mkdtempSync(path.join(os.tmpdir(), "caddis-probe-"));
    const agent = new AgentProcess(exe, def, dir, {
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      sessionUpdate: () => {},
    });
    try {
      return await withTimeout(
        (async () => {
          const init = await agent.initialize();
          const who = init.agentInfo
            ? `${init.agentInfo.title ?? init.agentInfo.name} ${init.agentInfo.version}`
            : undefined;
          let session: acp.NewSessionResponse;
          try {
            session = await agent.call(agent.conn.newSession({ cwd: dir, mcpServers: [] }));
          } catch (e) {
            const m = init.authMethods?.[0];
            const hint = m?.description ?? (m ? `sign in (${m.name})` : "");
            return { ...info, note: `${errorText(e)}${hint ? ` — ${hint}` : ""}` };
          }
          const modelOpt = optionByCategory(session.configOptions, "model");
          const effortOpt = optionByCategory(session.configOptions, "thought_level");
          const efforts = selectOptions(effortOpt);
          const models: ModelInfo[] = selectOptions(modelOpt).map((o) => ({
            id: o.value,
            label: o.name,
            efforts: efforts.map((e) => e.value),
            defaultEffort: effortOpt?.currentValue,
            description: o.description ?? undefined,
          }));
          if (!models.length)
            models.push({
              id: "",
              label: `${def.label} default`,
              efforts: efforts.map((e) => e.value),
              defaultEffort: effortOpt?.currentValue,
            });
          const caps = init.agentCapabilities?.sessionCapabilities as Record<string, unknown> | undefined;
          // Don't leave the probe in the agent's session list.
          if (caps?.delete)
            await agent.call(agent.conn.deleteSession({ sessionId: session.sessionId })).catch(() => {});
          else if (caps?.close)
            await agent.call(agent.conn.closeSession({ sessionId: session.sessionId })).catch(() => {});
          return {
            ...info,
            enabled: true,
            auth: who,
            models,
            defaultModel: modelOpt?.currentValue ?? "",
            effortLabels: Object.fromEntries(efforts.map((e) => [e.value, e.name])),
          };
        })(),
        45_000,
        `waiting for ${def.label} to start`,
      );
    } catch (e) {
      return { ...info, note: errorText(e) };
    } finally {
      agent.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  start(ctx: ProviderContext): AgentRun {
    return new AcpRun(this.def, ctx, this.mcp);
  }
}

interface ToolState {
  started: boolean;
  name: string;
  input: unknown;
  /** The input the history was given at tool-start; agents often fill it in later. */
  shown?: unknown;
}

class AcpRun implements AgentRun {
  private agent?: AgentProcess;
  private sessionId?: string;
  private closed = false;
  private readonly ready: Promise<void>;
  private endpoint?: McpEndpoint;
  private readonly queue: string[] = [];
  private busy = false;
  /** Updates while `session/load` replays old history are not news. */
  private replaying = false;
  /** Canvas instructions still need to go out with the next prompt (a new conversation). */
  private needsInstructions = false;
  private turn = 0;
  private segment = 0;
  private lastKind?: "text" | "thought" | "tool";
  private readonly toolsSeen = new Map<string, ToolState>();
  private deniedNotice = false;

  constructor(
    private readonly def: AcpAgentDef,
    private readonly ctx: ProviderContext,
    mcp: McpHost,
  ) {
    this.ready = this.boot(mcp).catch((e) => this.fatal(errorText(e)));
  }

  private emit(e: ProviderEvent) {
    if (!this.closed) this.ctx.emit(e);
  }

  private fatal(error: string) {
    this.emit({ type: "fatal", error });
    this.close();
  }

  private async boot(mcp: McpHost) {
    const exe = findExecutable(this.def.command);
    if (!exe) throw new Error(`${this.def.command} not found on PATH`);
    this.endpoint = await mcp.register(this.ctx.tools);
    if (this.closed) return this.endpoint.dispose();
    const { cwd } = this.ctx.config;
    const agent = new AgentProcess(exe, this.def, cwd, {
      sessionUpdate: (n) => this.onUpdate(n),
      requestPermission: (r) => this.onPermission(r),
    });
    this.agent = agent;
    void agent.exited.then((why) => this.closed || this.fatal(why));

    const init = await agent.initialize();
    const http = Boolean(init.agentCapabilities?.mcpCapabilities?.http);
    const e = this.endpoint;
    const mcpServers: acp.McpServer[] = [
      http
        ? { type: "http", name: e.name, url: e.url, headers: [] }
        : {
            name: e.name,
            command: e.stdio.command,
            args: e.stdio.args,
            env: Object.entries(e.stdio.env).map(([name, value]) => ({ name, value })),
          },
    ];
    const caps = (init.agentCapabilities?.sessionCapabilities ?? {}) as Record<string, unknown>;

    let session: { sessionId: string; configOptions?: acp.SessionConfigOption[] | null } | undefined;
    const resumeId = this.ctx.resumeId;
    if (resumeId) {
      try {
        if (this.ctx.fork) {
          if (!caps.fork) throw new Error(`${this.def.label} can't fork a conversation`);
          session = await agent.call(agent.conn.unstable_forkSession({ sessionId: resumeId, cwd, mcpServers }));
        } else if (caps.resume) {
          await agent.call(agent.conn.resumeSession({ sessionId: resumeId, cwd, mcpServers }));
          session = { sessionId: resumeId };
        } else if (init.agentCapabilities?.loadSession) {
          this.replaying = true;
          const r = await agent.call(agent.conn.loadSession({ sessionId: resumeId, cwd, mcpServers }));
          session = { sessionId: resumeId, configOptions: r.configOptions };
        } else throw new Error(`${this.def.label} can't resume a conversation`);
      } catch (err) {
        this.emit({
          type: "notice",
          level: "info",
          text: `${this.def.label} couldn't resume its earlier conversation (${errorText(err)}), so it starts fresh.`,
        });
      } finally {
        this.replaying = false;
      }
    }
    if (!session) {
      session = await agent.call(agent.conn.newSession({ cwd, mcpServers }));
      this.needsInstructions = true;
    }
    this.sessionId = session.sessionId;
    await this.applyConfig(session.configOptions);
    this.emit({ type: "session-id", id: session.sessionId });
    void this.pump();
  }

  /** Select the session's model and reasoning level where the agent exposes them as config options. */
  private async applyConfig(opts: acp.SessionConfigOption[] | null | undefined) {
    const { model, effort } = this.ctx.config;
    const want: [string, string][] = [
      ["model", model],
      ["thought_level", effort],
    ];
    for (const [cat, value] of want) {
      const o = optionByCategory(opts, cat);
      if (!value || !o || o.currentValue === value) continue;
      if (!selectOptions(o).some((x) => x.value === value)) {
        this.emit({
          type: "notice",
          level: "error",
          text: `${this.def.label} doesn't offer ${o.name.toLowerCase()} ${value}; using ${o.currentValue}.`,
        });
        continue;
      }
      try {
        const r = await this.agent!.call(
          this.agent!.conn.setSessionConfigOption({ sessionId: this.sessionId!, configId: o.id, value }),
        );
        opts = r.configOptions ?? opts;
      } catch (err) {
        this.emit({
          type: "notice",
          level: "error",
          text: `Couldn't set ${o.name.toLowerCase()} to ${value}: ${errorText(err)}`,
        });
      }
    }
  }

  private async pump() {
    if (this.busy || !this.sessionId || this.closed || !this.queue.length) return;
    this.busy = true;
    let text = this.queue.shift()!;
    if (this.needsInstructions) {
      text = `<canvas-instructions>\n${this.ctx.systemPrompt}\n</canvas-instructions>\n\n${text}`;
      this.needsInstructions = false;
    }
    this.turn++;
    this.segment = 0;
    this.lastKind = undefined;
    const started = Date.now();
    try {
      const r = await this.agent!.call(
        this.agent!.conn.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text }] }),
      );
      this.finishTools();
      const ok = r.stopReason === "end_turn";
      const why: Record<string, string> = {
        cancelled: "interrupted",
        refusal: "the agent refused",
        max_tokens: "hit the output token limit",
        max_turn_requests: "hit the turn's request limit",
      };
      this.emit({
        type: "turn-end",
        ok,
        error: ok ? undefined : (why[r.stopReason] ?? r.stopReason),
        durationMs: Date.now() - started,
      });
    } catch (err) {
      this.finishTools();
      this.emit({ type: "turn-end", ok: false, error: errorText(err), durationMs: Date.now() - started });
    } finally {
      this.busy = false;
    }
    void this.pump();
  }

  /** Close out tool calls the agent never reported finished. */
  private finishTools() {
    for (const [id, t] of this.toolsSeen)
      if (t.started) this.emit({ type: "tool-end", id, result: "", isError: false });
    this.toolsSeen.clear();
  }

  private messageId(kind: "text" | "thought") {
    if (this.lastKind !== kind) this.segment++;
    this.lastKind = kind;
    return `${this.sessionId}:${this.turn}:${this.segment}`;
  }

  private onUpdate(n: acp.SessionNotification) {
    if (this.replaying || n.sessionId !== this.sessionId) return;
    const u = n.update as any;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text")
          this.emit({ type: "text-delta", messageId: this.messageId("text"), text: u.content.text });
        return;
      case "agent_thought_chunk":
        if (u.content?.type === "text")
          this.emit({ type: "thinking", messageId: this.messageId("thought"), text: u.content.text });
        return;
      case "tool_call":
      case "tool_call_update":
        return this.onTool(u);
    }
  }

  private onTool(u: any) {
    this.lastKind = "tool";
    const id = String(u.toolCallId);
    let t = this.toolsSeen.get(id);
    if (!t) {
      t = { started: false, name: "", input: undefined };
      this.toolsSeen.set(id, t);
    }
    if (u.name || u.title || u.kind) t.name = toolName(u, this.ctx.tools) ?? t.name;
    if (u.rawInput !== undefined && u.rawInput !== null) t.input = u.rawInput;
    if (!t.started) {
      t.started = true;
      t.shown = t.input ?? { title: u.title };
      this.emit({ type: "tool-start", id, name: t.name || "tool", input: t.shown });
    }
    if (u.status === "completed" || u.status === "failed") {
      this.toolsSeen.delete(id);
      this.emit({
        type: "tool-end",
        id,
        result: toolOutput(u),
        isError: u.status === "failed",
        input: t.input !== undefined && t.input !== t.shown ? t.input : undefined,
      });
    }
  }

  /**
   * No approval UI yet, so permission requests follow a fixed policy, like Claude's defaults:
   * reads, searches, fetches and the canvas tools are allowed, and so are edits inside the working
   * directory. Commands and anything else are refused unless `CADDIS_ACP_PERMISSIONS=all`.
   */
  private async onPermission(r: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const allow = r.options.find((o) => o.kind === "allow_once") ?? r.options.find((o) => o.kind === "allow_always");
    const reject = r.options.find((o) => o.kind === "reject_once") ?? r.options.find((o) => o.kind === "reject_always");
    const ok = this.permitted(r.toolCall);
    if (ok && allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
    if (!ok && !this.deniedNotice) {
      this.deniedNotice = true;
      this.emit({
        type: "notice",
        level: "info",
        text: `Refused ${r.toolCall.title ?? "a tool call"}: ${this.def.label} may only read, edit files in the working directory and use the canvas tools. Set CADDIS_ACP_PERMISSIONS=all to allow everything.`,
      });
    }
    return reject
      ? { outcome: { outcome: "selected", optionId: reject.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  private permitted(call: acp.ToolCallUpdate): boolean {
    if (process.env.CADDIS_ACP_PERMISSIONS === "all") return true;
    if (toolName(call, this.ctx.tools)?.startsWith(mcpToolName(""))) return true;
    switch (call.kind) {
      case "read":
      case "search":
      case "fetch":
      case "think":
        return true;
      case "edit":
      case "delete":
      case "move": {
        const raw = call.rawInput as Record<string, unknown> | undefined;
        const paths = [
          ...(call.locations ?? []).map((l) => l.path),
          ...["file_path", "filePath", "path"].map((k) => raw?.[k]).filter((p): p is string => typeof p === "string"),
        ];
        const root = path.resolve(this.ctx.config.cwd);
        return (
          paths.length > 0 &&
          paths.every((p) => {
            const rel = path.relative(root, path.resolve(root, p));
            return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
          })
        );
      }
    }
    return false;
  }

  send(text: string) {
    this.queue.push(text);
    void this.ready.then(() => this.pump());
  }

  async interrupt() {
    this.queue.length = 0;
    if (this.agent && this.sessionId) await this.agent.conn.cancel({ sessionId: this.sessionId });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.agent?.kill();
    this.endpoint?.dispose();
  }
}

const KIND_TOOL: Record<string, string> = {
  execute: "Bash",
  edit: "Edit",
  delete: "Edit",
  move: "Edit",
  read: "Read",
  search: "Grep",
  fetch: "WebFetch",
};

/** Name a tool call like Claude's tools so the history's icons and summaries apply; canvas tools get their MCP name. */
function toolName(u: { name?: string | null; title?: string | null; kind?: string | null }, tools: ToolSet) {
  for (const raw of [u.name, u.title]) {
    if (!raw) continue;
    const canvas = tools.defs.find((d) => raw === d.name || new RegExp(`(^|[_./:\\s-])${d.name}\\b`).test(raw));
    if (canvas) return mcpToolName(canvas.name);
  }
  return (u.kind && KIND_TOOL[u.kind]) || u.name || u.title || u.kind || undefined;
}

function toolOutput(u: any): string {
  const parts: string[] = [];
  for (const c of u.content ?? []) {
    if (c.type === "content") parts.push(c.content?.type === "text" ? c.content.text : `[${c.content?.type}]`);
    else if (c.type === "diff") parts.push(`edited ${c.path}`);
    else if (c.type === "terminal") parts.push("[terminal]");
  }
  if (!parts.length && u.rawOutput !== undefined && u.rawOutput !== null)
    parts.push(typeof u.rawOutput === "string" ? u.rawOutput : JSON.stringify(u.rawOutput, null, 1));
  return parts.join("\n");
}
