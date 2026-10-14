/// <reference types="vite/client" />
import type { AgentCanvasBridge } from "../preload/index";

declare global {
  interface Window {
    /** Present only in Electron (exposed by the preload). */
    agentCanvas?: AgentCanvasBridge;
  }
}
export {};
