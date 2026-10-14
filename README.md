# Agent Canvas

Each window is one Claude session. The window itself is a live canvas the agent builds while you talk to it. The prompt and history float above the canvas: the agent can restyle them within limits, but it can't remove them.

Design: [docs/PLAN.md](docs/PLAN.md). Wire protocol and tools: [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Requirements

- Node 24+.
- The `claude` CLI, logged in. A Pro/Max subscription works: run `claude login`, or set `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.
- No API key is needed, and the app never sets `ANTHROPIC_API_KEY`.

## Run

```sh
npm install
npm start            # Electron: build, then open a window (Ctrl/Cmd+N opens another)
npm run dev          # Electron with renderer HMR
npm run web          # secondary target: build, then serve on http://0.0.0.0:5317
npm run serve        # serve an existing build
npm run typecheck
npm run e2e                                              # Electron E2E (real Claude turns)
TARGET=web BASE=http://192.168.86.73:5317 npm run e2e    # same E2E against `npm run serve`
```

| Variable | Purpose |
|---|---|
| `AGENT_CANVAS_DATA_DIR` | Session storage. Defaults to Electron `userData/data`, or `./data` for web |
| `AGENT_CANVAS_DEFAULT_CWD` | Default working directory (`$HOME`) |
| `AGENT_CANVAS_CLAUDE_EXECUTABLE` | Path to `claude`. Defaults to `PATH` |
| `AGENT_CANVAS_PERMISSION_MODE` | SDK permission mode (`dontAsk`) |
| `AGENT_CANVAS_SESSION` or `--session=<id>` | Reopen a session in Electron |
| `HOST`, `PORT` | Web listener (`0.0.0.0`, `5317`) |

On Linux, `scripts/with-display.mjs` makes Electron use Wayland when `WAYLAND_DISPLAY` is set but `XDG_SESSION_TYPE` isn't, which is common for shells started outside the login session.

The web target has **no authentication**. Use it only on networks you trust, such as your LAN or tailnet.

## Using it

1. Describe what the window should become. Pick a model and effort (both reported by your Claude login) and a working directory.
2. The agent builds the canvas with tools that update it **in place**:
   - CSS swaps, and HTML morphs.
   - JS modules re-run with their `ctx.state` kept.
   - Every write reports the errors it caused.
3. Pages can share state with the agent: `canvas.data.get/set/subscribe` and `canvas.emit`. Your interactions are attached to your next message.
4. The agent (or the page) can move and restyle the prompt and history with `chrome_set`. Values are clamped, and the clamps are reported back.
5. The stats chip in the history shows fps or a ⚠ count when the watchdog sees leaks or an fps collapse.
6. **Escape hatch:** Ctrl/Cmd+Shift+Esc, or the ⎋ button in the bottom-left corner, opens safe mode. It offers labelled undo/redo (covering canvas and chrome), reset chrome, hide/reload/clear canvas, a new window, and an unstyled history and prompt.

## Layout

```
src/shared/      protocol.ts (v2 messages and types), chrome.ts (base, limits, clamping, layout)
src/core/        session core shared by Electron main and the web server
  manager.ts     providers, sessions, per-client message handling
  session.ts     canvas/data/chrome state, undo, frame requests, persistence
  tools.ts       the MCP tools (in-process SDK MCP server "canvas")
  providers/     AgentProvider interface + Claude (Agent SDK on the claude CLI)
  static.ts      serves the frame shell + vendored three/d3/idiomorph
  dom.ts         persisted DOM ops on index.html (linkedom)
src/main/        Electron main: windows, IPC, canvas:// protocol, capturePage, process stats
src/preload/     contextBridge API (window.agentCanvas)
src/renderer/    React UI: start card, chrome, history, safe mode, iframe host
src/canvas/      frame.html + runtime.js (apply-in-place, module lifecycle, data, stats, watchdog)
src/server/      web target: HTTP + WebSocket on 0.0.0.0:5317
scripts/e2e.ts   end-to-end test (Electron or web) with real Claude turns
```
