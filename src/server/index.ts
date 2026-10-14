import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg, type SessionConfig } from "../shared/protocol";
import { ClaudeProvider } from "./providers/claude";
import { CodexProvider } from "./providers/codex";
import type { AgentProvider } from "./providers/types";
import { Session, SessionStore } from "./session";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 5317);
const DIST = path.join(ROOT, "dist");
const DATA = path.resolve(process.env.CANVAS_DATA_DIR ?? path.join(ROOT, "data"));
const DEFAULT_CWD = process.env.CANVAS_DEFAULT_CWD ?? os.homedir();

const providers: Record<string, AgentProvider> = { claude: new ClaudeProvider(), codex: new CodexProvider() };
const store = new SessionStore(path.join(DATA, "sessions"), (c) => providers[c.provider] ?? providers.claude);

// ------------------------------------------------------------------ static files

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".hdr": "application/octet-stream",
};

/** Libraries served to the sandboxed canvas, straight from node_modules (no CDN). */
const VENDOR: Record<string, string> = {
  "three/": path.join(ROOT, "node_modules/three/build/"),
  "three/addons/": path.join(ROOT, "node_modules/three/examples/jsm/"),
  "d3/": path.join(ROOT, "node_modules/d3/dist/"),
};

function resolveStatic(urlPath: string): string | undefined {
  const p = decodeURIComponent(urlPath);
  if (p.startsWith("/vendor/")) {
    const rest = p.slice("/vendor/".length);
    // Longest prefix wins (three/addons/ before three/).
    const prefix = Object.keys(VENDOR)
      .sort((a, b) => b.length - a.length)
      .find((k) => rest.startsWith(k));
    if (!prefix) return;
    return safeJoin(VENDOR[prefix], rest.slice(prefix.length));
  }
  return safeJoin(DIST, p === "/" ? "index.html" : p.slice(1));
}

function safeJoin(base: string, rel: string) {
  const full = path.resolve(base, rel);
  return full.startsWith(path.resolve(base) + path.sep) || full === path.resolve(base) ? full : undefined;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, v: PROTOCOL_VERSION }));
  }
  let file = resolveStatic(url.pathname);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    // SPA fallback for page routes; 404 for asset-looking paths.
    if (path.extname(url.pathname)) {
      res.writeHead(404);
      return res.end("not found");
    }
    file = path.join(DIST, "index.html");
    if (!existsSync(file)) {
      res.writeHead(503);
      return res.end("frontend not built: run `npm run build`");
    }
  }
  const headers: Record<string, string> = { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" };
  // The canvas iframe has an opaque origin, so its module/fetch loads of
  // /vendor and /frame are cross-origin and need CORS.
  if (url.pathname.startsWith("/vendor/") || url.pathname.startsWith("/frame/")) {
    headers["access-control-allow-origin"] = "*";
    headers["cache-control"] = "public, max-age=3600";
  } else {
    headers["cache-control"] = "no-cache";
  }
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
});

// ------------------------------------------------------------------ websocket

const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

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

const send = (ws: WebSocket, msg: ServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

wss.on("connection", (ws: WebSocket) => {
  let session: Session | undefined;
  send(ws, {
    t: "welcome",
    v: PROTOCOL_VERSION,
    providers: Object.values(providers).map((p) => p.info()),
    defaultCwd: DEFAULT_CWD,
  });

  ws.on("message", async (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send(ws, { t: "error", message: "bad json" });
    }
    try {
      await handle(msg);
    } catch (e: any) {
      send(ws, { t: "error", message: e?.message ?? String(e) });
    }
  });

  ws.on("close", () => session?.detach(ws));

  async function handle(msg: ClientMsg) {
    switch (msg.t) {
      case "hello": {
        if (msg.v !== PROTOCOL_VERSION) return send(ws, { t: "error", message: `protocol mismatch: server v${PROTOCOL_VERSION}` });
        const s = msg.sessionId ? store.get(msg.sessionId) : undefined;
        if (!s) return send(ws, { t: "session.none", sessionId: msg.sessionId });
        session?.detach(ws);
        session = s;
        s.attach(ws);
        return;
      }
      case "session.start": {
        if (session) throw new Error("this connection already has a session");
        const config = validateConfig(msg.config);
        session = store.create(config);
        session.attach(ws);
        session.prompt(msg.prompt);
        return;
      }
    }
    if (!session) {
      // Canvas reports from a frame that is not bound to a session are harmless; drop them.
      if (msg.t.startsWith("canvas.")) return;
      throw new Error("no session");
    }
    switch (msg.t) {
      case "prompt":
        return session.prompt(msg.text);
      case "interrupt":
        return session.interrupt();
      case "canvas.result":
        return session.onFrameResult(msg.requestId, msg);
      case "canvas.rendered":
        return session.onRendered(msg.version);
      case "canvas.console":
        return session.onConsole(msg.entries);
      case "canvas.undo":
        return session.undoCanvas();
      case "canvas.redo":
        return session.redoCanvas();
      case "canvas.clear":
        return session.clearCanvas();
      case "chrome.set":
        session.chromeUpdate(msg.component, msg.props as Record<string, unknown>);
        return;
      case "chrome.undo":
        return session.chromeUndo();
      case "chrome.reset":
        return session.chromeReset();
    }
  }
});

function validateConfig(c: SessionConfig): SessionConfig {
  const p = providers[c?.provider];
  if (!p || !p.info().enabled) throw new Error(`provider ${c?.provider} is not available`);
  const cwd = path.resolve(c.cwd?.replace(/^~(?=$|\/)/, os.homedir()) || DEFAULT_CWD);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`working directory does not exist: ${cwd}`);
  return { provider: c.provider, model: String(c.model ?? ""), effort: (c.effort ?? "") as SessionConfig["effort"], cwd };
}

server.listen(PORT, HOST, () => {
  console.log(`agent-canvas listening on http://${HOST}:${PORT}  (data: ${DATA})`);
});
