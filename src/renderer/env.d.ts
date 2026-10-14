/// <reference types="vite/client" />
import type { CaddisBridge } from "../shared/bridge";

declare global {
  interface Window {
    /** Present only in Electron (exposed by the preload). */
    caddis?: CaddisBridge;
  }
}
export {};
