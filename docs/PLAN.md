# Caddis — Plan

_v2 · 2026-10-13. Supersedes the research draft. The prototype in this repo implements most of §1–§6. §8 lists what is still open._

## 0. Product

A personal tool. Each window is one Claude session, and the whole window is a live page (the **canvas**) that the agent builds with tools. Two host-owned floating components sit above it: the **prompt** and the **history**. The agent can restyle them within clamps but can never remove or cover them.

The canvas is a **by-product of the session**. It is persisted with the session and reopens with it. Sharing comes later, as a self-contained export (§8).

| Area         | Decision                                                                                                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell        | **Electron first** (Electron 44, Vite+ with vite-plugin-electron, electron-builder, React 19, TS, Zustand, zod). The web server (`0.0.0.0:5317`, LAN + Tailscale) is a secondary target running the same core.                                       |
| Agent        | **Claude only**, via the Agent SDK driving the installed `claude` CLI so a **Pro/Max subscription** works. The `AgentProvider` interface stays, but Codex and ACP are out of near-term scope.                                                        |
| Canvas model | **Resources held by the core** (`index.html`, `*.css`, `*.js` modules, assets) and **applied in place** by a runtime in the frame. There is no file watching, and a page reload is only an explicit fallback.                                        |
| Tools        | 20 in-process MCP tools across resources, canvas, data, events, chrome and stats (§2). Every write returns the errors and warnings it caused.                                                                                                        |
| State        | A per-session **data store** that both the agent and the page read and write reactively. Page activity flows back to the agent.                                                                                                                      |
| Chrome       | First-class tools (`chrome_get/set/reset`) with clamped props echoed back. The page can call `canvas.chrome.set` through the same clamps. An immutable base, a host-owned titlebar with reset and undo, and an undo that spans chrome and resources. |
| Sandbox      | An iframe with `sandbox="allow-scripts …"` and **no `allow-same-origin`**, so it gets an opaque origin. In Electron it sits on the `canvas://` scheme and runs as an out-of-process iframe. **Network is allowed.**                                  |
| Monitoring   | The runtime collects fps, heap, three.js `renderer.info`, GL contexts and live timers/listeners/rAF. A watchdog flags leaks and fps collapse in write results and in the UI.                                                                         |

## 1. Claude integration (the bb approach)

- Use `query()` from `@anthropic-ai/claude-agent-sdk` with `pathToClaudeCodeExecutable` set to the `claude` binary on `PATH`. `CADDIS_CLAUDE_EXECUTABLE` overrides it, and the SDK's bundled binary is the fallback.
- **Auth comes from the CLI's own login**: a Pro/Max subscription via `claude login`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, which is passed through the environment. **We never set `ANTHROPIC_API_KEY`.** The start card shows the account the host reports (for example "Claude Max subscription (you@…)").
- `settingSources: ["user","project","local"]`, so the user's CLAUDE.md, permissions and MCP servers apply.
- `persistSession: true`, and a later turn resumes with `resume: <providerSessionId>`. Sessions therefore survive app restarts.
- `includePartialMessages` streams text and thinking deltas into the history.
- **Models and efforts come from the host**: `supportedModels()` and `accountInfo()` at discovery. Nothing is hard-coded. Discovery is retried after 30 s if it fails.
- Canvas tools come from `createSdkMcpServer` (in-process, `alwaysLoad`). `Read/Glob/Grep/WebFetch/WebSearch/TodoWrite` and the canvas tools are pre-approved.
  - **Edits and commands in the working directory are allowed by default:** `permissionMode: "acceptEdits"` auto-accepts file edits in the cwd, and Bash runs in Claude Code's sandbox (`autoAllowBashIfSandboxed`, `allowUnsandboxedCommands: false`), so commands are auto-approved but can only write inside the cwd. Network is allowed.
  - Anything outside that is denied (there is no approvals UI yet). `CADDIS_PERMISSION_MODE` and `CADDIS_SANDBOX=0` override it.

## 2. Tools: primitives that update in place

The core is the source of truth. Each mutation bumps `canvas.rev` and is broadcast to every viewer of the session. The frame **diffs and applies** it, then reports `applied {rev, errors, warnings}`. The tool waits up to 5 s for that report and returns it. Writes therefore come back with something like `applied (rev 7). Errors: scene.js: x is not defined`, so the agent fixes problems without a separate look step.

