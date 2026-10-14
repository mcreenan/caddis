# Agent Canvas protocol (v1)

Source of truth: [`src/shared/protocol.ts`](../src/shared/protocol.ts). This file is the prose version.
Bump `PROTOCOL_VERSION` on any breaking change; the server rejects a `hello` with a different version.

```
 browser window                                       Node server (:5317)
┌──────────────────────────────────────────┐   WS /ws   ┌─────────────────────────────┐
│ chrome (prompt, history)  z=2147483000   │◀──────────▶│ Session (source of truth)   │
│ safe mode / corner button z=2147483600   │            │  canvas doc + undo/redo     │
│ ┌──────────────────────────────────────┐ │            │  chrome overrides + undo    │
│ │ iframe sandbox="allow-scripts"  z=0  │ │            │  history, console buffer    │
│ │  bridge.js + runtime.js + agent code │ │            │  provider run (Claude SDK)  │
│ └──────────────────────────────────────┘ │            │   └ in-process MCP "canvas" │
│      ▲ postMessage (ToFrame/FromFrame)   │            └─────────────────────────────┘
└──────┴───────────────────────────────────┘                data/sessions/<id>.json
```

## 1. Canvas document

```ts
CanvasDoc { version, mode: "html"|"canvas"|"3d", html, css, script, context: "2d"|"webgl"|"webgl2", updatedAt }
```

- `version` increases on every change (write, patch, mode, undo/redo, clear).
- `html` is body markup. In `canvas`/`3d` modes it overlays the drawing surface.
- `script` is the body of an async function, run after the mode runtime is set up. In scope:
  - every mode: `THREE`, `d3`, `api {width,height,dpr,mode,version}`, `onFrame(fn(t,dt))`, `onResize(fn(w,h))`
  - `canvas`: `canvas`, `ctx` (2d, or WebGL when `context` is set; `gl` is the same), auto-resized with DPR
  - `3d`: `scene`, `camera`, `renderer`, `controls` (OrbitControls), `canvas`; the runtime renders every frame
  - `await import("three/addons/...")` works through an import map
- Libraries are served locally from `node_modules` at `/vendor/three/`, `/vendor/three/addons/`, and `/vendor/d3/`. Nothing is loaded from the internet.
- The server keeps up to 100 undo states and a redo stack.

## 2. WebSocket (`/ws`, JSON, field `t` is the type)

The connection must be same-origin: when an `Origin` header is present, its host must match `Host`.

### Client → server

| `t` | fields | notes |
|---|---|---|
| `hello` | `v`, `sessionId?` | Attach to an existing session. The reply is `session.snapshot` or `session.none`. |
| `session.start` | `config {provider, model, effort, cwd}`, `prompt` | Creates a session, attaches to it, and sends the first prompt. |
| `prompt` | `text` | Queued into the running agent. Starts or resumes the agent if needed. |
| `interrupt` | | |
| `canvas.rendered` | `version` | The iframe finished building or patching to `version`. |
| `canvas.console` | `entries[] {level, message, ts, version}` | Console output and errors from the iframe. The parent stamps `version`. |
| `canvas.result` | `requestId, ok, value?, error?, image?` | Reply to `canvas.request`. |
| `canvas.undo` / `canvas.redo` / `canvas.clear` | | Used from safe mode. |
| `chrome.set` | `component, props` | A user-originated chrome change, such as un-minimising. It is normalised the same way as agent changes. |
| `chrome.undo` / `chrome.reset` | | Used from safe mode. |

### Server → client

| `t` | fields |
|---|---|
| `welcome` | `v, providers[], defaultCwd` (always sent first) |
| `session.snapshot` | full `SessionSnapshot` (config, status, history, canvas, chrome, undo counts) |
| `session.none` | `sessionId?` |
| `history.append` | `item` |
| `history.update` | `id, patch, appendText?` (`appendText` carries streamed text) |
| `status` | `status: idle\|thinking\|tool\|error, detail?` |
| `canvas.state` | `canvas, undo`: do a full rebuild |
| `canvas.patch` | `patch, canvas, undo`: patch live if the frame is at `canvas.version-1`, otherwise rebuild |
| `canvas.request` | `requestId, kind: "eval", js` or `requestId, kind: "snapshot", maxWidth` |
| `chrome.state` | `chrome, undo` |
| `error` | `message` |

