import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import type { Author, HubUser, ProviderInfo } from "../shared/protocol";
import type { AgentProvider, AgentRun, ProviderEvent } from "./providers/types";
import { canvasSystemPrompt } from "./systemPrompt";
import { TOOL_DEFS, type ToolDef, type ToolOutput, type ToolSet } from "./tools";

/**
 * The agent link: how a person's own machine lends its coding agents to a hub.
 *
 * Agents never run on the hub. Each person runs an agent host (the Caddis app,
 * or `npm run agent`) that connects to the hub's `/agent` endpoint with the
 * hub token and their name. The hub sends it turns; the host runs them with
 * the provider installed and signed in on that machine, in a working
 * directory on that machine, and calls the canvas tools back over the link.
 * Everything the agent does is attributed to "<name>'s agent".
 *
 *   host -> hub   hello, providers, event (a ProviderEvent for a turn), tool (a call)
 *   hub -> host   welcome | denied, turn, tool.result, interrupt
 */

export const AGENT_LINK_VERSION = 1;

export interface TurnContext {
  projectName: string;
  artifactTitle: string;
  /** "Matt's agent": who the agent is in this room. */
  agentLabel: string;
  from?: Author;
}

export type AgentToHub =
  | { t: "hello"; v: number; token: string; name: string; providers: ProviderInfo[]; handoffs: boolean }
  | { t: "providers"; providers: ProviderInfo[] }
  | { t: "event"; turnId: string; event: ProviderEvent }
  | { t: "tool"; turnId: string; callId: string; name: string; args: Record<string, unknown> };

export type HubToAgent =
  | { t: "welcome"; hostId: string; user: HubUser }
  | { t: "denied"; message: string }
  | { t: "turn"; turnId: string; artifactId: string; provider: string; text: string; context: TurnContext }
  | { t: "tool.result"; callId: string; output: ToolOutput }
  | { t: "interrupt"; turnId: string };

/** Tools only hub agents get; the hub runs them because they act on the room, not the canvas. */
export const ROOM_TOOL_DEFS: ToolDef[] = [
  {
    name: "room_who",
    description: "Who is here: the people viewing this canvas and the agents connected to the hub, including you.",
    shape: {},
  },
  {
    name: "agent_message",
    description:
      "Hand work to another person's agent: posts your message in the room, addressed to them, and they take a turn after yours ends. Use it when someone asks you to coordinate with another agent. Hops between agents are limited.",
    shape: {
      to: z.string().describe(`the agent's label ("Lily's agent") or its owner's name`),
      text: z.string(),
    },
  },
];

export const HUB_TOOL_DEFS = [...TOOL_DEFS, ...ROOM_TOOL_DEFS];

export function hubSystemPrompt(cwd: string, label: string) {
  return `${canvasSystemPrompt(cwd)}

Shared canvas: you are ${label}, running on your owner's machine and connected to a Caddis hub. Several people, each with their own agent, share this project and canvas. Every message tells you who it is from. Messages people and other agents posted since your last turn arrive in a <room> block: treat them as context, and act only on the message addressed to you. Only one agent works on a canvas at a time, so keep turns focused. room_who lists who is here; agent_message hands work to another agent. Your working directory is on your owner's machine and is not shared.`;
}

/** Where the host keeps provider conversations and working directories per artifact. */
interface SlotState {
  providerSessionId?: string;
  cwd: string;
}

interface Slot extends SlotState {
  run?: AgentRun;
  turnId?: string;
}

export interface AgentLinkOptions {
  /** The hub's base URL, http(s)://host:port. */
  url: string;
  token: string;
  name: string;
  providers: Record<string, AgentProvider>;
  infos: () => ProviderInfo[];
  /** Subscribe to provider info changes. */
  onProviders?: (cb: (p: ProviderInfo[]) => void) => () => void;
  /** Agent state and per-artifact working directories live here. */
  dataDir: string;
  /** Use this folder for every artifact instead of one folder each. */
  cwd?: string;
  /** Accept turns other agents hand over (default true). */
  handoffs?: boolean;
  log?: (msg: string) => void;
}

const TOOL_TIMEOUT_MS = 120_000;

export function hubSocketUrl(base: string, pathname: string) {
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = pathname;
  u.search = "";
  return u.toString();
}

