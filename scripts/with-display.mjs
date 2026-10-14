#!/usr/bin/env node
// Runs a command (electron / electron-vite) with a clean Electron env and the
// right display backend. Electron's ozone "auto" hint keys off XDG_SESSION_TYPE; shells
// started outside the login session (terminals in tools, ssh+WAYLAND_DISPLAY)
// often lack it, and on a Wayland-only compositor Electron then looks for X.
import { spawn } from "node:child_process";

const env = { ...process.env };
// Terminals spawned by Electron apps (bb, VS Code, ...) often export this, which
// makes the electron binary run as plain Node and fail to import "electron".
delete env.ELECTRON_RUN_AS_NODE;
if (process.platform === "linux" && !env.XDG_SESSION_TYPE && env.WAYLAND_DISPLAY) env.XDG_SESSION_TYPE = "wayland";
const [cmd, ...args] = process.argv.slice(2);
const child = spawn(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32" });
child.on("exit", (code, sig) => (sig ? process.kill(process.pid, sig) : process.exit(code ?? 0)));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
