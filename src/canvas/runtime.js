// Caddis frame runtime (protocol v2). Runs inside the sandboxed canvas
// iframe and applies resources live, with no reloads:
//   *.css       -> <style data-ac-res> swapped in place
//   index.html  -> body DOM-morphed (idiomorph), focus and input values kept
//   *.js        -> ES modules with a setup(ctx) / dispose lifecycle; timers,
//                  listeners, rAF, data subscriptions, scene objects and WebGL
//                  contexts they create are tracked and cleaned up on dispose
//   assets      -> blob URLs (ctx.asset(name), [data-asset], url(asset:name) in css)
// It also measures fps/memory/leaks (watchdog) and answers eval/view/dom/stats
// requests. See src/shared/protocol.ts (ToFrameMsg / FromFrameMsg).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import d3 from "d3";
import { Idiomorph } from "idiomorph";

const CH = "caddis";
const V = 2;
const post = (m) => parent.postMessage({ ch: CH, v: V, ...m }, "*");

const orig = {
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
  setInterval: window.setInterval.bind(window),
  clearInterval: window.clearInterval.bind(window),
  raf: window.requestAnimationFrame.bind(window),
  caf: window.cancelAnimationFrame.bind(window),
  add: EventTarget.prototype.addEventListener,
  remove: EventTarget.prototype.removeEventListener,
  getContext: HTMLCanvasElement.prototype.getContext,
  o3dAdd: THREE.Object3D.prototype.add,
};
const sleep = (ms) => new Promise((r) => orig.setTimeout(r, ms));

// ======================================================================== console capture

const fmt1 = (a) => {
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
};
let consoleBuf = [];
let consoleTimer = 0;
/** Active apply windows collect the errors they cause. */
const errorSinks = new Set();
const flushConsole = () => {
  orig.clearTimeout(consoleTimer);
  consoleTimer = 0;
  if (!consoleBuf.length) return;
  const entries = consoleBuf;
  consoleBuf = [];
  post({ type: "console", entries });
};
const log = (level, args) => {
  const message = args.map(fmt1).join(" ").slice(0, 2000);
  consoleBuf.push({ level, message, ts: Date.now() });
  if (consoleBuf.length > 200) consoleBuf.splice(0, consoleBuf.length - 200);
  if (level === "error") for (const s of errorSinks) s(message);
  if (!consoleTimer) consoleTimer = orig.setTimeout(flushConsole, 100);
};
for (const level of ["log", "info", "warn", "error"]) {
  const o = console[level].bind(console);
  console[level] = (...args) => {
    log(level, args);
    o(...args);
  };
}
orig.add.call(
  window,
  "error",
  (e) => {
    if (e.error) log("error", [e.error]);
    else if (e.message) log("error", [`${e.message} (${e.filename}:${e.lineno})`]);
    else if (e.target && e.target !== window) log("error", [`failed to load ${e.target.src || e.target.href || e.target.tagName}`]);
  },
  true,
);
orig.add.call(window, "unhandledrejection", (e) => log("error", ["Unhandled rejection:", e.reason]));

// Host shortcuts, forwarded so they work while the canvas has focus (Electron catches them in main instead).
orig.add.call(
  window,
  "keydown",
  (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "Backslash") {
      e.preventDefault();
      post({ type: "hotkey", key: "overlay" });
    }
  },
  true,
);

// Forms never navigate the frame away (that would kill the canvas); handlers still see submit.
orig.add.call(window, "submit", (e) => e.preventDefault());
orig.add.call(window, "click", (e) => {
  const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (a && !a.getAttribute("href").startsWith("#") && !a.hasAttribute("download")) {
    e.preventDefault();
    log("warn", [`link navigation blocked (${a.href}); the canvas is a single page`]);
  }
});

// ======================================================================== ownership tracking

/** Everything a module instance creates, so dispose can clean it up. */
class Owner {
  constructor(name) {
    this.name = name;
    this.disposed = false;
    this.cleanups = [];
    this.frameFns = new Set();
    this.resizeFns = new Set();
    this.subs = new Set();
    this.objects = [];
    this.gl = new Set();
    this.rootEl = null;
  }
}
let current = null; // the owner whose code is running
let internal = 0; // >0 while the runtime itself creates things (not tracked)
const withOwner = (o, fn, self, args) => {
  const prev = current;
  current = o;
  try {
    return fn.apply(self, args);
  } finally {
    current = prev;
  }
};

const timeouts = new Map(); // id -> owner|null
const intervals = new Map();
const rafs = new Map();
const listeners = new Set(); // {target, type, capture, wrapped, fn, owner}
const listenerIndex = new WeakMap(); // fn -> records
let glLive = 0;
const glCanvases = new WeakSet();

