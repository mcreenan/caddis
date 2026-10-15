import { existsSync, mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION, type ClientMsg, type ProviderInfo, type SessionConfig } from "../shared/protocol";
import { parseArtifact } from "./artifact";
import { McpHost } from "./mcpHttp";
import { AcpProvider, KNOWN_ACP_AGENTS, loadCustomAcpAgents } from "./providers/acp";
import { ClaudeProvider } from "./providers/claude";
import { CodexProvider } from "./providers/codex";
import { findExecutable } from "./providers/exec";
import type { AgentProvider } from "./providers/types";
import { SessionStore, type ArtifactSource, type Client, type Session } from "./session";

/**
 * The session core: providers, the session store and per-client message
 * handling. Hosted in-process by Electron main and by the web server alike.
 */
export class SessionManager {
  readonly providers: Record<string, AgentProvider>;
  readonly store: SessionStore;
  private readonly mcp = new McpHost();
  /** Latest info per provider; placeholders (`pending`) until its discovery finishes. */
  private readonly infos = new Map<string, ProviderInfo>();
  private readonly discovering = new Map<string, Promise<ProviderInfo>>();
  private readonly clients = new Set<Client>();
  private readonly labels = new Map<string, string>();

  constructor(
    dataDir: string,
    /** Empty: each new session gets its own temporary directory. */
    readonly defaultCwd = process.env.CADDIS_DEFAULT_CWD ?? "",
    readonly platform: "web" | "electron" = "web",
  ) {
    this.providers = { claude: new ClaudeProvider(), codex: new CodexProvider(this.mcp) };
    this.labels.set("claude", "Claude");
    this.labels.set("codex", "Codex");
    // Known ACP agents are offered only when installed; declared ones always (their errors are useful).
    const custom = loadCustomAcpAgents(dataDir);
    for (const err of custom.errors) console.warn(`[caddis] ACP agents: ${err}`);
    const known = KNOWN_ACP_AGENTS.filter((a) => findExecutable(a.command));
    for (const def of [...known.filter((k) => !custom.agents.some((c) => c.id === k.id)), ...custom.agents]) {
      const p = new AcpProvider(def, this.mcp);
      this.providers[p.id] = p;
      this.labels.set(p.id, def.label);
    }
    for (const id of Object.keys(this.providers))
      this.infos.set(id, { id, label: this.labels.get(id)!, enabled: false, pending: true, models: [] });
    this.store = new SessionStore(
      path.join(dataDir, "sessions"),
      (c) => this.providers[c.provider] ?? missingProvider(c.provider),
    );
  }

  private snapshot = () => [...this.infos.values()];

  private broadcastProviders() {
    const providers = this.snapshot();
    for (const c of this.clients) c.send({ t: "providers", providers });
  }

  /** Ask one provider's host for availability, auth and models (cached; retried 30 s after a failure). */
  private discoverOne(id: string): Promise<ProviderInfo> {
    let p = this.discovering.get(id);
    if (!p) {
      const done = (info: ProviderInfo) => {
        this.infos.set(id, info);
        this.broadcastProviders();
        if (!info.enabled) setTimeout(() => this.discovering.delete(id), 30_000);
        return info;
      };
      p = this.providers[id]
        .discover(() => this.broadcastProviders())
        .catch((e: any): ProviderInfo => ({ ...this.infos.get(id)!, pending: false, note: e?.message ?? String(e) }))
        .then(done);
      this.discovering.set(id, p);
    }
    return p;
  }

  /** Start discovery for every provider; resolves when all have answered. */
  discover(): Promise<ProviderInfo[]> {
    return Promise.all(Object.keys(this.providers).map((id) => this.discoverOne(id)));
  }

