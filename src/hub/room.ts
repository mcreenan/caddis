import { z } from "zod";
import type { Author, HistoryItem, HubUser, ProviderInfo } from "../shared/protocol";
import { ROOM_TOOL_DEFS, type HubToAgent, type TurnContext } from "../core/agentLink";
import type { AgentProvider, AgentRun, ProviderContext, ProviderEvent, TurnMeta } from "../core/providers/types";
import type { Client, Session } from "../core/session";
import { TOOL_DEFS, type ToolOutput } from "../core/tools";

/**
 * A room is one artifact's shared conversation on the hub. It stands in for
 * the session's agent provider: prompts addressed to an agent are queued and
 * sent, one turn at a time, to the agent host on that person's machine.
 * Events coming back are attributed to "<name>'s agent", and tool calls run
 * here against the shared session.
 */

/** Consecutive agent-to-agent hand-offs allowed before a person has to step in. */
export const MAX_AGENT_HOPS = 4;
/** Room messages given to an agent that hasn't taken a turn here since the hub started. */
const FIRST_CONTEXT = 20;
const CONTEXT_LINES = 40;
const LINE_MAX = 400;

/** An agent host connected to the hub. */
export interface AgentConn {
  id: string;
  user: HubUser;
  label: string;
  providers: ProviderInfo[];
  handoffs: boolean;
  send(msg: HubToAgent): void;
}

export interface RoomHost {
  agent(id: string): AgentConn | undefined;
  agents(): AgentConn[];
  viewers(): Client[];
  context(): Omit<TurnContext, "agentLabel" | "from">;
  /** A turn started (with the message that asked for it) or ended; the hub commits at both. */
  onTurn(agent: AgentConn, active: boolean, request?: string): void;
}

interface Turn {
  id: string;
  agent: AgentConn;
  provider: string;
  text: string;
  from?: Author;
  /** Index of the message that asked for this turn. */
  at: number;
}

const agentAuthor = (a: AgentConn): Author => ({ id: a.id, name: a.label, kind: "agent", owner: a.user.id });

/** The provider an agent uses when someone hands it work without choosing one. */
export function defaultProvider(a: AgentConn) {
  const ok = a.providers.filter((p) => p.enabled);
  return (ok.find((p) => p.id === "claude") ?? ok[0])?.id;
}

let turnSeq = 0;

export class Room implements AgentProvider {
  private session!: Session;
  private ctx?: ProviderContext;
  private queue: Turn[] = [];
  active?: Turn;
  private hops = 0;
  /** agent id -> history length when its last turn ended */
  private readonly seen = new Map<string, number>();

  constructor(
    readonly artifactId: string,
    private readonly host: RoomHost,
  ) {}

  bind(session: Session) {
    this.session = session;
    // Frame requests (screenshots, eval) go to the acting agent's owner when they are watching.
    session.viewerFor = (ready) => {
      const owner = this.active?.agent.user.id;
      return owner ? ready.find((c) => c.user?.id === owner) : undefined;
    };
  }

  get busy() {
    return Boolean(this.active);
  }

  async discover(): Promise<ProviderInfo> {
    return { id: "hub", label: "Hub", enabled: true, models: [] };
  }

  start(ctx: ProviderContext): AgentRun {
    this.ctx = ctx;
    return {
      send: (text, meta) => this.enqueue(text, meta),
      interrupt: async () => this.interrupt(),
      close: () => {},
    };
  }

  private emit(e: ProviderEvent) {
    this.ctx?.emit(e);
  }

  /** Refuse a prompt the session already shows: a notice, and a failed turn so its status settles. */
  private refuse(error: string, by?: Author) {
    this.emit({ type: "notice", level: "error", text: error, ...(by && { by }) });
    if (!this.active) this.emit({ type: "turn-end", ok: false, error });
  }