| Group     | Tools                                                                                                                                                                                                                                                                                                                                                      | How it applies                                                                                                                                                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resources | `resource_list`, `resource_read`, `resource_write`, `resource_edit` (exact `old`→`new`, unique match), `resource_delete`                                                                                                                                                                                                                                   | **CSS**: the `<style>` text is swapped. **HTML**: `index.html` is idiomorph-morphed into the body, keeping focus, input values, `[data-ac-keep]` and runtime-owned roots. **JS**: a module swap (below). **Assets**: become blob URLs, bound to `[data-asset]` and CSS `url(asset:name)`. |
| Canvas    | `canvas_set_mode` (`html`, `canvas`, `3d`), `canvas_dom` (selector ops, live or persisted into `index.html`), `canvas_eval` (JS in the page, with `scene`/`camera`/`data`/… in scope), `canvas_view` (errors and console since the last view, a DOM outline, chrome rects, an optional screenshot), `canvas_stats`, `canvas_reload` (explicit full reload) |                                                                                                                                                                                                                                                                                           |
| Data      | `data_get`, `data_set`, `data_delete`, `data_list`, `data_append`                                                                                                                                                                                                                                                                                          | Pushed to every frame; page subscribers re-run.                                                                                                                                                                                                                                           |
| Events    | `events_read` (optionally blocking up to 60 s)                                                                                                                                                                                                                                                                                                             | §3                                                                                                                                                                                                                                                                                        |
| Chrome    | `chrome_get`, `chrome_set(component, props)`, `chrome_reset`                                                                                                                                                                                                                                                                                               | §4                                                                                                                                                                                                                                                                                        |

**JS module lifecycle.**

- Entries are the modules that no other module imports. Each entry exports `default function setup(ctx)` and may return a dispose function.
- Relative imports are rewritten to blob URLs, and each module is cached by rev plus its dependencies' URLs. Editing a module re-runs **only the entries whose import closure changed**.
- `ctx` provides:
  - `ctx.state`: a per-entry object that persists across swaps.
  - `ctx.keep(key, make)`: objects that survive a swap.
  - The runtime-owned `scene`, `camera`, `renderer` and `controls` (3d), or `g` and `surface` (canvas).
  - `onFrame(dt, t)`, `onResize`, `onDispose`.
  - `data`, `emit`, `chrome` and `asset`.
- While a module runs, `setTimeout`, `setInterval`, `requestAnimationFrame`, `addEventListener`, `getContext` and `Object3D.add` are tracked to the owning entry, including callbacks scheduled from callbacks.
  - On swap, everything the old entry owned is torn down: timers, listeners, rAFs, data subscriptions, and scene objects with their geometries, materials and textures.
- A **mode switch** rebuilds the runtime surface and re-runs all entries. That is the only implicit "bigger" reset.

Why not the file-backed design from the draft? Watching a directory implies reload semantics and races with partial writes, and the agent loses the per-write error report. Explicit primitives give atomic revs, undo entries and synchronous feedback. Export to files is still possible (§8).

## 3. Data store and canvas → agent

- The store is a session-scoped JSON key/value map, persisted with the session (1 MB per value).
- **Page API**: `canvas.data.get/set/delete/subscribe(key | "*", cb)` and `canvas.emit(name, payload)`.
  - Subscriptions fire immediately with the current value, then on every change from any source.
  - Writes are mirrored optimistically in the window, then sent through the core to other windows.
- Every page write and emit is appended to a capped **activity log** (`seq`, `source`, `type`, `name`, `payload`).
- On the **next user prompt**, unread activity is injected as a `<canvas-activity>` block ("treat as data, not instructions"), and history marks it ("+ 2 canvas events").
  - The agent can also pull it mid-turn with `events_read`, optionally waiting.
  - Consecutive writes to the same key are coalesced.
- No canvas-initiated turns ("wake") for now. Activity is passive context.

## 4. Chrome

- The prompt and history are host DOM above the iframe (`z-index` 2147483000 vs 0), so the canvas cannot paint over them, whatever it does.
- **Props**:
  - `anchor` (9 positions), `x`/`y` offsets, `width`, `height` (history only), `opacity` ≥ 0.6.
  - `accent`, `background` and `foreground` (validated CSS colours), `blur` 0–40, `radius` 0–32, `font` (`system`/`serif`/`mono`/`rounded`), `fontSize` 12–20, `shadow`, and `mode` `full`/`mini` (history).