window.setTimeout = function (fn, ms, ...args) {
  if (typeof fn !== "function" || internal) return orig.setTimeout(fn, ms, ...args);
  const o = current;
  const id = orig.setTimeout(() => {
    timeouts.delete(id);
    if (!o?.disposed) withOwner(o, fn, window, args);
  }, ms);
  timeouts.set(id, o);
  return id;
};
window.clearTimeout = (id) => {
  timeouts.delete(id);
  orig.clearTimeout(id);
};
window.setInterval = function (fn, ms, ...args) {
  if (typeof fn !== "function" || internal) return orig.setInterval(fn, ms, ...args);
  const o = current;
  const id = orig.setInterval(() => {
    if (!o?.disposed) withOwner(o, fn, window, args);
  }, ms);
  intervals.set(id, o);
  return id;
};
window.clearInterval = (id) => {
  intervals.delete(id);
  orig.clearInterval(id);
};
window.requestAnimationFrame = (fn) => {
  if (internal) return orig.raf(fn);
  const o = current;
  const id = orig.raf((t) => {
    rafs.delete(id);
    if (!o?.disposed) withOwner(o, fn, window, [t]);
  });
  rafs.set(id, o);
  return id;
};
window.cancelAnimationFrame = (id) => {
  rafs.delete(id);
  orig.caf(id);
};

const captureOf = (opts) => (typeof opts === "boolean" ? opts : Boolean(opts?.capture));
const dropListener = (rec) => {
  listeners.delete(rec);
  const list = listenerIndex.get(rec.fn);
  if (list) list.splice(list.indexOf(rec) >>> 0, 1);
};
EventTarget.prototype.addEventListener = function (type, fn, opts) {
  if (internal || !fn || (typeof fn !== "function" && typeof fn.handleEvent !== "function")) return orig.add.call(this, type, fn, opts);
  const capture = captureOf(opts);
  let list = listenerIndex.get(fn);
  if (!list) listenerIndex.set(fn, (list = []));
  if (list.some((r) => r.target === this && r.type === type && r.capture === capture)) return;
  const o = current;
  const rec = { target: this, type, capture, fn, owner: o, wrapped: null };
  rec.wrapped = function (ev) {
    if (opts?.once) dropListener(rec);
    if (o?.disposed) return;
    return withOwner(o, typeof fn === "function" ? fn : fn.handleEvent, typeof fn === "function" ? this : fn, [ev]);
  };
  list.push(rec);
  listeners.add(rec);
  if (opts?.signal) orig.add.call(opts.signal, "abort", () => dropListener(rec));
  return orig.add.call(this, type, rec.wrapped, opts);
};
EventTarget.prototype.removeEventListener = function (type, fn, opts) {
  const capture = captureOf(opts);
  const rec = listenerIndex.get(fn)?.find((r) => r.target === this && r.type === type && r.capture === capture);
  if (!rec) return orig.remove.call(this, type, fn, opts);
  dropListener(rec);
  return orig.remove.call(this, type, rec.wrapped, opts);
};

HTMLCanvasElement.prototype.getContext = function (kind, attrs) {
  const isGl = kind === "webgl" || kind === "webgl2" || kind === "experimental-webgl";
  const fresh = isGl && !glCanvases.has(this);
  const ctx = orig.getContext.call(this, kind, attrs);
  if (ctx && fresh) {
    glCanvases.add(this);
    glLive++;
    const o = internal ? null : current;
    o?.gl.add(ctx);
    orig.add.call(this, "webglcontextlost", () => glLive--, { once: true });
  }
  return ctx;
};

THREE.Object3D.prototype.add = function (...objs) {
  if (current && !internal) for (const obj of objs) if (obj !== this) current.objects.push([this, obj]);
  return orig.o3dAdd.apply(this, objs);
};

const kept = new WeakSet(); // ctx.keep values (and their GPU resources) survive dispose

function disposeThree(root) {
  if (kept.has(root)) return;
  root.traverse?.((o) => {
    if (kept.has(o)) return;
    if (o.geometry && !kept.has(o.geometry)) o.geometry.dispose();
    for (const m of [].concat(o.material ?? [])) {
      if (kept.has(m)) continue;
      for (const v of Object.values(m)) if (v?.isTexture && !kept.has(v)) v.dispose();
      m.dispose();
    }
  });
}

function disposeOwner(o) {
  for (const fn of o.cleanups.reverse()) {
    try {
      withOwner(o, fn, null, []);
    } catch (e) {
      log("error", [`${o.name}: cleanup threw:`, e]);
    }
  }
  o.disposed = true;
  for (const [id, owner] of timeouts) if (owner === o) window.clearTimeout(id);
  for (const [id, owner] of intervals) if (owner === o) window.clearInterval(id);
  for (const [id, owner] of rafs) if (owner === o) window.cancelAnimationFrame(id);
  for (const rec of [...listeners]) if (rec.owner === o) rec.target.removeEventListener(rec.type, rec.fn, { capture: rec.capture });
  o.subs.clear();
  o.frameFns.clear();
  o.resizeFns.clear();
  for (const [parent, obj] of o.objects.reverse()) {
    if (kept.has(obj)) continue;
    if (obj.parent === parent) parent.remove(obj);
    disposeThree(obj);
  }
  o.objects = [];
  for (const gl of o.gl) gl.getExtension("WEBGL_lose_context")?.loseContext();
  o.rootEl?.remove();
}

// ======================================================================== mode + surface

