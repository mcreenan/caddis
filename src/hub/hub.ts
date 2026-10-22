import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import {
  PROTOCOL_VERSION,
  type AgentInfo,
  type ArtifactInfo,
  type Author,
  type ClientMsg,
  type HubUser,
  type ProviderInfo,
  type SessionConfig,
} from "../shared/protocol";
import { parseArtifact } from "../core/artifact";
import { AGENT_LINK_VERSION, type AgentToHub, type HubToAgent } from "../core/agentLink";
import { handleSessionMsg } from "../core/manager";
import { Session, type Client } from "../core/session";
import { COMMIT_RE } from "./git";
import { ID_RE, ProjectStore, gitAuthor } from "./projects";
import { Room, type AgentConn } from "./room";

/**
 * The hub: an optional server that holds projects and their artifacts, lets
 * several people work in the same artifact at once, and keeps every project
 * in git. It runs no agents itself; see src/core/agentLink.ts.
 *
 * UI clients speak the ordinary Caddis protocol over `/ws`, plus the hub
 * messages (hub.join, project.*, artifact.create/leave, revisions.*).
 */

/** Hub sessions have no local agent; the room routes prompts. */
const HUB_CONFIG: SessionConfig = { provider: "hub", model: "", effort: "", cwd: "" };
/** Commit this long after the last change, unless an agent is mid-turn. */
const COMMIT_DEBOUNCE_MS = 3000;
const NAME_MAX = 40;

export interface HubOptions {
  dir: string;
  token: string;
  name: string;
}

interface Open {
  session: Session;
  room: Room;
  projectId: string;
  /** Who changed it since the last commit, and why. */
  pending?: { author: string; notes: string[] };
  timer?: NodeJS.Timeout;
}

interface UiConn {
  client: Client;
  user?: HubUser;
  projectId?: string;
  open?: Open;
}

export const userId = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "someone";

export function checkToken(want: string, got: unknown) {
  const a = Buffer.from(want);
  const b = Buffer.from(typeof got === "string" ? got : "");
  return a.length === b.length && timingSafeEqual(a, b);
}

export class Hub {
  readonly store: ProjectStore;
  private readonly opened = new Map<string, Open>();
  private readonly agentConns = new Map<string, AgentConn>();
  private readonly uis = new Set<UiConn>();

  constructor(private readonly o: HubOptions) {
    this.store = new ProjectStore(o.dir);
  }

  get name() {
    return this.o.name;
  }

  // ================================================================ agents

  private agentInfos(): AgentInfo[] {
    const busy = new Map<string, string>();
    for (const [id, o] of this.opened) if (o.room.active) busy.set(o.room.active.agent.id, id);
    return [...this.agentConns.values()].map((a) => ({
      id: a.id,
      owner: a.user,
      label: a.label,
      providers: a.providers.map((p) => ({ id: p.id, label: p.label, enabled: p.enabled })),
      busyIn: busy.get(a.id),
    }));
  }

  private broadcastAgents() {
    const agents = this.agentInfos();
    for (const u of this.uis) if (u.user) u.client.send({ t: "agents", agents });
  }

