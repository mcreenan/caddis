import type { ClientMsg, ServerMsg } from "../shared/protocol";

/** Hop 1 (UI <-> core): Electron IPC when the preload bridge exists, else WebSocket `/ws`. */
export interface Transport {
  platform: "web" | "electron";
  frameUrl: string;
  send(msg: ClientMsg): void;
  /** Starts the connection; `onOpen` runs on every (re)connect. */
  start(onMessage: (msg: ServerMsg) => void, onOpen: () => void, onClose: () => void): void;
  pickDirectory?(): Promise<string | undefined>;
  newWindow?(): void;
}

function electronTransport(): Transport {
  const b = window.agentCanvas!;
  return {
    platform: "electron",
    frameUrl: b.frameUrl,
    send: (msg) => b.send(msg),
    start(onMessage, onOpen) {
      b.onMessage(onMessage);
      void b.connect().then(onOpen);
    },
    pickDirectory: () => b.pickDirectory(),
    newWindow: () => b.newWindow(),
  };
}

function webTransport(): Transport {
  let ws: WebSocket | undefined;
  let delay = 300;
  return {
    platform: "web",
    frameUrl: new URL("/frame/index.html", location.href).href,
    send(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    start(onMessage, onOpen, onClose) {
      const connect = () => {
        ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
        ws.onopen = () => {
          delay = 300;
          onOpen();
        };
        ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
        ws.onclose = () => {
          onClose();
          setTimeout(connect, (delay = Math.min(delay * 2, 5000)));
        };
      };
      connect();
    },
  };
}

export const transport: Transport = window.agentCanvas ? electronTransport() : webTransport();
