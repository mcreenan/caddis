import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pkg from "../../package.json";
import {
  CANVAS_MODES,
  RESOURCE_NAME_RE,
  emptyChrome,
  resourceKind,
  type CanvasEvent,
  type CanvasMode,
  type ChromeState,
  type HistoryItem,
  type SessionTitle,
  type Resource,
  type SessionConfig,
} from "../shared/protocol";
import type { Persisted, UndoEntry } from "./session";
import { readZip, writeZip, type ZipEntry } from "./zip";

/**
 * `.caddis` artifacts: a zip holding everything needed to reopen a session
 * elsewhere, plus a manifest that lists (and checksums) every file in it.
 *
 *   manifest.json            this index
 *   data.json                the data store shared by the agent and the page
 *   history.json             the conversation as shown in the history panel
 *   canvas/<name>            every canvas resource (index.html, css, js, assets)
 *   chrome.json              prompt/history style overrides
 *   activity.json            the canvas activity log and the agent's read cursor
 *   undo.json                undo/redo stacks
 *   claude/transcript.jsonl  Claude Code's own session transcript, so the conversation can resume
 *   workspace/<path>         files the agent wrote in the working directory (Write/Edit tools)
 *   preview.png              what the window looked like when saved
 */

export const ARTIFACT_FORMAT = "caddis-artifact";
export const ARTIFACT_VERSION = 1;
export const ARTIFACT_EXT = "caddis";

const MAX_WORKSPACE_FILE = 8 * 1024 * 1024;
const MAX_WORKSPACE_TOTAL = 64 * 1024 * 1024;
const WRITE_TOOLS: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

export type ArtifactFileRole =
  | "data"
  | "history"
  | "canvas"
  | "chrome"
  | "activity"
  | "undo"
  | "transcript"
  | "workspace"
  | "preview";

export interface ManifestFile {
  path: string;
  role: ArtifactFileRole;
  size: number;
  sha256: string;
  mime?: string;
  /** canvas: resource name, kind and the rev it last changed at. */
  resource?: { name: string; kind: Resource["kind"]; binary: boolean; rev: number; updatedAt: number };
  /** workspace: path relative to the session's working directory. */
  source?: string;
}

export interface Manifest {
  format: typeof ARTIFACT_FORMAT;
  version: number;
  app: { name: "caddis"; version: string };
  savedAt: number;
  title: string;
  /** `title` is set when the agent or user named the session; the top-level `title` always has a value. */
  session: { id: string; createdAt: number; config: SessionConfig; providerSessionId?: string; title?: SessionTitle };
  canvas: { mode: CanvasMode; rev: number };
  summary: {
    turns: number;
    userMessages: number;
    toolCalls: number;
    costUsd: number;
    dataKeys: number;
    resources: number;
  };
  files: ManifestFile[];
  /** Things that could not be included (missing or oversized workspace files, no transcript…). */
  notes: string[];
}