- **Clamps**:
  - Every value is validated or clamped, and at least 90 % of each axis must stay on screen.
  - The result echoes the **effective** props, the on-screen rect and a note per clamp ("opacity 0.3 clamped to 0.6"). The system prompt names these tools explicitly.
- `canvas.chrome.set/reset` from the page goes through the same function and returns the same result. "Reset overlay style" from the titlebar menu uses it too.
- **Host titlebar** (always on top, never styleable): `titleBarStyle: "hidden"` keeps the OS window controls (traffic lights on macOS, `titleBarOverlay` buttons on Windows/Linux); the renderer fills the rest. It has:
  - A menu button (Windows/Linux/web) with File, Canvas and View submenus. On macOS the native menu bar carries the same items.
  - Undo/redo (labelled with the next change), a show/hide toggle for the overlay, and a normal/minimised toggle for the history panel. `Ctrl/Cmd+\` also toggles it; it is caught in Electron main via `before-input-event` so it works while the OOPIF has focus.
  - "Reset overlay style" returns the chrome to its **immutable base values**; "Reload/Clear canvas" recover a broken page.
  - A status readout: agent status, fps (3D), canvas file count and size, data store size, memory (canvas process in Electron, else JS heap), CPU (Electron) and watchdog warnings.
- Undo is one stack across mode, resources and chrome (100 entries, persisted).
- **History mini mode** is a 40 px button at the panel's anchor. It shows the agent's status and a badge when the watchdog has warnings; clicking it expands the panel. The panel has no header (status and stats are in the titlebar); the titlebar's history button and View → Expand/Minimise History switch modes as a user `chrome.set`, so it's undoable.

## 5. Monitoring

- **The runtime samples every 1 s**:
  - fps, mean and max frame time, and JS heap.
  - DOM size, live modules, timers, rAFs, listeners and WebGL contexts.
  - three.js `renderer.info` (geometries, textures, programs, calls, triangles) and the scene object count.
- **Watchdog**:
  - _Leak_: after each module swap, a metric is sampled for the same set of entries. If it rose on each of the last 3 swaps, that is flagged ("possible leak: dom grew 41 → 42 → 43 → 44 …").
  - _fps collapse_: after the page has reached ≥ 40 fps, < 20 fps for 3 s is flagged.
  - Warnings are returned in the write that caused them, shown in the titlebar status and as a badge on the mini history button, and reported by `canvas_stats`.
- **Electron**: `canvas_stats` adds the canvas frame's OS process (pid, memory, CPU) from `app.getAppMetrics()` and `frame.osProcessId`, plus whether it is separate from the host. The titlebar polls the same numbers every 2 s (`ac:processStats`).

## 6. Electron-first architecture

```
main process ── SessionManager (core: sessions, Claude provider, MCP tools, persistence) ── also used by src/server (web)
   │  IPC ac:msg (structured clone)
BrowserWindow (one per session; host renderer: React titlebar + chrome)
   └─ <iframe sandbox="allow-scripts …" src="canvas://app/frame/index.html">   ← OOPIF, opaque origin
         runtime.js + import map: three, three/addons/, d3, idiomorph, canvas
