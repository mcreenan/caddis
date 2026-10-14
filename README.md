# Caddis

Caddis is a desktop app where each window is one Claude session, and the window itself is the canvas. Describe what you want and Claude builds it live: a page, a 2D drawing surface or a 3D scene. You keep chatting to change it.

## Requirements

- Node 24 or newer.
- [Claude Code](https://claude.com/claude-code), installed and logged in. A Pro or Max subscription works (`claude login`), and no API key is needed. On a machine without an interactive login, set `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.

## Install and run

```sh
git clone https://github.com/mcreenan/caddis.git
cd caddis
npm install
npm start
```

Ctrl/Cmd+N opens another window, which is a new session.

## Using it

1. **Start a session.** Type what the window should become, then pick a model, effort level and working directory. Models and effort levels come from your Claude login.
2. **Watch it build.** Changes are applied in place without reloading, so 3D scenes keep their camera and animation state as Claude edits them.
3. **Keep talking.** After the first message the prompt shrinks to a single line, and the history panel shows Claude's replies and tool calls. Click `–` to collapse the history to a small dot that pulses while Claude is working.
4. **Interact with the canvas.** Pages Claude builds can store data and send events that Claude sees with your next message. For example, tick off a task on the page, then ask Claude about it.
5. **Let it restyle the controls.** Claude can move and restyle the prompt and history panel, within limits that keep them visible and usable.
6. **Undo or escape.** Press Ctrl/Cmd+Shift+Esc, or click the ⎋ button in the bottom-left corner, to open safe mode. It shows plain, unstyled controls with:
   - undo and redo for the canvas and the controls
   - reset controls
   - hide, reload or clear the canvas
   - new window

Sessions are saved automatically. Reopening one restores its canvas, data and controls.

### What Claude can do

In its working directory, Claude can read and edit files and run shell commands without asking. Commands run in Claude Code's sandbox, which allows writes only inside the working directory and allows network access. Canvas pages are sandboxed from the app but can reach the network.

### Use it from another device

`npm run web` serves Caddis at `http://<this-machine>:5317` for browsers on your LAN or tailnet. It has **no authentication**, and Claude can run commands on this machine, so use it only on networks you trust.

### Settings

| Variable | Purpose |
|---|---|
| `CADDIS_DEFAULT_CWD` | Default working directory (`$HOME`) |
| `CADDIS_DATA_DIR` | Where sessions are stored |
| `CADDIS_CLAUDE_EXECUTABLE` | Path to `claude`, if it isn't on `PATH` |
| `CADDIS_PERMISSION_MODE` | Claude permission mode (default `acceptEdits`) |
| `CADDIS_SANDBOX` | `0` turns off the command sandbox; commands then need pre-approval |
| `CADDIS_SESSION` or `--session=<id>` | Reopen a specific session |
| `HOST`, `PORT` | Web server address (`0.0.0.0`, `5317`) |

## Development

```sh
npm run dev         # Electron with hot reload
npm run typecheck
npm run e2e         # end-to-end test with real Claude turns (TARGET=web for the web build)
```