export interface ParsedArtifact {
  manifest: Manifest;
  history: HistoryItem[];
  data: Record<string, unknown>;
  resources: Record<string, Resource>;
  chrome: ChromeState;
  activity: { events: CanvasEvent[]; eventSeq: number; agentCursor: number };
  undo: { undo: UndoEntry[]; redo: UndoEntry[] };
  transcript?: Buffer;
  workspace: { rel: string; data: Buffer }[];
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const jsonBuf = (v: unknown) => Buffer.from(JSON.stringify(v, null, 1));

/** The chosen title, else the first line of the first prompt. */
export function sessionTitle(d: { history: HistoryItem[]; title?: SessionTitle }) {
  if (d.title) return d.title.text;
  const first = d.history.find((h) => h.kind === "user");
  const line = first?.kind === "user" ? first.text.split("\n")[0].trim() : "";
  return (line.length > 60 ? `${line.slice(0, 57)}…` : line) || "Untitled canvas";
}

export function artifactFilename(title: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "canvas"}.${ARTIFACT_EXT}`;
}

// ---------------------------------------------------------------------------
// Claude Code transcripts (<config>/projects/<sanitised cwd>/<session id>.jsonl)
// ---------------------------------------------------------------------------

const claudeProjects = () => path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects");
/** Mirrors the CLI's project-directory naming. Paths over 200 chars get a hash suffix we can't reproduce. */
const projectDirName = (cwd: string) => {
  const s = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return s.length <= 200 ? s : undefined;
};
const realCwd = (cwd: string) => {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
};

function findTranscript(sessionId: string, cwd: string): string | undefined {
  const root = claudeProjects();
  const preferred = projectDirName(realCwd(cwd));
  if (preferred) {
    const f = path.join(root, preferred, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  try {
    for (const d of readdirSync(root)) {
      const f = path.join(root, d, `${sessionId}.jsonl`);
      if (existsSync(f)) return f;
    }
  } catch {}
  return undefined;
}

/** Install a transcript where the CLI will find it when resuming in `cwd`. Never overwrites. */
export function installTranscript(sessionId: string, cwd: string, data: Buffer): boolean {
  if (!/^[\w-]{1,64}$/.test(sessionId)) return false;
  const dir = projectDirName(realCwd(cwd));
  if (!dir) return false;
  const file = path.join(claudeProjects(), dir, `${sessionId}.jsonl`);
  if (existsSync(file)) return true;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  return true;
}

// ---------------------------------------------------------------------------
// Workspace files Claude wrote
// ---------------------------------------------------------------------------

/** Paths (relative to cwd) of files the agent created or edited with its file tools. Bash side effects aren't tracked. */
export function writtenFiles(history: HistoryItem[], cwd: string): string[] {
  const out = new Set<string>();
  for (const h of history) {
    if (h.kind !== "tool" || h.state === "error") continue;
    const key = WRITE_TOOLS[h.name];
    const input = h.input as Record<string, unknown> | undefined;
    if (!key || !input) continue;
    // Claude names the path `key`; other agents' edits use filePath/path, or list several in `files`.
    const paths = [input[key], input.filePath, input.path, ...(Array.isArray(input.files) ? input.files : [])];
    for (const p of paths) {
      if (typeof p !== "string") continue;
      const rel = safeRelative(cwd, path.resolve(cwd, p));
      if (rel) out.add(rel);
    }
  }
  return [...out].sort();
}

function safeRelative(root: string, abs: string) {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildArtifact(d: Persisted, preview?: Buffer): { buffer: Buffer; manifest: Manifest } {
  const entries: ZipEntry[] = [];
  const files: ManifestFile[] = [];
  const notes: string[] = [];
  const add = (p: string, data: Buffer, role: ArtifactFileRole, extra: Partial<ManifestFile> = {}) => {
    entries.push({ path: p, data });
    files.push({ path: p, role, size: data.length, sha256: sha256(data), ...extra });
  };

  add("data.json", jsonBuf(d.data), "data", { mime: "application/json" });
  add("history.json", jsonBuf(d.history), "history", { mime: "application/json" });
  for (const r of Object.values(d.canvas.resources).sort((a, b) => a.name.localeCompare(b.name))) {
    const data = r.base64 !== undefined ? Buffer.from(r.base64, "base64") : Buffer.from(r.text ?? "");
    add(`canvas/${r.name}`, data, "canvas", {
      mime: r.mime,
      resource: { name: r.name, kind: r.kind, binary: r.base64 !== undefined, rev: r.rev, updatedAt: r.updatedAt },
    });
  }
  add("chrome.json", jsonBuf(d.chrome), "chrome", { mime: "application/json" });
  add("activity.json", jsonBuf({ events: d.events, eventSeq: d.eventSeq, agentCursor: d.agentCursor }), "activity", {
    mime: "application/json",
  });
  add("undo.json", jsonBuf({ undo: d.undo, redo: d.redo }), "undo", { mime: "application/json" });

  // Only Claude's transcript travels; other agents' conversations resume only on the machine that has them.
  const claude = d.config.provider === "claude";
  const transcript = claude && d.providerSessionId ? findTranscript(d.providerSessionId, d.config.cwd) : undefined;
  if (transcript)
    add("claude/transcript.jsonl", readFileSync(transcript), "transcript", { mime: "application/x-ndjson" });
  else if (d.providerSessionId && claude)
    notes.push("Claude's transcript was not found, so the conversation can be read but not resumed.");
  else if (d.providerSessionId)
    notes.push("The agent's own conversation isn't included, so it resumes only on this machine.");

  let total = 0;
  for (const rel of writtenFiles(d.history, d.config.cwd)) {
    const abs = path.join(d.config.cwd, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      notes.push(`workspace/${rel}: no longer exists`);
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_WORKSPACE_FILE || total + st.size > MAX_WORKSPACE_TOTAL) {
      notes.push(`workspace/${rel}: skipped (${Math.round(st.size / 1024)} KB is over the size limit)`);
      continue;
    }
    total += st.size;
    add(`workspace/${rel}`, readFileSync(abs), "workspace", { source: rel });
  }

  if (preview) add("preview.png", preview, "preview", { mime: "image/png" });

  const turns = d.history.filter((h) => h.kind === "turn");
  const manifest: Manifest = {
    format: ARTIFACT_FORMAT,
    version: ARTIFACT_VERSION,
    app: { name: "caddis", version: pkg.version },
    savedAt: Date.now(),
    title: sessionTitle(d),
    session: {
      id: d.id,
      createdAt: d.createdAt,
      config: d.config,
      providerSessionId: d.providerSessionId,
      title: d.title,
    },
    canvas: { mode: d.canvas.mode, rev: d.canvas.rev },
    summary: {
      turns: turns.length,
      userMessages: d.history.filter((h) => h.kind === "user").length,
      toolCalls: d.history.filter((h) => h.kind === "tool").length,
      costUsd: Math.round(turns.reduce((n, t) => n + (t.kind === "turn" ? (t.costUsd ?? 0) : 0), 0) * 10000) / 10000,
      dataKeys: Object.keys(d.data).length,
      resources: Object.keys(d.canvas.resources).length,
    },
    files,
    notes,
  };
  entries.unshift({ path: "manifest.json", data: jsonBuf(manifest) });
  return { buffer: writeZip(entries), manifest };
}

// ---------------------------------------------------------------------------
// Parse (validates everything; the archive may come from anywhere)
// ---------------------------------------------------------------------------

export function parseArtifact(buf: Buffer): ParsedArtifact {
  const zip = readZip(buf);
  const mf = zip.get("manifest.json");
  if (!mf) throw new Error("not a Caddis artifact (no manifest.json)");
  const manifest = JSON.parse(mf.toString("utf8")) as Manifest;
  if (manifest?.format !== ARTIFACT_FORMAT) throw new Error("not a Caddis artifact");
  if (typeof manifest.version !== "number" || manifest.version > ARTIFACT_VERSION)
    throw new Error(
      `this artifact needs a newer Caddis (format v${manifest.version}; this build reads v${ARTIFACT_VERSION})`,
    );
  if (!Array.isArray(manifest.files)) throw new Error("manifest has no file list");

  const listed = new Map<string, ManifestFile>();
  for (const f of manifest.files) {
    const data = zip.get(f.path);
    if (!data) throw new Error(`${f.path} is listed in the manifest but missing from the archive`);
    if (sha256(data) !== f.sha256) throw new Error(`${f.path} does not match its manifest checksum`);
    listed.set(f.path, f);
  }
  const json = <T>(p: string, fallback: T): T => {
    const b = listed.has(p) ? zip.get(p) : undefined;
    return b ? (JSON.parse(b.toString("utf8")) as T) : fallback;
  };

  const resources: Record<string, Resource> = {};
  const workspace: ParsedArtifact["workspace"] = [];
  for (const f of listed.values()) {
    const data = zip.get(f.path)!;
    if (f.role === "canvas") {
      const name = f.path.slice("canvas/".length);
      if (!RESOURCE_NAME_RE.test(name)) throw new Error(`invalid resource name ${name}`);
      const kind = resourceKind(name);
      const binary = kind === "asset" && (f.resource?.binary ?? !isText(f.mime));
      resources[name] = {
        name,
        kind,
        mime: f.mime ?? "application/octet-stream",
        size: data.length,
        rev: Number(f.resource?.rev) || 0,
        updatedAt: Number(f.resource?.updatedAt) || manifest.savedAt,
        ...(binary ? { base64: data.toString("base64") } : { text: data.toString("utf8") }),
      };
    } else if (f.role === "workspace") {
      const rel = f.path.slice("workspace/".length);
      if (rel.split("/").some((s) => !s || s === "." || s === "..") || path.isAbsolute(rel))
        throw new Error(`unsafe workspace path ${rel}`);
      workspace.push({ rel, data });
    }
  }

  const activity = json<ParsedArtifact["activity"]>("activity.json", { events: [], eventSeq: 0, agentCursor: 0 });
  const undo = json<ParsedArtifact["undo"]>("undo.json", { undo: [], redo: [] });
  const chrome = json<ChromeState>("chrome.json", emptyChrome());
  const history = sanitiseHistory(json<unknown>("history.json", []));
  const data = json<Record<string, unknown>>("data.json", {});
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("data.json is not an object");
  if (!CANVAS_MODES.includes(manifest.canvas?.mode)) throw new Error("manifest has an invalid canvas mode");

  return {
    manifest,
    history,
    data,
    resources,
    chrome: { prompt: chrome?.prompt ?? {}, history: chrome?.history ?? {} },
    activity: {
      events: Array.isArray(activity.events) ? activity.events : [],
      eventSeq: Number(activity.eventSeq) || 0,
      agentCursor: Number(activity.agentCursor) || 0,
    },
    undo: { undo: sanitiseUndo(undo.undo), redo: sanitiseUndo(undo.redo) },
    transcript: listed.has("claude/transcript.jsonl") ? zip.get("claude/transcript.jsonl") : undefined,
    workspace,
  };
}

const HISTORY_KINDS = new Set(["user", "assistant", "thinking", "tool", "turn", "notice"]);

/** Keep only well-formed history items, so a hand-edited artifact can't break the history panel. */
function sanitiseHistory(v: unknown): HistoryItem[] {
  if (!Array.isArray(v)) throw new Error("history.json is not a list");
  return v.filter((h): h is HistoryItem => {
    if (!h || typeof h !== "object" || typeof h.id !== "string" || !HISTORY_KINDS.has(h.kind)) return false;
    if ("text" in h && typeof h.text !== "string") return false;
    if (h.kind === "tool") {
      if (typeof h.name !== "string") return false;
      if (h.state === "running") h.state = "error";
      if (h.result !== undefined && typeof h.result !== "string") h.result = String(h.result);
    }
    return typeof h.ts === "number" || ((h.ts = 0), true);
  });
}

function sanitiseUndo(v: unknown): UndoEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (e): e is UndoEntry =>
      !!e &&
      typeof e === "object" &&
      typeof e.label === "string" &&
      (e.mode === undefined || CANVAS_MODES.includes(e.mode)) &&
      Object.keys(e.res ?? {}).every((n) => RESOURCE_NAME_RE.test(n)),
  );
}

const isText = (mime?: string) => !!mime && (mime.startsWith("text/") || /json|xml|svg|javascript/.test(mime));

/**
 * Restore workspace files into `cwd`, writing only files that don't exist yet.
 * Returns what was written and what was left alone.
 */
export function restoreWorkspace(files: ParsedArtifact["workspace"], cwd: string) {
  const written: string[] = [];
  const kept: string[] = [];
  for (const f of files) {
    const abs = path.resolve(cwd, f.rel);
    if (!safeRelative(cwd, abs)) continue;
    if (existsSync(abs)) {
      kept.push(f.rel);
      continue;
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.data);
    written.push(f.rel);
  }
  return { written, kept };
}