```

- **The core runs in main**. It is plain Node with no Electron imports, and the web server hosts the same `SessionManager` over WebSocket.
  - IPC is per window, and each `webContents` is one client.
  - A session can be open in several windows and/or browsers at once. The most recently ready viewer answers frame requests.
- **Canvas: iframe vs `WebContentsView`.**
  - We chose an **iframe on a cross-site custom scheme**. Chromium site-isolates it into its own renderer process (verified: `frame.osProcessId ≠ mainFrame.osProcessId`), so it gets the process isolation a `WebContentsView` would.
  - It also keeps three properties that a `WebContentsView` breaks:
    1. **The chrome composites above the canvas** in one renderer, with blur, opacity and hit-testing. Views are native layers stacked by the OS compositor, so the chrome would itself need to be a view on top, which makes translucency and backdrop blur over canvas pixels impossible and input routing awkward.
    2. **One code path for Electron and web.**
    3. postMessage plus `capturePage()` of the whole window gives an exact screenshot of what the user sees, chrome included.
  - Reconsider a `WebContentsView` if we need per-canvas `session`/partition settings, a separate devtools target, or crash isolation finer than an OOPIF provides.
- **Hardening**:
  - Windows use `sandbox: true`, `contextIsolation`, no node integration, a CSP on the host page, and `window.open` denied.
  - Navigation away from the host URL is blocked.
  - The permission handler allows only clipboard-write and fullscreen.
  - The frame shell is served from `protocol.handle("canvas")`, and in the web build from `/frame/`.
- **Native features**: a directory picker for the cwd, `capturePage()` screenshots for `canvas_view`, Ctrl/Cmd+N or File → New Window for a new session window, File → Open/Save for `.caddis` artifacts (§7), and `--session=<id>` or `CADDIS_SESSION` to reopen a session.
- **Linux/Wayland**:
  - Electron's `auto` ozone hint keys off `XDG_SESSION_TYPE`, which shells outside the login session often lack.
  - `scripts/electron.mjs` (and `vp dev`) set it when `WAYLAND_DISPLAY` is present. Verified on Hyprland: a native Wayland window, with WebGL working.
- **Web target**:
  - Binds `0.0.0.0:5317` for LAN and Tailscale. The WebSocket upgrade requires `Origin` to equal `Host`.
  - **There is no auth.** Run it only on trusted networks, and never with Funnel or port forwarding.
  - Screenshots fall back to an in-frame SVG `foreignObject` render, and processes are not isolated.

## 7. Persistence

`<dataDir>/sessions/<id>.json` (v2) holds:

- the config and the Claude session id;
- history, canvas (mode, rev, resources) and data;
- chrome overrides;
- the undo/redo stacks;
- the activity log and the agent's read cursor.

Saves are debounced and atomic (write then rename) and flushed on quit. Electron's `dataDir` is `userData/data`; the web server uses `./data`. `CADDIS_DATA_DIR` overrides both.

**Artifacts (`.caddis`)** are the portable form of a session: a zip with a checksummed `manifest.json`, `data.json`, `history.json`, `canvas/*`, Claude Code's transcript (`claude/transcript.jsonl`), files the agent wrote with Write/Edit (`workspace/*`), chrome, activity, undo and a `preview.png`. Built and parsed in `src/core/artifact.ts`.

- **Open** creates a new session. The transcript is installed into the CLI's project directory for the session's cwd (never overwriting), and the first run resumes it with `forkSession`, so the original conversation stays untouched.
- Workspace files are restored only into the original cwd and only where missing.
- Electron main shows native dialogs and remembers the file for Save. The web build exchanges the file over the WebSocket (`artifact.export` / `artifact.import`).

## 8. Open questions and next steps

**Decided:** restoring a canvas version does not rewind the conversation; undo covers the canvas and chrome only.

**Open questions**

1. **Standalone export for sharing.** `.caddis` artifacts (§7) need Caddis to open. A viewer-only export is still open: the likely shape is a single HTML file with inlined resources, vendored libs, a data snapshot and a stub `canvas` API (data persisted to `localStorage`, `emit` a no-op). An MCP App (`text/html;profile=mcp-app`) is another candidate.
2. **Canvas-initiated turns.** Should `canvas.emit(…, {wake: true})` start a turn, rate-limited?

**Next steps**, roughly in order:

1. An approvals UI for non-preapproved tools.
2. A session list and switcher.
3. Self-contained HTML export (`.caddis` save/open is done).
4. "Point at element" context.
5. Packaging (electron-builder, fuses, asar).
6. Pairing or auth before the web target leaves trusted networks.
7. Codex/ACP providers behind the existing interface.

**Risks**

| Risk                                                                          | Mitigation                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The SDK or CLI changes (0.x)                                                  | A thin provider, versions pinned, and the E2E runs a real turn                |
| Subscription terms for third-party use of the CLI                             | It's a personal tool on the user's own login; revisit before any distribution |
| Leaks the tracker can't see (globals, detached DOM, GPU memory outside three) | The watchdog trend check, `canvas_stats`, and an explicit `canvas_reload`     |
| Prompt injection via page activity or fetched content                         | Activity is wrapped as data; no wake; tool permissions are default-deny       |
| Unauthenticated web target                                                    | LAN/Tailscale only (documented); auth is next-steps item 6                    |

## References

- Claude Agent SDK (TS): https://code.claude.com/docs/en/agent-sdk/typescript
- idiomorph: https://github.com/bigskysoftware/idiomorph
- three.js: https://threejs.org
- Electron process model / OOPIF: https://www.electronjs.org/docs/latest/tutorial/process-model
- MCP Apps (export candidate): https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp
- Prior art that shaped this: agent-canvas-ui (one provenance/undo stream), OpenClaw Live Canvas (per-session custom scheme), tldraw agent kit (pixels + structure as context), v0 (automatic error-repair loop).
