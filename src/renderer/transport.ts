import type { ClientMsg, ServerMsg } from "../shared/protocol";

/** Hop 1 (UI <-> core): Electron IPC when the preload bridge exists, else WebSocket `/ws`. */
export interface Transport {
  platform: "web" | "electron";
  frameUrl: string;
  send(msg: ClientMsg): void;
  /** Starts the connection; `onOpen` runs on every (re)connect. */
  start(onMessage: (msg: ServerMsg) => void, onOpen: () => void, onClose: () => void): void;
  pickDirectory?(): Promise<string | undefined>;
  newWindow(): void;
  /** Electron only: main runs Open/Save with native dialogs. The web build goes through the core instead. */
  file?(cmd: "open" | "save" | "saveAs"): void;
  /** Electron only: connect this window to the hub at `url` (main relays to it), or back to the local core. */
  setHub?(url: string | undefined): void;
}

/** How to join a hub; kept in localStorage. `url` is only needed by the desktop app (a browser is served by the hub). */
export interface HubLogin {
  url?: string;
  name: string;
  token: string;
}

const HUB_KEY = "caddis.hub";

export function savedHub(): HubLogin | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(HUB_KEY) ?? "null");
    return v && typeof v.name === "string" && typeof v.token === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

export function saveHub(login: HubLogin | undefined) {
  if (login) localStorage.setItem(HUB_KEY, JSON.stringify(login));
  else localStorage.removeItem(HUB_KEY);
}

function electronTransport(): Transport {
  const b = window.caddis!;
  let opened = () => {};
  return {
    platform: "electron",
    frameUrl: b.frameUrl,
    send: (msg) => b.send(msg),
    start(onMessage, onOpen) {
      opened = onOpen;
      b.onMessage(onMessage);
      void b.connect(savedHub()?.url).then(onOpen);
    },
    setHub: (url) => void b.connect(url).then(() => opened()),
    pickDirectory: () => b.pickDirectory(),
    newWindow: () => b.newWindow(),
    file: (cmd) => b.file(cmd),
  };
}

function webTransport(): Transport {
  let ws: WebSocket | undefined;
  let delay = 300;
  return {
    platform: "web",
    frameUrl: new URL("/frame/index.html", location.href).href,
    newWindow: () => void window.open(location.pathname, "_blank"),
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

export const transport: Transport = window.caddis ? electronTransport() : webTransport();