  /** An agent host connection (`/agent`). */
  connectAgent(send: (m: HubToAgent) => void) {
    let conn: AgentConn | undefined;
    const receive = async (msg: AgentToHub) => {
      if (!conn) {
        if (msg.t !== "hello") return;
        if (msg.v !== AGENT_LINK_VERSION)
          return send({ t: "denied", message: `hub speaks agent link v${AGENT_LINK_VERSION}` });
        if (!checkToken(this.o.token, msg.token)) return send({ t: "denied", message: "wrong hub token" });
        const name = cleanName(msg.name);
        if (!name) return send({ t: "denied", message: "a name is required" });
        const user = { id: userId(name), name };
        const mine = [...this.agentConns.values()].filter((a) => a.user.id === user.id).length;
        conn = {
          id: randomUUID(),
          user,
          label: `${name}'s agent${mine ? ` (${mine + 1})` : ""}`,
          providers: cleanProviders(msg.providers),
          handoffs: msg.handoffs !== false,
          send,
        };
        this.agentConns.set(conn.id, conn);
        send({ t: "welcome", hostId: conn.id, user });
        return this.broadcastAgents();
      }
      switch (msg.t) {
        case "providers":
          conn.providers = cleanProviders(msg.providers);
          return this.broadcastAgents();
        case "event":
          for (const o of this.opened.values())
            if (o.room.active?.id === msg.turnId) o.room.onAgentEvent(msg.turnId, msg.event);
          return;
        case "tool": {
          const o = [...this.opened.values()].find((x) => x.room.active?.id === msg.turnId);
          const output = o
            ? await o.room.runTool(msg.turnId, String(msg.name), msg.args)
            : { text: "Error: your turn has ended", isError: true };
          return send({ t: "tool.result", callId: msg.callId, output });
        }
      }
    };
    return {
      receive: (msg: AgentToHub) => receive(msg).catch((e) => console.warn("[hub] agent message:", e)),
      close: () => {
        if (!conn) return;
        this.agentConns.delete(conn.id);
        for (const o of this.opened.values()) o.room.agentGone(conn.id);
        this.broadcastAgents();
      },
    };
  }

  // ================================================================ artifacts

  private open(artifactId: string): Open | undefined {
    let o = this.opened.get(artifactId);
    if (o) return o;
    const projectId = this.store.projectOf(artifactId);
    const file = this.store.stateFile(artifactId);
    if (!projectId || !existsSync(file)) return undefined;
    const room = this.newRoom(artifactId);
    const session = Session.load(file, () => room);
    if (!session) return undefined;
    return this.track(session, room, projectId);
  }

  private newRoom(artifactId: string): Room {
    const room: Room = new Room(artifactId, {
      agent: (id) => this.agentConns.get(id),
      agents: () => [...this.agentConns.values()],
      viewers: () => [...(this.opened.get(artifactId)?.session.clients ?? [])],
      context: () => {
        const o = this.opened.get(artifactId);
        return {
          projectName: o ? (this.store.info(o.projectId)?.name ?? "") : "",
          artifactTitle: o ? o.session.title : "",
        };
      },
      onTurn: (agent, active, request) => {
        const o = this.opened.get(artifactId);
        if (o) {
          // One commit per turn: whatever came before it, then the turn's own changes.
          if (o.pending || !active) void this.commit(o).catch((e) => console.warn("[hub] commit failed:", e));
          if (active) o.pending = { author: agent.label, notes: request ? [firstLine(request)] : [] };
        }
        this.broadcastAgents();
      },
    });
    return room;
  }

  private track(session: Session, room: Room, projectId: string): Open {
    room.bind(session);
    const o: Open = { session, room, projectId };
    session.onChange = () => this.commitSoon(o);
    this.opened.set(session.id, o);
    return o;
  }

  private async createArtifact(projectId: string, by: HubUser, from?: Buffer, name?: string) {
    if (!this.store.has(projectId)) throw new Error("no such project");
    const id = randomUUID();
    const room = this.newRoom(id);
    const session = from
      ? Session.fromArtifact(id, parseArtifact(from), HUB_CONFIG, this.store.stateDir, room, { name })
      : Session.create(id, HUB_CONFIG, this.store.stateDir, room);
    this.store.adopt(projectId, id);
    const o = this.track(session, room, projectId);
    this.touch(o, by.name, from ? `Import ${name ?? "an artifact"}` : "Create artifact");
    await this.commit(o);
    return o;
  }

  /** Remember who changed an artifact (and why) for its next commit. */
  private touch(o: Open, author: string, note?: string) {
    o.pending ??= { author, notes: [] };
    o.pending.author = author;
    if (note && !o.pending.notes.includes(note)) o.pending.notes.push(note);
  }

  private commitSoon(o: Open, ms = COMMIT_DEBOUNCE_MS) {
    clearTimeout(o.timer);
    if (o.room.busy) return; // the turn's end commits
    o.timer = setTimeout(() => void this.commit(o).catch((e) => console.warn("[hub] commit failed:", e)), ms);
  }

