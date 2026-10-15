import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Find `name` on PATH, plus the usual install spots a GUI launch's minimal PATH misses. */
export function findExecutable(name: string): string | undefined {
  if (path.isAbsolute(name)) return isExecutable(name) ? name : undefined;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  dirs.push(
    path.join(os.homedir(), ".local/bin"),
    path.join(os.homedir(), ".claude/local"),
    path.join(os.homedir(), ".opencode/bin"),
    path.join(os.homedir(), ".bun/bin"),
    path.join(os.homedir(), ".cargo/bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  );
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const d of dirs)
    for (const ext of exts) {
      const p = path.join(d, name + ext);
      if (isExecutable(p)) return p;
    }
  return undefined;
}

function isExecutable(p: string) {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Reject after `ms` with `what` in the message. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`timed out ${what}`)), ms))),
  ]).finally(() => clearTimeout(timer));
}