  private enqueue(text: string, meta?: TurnMeta) {
    const at = this.session.state.history.length - 1;
    const agent = meta?.to && this.host.agent(meta.to.agent);
    if (!agent) return this.refuse("That agent isn't connected to the hub any more.");
    const from = meta?.by;
    if (from?.kind === "user" && from.id !== agent.user.id)
      return this.refuse(`Only ${agent.user.name} can prompt ${agent.label}.`);
    if (from?.kind === "agent") {
      if (!agent.handoffs) return this.refuse(`${agent.label} doesn't accept work from other agents.`);
      if (++this.hops > MAX_AGENT_HOPS)
        return this.refuse(`Stopped after ${MAX_AGENT_HOPS} hand-offs between agents; someone needs to step in.`);
    } else this.hops = 0;
    const provider = meta!.to!.provider || defaultProvider(agent);
    if (!provider || !agent.providers.some((p) => p.id === provider && p.enabled))
      return this.refuse(`${agent.label} can't run ${provider ?? "any agent"} right now.`);
    this.queue.push({ id: `t${++turnSeq}-${Date.now().toString(36)}`, agent, provider, text, from, at });
    if (this.active) this.emit({ type: "notice", level: "info", text: `Queued for ${agent.label}.` });
    this.pump();
  }

  private pump(): void {
    if (this.active) return;
    const turn = this.queue.shift();
    if (!turn) return;
    if (!this.host.agent(turn.agent.id)) {
      this.refuse(`${turn.agent.label} disconnected before its turn.`);
      return this.pump();
    }
    this.active = turn;
    this.emit({ type: "busy", detail: turn.agent.label });
    const asked = this.session.state.history[turn.at];
    this.host.onTurn(turn.agent, true, asked?.kind === "user" ? asked.text : undefined);
    turn.agent.send({
      t: "turn",
      turnId: turn.id,
      artifactId: this.artifactId,
      provider: turn.provider,
      text: this.compose(turn),
      context: { ...this.host.context(), agentLabel: turn.agent.label, from: turn.from },
    });
  }

  /** The prompt as the agent sees it: room messages since its last turn, then who is asking. */
  private compose(turn: Turn) {
    const history = this.session.state.history;
    const since = this.seen.get(turn.agent.id) ?? Math.max(0, turn.at - FIRST_CONTEXT);
    const lines = history
      .slice(since, turn.at)
      .filter(
        (h): h is Extract<HistoryItem, { kind: "user" | "assistant" }> =>
          (h.kind === "user" || h.kind === "assistant") && h.by?.id !== turn.agent.id,
      )
      .map((h) => {
        const who = h.by?.name ?? (h.kind === "user" ? "Someone" : "An agent");
        const to = h.kind === "user" && h.to ? ` (to ${h.to})` : "";
        const text = h.text.replace(/\s+/g, " ").trim();
        return `${who}${to}: ${text.length > LINE_MAX ? `${text.slice(0, LINE_MAX)}…` : text}`;
      })
      .slice(-CONTEXT_LINES);
    const { projectName, artifactTitle } = this.host.context();
    const room = lines.length
      ? `<room project="${attr(projectName)}" canvas="${attr(artifactTitle)}" note="messages since your last turn">\n${lines.join("\n")}\n</room>\n\n`
      : "";
    return `${room}From ${turn.from?.name ?? "someone"} to you:\n${turn.text}`;
  }

  /** An event from the agent host running `turnId`. */
  onAgentEvent(turnId: string, e: ProviderEvent) {
    const turn = this.active;
    if (!turn || turn.id !== turnId) return;
    const by = agentAuthor(turn.agent);
    const id = (s: string) => `${turnId}:${s}`;
    switch (e.type) {
      case "session-id":
      case "busy":
        return;
      case "text-delta":
      case "text":
      case "thinking":
        return this.emit({ ...e, messageId: id(e.messageId), by });
      case "tool-start":
      case "tool-end":
        return this.emit({ ...e, id: id(e.id), by });
      case "notice":
        return this.emit({ ...e, by });
      case "turn-end":
        this.emit({ ...e, by });
        return this.finish();
      case "fatal":
        this.emit({ type: "notice", level: "error", text: e.error, by });
        this.emit({ type: "turn-end", ok: false, error: e.error, by });
        return this.finish();
    }
  }

