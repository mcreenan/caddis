// Agent Canvas iframe bridge (classic script, runs first in <head>).
// Captures console/errors, forwards the escape hotkey, and answers parent
// requests (eval, patch, snapshot). See src/shared/protocol.ts.
(() => {
  const CH = "agent-canvas";
  const V = 1;
  const VERSION = Number(document.currentScript.dataset.version);
  const post = (m) => parent.postMessage({ ch: CH, v: V, ...m }, "*");

  // ------------------------------------------------------------ console capture
  const fmt1 = (a) => {
    if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  let buf = [];
  let timer = 0;
  const flush = () => {
    clearTimeout(timer);
    timer = 0;
    if (!buf.length) return;
    const entries = buf;
    buf = [];
    post({ type: "console", entries, version: VERSION });
  };
  const push = (level, args) => {
    buf.push({ level, message: args.map(fmt1).join(" ").slice(0, 2000), ts: Date.now() });
    if (buf.length > 200) buf.splice(0, buf.length - 200);
    if (!timer) timer = setTimeout(flush, 100);
  };
  for (const level of ["log", "info", "warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      push(level, args);
      orig(...args);
    };
  }
  addEventListener("error", (e) => {
    if (e.error) push("error", [e.error]);
    else if (e.message) push("error", [`${e.message} (${e.filename}:${e.lineno})`]);
    else if (e.target && e.target !== window) push("error", [`failed to load ${e.target.src || e.target.href || e.target.tagName}`]);
  }, true);
  addEventListener("unhandledrejection", (e) => push("error", ["Unhandled rejection:", e.reason]));

  // ------------------------------------------------------------ escape hatch
  addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "Escape" || e.code === "Escape")) {
      e.preventDefault();
      post({ type: "escape" });
    }
  }, true);

  // ------------------------------------------------------------ shared state
  let readyResolve;
  const ac = {
    VERSION,
    post,
    push,
    flush,
    scope: {},
    snapshotHook: null, // set by runtime: () => HTMLCanvasElement | null
    ready: new Promise((r) => (readyResolve = r)),
    markReady() {
      readyResolve();
      flush();
      post({ type: "ready", version: VERSION });
    },
  };
  window.__ac = ac;

  const AsyncFunction = (async () => {}).constructor;

  const serialise = (v) => {
    if (v === undefined) return "undefined";
    if (v instanceof Element) return v.outerHTML.slice(0, 20000);
    if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
    const seen = new WeakSet();
    try {
      const s = JSON.stringify(v, (k, x) => {
        if (typeof x === "object" && x !== null) {
          if (seen.has(x)) return "[circular]";
          seen.add(x);
          if (x instanceof Element) return `<${x.tagName.toLowerCase()}>`;
        }
        if (typeof x === "bigint") return String(x);
        return x;
      }, 2);
      return (s ?? String(v)).slice(0, 20000);
    } catch {
      return String(v).slice(0, 20000);
    }
  };

  // ------------------------------------------------------------ patch (mirrors src/server/patch.ts)
  const applyPatch = (p) => {
    let nodes = Array.from(document.body.querySelectorAll(p.selector)).filter((el) => !el.closest("[data-ac-internal]"));
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
  };

  // ------------------------------------------------------------ snapshot
  const loadImage = (src) =>
    new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("could not rasterise the HTML layer"));
      img.src = src;
    });

  async function htmlLayer(w, h) {
    // Serialise the DOM into an SVG foreignObject. Canvases are swapped for
    // bitmaps; scripts and the drawing surface are dropped.
    const clone = document.documentElement.cloneNode(true);
    const live = document.querySelectorAll("canvas");
    const cloned = clone.querySelectorAll("canvas");
    live.forEach((c, i) => {
      const dst = cloned[i];
      if (!dst) return;
      if (c.closest("[data-ac-internal]")) return dst.remove();
      try {
        const img = document.createElement("img");
        img.src = c.toDataURL();
        img.setAttribute("style", c.getAttribute("style") || "");
        img.width = c.clientWidth;
        img.height = c.clientHeight;
        dst.replaceWith(img);
      } catch {}
    });
    clone.querySelectorAll("script,[data-ac-internal]").forEach((n) => n.remove());
    // Backgrounds were already painted underneath the surface.
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
    const ctx = out.getContext("2d");
    ctx.scale(scale, scale);
    const clear = (c) => !c || c === "transparent" || c === "rgba(0, 0, 0, 0)";
    const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    ctx.fillStyle = !clear(bodyBg) ? bodyBg : !clear(htmlBg) ? htmlBg : "#0e0f13";
    ctx.fillRect(0, 0, w, h);
    const surface = ac.snapshotHook?.();
    if (surface) ctx.drawImage(surface, 0, 0, w, h);
    const hasHtml = document.body.children.length > 0 || document.body.textContent.trim();
    let note = "";
    if (hasHtml) {
      try {
        ctx.drawImage(await htmlLayer(w, h), 0, 0, w, h);
      } catch (e) {
        note = ` (html layer omitted: ${e.message})`;
      }
    }
    const url = out.toDataURL("image/png");
    return { image: { data: url.slice(url.indexOf(",") + 1), mimeType: "image/png" }, value: `${out.width}x${out.height}${note}` };
  }

  // ------------------------------------------------------------ requests from parent
  addEventListener("message", async (ev) => {
    if (ev.source !== parent) return;
    const m = ev.data;
    if (!m || m.ch !== CH) return;
    if (m.type === "patch") {
      try {
        applyPatch(m.patch);
      } catch (e) {
        push("error", ["patch failed:", e]);
      }
      return;
    }
    if (m.type === "eval") {
      await ac.ready;
      try {
        const names = Object.keys(ac.scope);
        const fn = new AsyncFunction(...names, `${m.js}\n//# sourceURL=canvas-eval.js`);
        const value = await fn(...names.map((n) => ac.scope[n]));
        post({ type: "result", id: m.id, ok: true, value: serialise(value) });
      } catch (e) {
        post({ type: "result", id: m.id, ok: false, error: fmt1(e) });
      }
      flush();
      return;
    }
    if (m.type === "snapshot") {
      await ac.ready;
      try {
        const r = await snapshot(m.maxWidth || 768);
        post({ type: "result", id: m.id, ok: true, ...r });
      } catch (e) {
        post({ type: "result", id: m.id, ok: false, error: fmt1(e) });
      }
    }
  });
})();
