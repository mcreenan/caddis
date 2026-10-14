import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from "../shared/protocol";
import { CanvasFrameHost } from "./canvasFrame";
import { reduce, useUi } from "./store";
import { transport } from "./transport";

/** Glue between the transport, the store and the canvas frame. */

let frame: CanvasFrameHost | undefined;

export const send = (msg: ClientMsg) => transport.send(msg);

export const toggleSafe = () => useUi.setState((s) => ({ safe: !s.safe }));

const sessionFromUrl = () => new URLSearchParams(location.search).get("s") ?? undefined;

function onMessage(msg: ServerMsg) {
  reduce(msg);
  if (msg.t === "session.snapshot") {
    const url = new URL(location.href);
    if (url.searchParams.get("s") !== msg.session.id) {
      url.searchParams.set("s", msg.session.id);
      history.replaceState(null, "", url);
    }
    reportViewport();
  } else if (msg.t === "session.none" && sessionFromUrl()) {
    const url = new URL(location.href);
    url.searchParams.delete("s");
    history.replaceState(null, "", url);
  }
  frame?.onServer(msg);
}

let vpTimer: number | undefined;
function reportViewport() {
  clearTimeout(vpTimer);
  vpTimer = window.setTimeout(() => send({ t: "viewport", width: innerWidth, height: innerHeight }), 100);
}

export function startController() {
  transport.start(
    onMessage,
    () => {
      useUi.setState({ connected: true });
      send({ t: "hello", v: PROTOCOL_VERSION, sessionId: useUi.getState().sessionId ?? sessionFromUrl() });
    },
    () => useUi.setState({ connected: false }),
  );
  window.agentCanvas?.onUi((cmd) => cmd === "escape" && toggleSafe());
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "Escape") {
        e.preventDefault();
        toggleSafe();
      }
    },
    true,
  );
  window.addEventListener("resize", () => useUi.getState().phase === "session" && reportViewport());
}

/** Called by the Stage component once its element exists. */
export function attachStage(el: HTMLElement) {
  frame?.dispose();
  frame = new CanvasFrameHost(el, transport.frameUrl, send, toggleSafe);
  frame.mount();
  return () => {
    frame?.dispose();
    frame = undefined;
  };
}