`HistoryItem` kinds are `user`, `assistant`, `thinking`, `tool {name,input,state,result}`, `turn {ok,durationMs,costUsd,error}`, and `notice`.

## 3. postMessage (parent ⇄ sandboxed iframe)

Every message carries `{ ch: "agent-canvas", v: 1 }`. The iframe has an opaque origin (sandbox without `allow-same-origin`), so `targetOrigin` is `*`. Each side authenticates by `event.source`. The parent only accepts messages from the `contentWindow` of an iframe it created, and the bridge only accepts messages from `parent`. The parent re-validates and truncates every field it forwards.

| direction | `type` | fields |
|---|---|---|
| parent → frame | `eval` | `id, js` |
| parent → frame | `snapshot` | `id, maxWidth` |
| parent → frame | `patch` | `patch, version` |
| frame → parent | `ready` | `version` (the script has settled and a frame has painted, or a timeout fired) |
| frame → parent | `result` | `id, ok, value?, error?, image? {data(base64), mimeType}` |
| frame → parent | `console` | `entries[], version` |
| frame → parent | `escape` | The escape-hatch hotkey was pressed inside the canvas. |

Full renders are double-buffered. The new iframe (`srcdoc`) loads under the old one and replaces it on `ready`.

## 4. Agent tools (MCP server `canvas`, exposed as `mcp__canvas__<name>`)

| tool | args | result |
|---|---|---|
| `canvas_set_mode` | `mode, context?` | Keeps html/css and clears the script. Returns a render report. |
| `canvas_write` | `mode?, html?, css?, script?, context?` | Full replace (omitted fields become empty). Waits up to 4s for a live viewer to rebuild, then returns `Rendered vN OK` or the errors it collected. |
| `canvas_patch` | `selector, op, content?, all?` | Ops: `replace\|inner\|append\|prepend\|before\|after\|remove\|attr\|style\|text`. Applied to the stored HTML on the server (linkedom) and live in the iframe without a reload. |
| `canvas_eval` | `js` | Runs in the live iframe with the same scope as `script` and returns the JSON-serialised value. Not persisted. |
| `canvas_get_state` | | Source and console output for the current version |
| `canvas_snapshot` | `maxWidth?` | A PNG image content block. Captures the drawing surface plus the HTML layer (via SVG foreignObject). |
| `chrome_update` | `component: prompt\|history, props` | Returns the applied props and clamp notes. |
| `chrome_reset` | `component?` | |

`eval` and `snapshot` round-trip through server → WS → parent → iframe → parent → WS → server. They time out after 15s. Without a connected viewer they fail immediately.

## 5. Chrome clamps

The prompt and the history panel always exist. They render in a layer whose z-index the canvas iframe cannot exceed. Agent-settable props: `x, y, width, height (history only), opacity, accent, background, foreground, blur, radius, mini (history only)`.

- Server-side normalisation (`normaliseChromeProps`): opacity 0.6–1, blur 0–40, radius 0–32, width ≥ 280 (prompt) / 240 (history), height ≥ 160, colours must match a CSS colour grammar (no `url()`/`var()`), and unknown keys are dropped. The agent gets notes on anything that was changed.
- Client-side layout clamp (`clampRect`): at least 90% of each axis stays on-screen (≥ 81% of the area), re-applied on every resize. The client also re-clamps opacity, blur, and radius and re-validates colours before applying them as CSS variables. No `display`, `visibility`, or `z-index` is exposed.
- Every chrome change is pushed onto an undo stack.

**Escape hatch:** Ctrl/Cmd+Shift+Esc (also forwarded from inside the iframe) or the tiny ◐ button in the bottom-left corner. Either opens a safe-mode overlay at an even higher z-index. It ignores agent styling and offers a base history view, a base prompt, Reset chrome, Undo chrome, Undo/Redo/Clear canvas, Hide canvas, and New session.
