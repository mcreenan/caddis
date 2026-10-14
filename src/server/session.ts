import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import { normaliseChromeProps } from "../shared/chrome";
import {
  emptyCanvas,
  emptyChrome,
  type AgentStatus,
  type CanvasContextKind,
  type CanvasDoc,
  type CanvasMode,
  type CanvasPatch,
  type ChromeComponent,
  type ChromeState,
  type ConsoleEntry,
  type HistoryItem,
  type ServerMsg,
  type SessionConfig,
  type SessionSnapshot,
  type UndoInfo,
} from "../shared/protocol";
import type { CanvasToolHost, FrameResult, RenderReport } from "./canvasTools";
import { applyPatch } from "./patch";
import type { AgentProvider, AgentRun, ProviderEvent } from "./providers/types";
import { canvasSystemPrompt } from "./systemPrompt";

const UNDO_LIMIT = 100;
const CONSOLE_LIMIT = 200;
const RENDER_WAIT_MS = 4000;
const REQUEST_TIMEOUT_MS = 15000;

interface Persisted {
  id: string;
  createdAt: number;
  config: SessionConfig;
  providerSessionId?: string;
  history: HistoryItem[];
  canvas: CanvasDoc;
  canvasUndo: CanvasDoc[];
  canvasRedo: CanvasDoc[];
  chrome: ChromeState;
  chromeUndo: ChromeState[];
}

const clone = <T>(v: T): T => structuredClone(v);

export class Session implements CanvasToolHost {
  readonly clients = new Set<WebSocket>();
  private data: Persisted;
  private status: AgentStatus = "idle";
  private statusDetail?: string;
  private run?: AgentRun;
  private console: ConsoleEntry[] = [];
  private renderedVersion = -1;
  private renderWaiters: { version: number; resolve: () => void }[] = [];
  private pending = new Map<string, (r: FrameResult) => void>();
  /** provider message/tool id -> history item id */
  private itemFor = new Map<string, string>();
  private saveTimer?: NodeJS.Timeout;

  constructor(
    data: Persisted,
    private file: string,
    private provider: AgentProvider,
  ) {
    this.data = data;
  }

  static create(id: string, config: SessionConfig, dir: string, provider: AgentProvider) {
    const s = new Session(
      {
        id,
        createdAt: Date.now(),
        config,
        history: [],
        canvas: emptyCanvas(),
        canvasUndo: [],
        canvasRedo: [],
        chrome: emptyChrome(),
        chromeUndo: [],
      },
      path.join(dir, `${id}.json`),
      provider,
    );
    s.save();
    return s;
  }

  static load(file: string, providerFor: (c: SessionConfig) => AgentProvider) {
    const data = JSON.parse(readFileSync(file, "utf8")) as Persisted;
    // Anything "running" when the server died is not running now.
    for (const h of data.history) if (h.kind === "tool" && h.state === "running") h.state = "error";
    return new Session(data, file, providerFor(data.config));
  }

  get id() {
    return this.data.id;
  }
  get config() {
    return this.data.config;
  }

  // ---------------------------------------------------------------- clients

  attach(ws: WebSocket) {
    this.clients.add(ws);
    this.sendTo(ws, { t: "session.snapshot", session: this.toSnapshot() });
  }

  detach(ws: WebSocket) {
    this.clients.delete(ws);
  }

  toSnapshot(): SessionSnapshot {
    return {
      id: this.data.id,
      config: this.data.config,
      status: this.status,
      statusDetail: this.statusDetail,
      history: this.data.history,
      canvas: this.data.canvas,
      chrome: this.data.chrome,
      undo: this.undoInfo(),
    };
  }

  private undoInfo(): UndoInfo {
    return { canvasUndo: this.data.canvasUndo.length, canvasRedo: this.data.canvasRedo.length, chromeUndo: this.data.chromeUndo.length };
  }

  private sendTo(ws: WebSocket, msg: ServerMsg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMsg) {
    const s = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(s);
  }

