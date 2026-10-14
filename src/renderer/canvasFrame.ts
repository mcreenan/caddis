import { FRAME_CHANNEL, PROTOCOL_VERSION, type ClientMsg, type FromFrameMsg, type ServerMsg, type ToFrameMsg } from "../shared/protocol";
import { useUi } from "./store";

/**
 * Owns the sandboxed canvas iframe (hop 2) and relays between it and the core.
 * The iframe is a static shell loaded once; content always arrives as state
 * over postMessage and is applied in place. Only an explicit reload rebuilds it.
 */
export class CanvasFrameHost {
  private iframe?: HTMLIFrameElement;
  private alive = false;
  private onWindowMessage = (ev: MessageEvent) => this.fromFrame(ev);

  constructor(
    private stage: HTMLElement,
    private frameUrl: string,
    private send: (msg: ClientMsg) => void,
    private onEscape: () => void,
  ) {
    window.addEventListener("message", this.onWindowMessage);
  }

  mount() {
    this.iframe?.remove();
    this.alive = false;
    const f = document.createElement("iframe");
    // allow-scripts without allow-same-origin: opaque origin, no access to the host,
    // its storage or its IPC bridge. Network access is allowed.
    f.setAttribute("sandbox", "allow-scripts allow-forms allow-pointer-lock allow-downloads");
    f.setAttribute("allow", "fullscreen; clipboard-write; autoplay");
    f.className = "canvas-frame";
    f.title = "canvas";
    f.src = this.frameUrl;
    this.stage.append(f);
    this.iframe = f;
  }

  dispose() {
    window.removeEventListener("message", this.onWindowMessage);
    this.iframe?.remove();
  }

  private post(m: ToFrameMsg) {
    this.iframe?.contentWindow?.postMessage({ ch: FRAME_CHANNEL, v: PROTOCOL_VERSION, ...m }, "*");
  }

  /** Server messages that concern the frame (after the store has reduced them). */
  onServer(msg: ServerMsg) {
    switch (msg.t) {
      case "session.snapshot":
      case "canvas.mode":
      case "canvas.resource":
      case "canvas.delete":
      case "canvas.state":
        if (this.alive) this.post({ type: "state", canvas: useUi.getState().canvas });
        return;
      case "canvas.reload":
        return this.mount();
      case "data.changed":
        return this.post({ type: "data", key: msg.key, value: msg.value, deleted: msg.deleted });
      case "frame.request":
        if (!this.alive) return this.send({ t: "frame.result", requestId: msg.requestId, result: { ok: false, error: "canvas is still loading" } });
        return this.post({ type: "request", id: msg.requestId, request: msg.request });
      case "frame.chrome.result":
        return this.post({ type: "chrome.result", id: msg.requestId, result: msg.result });
    }
  }

  private fromFrame(ev: MessageEvent) {
    if (!this.iframe || ev.source !== this.iframe.contentWindow) return;
    const m = ev.data as (FromFrameMsg & { ch?: string }) | undefined;
    if (!m || m.ch !== FRAME_CHANNEL || typeof m.type !== "string") return;
    const st = useUi.getState();
    switch (m.type) {
      case "hello":
        this.alive = true;
        return this.post({ type: "init", canvas: st.canvas, data: st.data });
      case "ready":
        return this.send({ t: "frame.ready", rev: m.rev });
      case "applied":
        return this.send({ t: "frame.applied", rev: m.rev, errors: m.errors, warnings: m.warnings });
      case "console":
        return this.send({ t: "frame.console", entries: m.entries.map((e) => ({ ...e, rev: st.canvas.rev })) });
      case "result":
        return this.send({ t: "frame.result", requestId: m.id, result: m.result });
      case "data":
        // Optimistic local mirror; the core broadcasts to other windows.
        useUi.setState((s) => {
          const data = { ...s.data };
          if (m.deleted) delete data[m.key];
          else data[m.key] = m.value;
          return { data };
        });
        return this.send({ t: "frame.data", key: String(m.key), value: m.value, deleted: m.deleted });
      case "emit":
        return this.send({ t: "frame.emit", name: String(m.name), payload: m.payload });
      case "chrome":
        return this.send({ t: "frame.chrome", requestId: m.id, component: m.component, props: m.props, reset: m.reset });
      case "stats":
        useUi.setState({ stats: m.stats });
        return this.send({ t: "frame.stats", stats: m.stats });
      case "escape":
        return this.onEscape();
    }
  }
}
