import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";
import { defineConfig } from "vite-plus";
import pkg from "./package.json" with { type: "json" };

/**
 * One config for the whole toolchain (`vp dev`, `vp build`, `vp pack`, `vp check`, `vp test`):
 * - the renderer is the Vite app (root `src/renderer`, built to `out/renderer`);
 * - vite-plugin-electron builds main and preload to `out/` and starts/restarts Electron under `vp dev`;
 * - `vp pack` builds the standalone web server, the hub and the agent link CLI to `out/server`.
 */

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Runtime dependencies stay in node_modules (shipped by electron-builder) rather than being bundled into main. */
const external = Object.keys(pkg.dependencies).map((d) => new RegExp(`^${d}(/.*)?$`));

/** Env for the Electron child under `vp dev`; see scripts/electron.mjs for why. */
function electronEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform === "linux" && !env.XDG_SESSION_TYPE && env.WAYLAND_DISPLAY) env.XDG_SESSION_TYPE = "wayland";
  return env;
}

/**
 * vp also loads this file for `vp test`/`vp pack`/`vp lint`; the Electron plugin only belongs to `vp dev`/`vp build`
 * (otherwise it writes a placeholder index.html at the root or tries to start Electron).
 */
const electronTargets = !process.env.VITEST && !process.env.VP_RESOLVING_CONFIG_METADATA;

export default defineConfig({
  root: r("src/renderer"),
  base: "./",
  build: { outDir: r("out/renderer"), emptyOutDir: true },
  // Only Electron loads the dev server; the user-facing web target is `vp run web` (binds 0.0.0.0).
  server: { host: "127.0.0.1" },
  plugins: [
    react(),
    electronTargets &&
      electron({
        main: {
          entry: r("src/main/index.ts"),
          // Keep the OS sandbox on (the plugin's default argv adds --no-sandbox).
          onstart: ({ startup }) => void startup(["."], { cwd: r("."), env: electronEnv() }),
          vite: {
            build: { outDir: r("out/main"), emptyOutDir: true, minify: false, rolldownOptions: { external } },
          },
        },
        preload: {
          input: r("src/preload/index.ts"),
          vite: {
            // Sandboxed renderers can only load CommonJS preloads.
            build: {
              outDir: r("out/preload"),
              emptyOutDir: true,
              minify: false,
              rolldownOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
            },
          },
        },
      }),
  ],

  pack: {
    entry: { index: r("src/server/index.ts"), hub: r("src/hub/index.ts"), agent: r("src/agent/index.ts") },
    outDir: r("out/server"),
    platform: "node",
    format: "esm",
    dts: false,
  },

  test: {
    root: r("."),
    projects: [
      { extends: true, test: { name: "unit", include: ["src/**/*.test.{ts,tsx}"], environment: "node" } },
      // Drives the real app against a real Claude turn; opt in with `vp run e2e`.
      ...(process.env.CADDIS_E2E
        ? [{ extends: true, test: { name: "e2e", include: ["e2e/**/*.e2e.ts"], testTimeout: 30 * 60_000 } }]
        : []),
    ],
  },

  fmt: {
    ignorePatterns: ["out/**", "dist/**", "data/**", "hub-data/**", ".e2e/**", "package-lock.json"],
    printWidth: 120,
    sortPackageJson: true,
  },

  lint: {
    ignorePatterns: ["out/**", "dist/**", "data/**", "hub-data/**", ".e2e/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      // `for (const x of [...coll])` snapshots collections the loop body mutates; that copy is the point.
      "unicorn/no-useless-spread": "off",
    },
    options: { typeAware: true, typeCheck: true },
  },
});