  private save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
    }, 250);
  }

  // ---------------------------------------------------------------- agent

  prompt(text: string) {
    this.addItem({ id: randomUUID(), ts: Date.now(), kind: "user", text });
    this.setStatus("thinking");
    if (!this.run) {
      this.run = this.provider.start({
        config: this.data.config,
        systemPrompt: canvasSystemPrompt(this.data.config.cwd),
        resumeId: this.data.providerSessionId,
        tools: this,
        emit: (e) => this.onProviderEvent(e),
      });
    }
    this.run.send(text);
  }

  async interrupt() {
    await this.run?.interrupt().catch(() => {});
  }

  dispose() {
    this.run?.close();
    this.run = undefined;
  }

  private setStatus(status: AgentStatus, detail?: string) {
    this.status = status;
    this.statusDetail = detail;
    this.broadcast({ t: "status", status, detail });
  }

  private addItem(item: HistoryItem) {
    this.data.history.push(item);
    this.broadcast({ t: "history.append", item });
    this.save();
  }

  private findItem(id: string) {
    return this.data.history.find((h) => h.id === id);
  }

  private onProviderEvent(e: ProviderEvent) {
    switch (e.type) {
      case "session-id":
        this.data.providerSessionId = e.id;
        this.save();
        return;
      case "turn-start":
        return;
      case "text-delta":
      case "thinking": {
        const kind = e.type === "text-delta" ? "assistant" : "thinking";
        const key = `${kind}:${e.messageId}`;
        const existing = this.itemFor.get(key);
        if (!existing && !e.text) {
          // Thinking with omitted text: reflect it in status only.
          if (this.status !== "thinking") this.setStatus("thinking");
          return;
        }
        if (!existing) {
          const id = randomUUID();
          this.itemFor.set(key, id);
          this.addItem({ id, ts: Date.now(), kind, text: e.text });
        } else {
          const item = this.findItem(existing);
          if (item && (item.kind === "assistant" || item.kind === "thinking")) item.text += e.text;
          this.broadcast({ t: "history.update", id: existing, patch: {}, appendText: e.text });
          this.save();
        }
        if (this.status !== "thinking") this.setStatus("thinking");
        return;
      }
      case "text":
        this.addItem({ id: randomUUID(), ts: Date.now(), kind: "assistant", text: e.text });
        return;
      case "tool-start": {
        const id = randomUUID();
        this.itemFor.set(`tool:${e.id}`, id);
        this.addItem({ id, ts: Date.now(), kind: "tool", name: e.name, input: e.input, state: "running" });
        this.setStatus("tool", e.name.replace(/^mcp__canvas__/, ""));
        return;
      }
      case "tool-end": {
        const id = this.itemFor.get(`tool:${e.id}`);
        const item = id && this.findItem(id);
        if (item && item.kind === "tool") {
          item.state = e.isError ? "error" : "done";
          item.result = e.result.slice(0, 4000);
          this.broadcast({ t: "history.update", id: item.id, patch: { state: item.state, result: item.result } as any });
          this.save();
        }
        this.setStatus("thinking");
        return;
      }
      case "turn-end":
        this.addItem({ id: randomUUID(), ts: Date.now(), kind: "turn", ok: e.ok, error: e.error, durationMs: e.durationMs, costUsd: e.costUsd });
        this.setStatus(e.ok ? "idle" : "error", e.error);
        return;
      case "fatal":
        this.addItem({ id: randomUUID(), ts: Date.now(), kind: "notice", level: "error", text: e.error });
        this.setStatus("error", e.error);
        // Drop the run; the next prompt starts (and resumes) a fresh one.
        this.run?.close();
        this.run = undefined;
        return;
    }
  }

  // ---------------------------------------------------------------- canvas state

  private commitCanvas(next: Omit<CanvasDoc, "version" | "updatedAt">, opts: { pushUndo?: boolean; clearRedo?: boolean } = {}) {
    const { pushUndo = true, clearRedo = true } = opts;
    if (pushUndo) {
      this.data.canvasUndo.push(clone(this.data.canvas));
      if (this.data.canvasUndo.length > UNDO_LIMIT) this.data.canvasUndo.shift();
    }
    if (clearRedo) this.data.canvasRedo = [];
    this.data.canvas = { ...next, version: this.data.canvas.version + 1, updatedAt: Date.now() };
    this.save();
    return this.data.canvas;
  }

  private publishCanvas() {
    this.broadcast({ t: "canvas.state", canvas: this.data.canvas, undo: this.undoInfo() });
  }

  undoCanvas() {
    const prev = this.data.canvasUndo.pop();
    if (!prev) return;
    this.data.canvasRedo.push(clone(this.data.canvas));
    this.commitCanvas(prev, { pushUndo: false, clearRedo: false });
    this.publishCanvas();
  }

  redoCanvas() {
    const next = this.data.canvasRedo.pop();
    if (!next) return;
    this.data.canvasUndo.push(clone(this.data.canvas));
    this.commitCanvas(next, { pushUndo: false, clearRedo: false });
    this.publishCanvas();
  }

  clearCanvas() {
    const e = emptyCanvas();
    this.commitCanvas(e);
    this.publishCanvas();
  }

  onRendered(version: number) {
    this.renderedVersion = Math.max(this.renderedVersion, version);
    this.renderWaiters = this.renderWaiters.filter((w) => {
      if (w.version <= version) w.resolve();
      return w.version > version;
    });
  }

  onConsole(entries: ConsoleEntry[]) {
    for (const e of entries) this.console.push({ ...e, message: String(e.message).slice(0, 2000) });
    if (this.console.length > CONSOLE_LIMIT) this.console.splice(0, this.console.length - CONSOLE_LIMIT);
  }

  onFrameResult(requestId: string, r: FrameResult) {
    const resolve = this.pending.get(requestId);
    if (resolve) {
      this.pending.delete(requestId);
      resolve(r);
    }
  }

  private consoleFor(version: number) {
    return this.console.filter((c) => c.version === version);
  }

  /** Wait for a viewer to rebuild `version`, then give its errors a moment to arrive. */
  private async awaitRender(version: number): Promise<RenderReport> {
    if (this.clients.size === 0) return { version, verified: false, errors: [] };
    const ok = await new Promise<boolean>((resolve) => {
      if (this.renderedVersion >= version) return resolve(true);
      const t = setTimeout(() => resolve(false), RENDER_WAIT_MS);
      this.renderWaiters.push({ version, resolve: () => (clearTimeout(t), resolve(true)) });
    });
    if (ok) await new Promise((r) => setTimeout(r, 400));
    return { version, verified: ok, errors: this.consoleFor(version).filter((c) => c.level === "error") };
  }

  private frameRequest(msg: { kind: "eval"; js: string } | { kind: "snapshot"; maxWidth: number }): Promise<FrameResult> {
    if (this.clients.size === 0) return Promise.resolve({ ok: false, error: "no live viewer is connected to this session" });
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: "timed out waiting for the canvas" });
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, (r) => (clearTimeout(t), resolve(r)));
      this.broadcast({ t: "canvas.request", requestId, ...msg } as ServerMsg);
    });
  }

  // ---------------------------------------------------------------- CanvasToolHost

  async setMode(mode: CanvasMode, context?: CanvasContextKind) {
    const c = this.data.canvas;
    const doc = this.commitCanvas({ mode, html: c.html, css: c.css, script: "", context: context ?? "2d" });
    this.publishCanvas();
    return this.awaitRender(doc.version);
  }

  async write(d: Partial<Pick<CanvasDoc, "mode" | "html" | "css" | "script" | "context">>) {
    const doc = this.commitCanvas({
      mode: d.mode ?? this.data.canvas.mode,
      html: d.html ?? "",
      css: d.css ?? "",
      script: d.script ?? "",
      context: d.context ?? "2d",
    });
    this.publishCanvas();
    return this.awaitRender(doc.version);
  }

  patch(p: CanvasPatch) {
    const { html, matched } = applyPatch(this.data.canvas.html, p);
    if (!matched) return { matched, version: this.data.canvas.version };
    const doc = this.commitCanvas({ ...this.data.canvas, html });
    this.broadcast({ t: "canvas.patch", patch: p, canvas: doc, undo: this.undoInfo() });
    return { matched, version: doc.version };
  }

  evalJs(js: string) {
    return this.frameRequest({ kind: "eval", js });
  }

  snapshot(maxWidth: number) {
    return this.frameRequest({ kind: "snapshot", maxWidth: Math.max(64, Math.min(2048, maxWidth)) });
  }

  getState() {
    return { canvas: this.data.canvas, console: this.consoleFor(this.data.canvas.version) };
  }

  // ---------------------------------------------------------------- chrome

  private pushChrome() {
    this.data.chromeUndo.push(clone(this.data.chrome));
    if (this.data.chromeUndo.length > UNDO_LIMIT) this.data.chromeUndo.shift();
  }

  private publishChrome() {
    this.save();
    this.broadcast({ t: "chrome.state", chrome: this.data.chrome, undo: this.undoInfo() });
  }

  chromeUpdate(component: ChromeComponent, input: Record<string, unknown>) {
    const r = normaliseChromeProps(component, input);
    this.pushChrome();
    this.data.chrome = { ...this.data.chrome, [component]: { ...this.data.chrome[component], ...r.props } };
    this.publishChrome();
    return r;
  }

  chromeReset(component?: ChromeComponent) {
    this.pushChrome();
    this.data.chrome = component ? { ...this.data.chrome, [component]: {} } : emptyChrome();
    this.publishChrome();
  }

  chromeUndo() {
    const prev = this.data.chromeUndo.pop();
    if (!prev) return;
    this.data.chrome = prev;
    this.publishChrome();
  }
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  constructor(
    private dir: string,
    private providerFor: (c: SessionConfig) => AgentProvider,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  get(id: string): Session | undefined {
    if (!/^[\w-]{1,64}$/.test(id)) return undefined;
    let s = this.sessions.get(id);
    if (!s) {
      const file = path.join(this.dir, `${id}.json`);
      if (!existsSync(file)) return undefined;
      s = Session.load(file, this.providerFor);
      this.sessions.set(id, s);
    }
    return s;
  }

  create(config: SessionConfig) {
    const id = randomUUID();
    const s = Session.create(id, config, this.dir, this.providerFor(config));
    this.sessions.set(id, s);
    return s;
  }
}
