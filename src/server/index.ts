import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from "../shared/protocol";
import { SessionManager } from "../core/manager";
import { FRAME_HEADERS, MIME, createFrameFiles, safeJoin } from "../core/static";
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
const serveFrame = createFrameFiles(ROOT);
void manager.discover();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, v: PROTOCOL_VERSION }));
  }
  if (url.pathname.startsWith("/frame/")) {
    const f = serveFrame(url.pathname.slice("/frame/".length));
    if (!f) {
      res.writeHead(404, FRAME_HEADERS);
      return res.end("not found");
    }
    res.writeHead(200, { ...FRAME_HEADERS, "content-type": f.mime });
    return res.end(f.body);
  }
  let file = safeJoin(UI, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).slice(1));
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    if (path.extname(url.pathname)) {
      res.writeHead(404);
      return res.end("not found");
    }
    file = path.join(UI, "index.html"); // SPA fallback
    if (!existsSync(file)) {
      res.writeHead(503);
      return res.end("UI not built: run `npm run build`");
    }
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
  createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/ws") return socket.destroy();
  // Same-origin check: browsers always send Origin; it must match Host.
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) {
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
      msg = JSON.parse(String(raw));
    } catch {
      return client.send({ t: "error", message: "bad json" });
    }
    conn.receive(msg);
  });
  ws.on("close", () => conn.close());
});

server.listen(PORT, HOST, () => console.log(`caddis web on http://${HOST}:${PORT}  (data: ${DATA})`));

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    manager.shutdown();
    process.exit(0);
  });
