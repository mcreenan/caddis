import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

/**
 * Files served to the sandboxed canvas frame, shared by the web server
 * (`/frame/*`) and Electron (`canvas://app/frame/*`). Everything is local:
 * the frame shell, its runtime and vendored libraries straight from node_modules.
 */

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".hdr": "application/octet-stream",
  ".woff2": "font/woff2",
};

export function safeJoin(base: string, rel: string) {
  const root = path.resolve(base);
  const full = path.resolve(root, rel);
  return full === root || full.startsWith(root + path.sep) ? full : undefined;
}

export interface Served {
  body: Buffer | string;
  mime: string;
}

export function createFrameFiles(root: string) {
  const nm = path.join(root, "node_modules");
  const canvasDir = path.join(root, "src/canvas");
  const FILES: Record<string, string> = {
    "index.html": path.join(canvasDir, "frame.html"),
    "runtime.js": path.join(canvasDir, "runtime.js"),
    "canvas.js": path.join(canvasDir, "canvas.js"),
    "vendor/d3.umd.js": path.join(nm, "d3/dist/d3.min.js"),
    "vendor/idiomorph.js": path.join(nm, "idiomorph/dist/idiomorph.esm.js"),
  };
  const DIRS: [string, string][] = [
    ["vendor/three/addons/", path.join(nm, "three/examples/jsm/")],
    ["vendor/three/", path.join(nm, "three/build/")],
  ];

  let d3Shim: string | undefined;
  /** ESM facade over the UMD build, with every named export d3 has. */
  const makeD3Shim = () => {
    if (d3Shim) return d3Shim;
    const sandbox: Record<string, any> = {};
    sandbox.globalThis = sandbox;
    vm.runInNewContext(readFileSync(FILES["vendor/d3.umd.js"], "utf8"), sandbox);
    const names = Object.keys(sandbox.d3 ?? {}).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && n !== "default");
    d3Shim = `import "./d3.umd.js";\nconst d3 = globalThis.d3;\nexport default d3;\nexport const { ${names.join(", ")} } = d3;\n`;
    return d3Shim;
  };

  /** `rel` is the path below the frame prefix, e.g. "index.html" or "vendor/three/three.module.js". */
  return function serveFrame(rel: string): Served | undefined {
    rel = decodeURIComponent(rel).replace(/^\/+/, "");
    if (rel === "") rel = "index.html";
    if (rel === "vendor/d3.js") return { body: makeD3Shim(), mime: MIME[".js"] };
    let file: string | undefined = FILES[rel];
    if (!file) {
      const dir = DIRS.find(([p]) => rel.startsWith(p));
      if (dir) file = safeJoin(dir[1], rel.slice(dir[0].length));
    }
    if (!file || !existsSync(file) || !statSync(file).isFile()) return undefined;
    return { body: readFileSync(file), mime: MIME[path.extname(file)] ?? "application/octet-stream" };
  };
}

/** Headers for frame files: the frame has an opaque origin, so module loads are cross-origin. */
export const FRAME_HEADERS = {
  "access-control-allow-origin": "*",
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
};