  /** Commit the artifact as it is now, attributed to whoever changed it since the last commit. */
  private async commit(o: Open) {
    clearTimeout(o.timer);
    const p = o.pending ?? { author: "Caddis hub", notes: [] };
    o.pending = undefined;
    const title = o.session.title;
    const msg = p.notes.length ? `${p.author}: ${p.notes.join("; ")}`.slice(0, 200) : `${p.author}: update ${title}`;
    const commit = await this.store.commitArtifact(o.projectId, o.session.state, msg, gitAuthor(p.author));
    if (commit) this.sendProject(o.projectId);
    return commit;
  }

  /** Commit everything still pending (shutdown). */
  async flush() {
    for (const o of this.opened.values()) {
      o.session.flush();
      if (o.pending) await this.commit(o).catch(() => {});
    }
  }

  private artifactInfos(projectId: string): ArtifactInfo[] {
    return this.store.artifacts(projectId).map((a) => {
      const o = this.opened.get(a.id);
      return o ? { ...a, title: o.session.title, mode: o.session.state.canvas.mode } : a;
    });
  }

  private projectMsg(projectId: string) {
    const project = this.store.info(projectId);
    return project ? ({ t: "project", project, artifacts: this.artifactInfos(projectId) } as const) : undefined;
  }

  private sendProject(projectId: string) {
    const msg = this.projectMsg(projectId);
    if (msg) for (const u of this.uis) if (u.projectId === projectId) u.client.send(msg);
  }

  private sendPresence(o: Open) {
    const users = [...new Map([...o.session.clients].flatMap((c) => (c.user ? [[c.user.id, c.user]] : []))).values()];
    o.session.broadcast({ t: "presence", users: users.map((u) => ({ id: u.id, name: u.name })) });
  }

  // ================================================================ UI clients

