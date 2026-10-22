import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from "../shared/protocol";
import { SessionManager } from "../core/manager";
import { createWebHandler, sameOrigin } from "../core/web";
import type { Client } from "../core/session";

/**
 * Web target: the same session core as Electron, served over HTTP + WebSocket.
 * Binds 0.0.0.0 by default so LAN/Tailscale devices can use it (no auth yet:
 * do not expose it beyond networks you trust).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 5317);
const UI = path.join(ROOT, "out/renderer");
const DATA = path.resolve(process.env.CADDIS_DATA_DIR ?? path.join(ROOT, "data"));

const manager = new SessionManager(DATA, undefined, "web");
void manager.discover();

const server = http.createServer(createWebHandler(ROOT, UI, () => ({ ok: true, v: PROTOCOL_VERSION })));

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/ws") return socket.destroy();
  if (!sameOrigin(req)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

let nextId = 0;
wss.on("connection", (ws: WebSocket) => {
  const client: Client = {
    id: `ws-${++nextId}`,
    kind: "web",
    send: (msg: ServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)),
  };
  const conn = manager.connect(client);
  ws.on("message", (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse((raw as Buffer).toString()); // binaryType is the default "nodebuffer"
    } catch {
      return client.send({ t: "error", message: "bad json" });
    }
    void conn.receive(msg);
  });
  ws.on("close", () => conn.close());
});

server.listen(PORT, HOST, () => console.log(`caddis web on http://${HOST}:${PORT}  (data: ${DATA})`));

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    manager.shutdown();
    process.exit(0);
  });
