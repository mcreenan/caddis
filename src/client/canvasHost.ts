import {
  FRAME_CHANNEL,
  PROTOCOL_VERSION,
  type CanvasDoc,
  type CanvasPatch,
  type ConsoleEntry,
  type FromFrameMsg,
  type ToFrameMsg,
} from "../shared/protocol";

const IMPORT_MAP = JSON.stringify({
  imports: { three: "/vendor/three/three.module.js", "three/addons/": "/vendor/three/addons/" },
});

// In canvas/3d modes <html> has no background, so any body background
// propagates to the viewport and paints *below* the fixed surface
// (z-index:-1). Body ignores pointer events so the surface stays interactive
// while overlay elements still receive them.
const BASE_CSS = `
:root{color-scheme:dark;color:#e6e6ea;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;height:100%}
html:not(.ac-surface){background:#0e0f13}
body{margin:0;min-height:100%}
html.ac-surface body{pointer-events:none}
:where(html.ac-surface body *){pointer-events:auto}
#__ac_surface{position:fixed;inset:0;width:100vw;height:100vh;display:block;z-index:-1}
`;

const esc = (s: string, tag: string) => s.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);

export function buildSrcdoc(doc: CanvasDoc, origin: string): string {
  const state = JSON.stringify({ version: doc.version, mode: doc.mode, script: doc.script, context: doc.context }).replace(/</g, "\\u003c");
  const cls = doc.mode === "html" ? "" : ' class="ac-surface"';
  return `<!doctype html><html${cls}><head><meta charset="utf-8"><base href="${origin}/">
<meta name="viewport" content="width=device-width,initial-scale=1">
<script type="importmap">${IMPORT_MAP}</script>
<style>${BASE_CSS}</style>
<style id="__ac_css">${esc(doc.css, "style")}</style>
<script src="/frame/bridge.js" data-version="${doc.version}"></script>
<script src="/vendor/d3/d3.min.js"></script>
<script type="application/json" id="__ac_state">${state}</script>
<script type="module" src="/frame/runtime.js" onerror="__ac.push('error',['canvas runtime failed to load']);__ac.markReady()"></script>
</head><body>${doc.html}</body></html>`;
}

interface FrameRec {
  el: HTMLIFrameElement;
  /** Version currently shown in this frame (advances on live patches). */
  version: number;
  ready: boolean;
}

export interface CanvasHostEvents {
  rendered(version: number): void;
  console(entries: ConsoleEntry[]): void;
  result(id: string, r: { ok: boolean; value?: string; error?: string; image?: { data: string; mimeType: string } }): void;
  escape(): void;
}

/**
 * Owns the sandboxed canvas iframe. Full renders are double-buffered: the new
 * frame loads underneath the old one and replaces it once it reports ready.
 */
export class CanvasHost {
  private current?: FrameRec;
  private loading?: FrameRec;
  private swapTimer?: number;

  constructor(
    private stage: HTMLElement,
    private ev: CanvasHostEvents,
  ) {
    window.addEventListener("message", (e) => this.onMessage(e));
  }

  get version() {
    return (this.loading ?? this.current)?.version ?? -1;
  }

  render(doc: CanvasDoc) {
    if (this.loading) this.loading.el.remove();
    const el = document.createElement("iframe");
    el.className = "canvas-frame loading";
    el.setAttribute("sandbox", "allow-scripts");
    el.setAttribute("referrerpolicy", "no-referrer");
    el.setAttribute("title", "Agent canvas");
    el.srcdoc = buildSrcdoc(doc, location.origin);
    const rec: FrameRec = { el, version: doc.version, ready: false };
    this.loading = rec;
    this.stage.prepend(el); // underneath the current frame
    clearTimeout(this.swapTimer);
    this.swapTimer = window.setTimeout(() => this.promote(rec), 4000);
  }

  private promote(rec: FrameRec) {
    if (this.loading !== rec) return;
    clearTimeout(this.swapTimer);
    this.current?.el.remove();
    this.current = rec;
    this.loading = undefined;
    rec.el.classList.remove("loading");
  }

  /** Apply a patch live if we are exactly one version behind; otherwise full render. */
  patch(patch: CanvasPatch, doc: CanvasDoc) {
    const rec = this.loading ?? this.current;
    if (rec && rec.ready && rec.version === doc.version - 1) {
      this.post(rec, { type: "patch", patch, version: doc.version });
      rec.version = doc.version;
      this.ev.rendered(doc.version);
    } else {
      this.render(doc);
    }
  }

  request(msg: ToFrameMsg & { id: string }) {
    const rec = this.loading ?? this.current;
    if (!rec) return this.ev.result(msg.id, { ok: false, error: "no canvas frame" });
    this.post(rec, msg);
  }

  setHidden(hidden: boolean) {
    this.stage.classList.toggle("hidden", hidden);
  }

  private post(rec: FrameRec, msg: ToFrameMsg) {
    // Opaque-origin frame: targetOrigin must be "*". Only this frame receives it.
    rec.el.contentWindow?.postMessage({ ch: FRAME_CHANNEL, v: PROTOCOL_VERSION, ...msg }, "*");
  }

  private onMessage(e: MessageEvent) {
    const rec = [this.current, this.loading].find((r) => r && r.el.contentWindow === e.source);
    if (!rec) return; // not from a canvas frame we own
    const m = e.data as FromFrameMsg & { ch?: string; v?: number };
    if (!m || m.ch !== FRAME_CHANNEL || m.v !== PROTOCOL_VERSION) return;
    switch (m.type) {
      case "ready":
        rec.ready = true;
        if (rec === this.loading) this.promote(rec);
        this.ev.rendered(rec.version);
        return;
      case "console":
        if (!Array.isArray(m.entries)) return;
        this.ev.console(
          m.entries.slice(0, 200).map((x) => ({
            level: (["log", "info", "warn", "error"] as const).includes(x.level) ? x.level : "log",
            message: String(x.message).slice(0, 2000),
            ts: Number(x.ts) || Date.now(),
            version: rec.version,
          })),
        );
        return;
      case "result":
        this.ev.result(String(m.id), {
          ok: Boolean(m.ok),
          value: m.value === undefined ? undefined : String(m.value),
          error: m.error === undefined ? undefined : String(m.error),
          image: m.image && typeof m.image.data === "string" ? { data: m.image.data, mimeType: "image/png" } : undefined,
        });
        return;
      case "escape":
        this.ev.escape();
        return;
    }
  }
}
