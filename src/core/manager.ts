import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION, type ClientMsg, type ProviderInfo, type SessionConfig } from "../shared/protocol";
import { parseArtifact } from "./artifact";
import { ClaudeProvider } from "./providers/claude";
import type { AgentProvider } from "./providers/types";
import { SessionStore, type ArtifactSource, type Client, type Session } from "./session";

/**
 * The session core: providers, the session store and per-client message
 * handling. Hosted in-process by Electron main and by the web server alike.
 */
export class SessionManager {
  readonly providers: Record<string, AgentProvider> = { claude: new ClaudeProvider() };
  readonly store: SessionStore;
  private discovery?: Promise<ProviderInfo[]>;

  constructor(
    dataDir: string,
    readonly defaultCwd = process.env.CADDIS_DEFAULT_CWD ?? os.homedir(),
    readonly platform: "web" | "electron" = "web",
  ) {
    this.store = new SessionStore(path.join(dataDir, "sessions"), (c) => this.providers[c.provider] ?? this.providers.claude);
  }

  /** Ask each provider's host for availability, auth and models (cached; retried after a failure). */
  discover(): Promise<ProviderInfo[]> {
    if (!this.discovery) {
      this.discovery = Promise.all(Object.values(this.providers).map((p) => p.discover()));
      this.discovery.then((list) => {
        if (list.some((p) => !p.enabled)) setTimeout(() => (this.discovery = undefined), 30_000);
      });
    }
    return this.discovery;
  }

  private validateConfig(c: SessionConfig, providers: ProviderInfo[]): SessionConfig {
    const info = providers.find((p) => p.id === c?.provider);
    if (!info?.enabled) throw new Error(`provider ${c?.provider} is not available${info?.note ? `: ${info.note}` : ""}`);
    const cwd = path.resolve(c.cwd?.trim().replace(/^~(?=$|\/)/, os.homedir()) || this.defaultCwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`working directory does not exist: ${cwd}`);
    const model = String(c.model ?? "");
    if (model && info.models.length && !info.models.some((m) => m.id === model)) throw new Error(`unknown model ${model}`);
    return { provider: info.id, model, effort: (c.effort ?? "") as SessionConfig["effort"], cwd };
  }

  /**
   * Open a `.caddis` artifact as a new session. It keeps its original working
   * directory when that exists on this machine, else uses the default.
   */
  async importArtifact(buf: Buffer, source?: ArtifactSource): Promise<Session> {
    const a = parseArtifact(buf);
    const orig = a.manifest.session?.config;
    const cwd = typeof orig?.cwd === "string" && existsSync(orig.cwd) && statSync(orig.cwd).isDirectory() ? orig.cwd : this.defaultCwd;
    const providers = await this.discover();
    const info = providers.find((p) => p.id === orig?.provider);
    const model = info?.models.some((m) => m.id === orig?.model) ? String(orig?.model) : "";
    const config: SessionConfig = { provider: "claude", model, effort: model ? ((orig?.effort ?? "") as SessionConfig["effort"]) : "", cwd };
    return this.store.import(a, config, source);
  }

  /** Bind a transport connection. Returns the handler for its messages and a close hook. */
  connect(client: Client) {
    let session: Session | undefined;
    const fail = (message: string) => client.send({ t: "error", message });

    this.discover().then((providers) =>
      client.send({ t: "welcome", v: PROTOCOL_VERSION, providers, defaultCwd: this.defaultCwd, platform: this.platform }),
    );

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
          const config = this.validateConfig(msg.config, await this.discover());
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
        case "artifact.export": {
          const { buffer } = await s.exportArtifact();
          return client.send({ t: "artifact.file", name: s.artifactName, data: buffer.toString("base64") });
        }
      }
    };

    return {
      receive: (msg: ClientMsg) =>
        handle(msg).catch((e: any) => fail(e?.message ?? String(e))),
      close: () => session?.detach(client),
      get session() {
        return session;
      },
    };
  }

  shutdown() {
    this.store.flushAll();
  }
}
