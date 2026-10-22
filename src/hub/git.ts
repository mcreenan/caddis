import { execFile } from "node:child_process";

/**
 * A project's git repository, driven through the `git` CLI. Calls are
 * serialised per repository so commits never race each other.
 */

export interface GitAuthor {
  name: string;
  email: string;
}

const MAX_BUFFER = 256 * 1024 * 1024;

function run(cwd: string, args: string[], env: Record<string, string> = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "commit.gpgsign=false", "-c", "core.quotepath=false", ...args],
      {
        cwd,
        encoding: "buffer",
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]}: ${String(stderr).trim() || err.message}`));
        else resolve(stdout);
      },
    );
  });
}

export const COMMIT_RE = /^[0-9a-f]{7,64}$/;

export class Repo {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string) {}

  /** Run `fn` after every earlier call on this repository has finished. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  init() {
    return this.serial(async () => {
      await run(this.dir, ["init", "-q", "-b", "main"]);
    });
  }

  /**
   * Run `prepare` (which writes the working tree), then stage `paths` and commit them, all in turn
   * with every other call. Resolves to the new commit, or undefined when nothing changed.
   */
  commit(paths: string[], message: string, author: GitAuthor, prepare?: () => void): Promise<string | undefined> {
    return this.serial(async () => {
      prepare?.();
      await run(this.dir, ["add", "-A", "--", ...paths]);
      try {
        await run(this.dir, ["diff", "--cached", "--quiet"]);
        return undefined; // nothing staged
      } catch {}
      await run(this.dir, ["commit", "-q", "--no-verify", "-m", message], {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: "Caddis hub",
        GIT_COMMITTER_EMAIL: "hub@caddis.local",
      });
      return String(await run(this.dir, ["rev-parse", "HEAD"])).trim();
    });
  }

  /** Commits that touched `path`, newest first. */
  log(path: string, limit = 100) {
    return this.serial(async () => {
      const out = String(
        await run(this.dir, ["log", `-n${limit}`, "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e", "--", path]).catch(() =>
          Buffer.from(""),
        ),
      );
      return out
        .split("\x1e")
        .map((r) => r.trim())
        .filter(Boolean)
        .map((r) => {
          const [commit, short, author, at, message] = r.split("\x1f");
          return { commit, short, author, ts: Number(at) * 1000, message };
        });
    });
  }

  /** A file's contents at `commit`, or undefined if it didn't exist there. */
  show(commit: string, path: string): Promise<Buffer | undefined> {
    if (!COMMIT_RE.test(commit)) return Promise.reject(new Error("bad commit id"));
    return this.serial(() => run(this.dir, ["show", `${commit}:${path}`]).catch(() => undefined));
  }
}