export class AgentLink {
  private ws?: WebSocket;
  private closed = false;
  private delay = 500;
  private readonly slots = new Map<string, Slot>();
  private readonly turns = new Map<string, string>();
  private readonly calls = new Map<string, { resolve: (o: ToolOutput) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  private unsubscribe?: () => void;
  private readonly stateFile: string;
  private state: Record<string, SlotState> = {};
  hostId?: string;
  user?: HubUser;
  /** Last error from the hub (e.g. a wrong token). */
  error?: string;

  constructor(private readonly o: AgentLinkOptions) {
    this.stateFile = path.join(o.dataDir, "hub-agent.json");
    try {
      this.state = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch {}
  }

  get label() {
    return `${this.o.name}'s agent`;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN && Boolean(this.hostId);
  }

  start() {
    this.unsubscribe = this.o.onProviders?.((providers) => this.send({ t: "providers", providers }));
    this.connect();
    return this;
  }

  close() {
    this.closed = true;
    this.unsubscribe?.();
    this.ws?.close();
    for (const s of this.slots.values()) s.run?.close();
    this.slots.clear();
  }

  private log(msg: string) {
    (this.o.log ?? console.log)(`[caddis agent] ${msg}`);
  }

  private send(msg: AgentToHub) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private connect() {
    if (this.closed) return;
    const ws = new WebSocket(hubSocketUrl(this.o.url, "/agent"), { maxPayload: 64 * 1024 * 1024 });
    this.ws = ws;
    ws.on("open", () => {
      this.delay = 500;
      this.send({
        t: "hello",
        v: AGENT_LINK_VERSION,
        token: this.o.token,
        name: this.o.name,
        providers: this.o.infos(),
        handoffs: this.o.handoffs !== false,
      });
    });
    ws.on("message", (raw) => {
      try {
        this.receive(JSON.parse((raw as Buffer).toString()) as HubToAgent);
      } catch (e: any) {
        this.log(`bad message from hub: ${e?.message ?? e}`);
      }
    });
    ws.on("error", (e) => this.log(`hub connection: ${e.message}`));
    ws.on("close", () => {
      this.hostId = undefined;
      for (const [id, c] of this.calls) {
        clearTimeout(c.timer);
        c.resolve({ text: "Error: lost the connection to the hub", isError: true });
        this.calls.delete(id);
      }
      if (this.closed || this.error) return;
      setTimeout(() => this.connect(), (this.delay = Math.min(this.delay * 2, 10_000)));
    });
  }

  private receive(msg: HubToAgent) {
    switch (msg.t) {
      case "welcome":
        this.hostId = msg.hostId;
        this.user = msg.user;
        this.error = undefined;
        this.log(`connected to ${this.o.url} as ${this.label}`);
        return;
      case "denied":
        this.error = msg.message;
        this.log(`hub refused the agent: ${msg.message}`);
        this.ws?.close();
        return;
      case "turn":
        return this.turn(msg);
      case "tool.result": {
        const c = this.calls.get(msg.callId);
        if (!c) return;
        clearTimeout(c.timer);
        this.calls.delete(msg.callId);
        c.resolve(msg.output);
        return;
      }
      case "interrupt": {
        const key = this.turns.get(msg.turnId);
        const run = key ? this.slots.get(key)?.run : undefined;
        void run?.interrupt().catch(() => {});
        return;
      }
    }
  }

  private saveState() {
    try {
      mkdirSync(this.o.dataDir, { recursive: true });
      writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.state, null, 1));
      renameSync(`${this.stateFile}.tmp`, this.stateFile);
    } catch (e: any) {
      this.log(`could not save agent state: ${e?.message ?? e}`);
    }
  }

  private slot(artifactId: string, provider: string): Slot {
    const key = `${artifactId}:${provider}`;
    let slot = this.slots.get(key);
    if (!slot) {
      const saved = this.state[key];
      const cwd = this.o.cwd || saved?.cwd || path.join(this.o.dataDir, "hub-work", artifactId.replace(/[^\w-]/g, ""));
      mkdirSync(cwd, { recursive: true });
      slot = { cwd, providerSessionId: saved?.providerSessionId };
      this.slots.set(key, slot);
      this.state[key] = { cwd, providerSessionId: slot.providerSessionId };
      this.saveState();
    }
    return slot;
  }

  private turn(msg: Extract<HubToAgent, { t: "turn" }>) {
    const key = `${msg.artifactId}:${msg.provider}`;
    const event = (e: ProviderEvent) => this.send({ t: "event", turnId: msg.turnId, event: e });
    const provider = this.o.providers[msg.provider];
    const info = this.o.infos().find((p) => p.id === msg.provider);
    if (!provider || !info?.enabled) {
      event({ type: "fatal", error: `${msg.provider} is not available on ${this.o.name}'s machine` });
      return;
    }
    const slot = this.slot(msg.artifactId, msg.provider);
    this.turns.set(msg.turnId, key);
    slot.turnId = msg.turnId;
    if (!slot.run) {
      slot.run = provider.start({
        config: { provider: msg.provider, model: "", effort: "", cwd: slot.cwd },
        systemPrompt: hubSystemPrompt(slot.cwd, msg.context.agentLabel),
        resumeId: slot.providerSessionId,
        tools: this.tools(slot),
        emit: (e) => this.onEvent(key, slot, e),
      });
    }
    this.log(`turn in "${msg.context.artifactTitle}" (${msg.context.projectName}) with ${msg.provider}`);
    slot.run.send(msg.text);
  }

  private onEvent(key: string, slot: Slot, e: ProviderEvent) {
    if (e.type === "session-id") {
      slot.providerSessionId = e.id;
      this.state[key] = { cwd: slot.cwd, providerSessionId: e.id };
      this.saveState();
      return;
    }
    const turnId = slot.turnId;
    if (e.type === "fatal") {
      slot.run?.close();
      slot.run = undefined;
    }
    if (!turnId) return;
    this.send({ t: "event", turnId, event: e });
    if (e.type === "turn-end" || e.type === "fatal") {
      slot.turnId = undefined;
      this.turns.delete(turnId);
    }
  }

  /** The canvas and room tools, run on the hub. */
  private tools(slot: Slot): ToolSet {
    return {
      defs: HUB_TOOL_DEFS,
      run: (name, args) => {
        const turnId = slot.turnId;
        if (!turnId || !this.connected)
          return Promise.resolve({ text: "Error: not in a hub turn (the hub may be unreachable)", isError: true });
        const callId = `c${++this.seq}`;
        return new Promise<ToolOutput>((resolve) => {
          const timer = setTimeout(() => {
            this.calls.delete(callId);
            resolve({ text: "Error: the hub did not answer in time", isError: true });
          }, TOOL_TIMEOUT_MS);
          this.calls.set(callId, { resolve, timer });
          this.send({ t: "tool", turnId, callId, name, args });
        });
      },
    };
  }
}
