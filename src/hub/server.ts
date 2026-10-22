import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMsg, ServerMsg } from "../shared/protocol";
import type { AgentToHub } from "../core/agentLink";
import type { Client } from "../core/session";
import { createWebHandler, sameOrigin } from "../core/web";
import { Hub, type HubOptions } from "./hub";

export interface HubServerOptions extends HubOptions {
  host: string;
  port: number;
  /** Repo root (for the canvas frame files) and the built renderer. */
  root: string;
  ui: string;
}

/**
 * HTTP + WebSocket front for a Hub: the browser UI, `/ws` for UI clients
 * (Caddis protocol) and `/agent` for agent hosts (src/core/agentLink.ts).
 */
export async function startHubServer(o: HubServerOptions) {
  const hub = new Hub(o);
  const server = http.createServer(createWebHandler(o.root, o.ui, () => ({ ok: true, hub: hub.name })));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://x");
    if (pathname !== "/ws" && pathname !== "/agent") return socket.destroy();
    if (!sameOrigin(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => (pathname === "/ws" ? onClient(ws) : onAgent(ws)));
  });

  let nextId = 0;
  const parse = <T>(raw: unknown): T | undefined => {
    try {
      return JSON.parse((raw as Buffer).toString()) as T;
    } catch {
      return undefined;
    }
  };

  function onClient(ws: WebSocket) {
    const client: Client = {
      id: `hub-${++nextId}`,
      kind: "web",
      send: (msg: ServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)),
    };
    const conn = hub.connectClient(client);
    ws.on("message", (raw) => {
      const msg = parse<ClientMsg>(raw);
      if (msg) void conn.receive(msg);
      else client.send({ t: "error", message: "bad json" });
    });
    ws.on("close", () => conn.close());
  }

  function onAgent(ws: WebSocket) {
    const conn = hub.connectAgent((m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)));
    ws.on("message", (raw) => {
      const msg = parse<AgentToHub>(raw);
      if (msg) void conn.receive(msg);
    });
    ws.on("close", () => conn.close());
  }

  await new Promise<void>((resolve) => server.listen(o.port, o.host, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    hub,
    port,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => server.close(() => r()));
      await hub.flush();
    },
  };
}
