import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { PROTOCOL_VERSION, type ClientMsg, type ProviderInfo, type ServerMsg } from "../shared/protocol";
import { AgentLink } from "../core/agentLink";
import type { AgentProvider, ProviderContext } from "../core/providers/types";
import { startHubServer } from "./server";

const TOKEN = "test-token";
let dir: string;
let server: Awaited<ReturnType<typeof startHubServer>>;
let url: string;
const links: AgentLink[] = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "caddis-hub-test-"));
  server = await startHubServer({
    dir: path.join(dir, "hub"),
    token: TOKEN,
    name: "test hub",
    host: "127.0.0.1",
    port: 0,
    root: path.resolve("."),
    ui: path.join(dir, "no-ui"),
  });
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  for (const l of links) l.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A UI client over `/ws` that records every message. */
async function ui() {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const msgs: ServerMsg[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (raw) => {
    msgs.push(JSON.parse((raw as Buffer).toString()));
    for (const w of waiters.splice(0)) w();
  });
  await new Promise((r) => ws.once("open", r));
  const send = (m: ClientMsg) => ws.send(JSON.stringify(m));
  /** Resolves with the first message (from `from` on) matching `pred`. */
  const next = async <T extends ServerMsg["t"]>(
    t: T,
    pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true,
    from = 0,
  ): Promise<Extract<ServerMsg, { t: T }>> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const m = msgs.slice(from).find((x) => x.t === t && pred(x as any));
      if (m) return m as any;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${t}; got ${msgs.map((x) => x.t).join(",")}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 100);
      });
    }
  };
  return { ws, msgs, send, next, close: () => ws.close() };
}

/** A provider that writes `html` to the canvas each turn, recording the prompts it gets. */
function fakeProvider(html: (n: number) => string, prompts: string[], extra?: (ctx: ProviderContext) => Promise<void>) {
  const info: ProviderInfo = { id: "claude", label: "Claude", enabled: true, models: [] };
  const provider: AgentProvider = {
    discover: async () => info,
    start(ctx) {
      return {
        send(text) {
          prompts.push(text);
          void (async () => {
            const n = prompts.length;
            ctx.emit({ type: "tool-start", id: `tool${n}`, name: "mcp__canvas__resource_write", input: {} });
            const r = await ctx.tools.run("resource_write", { name: "index.html", content: html(n) });
            ctx.emit({ type: "tool-end", id: `tool${n}`, result: r.text, isError: Boolean(r.isError) });
            await extra?.(ctx);
            ctx.emit({ type: "text", messageId: `m${n}`, text: `turn ${n} done` });
            ctx.emit({ type: "turn-end", ok: true });
          })();
        },
        interrupt: async () => {},
        close() {},
      };
    },
  };
  return { provider, info };
}

async function agent(name: string, p: ReturnType<typeof fakeProvider>) {
  const link = new AgentLink({
    url,
    token: TOKEN,
    name,
    providers: { claude: p.provider },
    infos: () => [p.info],
    dataDir: path.join(dir, `agent-${name}`),
    log: () => {},
  }).start();
  links.push(link);
  for (let i = 0; i < 50 && !link.connected; i++) await new Promise((r) => setTimeout(r, 50));
  expect(link.connected).toBe(true);
  return link;
}