  private async validateConfig(c: SessionConfig): Promise<SessionConfig> {
    const info = this.providers[c?.provider] ? await this.discoverOne(c.provider) : undefined;
    if (!info?.enabled)
      throw new Error(`provider ${c?.provider} is not available${info?.note ? `: ${info.note}` : ""}`);
    const model = String(c.model ?? "");
    if (model && info.models.length && !info.models.some((m) => m.id === model))
      throw new Error(`unknown model ${model}`);
    const dir = c.cwd?.trim() || this.defaultCwd;
    const cwd = dir ? path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir())) : this.tempCwd();
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`working directory does not exist: ${cwd}`);
    const effort = String(c.effort ?? "");
    return { provider: info.id, model, effort, cwd };
  }

  private tempCwd() {
    return mkdtempSync(path.join(os.tmpdir(), "caddis-"));
  }

  /**
   * Open a `.caddis` artifact as a new session. It keeps its original working
   * directory when that exists on this machine, else uses the default.
   */
  async importArtifact(buf: Buffer, source?: ArtifactSource): Promise<Session> {
    const a = parseArtifact(buf);
    const orig = a.manifest.session?.config;
    const cwd =
      typeof orig?.cwd === "string" && existsSync(orig.cwd) && statSync(orig.cwd).isDirectory()
        ? orig.cwd
        : this.defaultCwd || this.tempCwd();
    // Keep the artifact's agent when it's available here, else fall back to Claude.
    const want = typeof orig?.provider === "string" && this.providers[orig.provider] ? orig.provider : "claude";
    let info = await this.discoverOne(want);
    if (!info.enabled && want !== "claude") info = await this.discoverOne("claude");
    const model =
      info.id === orig?.provider && info.models.some((m) => m.id === orig?.model) ? String(orig?.model) : "";
    const config: SessionConfig = {
      provider: info.id,
      model,
      effort: model ? String(orig?.effort ?? "") : "",
      cwd,
    };
    return this.store.import(a, config, source);
  }

  /** Bind a transport connection. Returns the handler for its messages and a close hook. */
  connect(client: Client) {
    let session: Session | undefined;
    const fail = (message: string) => client.send({ t: "error", message });
    this.clients.add(client);

    // Welcome at once; providers still being asked arrive in later `providers` messages.
    void this.discover();
    client.send({
      t: "welcome",
      v: PROTOCOL_VERSION,
      providers: this.snapshot(),
      defaultCwd: this.defaultCwd,
      platform: this.platform,
    });

    const handle = async (msg: ClientMsg) => {
      switch (msg.t) {
        case "hello": {
          if (msg.v !== PROTOCOL_VERSION) return fail(`protocol mismatch: core speaks v${PROTOCOL_VERSION}`);
          const s = msg.sessionId ? this.store.get(msg.sessionId) : undefined;
          if (!s) return client.send({ t: "session.none", sessionId: msg.sessionId });
          session?.detach(client);
          session = s;
          s.attach(client);
          return;
        }
        case "session.start": {
          if (session) return fail("this window already has a session");
          const config = await this.validateConfig(msg.config);
          session = this.store.create(config);
          session.attach(client);
          session.prompt(msg.prompt);
          return;
        }
        case "artifact.import": {
          const name = typeof msg.name === "string" ? msg.name.slice(0, 200) : undefined;
          const s = await this.importArtifact(Buffer.from(String(msg.data ?? ""), "base64"), { name });
          return client.send({ t: "artifact.opened", sessionId: s.id });
        }
      }
      // Frame reports from a window without a session are harmless; drop them.
      if (!session) return msg.t.startsWith("frame.") || msg.t === "viewport" ? undefined : fail("no session");
      const s = session;
      switch (msg.t) {
        case "prompt":
          return s.prompt(String(msg.text ?? ""));
        case "interrupt":
          return void s.interrupt();
        case "viewport":
          return s.setViewport(Number(msg.width) || 0, Number(msg.height) || 0);
        case "frame.ready":
          return s.onFrameReady(client, msg.rev);
        case "frame.applied":
          return s.onApplied({ rev: msg.rev, errors: msg.errors ?? [], warnings: msg.warnings ?? [], verified: true });
        case "frame.console":
          return s.onConsole(msg.entries ?? []);
        case "frame.result":
          return s.onFrameResult(msg.requestId, msg.result);
        case "frame.stats":
          return s.onStats(msg.stats);
        case "frame.data":
          if (msg.deleted) s.dataDelete(msg.key, "canvas", client);
          else s.dataSet(msg.key, msg.value, "canvas", client);
          return;
        case "frame.emit":
          return s.emit(msg.name, msg.payload);
        case "frame.chrome": {
          let result;
          try {
            if (msg.reset) {
              s.chromeReset(msg.component);
              result = s.chromeSet(msg.component, {}, "canvas");
            } else result = s.chromeSet(msg.component, msg.props ?? {}, "canvas");
          } catch (e: any) {
            result = { error: e?.message ?? String(e) };
          }
          return client.send({ t: "frame.chrome.result", requestId: msg.requestId, result });
        }
        case "chrome.set":
          s.chromeSet(msg.component, msg.props ?? {}, "user");
          return;
        case "chrome.reset":
          return s.chromeReset(msg.component);
        case "undo":
          return s.undo();
        case "redo":
          return s.redo();
        case "canvas.clear":
          return s.clearCanvas();
        case "canvas.reload":
          return void s.reload();
        case "title.set":
          return void s.setTitle(msg.title, "user");
        case "artifact.export": {
          const { buffer } = await s.exportArtifact();
          return client.send({ t: "artifact.file", name: s.artifactName, data: buffer.toString("base64") });
        }
      }
    };

    return {
      receive: (msg: ClientMsg) => handle(msg).catch((e: any) => fail(e?.message ?? String(e))),
      close: () => {
        this.clients.delete(client);
        session?.detach(client);
      },
      get session() {
        return session;
      },
    };
  }

  shutdown() {
    this.store.flushAll();
    this.mcp.close();
  }
}

/** A session whose agent isn't installed (or configured) on this machine. */
function missingProvider(id: string): AgentProvider {
  const why = `the ${id} agent is not available on this machine`;
  return {
    discover: async () => ({ id, label: id, enabled: false, models: [], note: why }),
    start: (ctx) => {
      queueMicrotask(() => ctx.emit({ type: "fatal", error: why }));
      return { send() {}, interrupt: async () => {}, close() {} };
    },
  };
}
