import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Entries follow electron-vite's defaults: src/main/index.ts, src/preload/index.ts, src/renderer/index.html.
export default defineConfig({
  main: {},
  preload: {
    // Sandboxed renderers can only load CommonJS preloads.
    build: { rolldownOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    base: "./",
    plugins: [react()],
    server: { host: "127.0.0.1" },
  },
});