  connectClient(client: Client) {
    const ui: UiConn = { client };
    this.uis.add(ui);
    const fail = (message: string) => client.send({ t: "error", message });
    client.send({
      t: "welcome",
      v: PROTOCOL_VERSION,
      providers: [],
      defaultCwd: "",
      platform: "web",
      hub: { name: this.o.name },
    });

    const leave = () => {
      const o = ui.open;
      if (!o) return;
      ui.open = undefined;
      o.session.detach(client);
      this.sendPresence(o);
    };

    const handle = async (msg: ClientMsg) => {
      if (msg.t === "hub.join") {
        if (!checkToken(this.o.token, msg.token))
          return client.send({ t: "hub.denied", message: "Wrong access token." });
        const name = cleanName(msg.name);
        if (!name) return client.send({ t: "hub.denied", message: "Enter your name." });
        ui.user = { id: userId(name), name };
        client.user = { ...ui.user, kind: "user" } satisfies Author;
        return client.send({ t: "hub.joined", user: ui.user, agents: this.agentInfos() });
      }
      const user = ui.user;
      if (!user) return msg.t.startsWith("frame.") || msg.t === "viewport" ? undefined : fail("join the hub first");

      switch (msg.t) {
        case "hello": {
          if (msg.v !== PROTOCOL_VERSION) return fail(`protocol mismatch: hub speaks v${PROTOCOL_VERSION}`);
          const o = msg.sessionId && ID_RE.test(msg.sessionId) ? this.open(msg.sessionId) : undefined;
          if (!o) return client.send({ t: "session.none", sessionId: msg.sessionId });
          leave();
          ui.projectId = o.projectId;
          ui.open = o;
          client.send(this.projectMsg(o.projectId)!);
          o.session.attach(client);
          return this.sendPresence(o);
        }
        case "project.list":
          return client.send({ t: "projects", projects: this.store.list() });
        case "project.create": {
          const p = await this.store.create(msg.name, user);
          for (const u of this.uis) if (u.user) u.client.send({ t: "projects", projects: this.store.list() });
          leave();
          ui.projectId = p.id;
          return client.send(this.projectMsg(p.id)!);
        }
        case "project.open": {
          const m = this.projectMsg(String(msg.projectId));
          if (!m) return fail("no such project");
          leave();
          ui.projectId = m.project.id;
          return client.send(m);
        }
        case "artifact.create": {
          const o = await this.createArtifact(String(msg.projectId), user);
          return client.send({ t: "artifact.created", projectId: o.projectId, artifactId: o.session.id });
        }
        case "artifact.import": {
          if (!ui.projectId) return fail("open a project first");
          const name = typeof msg.name === "string" ? msg.name.slice(0, 200) : undefined;
          const o = await this.createArtifact(ui.projectId, user, Buffer.from(String(msg.data ?? ""), "base64"), name);
          return client.send({ t: "artifact.opened", sessionId: o.session.id });
        }
        case "artifact.leave":
          return leave();
        case "session.start":
          return fail("on a hub, create an artifact in a project instead");
      }

      const o = ui.open;
      if (!o) return msg.t.startsWith("frame.") || msg.t === "viewport" ? undefined : fail("open an artifact first");
      const s = o.session;
      switch (msg.t) {
        case "prompt": {
          const text = String(msg.text ?? "").trim();
          if (!text) return;
          const by = client.user!;
          if (!msg.to) {
            this.touch(o, user.name, "message");
            return s.prompt(text, { by, room: true });
          }
          const agent = this.agentConns.get(String(msg.to.agent));
          if (!agent) return fail("that agent isn't connected");
          if (agent.user.id !== user.id) return fail(`only ${agent.user.name} can prompt ${agent.label}`);
          return s.prompt(text, {
            by,
            to: { agent: agent.id, provider: String(msg.to.provider ?? "") },
            toLabel: agent.label,
          });
        }
        case "interrupt": {
          const a = o.room.active;
          if (!a) return;
          if (a.agent.user.id !== user.id && a.from?.id !== user.id)
            return fail(`only ${a.agent.user.name} or whoever asked can stop ${a.agent.label}`);
          return o.room.interrupt();
        }
        case "revisions.list":
          return client.send({ t: "revisions", revisions: await this.store.revisions(o.projectId, s.id) });
        case "revisions.restore": {
          const commit = String(msg.commit ?? "");
          if (!COMMIT_RE.test(commit)) return fail("bad revision");
          if (o.room.busy) return fail("wait for the agent's turn to finish before restoring");
          const r = await this.store.readRevision(o.projectId, s.id, commit);
          s.replaceCanvas(`restore ${commit.slice(0, 7)}`, r.mode, r.resources, r.data);
          this.touch(o, user.name, `Restore ${commit.slice(0, 7)}`);
          await this.commit(o);
          return client.send({ t: "revisions", revisions: await this.store.revisions(o.projectId, s.id) });
        }
      }
      if (MUTATING.has(msg.t)) this.touch(o, user.name, NOTES[msg.t]);
      await handleSessionMsg(s, client, msg);
    };

    return {
      receive: (msg: ClientMsg) => handle(msg).catch((e: any) => fail(e?.message ?? String(e))),
      close: () => {
        leave();
        this.uis.delete(ui);
      },
    };
  }
}

/** Client messages that change an artifact, for commit attribution. */
const MUTATING = new Set<ClientMsg["t"]>([
  "frame.data",
  "frame.chrome",
  "chrome.set",
  "chrome.reset",
  "undo",
  "redo",
  "canvas.clear",
  "title.set",
]);
const NOTES: Partial<Record<ClientMsg["t"], string>> = {
  undo: "undo",
  redo: "redo",
  "canvas.clear": "clear canvas",
  "title.set": "rename",
};

const firstLine = (t: string) => {
  const l = t.split("\n")[0].trim();
  return l.length > 72 ? `${l.slice(0, 72)}…` : l;
};

function cleanName(n: unknown) {
  return (typeof n === "string" ? n : "")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim()
    .slice(0, NAME_MAX);
}

function cleanProviders(ps: unknown): ProviderInfo[] {
  if (!Array.isArray(ps)) return [];
  return ps
    .filter((p) => p && typeof p.id === "string")
    .slice(0, 20)
    .map((p) => ({
      id: String(p.id).slice(0, 64),
      label: String(p.label ?? p.id).slice(0, 64),
      enabled: Boolean(p.enabled),
      models: [],
    }));
}
