import type { CanvasStats, ClientMsg, ServerMsg, UiCommand } from "./protocol";

export type FileCommand = "new" | "open" | "save" | "saveAs";

/** The only surface the host renderer gets (`window.caddis`, exposed by the preload): a message pipe to the core plus a few native helpers. */
export interface CaddisBridge {
  platform: "electron";
  /** The OS: macOS gets the native menu bar and traffic lights; elsewhere the titlebar has a menu button. */
  os: string;
  frameUrl: string;
  /** (Re)bind this window to the local core, or to the hub at `hub` (main relays). Call after registering onMessage. */
  connect(hub?: string): Promise<void>;
  send(msg: ClientMsg): void;
  onMessage(cb: (msg: ServerMsg) => void): () => void;
  /** Window-level UI commands from main: native menu items and shortcuts caught while the canvas has focus. */
  onUi(cb: (cmd: UiCommand) => void): () => void;
  pickDirectory(): Promise<string | undefined>;
  newWindow(): void;
  /** Memory/CPU of the canvas frame's process. */
  processStats(): Promise<CanvasStats["process"]>;
  /** File menu actions; main shows the native dialogs and reads/writes `.caddis` files. */
  file(cmd: FileCommand): void;
}
