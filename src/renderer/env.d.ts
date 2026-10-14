/// <reference types="vite/client" />
import type { CaddisBridge } from "../preload/index";

declare global {
  interface Window {
    /** Present only in Electron (exposed by the preload). */
    caddis?: CaddisBridge;
  }
}
export {};