const rt = {
  mode: "html",
  width: innerWidth,
  height: innerHeight,
  dpr: Math.min(devicePixelRatio || 1, 2),
  surface: null,
  g: null,
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
};

function teardownMode() {
  internal++;
  try {
    rt.controls?.dispose();
    if (rt.scene) for (const child of [...rt.scene.children]) (rt.scene.remove(child), disposeThree(child));
    rt.renderer?.dispose();
    rt.renderer?.forceContextLoss();
    rt.surface?.remove();
  } finally {
    internal--;
  }
  Object.assign(rt, { surface: null, g: null, renderer: null, scene: null, camera: null, controls: null });
}

function setupMode(mode) {
  teardownMode();
  rt.mode = mode;
  document.documentElement.classList.toggle("ac-surface", mode !== "html");
  const mount = (el) => {
    el.id = "__ac_surface";
    el.setAttribute("data-ac-internal", "");
    document.documentElement.insertBefore(el, document.body); // outside body: morphs never touch it
    return el;
  };
  internal++;
  try {
    if (mode === "canvas") {
      rt.surface = mount(document.createElement("canvas"));
      rt.g = rt.surface.getContext("2d");
    } else if (mode === "3d") {
      rt.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      rt.renderer.setPixelRatio(rt.dpr);
      rt.surface = mount(rt.renderer.domElement);
      rt.scene = new THREE.Scene();
      rt.camera = new THREE.PerspectiveCamera(60, rt.width / rt.height, 0.1, 2000);
      rt.camera.position.set(0, 1.5, 5);
      rt.controls = new OrbitControls(rt.camera, rt.renderer.domElement);
      rt.controls.enableDamping = true;
    }
  } finally {
    internal--;
  }
  resizeSurface();
}

function resizeSurface() {
  if (rt.mode === "canvas" && rt.surface) {
    rt.surface.width = Math.round(rt.width * rt.dpr);
    rt.surface.height = Math.round(rt.height * rt.dpr);
    rt.g.setTransform(rt.dpr, 0, 0, rt.dpr, 0, 0);
  } else if (rt.mode === "3d" && rt.renderer) {
    rt.renderer.setSize(rt.width, rt.height, false);
    rt.camera.aspect = rt.width / rt.height;
    rt.camera.updateProjectionMatrix();
  }
}

orig.add.call(window, "resize", () => {
  rt.width = innerWidth;
  rt.height = innerHeight;
  resizeSurface();
  for (const e of entries.values())
    for (const fn of e.owner.resizeFns)
      try {
        withOwner(e.owner, fn, null, [rt.width, rt.height]);
      } catch (err) {
        log("error", [`${e.name}: onResize threw:`, err]);
      }
});

// ======================================================================== render loop + stats

const perf = { frames: 0, sum: 0, max: 0, last: performance.now(), fps: 0, frameMs: 0, frameMsMax: 0 };
function loop(t) {
  orig.raf(loop);
  const dt = t - perf.last;
  perf.last = t;
  perf.frames++;
  perf.sum += dt;
  perf.max = Math.max(perf.max, dt);
  for (const e of entries.values()) {
    for (const fn of e.owner.frameFns) {
      try {
        withOwner(e.owner, fn, null, [dt / 1000, t / 1000]);
      } catch (err) {
        e.owner.frameFns.delete(fn); // one report, not one per frame
        log("error", [`${e.name}: onFrame callback threw and was removed:`, err]);
      }
    }
  }
  if (rt.mode === "3d" && rt.renderer) {
    rt.controls.update();
    rt.renderer.render(rt.scene, rt.camera);
  }
}
orig.raf(loop);

const watch = { samples: [], signature: "", leaks: [], fpsGood: false, lowSecs: 0, fpsWarning: "", swaps: 0 };
const LEAK_KEYS = ["timers", "rafs", "listeners", "webglContexts", "dom", "geometries", "textures", "objects"];

function countObjects() {
  let n = 0;
  rt.scene?.traverse(() => n++);
  return rt.scene ? n - 1 : 0;
}

function collectStats() {
  const info = rt.renderer?.info;
  const stats = {
    ts: Date.now(),
    mode: rt.mode,
    fps: perf.fps,
    frameMs: perf.frameMs,
    frameMsMax: perf.frameMsMax,
    heapMB: performance.memory ? Math.round((performance.memory.usedJSHeapSize / 1048576) * 10) / 10 : undefined,
    dom: document.getElementsByTagName("*").length,
    modules: entries.size,
    timers: timeouts.size + intervals.size,
    rafs: rafs.size,
    listeners: listeners.size,
    webglContexts: glLive,
    swaps: watch.swaps,
    warnings: [...watch.leaks, ...(watch.fpsWarning ? [watch.fpsWarning] : [])],
  };
  if (info)
    stats.three = {
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      calls: info.render.calls,
      triangles: info.render.triangles,
      objects: countObjects(),
    };
  return stats;
}

