import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ClientMsg, ServerMsg } from "../shared/protocol";

/** The only surface the host renderer gets: a message pipe to the core plus a few native helpers. */
const api = {
  platform: "electron" as const,
  frameUrl: "canvas://app/frame/index.html",
  /** (Re)bind this window to the core. Call after registering onMessage. */
  connect: (): Promise<void> => ipcRenderer.invoke("ac:connect"),
  send: (msg: ClientMsg) => ipcRenderer.send("ac:msg", msg),
  onMessage(cb: (msg: ServerMsg) => void) {
    const h = (_e: IpcRendererEvent, m: ServerMsg) => cb(m);
    ipcRenderer.on("ac:msg", h);
    return () => void ipcRenderer.off("ac:msg", h);
  },
  /** Window-level UI commands from main (e.g. the Ctrl+Shift+Esc escape hatch). */
  onUi(cb: (cmd: string) => void) {
    const h = (_e: IpcRendererEvent, c: string) => cb(c);
    ipcRenderer.on("ac:ui", h);
    return () => void ipcRenderer.off("ac:ui", h);
  },
  pickDirectory: (): Promise<string | undefined> => ipcRenderer.invoke("ac:pickDir"),
  newWindow: () => ipcRenderer.send("ac:newWindow"),
};

export type AgentCanvasBridge = typeof api;
contextBridge.exposeInMainWorld("agentCanvas", api);