  private finish() {
    const turn = this.active;
    if (!turn) return;
    this.seen.set(turn.agent.id, this.session.state.history.length);
    this.active = undefined;
    this.host.onTurn(turn.agent, false);
    this.pump();
  }

  /** An agent host went away: end its turn and drop its queued ones. */
  agentGone(agentId: string) {
    const dropped = this.queue.filter((t) => t.agent.id === agentId);
    this.queue = this.queue.filter((t) => t.agent.id !== agentId);
    if (this.active?.agent.id === agentId) {
      const by = agentAuthor(this.active.agent);
      this.emit({ type: "turn-end", ok: false, error: `${this.active.agent.label} disconnected`, by });
      this.finish();
    }
    if (dropped.length)
      this.emit({
        type: "notice",
        level: "error",
        text: `${dropped[0].agent.label} disconnected; dropped ${dropped.length} queued turn(s).`,
      });
  }

  interrupt() {
    const turn = this.active;
    if (turn) turn.agent.send({ t: "interrupt", turnId: turn.id });
  }

  /** A tool call from the agent running `turnId`. */
  async runTool(turnId: string, name: string, args: unknown): Promise<ToolOutput> {
    const turn = this.active;
    if (!turn || turn.id !== turnId) return { text: "Error: your turn in this canvas has ended", isError: true };
    const def = [...TOOL_DEFS, ...ROOM_TOOL_DEFS].find((d) => d.name === name);
    if (!def) return { text: `unknown tool ${name}`, isError: true };
    const parsed = z.object(def.shape).safeParse(args ?? {});
    if (!parsed.success) return { text: `Invalid arguments: ${z.prettifyError(parsed.error)}`, isError: true };
    const a = parsed.data as Record<string, any>;
    if (name === "room_who") return { text: this.who(turn) };
    if (name === "agent_message") return this.handOff(turn, String(a.to), String(a.text));
    return this.ctx!.tools.run(name, a);
  }

  private who(turn: Turn) {
    const people = [...new Map(this.host.viewers().flatMap((c) => (c.user ? [[c.user.id, c.user.name]] : [])))];
    const agents = this.host.agents().map((a) => {
      const you = a.id === turn.agent.id ? " (you)" : "";
      const ps = a.providers.filter((p) => p.enabled).map((p) => p.label);
      return `- ${a.label}${you}: ${ps.join(", ") || "no agents available"}${a.handoffs ? "" : "; doesn't accept hand-offs"}`;
    });
    return [
      `Viewing this canvas: ${people.map(([, n]) => n).join(", ") || "nobody"}`,
      `Agents connected to the hub:\n${agents.join("\n")}`,
    ].join("\n");
  }

  private handOff(turn: Turn, to: string, text: string): ToolOutput {
    const want = to.trim().toLowerCase();
    const target = this.host
      .agents()
      .find(
        (a) =>
          a.label.toLowerCase() === want ||
          a.user.name.toLowerCase() === want ||
          a.label.toLowerCase().startsWith(want),
      );
    if (!target) return { text: `No connected agent matches "${to}". room_who lists them.`, isError: true };
    if (target.id === turn.agent.id) return { text: "That's you.", isError: true };
    if (!target.handoffs) return { text: `${target.label} doesn't accept hand-offs.`, isError: true };
    if (this.hops >= MAX_AGENT_HOPS)
      return { text: `Hand-off limit (${MAX_AGENT_HOPS}) reached; ask a person to continue.`, isError: true };
    const provider = defaultProvider(target);
    if (!provider) return { text: `${target.label} has no agent available.`, isError: true };
    if (!text.trim()) return { text: "Say what you want them to do.", isError: true };
    this.session.prompt(text.trim(), {
      by: agentAuthor(turn.agent),
      to: { agent: target.id, provider },
      toLabel: target.label,
    });
    return { text: `Sent to ${target.label}. It takes its turn after yours ends.` };
  }
}

const attr = (s: string) => s.replace(/["<>&]/g, " ");