const metricsOf = (s) => ({
  timers: s.timers,
  rafs: s.rafs,
  listeners: s.listeners,
  webglContexts: s.webglContexts,
  dom: s.dom,
  geometries: s.three?.geometries ?? 0,
  textures: s.three?.textures ?? 0,
  objects: s.three?.objects ?? 0,
});

/** After a module swap: if a count rose on each of the last 3 swaps of the same modules, something is not cleaned up. */
function sampleAfterSwap() {
  watch.swaps++;
  const sig = `${rt.mode}|${[...entries.keys()].sort().join(",")}`;
  if (sig !== watch.signature) {
    watch.signature = sig;
    watch.samples = [];
  }
  watch.samples.push(metricsOf(collectStats()));
  if (watch.samples.length > 8) watch.samples.shift();
  const s = watch.samples.slice(-4);
  watch.leaks = [];
  if (s.length < 4) return;
  for (const k of LEAK_KEYS) {
    const v = s.map((x) => x[k]);
    if (v[0] < v[1] && v[1] < v[2] && v[2] < v[3])
      watch.leaks.push(`possible leak: ${k} grew ${v.join(" → ")} over the last 3 module swaps (not cleaned up on dispose?)`);
  }
}

orig.setInterval(() => {
  perf.fps = perf.frames;
  perf.frameMs = perf.frames ? Math.round((perf.sum / perf.frames) * 10) / 10 : 0;
  perf.frameMsMax = Math.round(perf.max * 10) / 10;
  perf.frames = 0;
  perf.sum = 0;
  perf.max = 0;
  if (document.visibilityState === "visible") {
    if (perf.fps >= 40) watch.fpsGood = true;
    if (watch.fpsGood && perf.fps < 20) watch.lowSecs++;
    else watch.lowSecs = 0;
    if (watch.lowSecs >= 3) watch.fpsWarning = `fps collapsed to ${perf.fps} (frame ${perf.frameMs} ms avg, ${perf.frameMsMax} ms max) for ${watch.lowSecs}s`;
    else if (perf.fps >= 30) watch.fpsWarning = "";
  }
  post({ type: "stats", stats: collectStats() });
}, 1000);

// ======================================================================== data store mirror + events

const store = {};
const subs = new Set(); // {key, cb, owner}
const json = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function notify(key, value) {
  for (const s of [...subs]) {
    if (s.owner?.disposed) {
      subs.delete(s);
      continue;
    }
    if (s.key !== key && s.key !== "*") continue;
    try {
      withOwner(s.owner, s.cb, null, [value, key]);
    } catch (e) {
      log("error", [`data subscriber for "${key}" threw:`, e]);
    }
  }
}

const data = {
  get: (key) => store[key],
  has: (key) => key in store,
  keys: () => Object.keys(store),
  all: () => ({ ...store }),
  set(key, value) {
    const v = json(value);
    store[key] = v;
    post({ type: "data", key, value: v });
    notify(key, v);
  },
  delete(key) {
    delete store[key];
    post({ type: "data", key, deleted: true });
    notify(key, undefined);
  },
  /** cb(value, key) runs now and on every change (from the agent or the page). "*" = all keys. */
  subscribe(key, cb) {
    const s = { key, cb, owner: current };
    subs.add(s);
    current?.subs.add(s);
    try {
      if (key === "*") for (const k of Object.keys(store)) cb(store[k], k);
      else cb(store[key], key);
    } catch (e) {
      log("error", [`data subscriber for "${key}" threw:`, e]);
    }
    return () => subs.delete(s);
  },
};

const emit = (name, payload) => post({ type: "emit", name: String(name), payload: json(payload) });

let reqSeq = 0;
const chromeWaiters = new Map();
const chromeCall = (msg) =>
  new Promise((resolve, reject) => {
    const id = `c${++reqSeq}`;
    chromeWaiters.set(id, (r) => (r?.error ? reject(new Error(r.error)) : resolve(r)));
    orig.setTimeout(() => chromeWaiters.delete(id) && reject(new Error("chrome request timed out")), 5000);
    post({ type: "chrome", id, ...msg });
  });
const chrome = {
  /** Same clamps as the agent's chrome_set; resolves with the applied values. */
  set: (component, props) => chromeCall({ component, props: json(props) }),
  reset: (component) => chromeCall({ component, reset: true }),
};

// ======================================================================== assets

const assetUrls = new Map(); // name -> {rev, url}
const asset = (name) => assetUrls.get(name)?.url;

function applyAssets(resources, prev) {
  let changed = false;
  for (const [name, r] of Object.entries(resources)) {
    if (r.kind !== "asset" || prev[name]?.rev === r.rev) continue;
    if (assetUrls.has(name)) URL.revokeObjectURL(assetUrls.get(name).url);
    const bytes = r.base64 !== undefined ? Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)) : r.text ?? "";
    assetUrls.set(name, { rev: r.rev, url: URL.createObjectURL(new Blob([bytes], { type: r.mime })) });
    changed = true;
  }
  for (const name of [...assetUrls.keys()])
    if (!resources[name]) {
      URL.revokeObjectURL(assetUrls.get(name).url);
      assetUrls.delete(name);
      changed = true;
    }
  return changed;
}

