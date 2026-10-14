# Agent Canvas

Each browser window is one agent session. The window is a live canvas that the agent builds while you chat with it. The prompt and the session history float above the canvas. The agent can restyle them within limits, but it can't remove them.

## Run

```sh
npm install
npm start          # builds the frontend, then serves on http://0.0.0.0:5317
```

- `npm run dev` rebuilds the frontend on change (`vite build --watch`) and restarts the server (`tsx watch`), still on :5317.
- `npm run dev:vite` is an optional Vite HMR server on :5318 that proxies `/ws` and `/vendor` to :5317. It binds 0.0.0.0, and its allowed hosts include mattdesktop and the LAN/Tailscale IPs.
- `npm run typecheck`
- `npm run e2e` drives the real UI in headless Chromium. Set `BASE=http://192.168.86.73:5317`. To run your own prompts instead, set `PROMPTS='a||b'`. Artifacts go in `.e2e/`.

Environment variables: `HOST` (default `0.0.0.0`), `PORT` (`5317`), `CANVAS_DATA_DIR` (`./data`), and `CANVAS_DEFAULT_CWD` (`$HOME`).

The Claude provider uses the Claude Agent SDK and authenticates through the local `claude` login. Codex appears in the provider list but is disabled (stub).

## Using it

1. Type a prompt and pick a provider, model, effort, and working directory.
2. After the first message, the options disappear. You get a single-line prompt that auto-grows up to 8 lines, plus the history panel. Click `–` to collapse the panel to an activity dot. The dot pulses while the agent thinks, flashes amber while a tool runs, and turns red on errors. Click the dot to restore the panel.
3. The URL becomes `/?s=<id>`. Reloading restores the session, canvas, and chrome from the server.
4. **Escape hatch:** press Ctrl/Cmd+Shift+Esc or click the tiny ◐ button in the bottom-left corner. You get unstyled base controls: reset/undo chrome, undo/redo/clear canvas, hide canvas, and a base prompt.

## Layout

```
src/shared/protocol.ts   versioned protocol: WS + postMessage messages, tool schemas (zod)
src/shared/chrome.ts     chrome clamping (server normalisation + client viewport clamp)
src/server/index.ts      HTTP (dist/ + /vendor from node_modules) + WebSocket
src/server/session.ts    session state, persistence (data/sessions/*.json), undo, frame requests
src/server/canvasTools.ts  provider-agnostic tool impls + in-process SDK MCP server
src/server/patch.ts      server-side DOM patching (linkedom)
src/server/systemPrompt.ts the (short) canvas system prompt
src/server/providers/    provider interface, Claude Agent SDK provider, Codex stub
src/client/              vanilla TS UI: main.ts, canvasHost.ts (iframe), historyView.ts
public/frame/            bridge.js + runtime.js loaded inside the sandboxed iframe
scripts/e2e.ts           headless end-to-end test
docs/PROTOCOL.md         protocol reference
```

## Security notes

- The canvas runs in `<iframe sandbox="allow-scripts">` with no `allow-same-origin`, so it has an opaque origin. It talks to the parent only through postMessage, and the parent checks `event.source`.
- The agent's built-in tools are limited to `Read`, `Glob`, and `Grep`, plus the canvas tools. It runs with `permissionMode: "dontAsk"`, so any other tool is denied.
- The WebSocket rejects cross-origin upgrades.
