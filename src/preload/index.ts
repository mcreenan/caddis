import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { CanvasStats, ClientMsg, ServerMsg, UiCommand } from "../shared/protocol";

/** The only surface the host renderer gets: a message pipe to the core plus a few native helpers. */
const api = {
  platform: "electron" as const,
  /** The OS: macOS gets the native menu bar and traffic lights; elsewhere the titlebar has a menu button. */
  os: process.platform,
  frameUrl: "canvas://app/frame/index.html",
  /** (Re)bind this window to the core. Call after registering onMessage. */
  connect: (): Promise<void> => ipcRenderer.invoke("ac:connect"),
  send: (msg: ClientMsg) => ipcRenderer.send("ac:msg", msg),
  onMessage(cb: (msg: ServerMsg) => void) {
    const h = (_e: IpcRendererEvent, m: ServerMsg) => cb(m);
    ipcRenderer.on("ac:msg", h);
    return () => void ipcRenderer.off("ac:msg", h);
  },
  /** Window-level UI commands from main: native menu items and shortcuts caught while the canvas has focus. */
  onUi(cb: (cmd: UiCommand) => void) {
    const h = (_e: IpcRendererEvent, c: UiCommand) => cb(c);
    ipcRenderer.on("ac:ui", h);
    return () => void ipcRenderer.off("ac:ui", h);
  },
  pickDirectory: (): Promise<string | undefined> => ipcRenderer.invoke("ac:pickDir"),
  newWindow: () => ipcRenderer.send("ac:newWindow"),
  /** Memory/CPU of the canvas frame's process. */
  processStats: (): Promise<CanvasStats["process"]> => ipcRenderer.invoke("ac:processStats"),
  /** File menu actions; main shows the native dialogs and reads/writes `.caddis` files. */
  file: (cmd: "new" | "open" | "save" | "saveAs") => ipcRenderer.send("ac:file", cmd),
};

export type CaddisBridge = typeof api;
contextBridge.exposeInMainWorld("caddis", api);