function bindAssets() {
  for (const el of document.querySelectorAll("[data-asset]")) {
    const url = asset(el.getAttribute("data-asset"));
    if (!url) continue;
    const attr = el.tagName === "A" || el.tagName === "LINK" ? "href" : "src";
    if (el.getAttribute(attr) !== url) el.setAttribute(attr, url);
  }
}

const cssWithAssets = (css) => css.replace(/url\(\s*(["']?)asset:([^"')]+)\1\s*\)/g, (m, q, name) => (asset(name) ? `url("${asset(name)}")` : m));

// ======================================================================== css + html

function applyCss(resources, prev, assetsChanged) {
  const names = Object.keys(resources).filter((n) => resources[n].kind === "css").sort();
  for (const el of document.head.querySelectorAll("style[data-ac-res]")) if (!resources[el.dataset.acRes]) el.remove();
  let after = document.head.querySelector("style[data-ac-internal]");
  for (const name of names) {
    let el = document.head.querySelector(`style[data-ac-res="${CSS.escape(name)}"]`);
    if (!el) {
      el = document.createElement("style");
      el.dataset.acRes = name;
    }
    if (prev[name]?.rev !== resources[name].rev || assetsChanged || !el.isConnected) el.textContent = cssWithAssets(resources[name].text ?? "");
    if (after.nextElementSibling !== el) after.after(el); // keep name order
    after = el;
  }
}

function applyHtml(html) {
  Idiomorph.morph(document.body, html, {
    morphStyle: "innerHTML",
    ignoreActiveValue: true,
    callbacks: {
      // Module roots and anything marked data-ac-keep belong to JS, not to index.html.
      beforeNodeRemoved: (node) => !(node.nodeType === 1 && (node.hasAttribute("data-ac-root") || node.hasAttribute("data-ac-keep"))),
    },
  });
}

// ======================================================================== js modules

/** name -> {name, owner, state, keep, sig} for each entry module (a js resource no other module imports). */
const entries = new Map();
const states = new Map(); // per-entry ctx.state, survives swaps and mode switches
const keeps = new Map(); // per-entry ctx.keep cache
const urlCache = new Map(); // module name -> {key, url}

const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+|\/[^"']+)\2/g;

function resolveSpec(from, spec) {
  const parts = spec.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function depsOf(name, text) {
  const deps = new Set();
  for (const m of text.matchAll(SPEC_RE)) deps.add(resolveSpec(name, m[3]));
  return deps;
}

function moduleGraph(resources) {
  const js = Object.values(resources).filter((r) => r.kind === "js");
  const deps = new Map(js.map((r) => [r.name, depsOf(r.name, r.text ?? "")]));
  const imported = new Set([...deps.values()].flatMap((d) => [...d]));
  const entryNames = js.map((r) => r.name).filter((n) => !imported.has(n)).sort();
  const closure = (n, seen = new Set()) => {
    if (seen.has(n)) return seen;
    seen.add(n);
    for (const d of deps.get(n) ?? []) closure(d, seen);
    return seen;
  };
  const sig = (n) => [...closure(n)].sort().map((m) => `${m}@${resources[m]?.rev ?? "missing"}`).join(",");
  return { deps, entryNames, sig };
}

/** Blob URL for a module with its relative imports rewritten to its deps' blob URLs. */
function moduleUrl(name, resources, deps, stack = []) {
  const r = resources[name];
  if (!r) throw new Error(`${stack.at(-1) ?? name} imports "${name}", which does not exist`);
  if (stack.includes(name)) throw new Error(`circular import: ${[...stack, name].join(" -> ")}`);
  const depUrls = {};
  for (const d of deps.get(name) ?? []) depUrls[d] = moduleUrl(d, resources, deps, [...stack, name]);
  const key = `${r.rev}|${Object.values(depUrls).join("|")}`;
  const cached = urlCache.get(name);
  if (cached?.key === key) return cached.url;
  const code = (r.text ?? "").replace(SPEC_RE, (m, pre, q, spec) => `${pre}${q}${depUrls[resolveSpec(name, spec)]}${q}`);
  const url = URL.createObjectURL(new Blob([`${code}\n//# sourceURL=canvas:///${name}`], { type: "text/javascript" }));
  urlCache.set(name, { key, url });
  return url;
}

function makeCtx(owner, name) {
  if (!states.has(name)) states.set(name, {});
  if (!keeps.has(name)) keeps.set(name, new Map());
  const keepMap = keeps.get(name);
  return {
    name,
    state: states.get(name),
    THREE,
    d3,
    get mode() {
      return rt.mode;
    },
    get width() {
      return rt.width;
    },
    get height() {
      return rt.height;
    },
    get dpr() {
      return rt.dpr;
    },
    get scene() {
      return rt.scene;
    },
    get camera() {
      return rt.camera;
    },
    get renderer() {
      return rt.renderer;
    },
    get controls() {
      return rt.controls;
    },
    get g() {
      return rt.g;
    },
    get surface() {
      return rt.surface;
    },
    /** A container in <body> owned by this module: kept by html morphs, removed on dispose. */
    get root() {
      if (!owner.rootEl) {
        owner.rootEl = document.createElement("div");
        owner.rootEl.setAttribute("data-ac-root", name);
        document.body.append(owner.rootEl);
      }
      return owner.rootEl;
    },
    onFrame: (fn) => (owner.frameFns.add(fn), () => owner.frameFns.delete(fn)),
    onResize: (fn) => (owner.resizeFns.add(fn), () => owner.resizeFns.delete(fn)),
    onDispose: (fn) => owner.cleanups.push(fn),
    /** Create once and reuse across swaps (never auto-disposed). */
    keep(key, make) {
      if (!keepMap.has(key)) {
        const prev = current;
        current = null;
        internal++;
        let v;
        try {
          v = make();
        } finally {
          internal--;
          current = prev;
        }
        keepMap.set(key, v);
        if (v && typeof v === "object") {
          kept.add(v);
          v.traverse?.((o) => {
            kept.add(o);
            if (o.geometry) kept.add(o.geometry);
            for (const m of [].concat(o.material ?? [])) kept.add(m);
          });
        }
      }
      return keepMap.get(key);
    },
    data,
    emit,
    chrome,
    asset,
  };
}

async function runEntry(name, url, errors) {
  const owner = new Owner(name);
  const e = { name, owner, url };
  entries.set(name, e);
  const prev = current;
  current = owner;
  try {
    const mod = await import(url);
    const setup = mod.default ?? mod.setup;
    if (typeof setup === "function") {
      const ret = await setup(makeCtx(owner, name));
      if (typeof ret === "function") owner.cleanups.push(ret);
      else if (typeof ret?.dispose === "function") owner.cleanups.push(() => ret.dispose());
    }
  } catch (err) {
    const msg = `${name}: ${fmt1(err)}`;
    errors.push(msg);
    log("error", [msg]);
  } finally {
    current = prev;
  }
}

function disposeEntry(name) {
  const e = entries.get(name);
  if (!e) return;
  entries.delete(name);
  disposeOwner(e.owner);
}

/** Re-run exactly the entries whose module closure changed (or all, after a mode switch). */
async function applyModules(resources, force, errors) {
  const { deps, entryNames, sig } = moduleGraph(resources);
  let swapped = false;
  for (const name of [...entries.keys()])
    if (!entryNames.includes(name)) {
      disposeEntry(name);
      swapped = true;
    }
  for (const name of [...keeps.keys()]) if (!resources[name]) (keeps.delete(name), states.delete(name));
  for (const name of [...urlCache.keys()]) if (!resources[name]) (URL.revokeObjectURL(urlCache.get(name).url), urlCache.delete(name));
  for (const name of entryNames) {
    const s = sig(name);
    const e = entries.get(name);
    if (e && e.sig === s && !force) continue;
    disposeEntry(name);
    let url;
    try {
      url = moduleUrl(name, resources, deps);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
      log("error", [`${name}: ${err.message}`]);
      continue;
    }
    await runEntry(name, url, errors);
    entries.get(name).sig = s;
    swapped = true;
  }
  return swapped;
}

// ======================================================================== applying canvas state

let shown = {}; // resources currently applied
let shownRev = -1;
let started = false;
let latest = null;
let queue = Promise.resolve();

function enqueue(canvas) {
  latest = canvas;
  queue = queue.then(() => (latest === canvas ? applyState(canvas) : undefined)).catch((e) => log("error", ["apply failed:", e]));
}

async function applyState(c) {
  const errors = [];
  const sink = (m) => errors.push(m);
  errorSinks.add(sink);
  const prev = shown;
  const res = c.resources;
  const changed = (n) => prev[n]?.rev !== res[n]?.rev;
  const all = new Set([...Object.keys(prev), ...Object.keys(res)]);
  const kindOf = (n) => (res[n] ?? prev[n]).kind;
  const dirty = [...all].filter(changed);
  const modeChanged = c.mode !== rt.mode || !started;
  try {
    const assetsChanged = applyAssets(res, prev);
    if (assetsChanged || dirty.some((n) => kindOf(n) === "css")) applyCss(res, prev, assetsChanged);
    if (dirty.includes("index.html") || !started) applyHtml(res["index.html"]?.text ?? "");
    if (assetsChanged || dirty.includes("index.html")) bindAssets();
    if (modeChanged) {
      for (const name of [...entries.keys()]) disposeEntry(name);
      setupMode(c.mode);
    }
    shown = res;
    shownRev = c.rev;
    started = true;
    const swapped = await applyModules(res, modeChanged, errors);
    bindAssets();
    // Let the new code run a little so its first errors and leaks are attributed to this change.
    await sleep(swapped ? 600 : 120);
    if (swapped) sampleAfterSwap();
  } catch (e) {
    errors.push(`apply failed: ${fmt1(e)}`);
  } finally {
    errorSinks.delete(sink);
  }
  flushConsole();
  const warnings = collectStats().warnings;
  post({ type: "applied", rev: c.rev, errors: [...new Set(errors)].slice(0, 20), warnings });
}

// ======================================================================== requests: eval / view / dom / stats

const AsyncFunction = (async () => {}).constructor;

const serialise = (v) => {
  if (v === undefined) return "undefined";
  if (v instanceof Element) return v.outerHTML.slice(0, 20000);
  if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
  const seen = new WeakSet();
  try {
    const s = JSON.stringify(
      v,
      (k, x) => {
        if (typeof x === "object" && x !== null) {
          if (seen.has(x)) return "[circular]";
          seen.add(x);
          if (x instanceof Element) return `<${x.tagName.toLowerCase()}>`;
          if (x.isObject3D) return `[${x.type}${x.name ? ` ${x.name}` : ""}]`;
        }
        if (typeof x === "bigint") return String(x);
        return x;
      },
      2,
    );
    return (s ?? String(v)).slice(0, 20000);
  } catch {
    return String(v).slice(0, 20000);
  }
};

function patchLive(p) {
  let nodes = [...document.body.querySelectorAll(p.selector)].filter((el) => !el.closest("[data-ac-internal]"));
  if (!p.all) nodes = nodes.slice(0, 1);
  const c = p.content ?? "";
  for (const el of nodes) {
    switch (p.op) {
      case "replace": el.outerHTML = c; break;
      case "inner": el.innerHTML = c; break;
      case "append": el.insertAdjacentHTML("beforeend", c); break;
      case "prepend": el.insertAdjacentHTML("afterbegin", c); break;
      case "before": el.insertAdjacentHTML("beforebegin", c); break;
      case "after": el.insertAdjacentHTML("afterend", c); break;
      case "remove": el.remove(); break;
      case "text": el.textContent = c; break;
      case "style": {
        const prev = el.getAttribute("style") ?? "";
        el.setAttribute("style", prev && !prev.trim().endsWith(";") ? `${prev}; ${c}` : `${prev}${c}`);
        break;
      }
      case "attr":
        for (const [k, v] of Object.entries(JSON.parse(c || "{}"))) {
          if (v === null || v === false) el.removeAttribute(k);
          else el.setAttribute(k, String(v));
        }
        break;
    }
  }
  return nodes.length;
}

function outline(rootSel, limit = 200) {
  const root = rootSel ? document.querySelector(rootSel) : document.body;
  if (!root) return `(no element matches ${rootSel})`;
  const lines = [];
  const walk = (el, depth) => {
    if (lines.length >= limit) return;
    if (el.hasAttribute("data-ac-internal") || el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
    const r = el.getBoundingClientRect();
    let label = el.tagName.toLowerCase();
    if (el.id) label += `#${el.id}`;
    if (el.classList.length) label += `.${[...el.classList].slice(0, 4).join(".")}`;
    if (el.hasAttribute("data-ac-root")) label += ` [module ${el.getAttribute("data-ac-root")}]`;
    const hidden = r.width === 0 && r.height === 0 ? " hidden" : ` ${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
    lines.push(`${"  ".repeat(depth)}${label}${hidden}${own ? ` "${own.slice(0, 60)}${own.length > 60 ? "…" : ""}"` : ""}`);
    for (const child of el.children) walk(child, depth + 1);
  };
  walk(root, 0);
  if (lines.length >= limit) lines.push(`… (truncated at ${limit} elements)`);
  return lines.join("\n");
}

const loadImage = (src) =>
  new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("could not rasterise the HTML layer"));
    img.src = src;
  });

async function htmlLayer(w, h) {
  // Serialise the DOM into an SVG foreignObject: canvases become bitmaps, the surface is drawn separately.
  const clone = document.documentElement.cloneNode(true);
  const live = document.querySelectorAll("canvas");
  const cloned = clone.querySelectorAll("canvas");
  live.forEach((c, i) => {
    const dst = cloned[i];
    if (!dst) return;
    if (c.hasAttribute("data-ac-internal")) return dst.remove();
    try {
      const img = document.createElement("img");
      img.src = c.toDataURL();
      img.setAttribute("style", c.getAttribute("style") || "");
      img.width = c.clientWidth;
      img.height = c.clientHeight;
      dst.replaceWith(img);
    } catch {}
  });
  clone.querySelectorAll("script,[data-ac-internal]:not(style)").forEach((n) => n.remove());
  clone.style.background = "transparent";
  clone.querySelector("body")?.style.setProperty("background", "transparent");
  const xhtml = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  return loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

async function snapshot(maxWidth) {
  const w = innerWidth;
  const h = innerHeight;
  const scale = Math.min(1, maxWidth / w);
  const out = document.createElement("canvas");
  out.width = Math.round(w * scale);
  out.height = Math.round(h * scale);
  const g = orig.getContext.call(out, "2d");
  g.scale(scale, scale);
  const clear = (c) => !c || c === "transparent" || c === "rgba(0, 0, 0, 0)";
  const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  g.fillStyle = !clear(bodyBg) ? bodyBg : !clear(htmlBg) ? htmlBg : "#0e0f13";
  g.fillRect(0, 0, w, h);
  if (rt.mode === "3d" && rt.renderer) {
    rt.renderer.render(rt.scene, rt.camera); // render + read in one task: no preserveDrawingBuffer needed
    g.drawImage(rt.surface, 0, 0, w, h);
  } else if (rt.surface) g.drawImage(rt.surface, 0, 0, w, h);
  let note = "";
  if (document.body.children.length || document.body.textContent.trim()) {
    try {
      g.drawImage(await htmlLayer(w, h), 0, 0, w, h);
    } catch (e) {
      note = ` (html layer omitted: ${e.message})`;
    }
  }
  const url = out.toDataURL("image/png");
  return { image: { data: url.slice(url.indexOf(",") + 1), mimeType: "image/png" }, note: `${out.width}x${out.height}${note}` };
}

function modulesSummary() {
  return Object.fromEntries([...entries.keys()].map((n) => [n, { state: states.get(n) }]));
}

async function handleRequest(req) {
  await queue;
  switch (req.kind) {
    case "eval": {
      const scope = {
        canvas: globalThis.canvas,
        THREE,
        d3,
        scene: rt.scene,
        camera: rt.camera,
        renderer: rt.renderer,
        controls: rt.controls,
        g: rt.g,
        data,
        modules: modulesSummary(),
        stats: collectStats,
      };
      const fn = new AsyncFunction(...Object.keys(scope), `${req.js}\n//# sourceURL=canvas-eval.js`);
      const value = await fn(...Object.values(scope));
      return { ok: true, value: serialise(value) };
    }
    case "dom": {
      const n = patchLive(req.patch);
      return { ok: true, value: `${n} element(s) matched ${req.patch.selector}` };
    }
    case "stats":
      return { ok: true, stats: collectStats() };
    case "view": {
      const s = collectStats();
      const parts = [
        `Modules: ${[...entries.keys()].join(", ") || "none"}`,
        `Stats: ${s.fps} fps, ${s.frameMs} ms/frame, dom ${s.dom}, timers ${s.timers}, rafs ${s.rafs}, listeners ${s.listeners}, webgl ${s.webglContexts}${s.three ? `, objects ${s.three.objects}, draw calls ${s.three.calls}` : ""}${s.heapMB ? `, heap ${s.heapMB} MB` : ""}`,
      ];
      if (s.warnings.length) parts.push(`Watchdog:\n${s.warnings.map((w) => `- ${w}`).join("\n")}`);
      if (req.outline) parts.push(`DOM outline${req.selector ? ` (${req.selector})` : ""}:\n${outline(req.selector)}`);
      let image;
      if (req.screenshot) {
        const shot = await snapshot(req.maxWidth || 1024);
        image = shot.image;
        parts.push(`Snapshot ${shot.note}`);
      }
      return { ok: true, value: parts.join("\n\n"), image };
    }
  }
  return { ok: false, error: `unknown request ${req.kind}` };
}

// ======================================================================== host messages

orig.add.call(window, "message", async (ev) => {
  if (ev.source !== parent) return;
  const m = ev.data;
  if (!m || m.ch !== CH || m.v !== V) return;
  switch (m.type) {
    case "init":
      Object.keys(store).forEach((k) => delete store[k]);
      Object.assign(store, m.data ?? {});
      enqueue(m.canvas);
      queue.then(() => post({ type: "ready", rev: shownRev }));
      return;
    case "state":
      return enqueue(m.canvas);
    case "data":
      if (m.deleted) delete store[m.key];
      else store[m.key] = m.value;
      return notify(m.key, m.deleted ? undefined : m.value);
    case "chrome.result": {
      const w = chromeWaiters.get(m.id);
      chromeWaiters.delete(m.id);
      return w?.(m.result);
    }
    case "request": {
      let result;
      try {
        result = await handleRequest(m.request);
      } catch (e) {
        result = { ok: false, error: fmt1(e) };
      }
      flushConsole();
      return post({ type: "result", id: m.id, result });
    }
  }
});

// The page-facing API (also `import canvas from "canvas"`).
globalThis.canvas = { data, emit, chrome, asset, THREE, d3 };

// Test/debug hooks (used by scripts/e2e.ts via the frame's own JS context).
window.__ac = {
  rt,
  entries,
  states,
  stats: collectStats,
  watch,
  /** Re-run one entry as if its source had been edited (counts as a swap). */
  async rerun(name) {
    const res = shown;
    const { deps } = moduleGraph(res);
    disposeEntry(name);
    urlCache.delete(name);
    const errors = [];
    await runEntry(name, moduleUrl(name, res, deps), errors);
    entries.get(name).sig = moduleGraph(res).sig(name);
    await sleep(300);
    sampleAfterSwap();
    return { errors, stats: collectStats() };
  },
  /** Add, replace (text) or remove (null) a module locally, bypassing the core. Tests only. */
  async inject(name, text) {
    const res = { ...shown };
    if (text == null) delete res[name];
    else res[name] = { name, kind: "js", text, rev: Date.now() };
    shown = res;
    const errors = [];
    if (await applyModules(res, false, errors)) {
      await sleep(300);
      sampleAfterSwap();
    }
    return { errors, stats: collectStats() };
  },
};

post({ type: "hello" });
