import { defineConfig } from "vite";

const BACKEND = `http://127.0.0.1:${process.env.PORT ?? 5317}`;

// Production: `npm run build` then the Node server serves dist/ on :5317.
// `npm run dev:vite` is an optional HMR server that proxies the backend.
export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5318,
    allowedHosts: ["localhost", "mattdesktop", "mattdesktop-1.taila85f65.ts.net", "192.168.86.73", "100.72.147.70"],
    proxy: {
      "/ws": { target: BACKEND, ws: true },
      "/vendor": BACKEND,
      "/healthz": BACKEND,
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