test("people share an artifact, prompt their own agents, hand off between agents, and restore revisions", async () => {
  // Joining needs the token.
  const matt = await ui();
  const welcome = await matt.next("welcome");
  expect(welcome.hub?.name).toBe("test hub");
  matt.send({ t: "hub.join", token: "wrong", name: "Matt" });
  await matt.next("hub.denied");
  matt.send({ t: "hub.join", token: TOKEN, name: "Matt" });
  expect((await matt.next("hub.joined")).user).toEqual({ id: "matt", name: "Matt" });

  // A project and an artifact in it.
  matt.send({ t: "project.create", name: "Demo" });
  const project = (await matt.next("project")).project;
  expect(project.name).toBe("Demo");
  matt.send({ t: "artifact.create", projectId: project.id });
  const { artifactId } = await matt.next("artifact.created");
  matt.send({ t: "hello", v: PROTOCOL_VERSION, sessionId: artifactId });
  await matt.next("session.snapshot");

  // Matt's agent runs on "his machine" (an AgentLink with a fake provider).
  const mattPrompts: string[] = [];
  const lilyPrompts: string[] = [];
  const mattAgent = await agent(
    "Matt",
    fakeProvider(
      (n) => `<h1>matt ${n}</h1>`,
      mattPrompts,
      async (ctx) => {
        if (mattPrompts.length === 2) {
          const r = await ctx.tools.run("agent_message", { to: "Lily", text: "Please add a footer." });
          expect(r.isError).toBeFalsy();
        }
      },
    ),
  );
  await matt.next("agents", (m) => m.agents.some((a) => a.label === "Matt's agent"));

  // Lily joins the same artifact.
  const lily = await ui();
  lily.send({ t: "hub.join", token: TOKEN, name: "Lily" });
  await lily.next("hub.joined");
  lily.send({ t: "hello", v: PROTOCOL_VERSION, sessionId: artifactId });
  await lily.next("session.snapshot");
  await matt.next("presence", (m) => m.users.length === 2);

  // Matt prompts his agent; both see the canvas change, attributed to his agent.
  let from = lily.msgs.length;
  matt.send({ t: "prompt", text: "Make a heading", to: { agent: mattAgent.hostId!, provider: "claude" } });
  const res = await lily.next("canvas.resource", (m) => m.resource.text === "<h1>matt 1</h1>", from);
  expect(res.resource.name).toBe("index.html");
  const reply = await lily.next(
    "history.append",
    (m) => m.item.kind === "assistant" && m.item.by?.name === "Matt's agent",
    from,
  );
  expect(reply.item.by?.owner).toBe("matt");
  await lily.next("history.append", (m) => m.item.kind === "turn", from);

  // Lily can't prompt Matt's agent; her room message reaches nobody's agent but shows up for Matt.
  lily.send({ t: "prompt", text: "hi", to: { agent: mattAgent.hostId!, provider: "claude" } });
  expect((await lily.next("error", () => true, from)).message).toMatch(/only Matt can prompt/);
  lily.send({ t: "prompt", text: "Looks great, add a footer?" });
  await matt.next("history.append", (m) => m.item.kind === "user" && m.item.by?.name === "Lily");
  expect(mattPrompts).toHaveLength(1);

  // Lily's agent connects; Matt's next turn hands work to it.
  await agent(
    "Lily",
    fakeProvider((n) => `<h1>matt 2</h1><footer>lily ${n}</footer>`, lilyPrompts),
  );
  from = matt.msgs.length;
  matt.send({
    t: "prompt",
    text: "Ask Lily's agent for the footer",
    to: { agent: mattAgent.hostId!, provider: "claude" },
  });
  await matt.next("canvas.resource", (m) => m.resource.text === "<h1>matt 2</h1><footer>lily 1</footer>", from);
  expect(mattPrompts[1]).toContain("Lily: Looks great, add a footer?");
  expect(mattPrompts[1]).toContain("From Matt to you:");
  expect(lilyPrompts[0]).toContain("From Matt's agent to you:");
  expect(lilyPrompts[0]).toContain("Please add a footer.");
  await matt.next("history.append", (m) => m.item.kind === "turn" && m.item.by?.name === "Lily's agent", from);

  // Every turn is a commit, authored by the agent.
  let revisions: { commit: string; author: string; message: string }[] = [];
  for (let i = 0; i < 40; i++) {
    from = matt.msgs.length;
    matt.send({ t: "revisions.list" });
    revisions = (await matt.next("revisions", () => true, from)).revisions;
    if (revisions.some((r) => r.author === "Lily's agent")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(revisions.map((r) => r.message)).toEqual(
    expect.arrayContaining([
      "Matt's agent: Make a heading",
      "Matt's agent: Ask Lily's agent for the footer",
      "Lily's agent: Please add a footer.",
      "Matt: Create artifact",
    ]),
  );
  const first = revisions.find((r) => r.message.includes("Make a heading"))!;
  expect(first).toBeTruthy();

  // Restoring an earlier revision puts its canvas back for everyone.
  from = lily.msgs.length;
  matt.send({ t: "revisions.restore", commit: first.commit });
  const state = await lily.next("canvas.state", () => true, from);
  expect(state.canvas.resources["index.html"].text).toBe("<h1>matt 1</h1>");

  // The project list shows the artifact with the agent's work in it.
  from = matt.msgs.length;
  matt.send({ t: "project.list" });
  const projects = (await matt.next("projects", () => true, from)).projects;
  expect(projects[0]).toMatchObject({ name: "Demo", artifacts: 1 });

  matt.close();
  lily.close();
});
