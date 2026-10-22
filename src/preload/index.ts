import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { CaddisBridge } from "../shared/bridge";
import type { ServerMsg, UiCommand } from "../shared/protocol";

const api: CaddisBridge = {
  platform: "electron",
  os: process.platform,
  frameUrl: "canvas://app/frame/index.html",
  connect: (hub) => ipcRenderer.invoke("ac:connect", hub),
  send: (msg) => ipcRenderer.send("ac:msg", msg),
  onMessage(cb) {
    const h = (_e: IpcRendererEvent, m: ServerMsg) => cb(m);
    ipcRenderer.on("ac:msg", h);
    return () => void ipcRenderer.off("ac:msg", h);
  },
  onUi(cb) {
    const h = (_e: IpcRendererEvent, c: UiCommand) => cb(c);
    ipcRenderer.on("ac:ui", h);
    return () => void ipcRenderer.off("ac:ui", h);
  },
  pickDirectory: () => ipcRenderer.invoke("ac:pickDir"),
  newWindow: () => ipcRenderer.send("ac:newWindow"),
  processStats: () => ipcRenderer.invoke("ac:processStats"),
  file: (cmd) => ipcRenderer.send("ac:file", cmd),
};

contextBridge.exposeInMainWorld("caddis", api);
