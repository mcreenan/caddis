import { createReadStream, existsSync, statSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import { FRAME_HEADERS, MIME, createFrameFiles, safeJoin } from "./static";

/**
 * HTTP for the browser UI, shared by the local web server and the hub:
 * the built renderer (with an SPA fallback) and the canvas frame files under `/frame/`.
 */
export function createWebHandler(root: string, ui: string, health: () => object) {
  const serveFrame = createFrameFiles(root);
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(health()));
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
    let file = safeJoin(ui, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).slice(1));
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      if (path.extname(url.pathname)) {
        res.writeHead(404);
        return res.end("not found");
      }
      file = path.join(ui, "index.html"); // SPA fallback
      if (!existsSync(file)) {
        res.writeHead(503);
        return res.end("UI not built: run `npm run build`");
      }
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    createReadStream(file).pipe(res);
  };
}

/** Browsers always send Origin on WebSocket upgrades; it must match Host. Non-browser clients send none. */
export function sameOrigin(req: http.IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
