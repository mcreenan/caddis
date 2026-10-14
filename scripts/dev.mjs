// Dev loop: rebuild the frontend on change and restart the server on change.
import { spawn } from "node:child_process";

const run = (cmd, args) => spawn(cmd, args, { stdio: "inherit", env: { ...process.env, HOST: process.env.HOST ?? "0.0.0.0", PORT: process.env.PORT ?? "5317" } });
const procs = [run("npx", ["vite", "build", "--watch"]), run("npx", ["tsx", "watch", "src/server/index.ts"])];
const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", (code) => (stop(), process.exit(code ?? 0)));
