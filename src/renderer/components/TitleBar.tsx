import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HOST_Z } from "../../shared/chrome";
import { TITLE_MAX, type UiCommand } from "../../shared/protocol";
import { fileNew, fileOpen, fileSave, historyMini, renameSession, uiCommand } from "../controller";
import { useSessionProvider, useUi } from "../store";
import { statusText } from "./History";

/**
 * Host-owned titlebar, drawn in place of the OS one. The OS keeps its window
 * controls (macOS traffic lights on the left, the Windows/Linux overlay buttons on
 * the right); this fills the space between. The agent can't restyle or cover it.
 */

const MAC_UI = /Mac|iPhone|iPad/.test(navigator.platform);
const mod = MAC_UI ? "⌘" : "Ctrl+";
/** Electron on macOS fills the native menu bar instead of showing a menu button. */
const NATIVE_MENU = window.caddis?.os === "darwin";

type MenuItem = { label: string; key?: string; run: () => void; disabled?: boolean; testid?: string } | "-";
type Menu = { label: string; items: MenuItem[] };

function useMenus(): Menu[] {
  const inSession = useUi((s) => s.phase === "session");
  const undo = useUi((s) => s.undo);
  const hidden = useUi((s) => s.overlayHidden);
  const mini = useUi(historyMini);
  const cmd = (c: UiCommand) => () => uiCommand(c);
  return [
    {
      label: "File",
      items: [
        { label: "New window", key: window.caddis ? `${mod}N` : undefined, run: fileNew },
        { label: "Open…", key: `${mod}O`, run: fileOpen },
        "-",
        { label: "Save", key: `${mod}S`, run: () => fileSave(false), disabled: !inSession },
        { label: "Save as…", key: `${mod}⇧S`, run: () => fileSave(true), disabled: !inSession },
        { label: "Rename…", run: cmd("rename"), disabled: !inSession, testid: "rename" },
      ],
    },
    {
      label: "Canvas",
      items: [
        {
          label: undo.next ? `Undo ${undo.next}` : "Undo change",
          run: cmd("undo"),
          disabled: !inSession || !undo.undo,
        },
        { label: "Redo change", run: cmd("redo"), disabled: !inSession || !undo.redo },
        "-",
        { label: "Reload canvas", run: cmd("reloadCanvas"), disabled: !inSession },
        { label: "Clear canvas", run: cmd("clearCanvas"), disabled: !inSession },
      ],
    },
    {
      label: "View",
      items: [
        { label: hidden ? "Show overlay" : "Hide overlay", key: `${mod}\\`, run: cmd("overlay"), disabled: !inSession },
        { label: mini ? "Expand history" : "Minimise history", run: cmd("history"), disabled: !inSession },
        { label: "Reset overlay style", run: cmd("resetOverlay"), disabled: !inSession, testid: "reset-overlay" },
      ],
    },
  ];
}

/** Closes on outside clicks, Escape, and window blur (clicks in the canvas never reach this document). */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: Event) => !ref.current?.contains(e.target as Node) && close();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("pointerdown", down, true);
    addEventListener("keydown", esc, true);
    addEventListener("blur", close);
    return () => {
      removeEventListener("pointerdown", down, true);
      removeEventListener("keydown", esc, true);
      removeEventListener("blur", close);
    };
  }, [open, close]);
  return ref;
}

function AppMenu() {
  const menus = useMenus();
  const file = useUi((s) => s.file);
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState(0);
  const close = useMemo(() => () => setOpen(false), []);
  const ref = useDismiss(open, close);
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={ref} className="tb-menu" data-testid="app-menu">
      <button
        className={`tb-btn${open ? " on" : ""}`}
        title="Menu"
        aria-label="Menu"
        aria-expanded={open}
        onClick={() => {
          setSub(0);
          setOpen(!open);
        }}
      >
        <Icon d="M3 5h12M3 9h12M3 13h12" />
      </button>
      {open && (
        <div className="tb-pop" role="menu">
          {menus.map((m, i) => (
            <div key={m.label} className={`tb-sub${sub === i ? " on" : ""}`} onPointerEnter={() => setSub(i)}>
              <button role="menuitem" aria-haspopup="menu" aria-expanded={sub === i} onClick={() => setSub(i)}>
                {m.label} <span className="chev">›</span>
              </button>
              {sub === i && (
                <div className="tb-pop tb-pop-sub" role="menu">
                  {m.items.map((it, j) =>
                    it === "-" ? (
                      <hr key={j} />
                    ) : (
                      <button
                        key={it.label}
                        role="menuitem"
                        disabled={it.disabled}
                        data-testid={it.testid}
                        onClick={run(it.run)}
                      >
                        {it.label} {it.key && <kbd>{it.key}</kbd>}
                      </button>
                    ),
                  )}
                  {m.label === "File" && file && <div className="tb-file">{file}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Icon({ d, children }: { d?: string; children?: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {d && <path d={d} />}
      {children}
    </svg>
  );
}

function SessionControls() {
  const undo = useUi((s) => s.undo);
  const hidden = useUi((s) => s.overlayHidden);
  const mini = useUi(historyMini);
  return (
    <div className="tb-group">
      <button
        className="tb-btn"
        title={undo.next ? `Undo: ${undo.next}` : "Nothing to undo"}
        aria-label="Undo"
        data-testid="undo"
        disabled={!undo.undo}
        onClick={() => uiCommand("undo")}
      >
        <Icon d="M6.5 4.5 3.5 7.5l3 3M3.5 7.5h7a4 4 0 0 1 0 8H8" />
      </button>
      <button
        className="tb-btn"
        title={undo.redo ? "Redo" : "Nothing to redo"}
        aria-label="Redo"
        data-testid="redo"
        disabled={!undo.redo}
        onClick={() => uiCommand("redo")}
      >
        <Icon d="M11.5 4.5l3 3-3 3M14.5 7.5h-7a4 4 0 0 0 0 8H10" />
      </button>
      <span className="tb-sep" />
      <button
        className={`tb-btn${hidden ? " on" : ""}`}
        title={`${hidden ? "Show" : "Hide"} the prompt and history (${mod}\\)`}
        aria-label={hidden ? "Show overlay" : "Hide overlay"}
        aria-pressed={hidden}
        data-testid="overlay-toggle"
        onClick={() => uiCommand("overlay")}
      >
        {hidden ? (
          <Icon d="M2.5 9s2.5-4.5 6.5-4.5S15.5 9 15.5 9 13 13.5 9 13.5 2.5 9 2.5 9ZM3 3l12 12" />
        ) : (
          <Icon d="M2.5 9s2.5-4.5 6.5-4.5S15.5 9 15.5 9 13 13.5 9 13.5 2.5 9 2.5 9Z">
            <circle cx="9" cy="9" r="2" />
          </Icon>
        )}
      </button>
      <button
        className={`tb-btn${mini ? "" : " on"}`}
        title={mini ? "Expand the history panel" : "Minimise the history panel"}
        aria-label={mini ? "Expand history" : "Minimise history"}
        aria-pressed={!mini}
        data-testid="history-toggle"
        onClick={() => uiCommand("history")}
      >
        {mini ? (
          <Icon d="M3 3.5h12v11H3zM11 3.5v11" />
        ) : (
          <Icon d="M3 3.5h12v11H3zM11 3.5v11M12.5 6.5h1M12.5 9h1M12.5 11.5h1" />
        )}
      </button>
    </div>
  );
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Records a value each time `tick` changes (stats arrive every 1–2 s); the last `n` samples. */
function useSamples(value: number | undefined, tick: unknown, n = 30) {
  const samples = useRef<number[]>([]);
  const last = useRef<unknown>(undefined);
  if (value !== undefined && tick !== last.current) {
    last.current = tick;
    samples.current = [...samples.current.slice(1 - n), value];
  }
  return samples.current;
}

/** A tiny trend line; `floor` keeps small values (idle CPU) from filling the box. */
function Sparkline({ values, floor }: { values: number[]; floor: number }) {
  const w = 36;
  const h = 14;
  if (values.length < 2) return <svg className="tb-spark" width={w} height={h} aria-hidden />;
  const max = Math.max(floor, ...values);
  const pts = values.map(
    (v, i) => [(i / (values.length - 1)) * w, h - 1 - (Math.min(v, max) / max) * (h - 2)] as const,
  );
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg className="tb-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polygon points={`0,${h} ${line} ${w},${h}`} fill="currentColor" opacity="0.18" />
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}

/** 14px glyphs for the status readout. */
const GLYPH = {
  file: "M4 1.5h4.5L11 4v8.5H4zM8.5 1.5V4H11",
  data: "M2.5 3.5c0-1.1 2-2 4.5-2s4.5.9 4.5 2-2 2-4.5 2-4.5-.9-4.5-2v7c0 1.1 2 2 4.5 2s4.5-.9 4.5-2v-7M2.5 7c0 1.1 2 2 4.5 2s4.5-.9 4.5-2",
  mem: "M3.5 3.5h7v7h-7zM5.5 1.5v2M8.5 1.5v2M5.5 10.5v2M8.5 10.5v2M1.5 5.5h2M1.5 8.5h2M10.5 5.5h2M10.5 8.5h2",
  warn: "M7 1.8 12.8 12H1.2zM7 5.5v3M7 10.2v.1",
};

function Glyph({ d }: { d: string }) {
  return (
    <svg
      className="tb-glyph"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

/** good / ok / bad colouring; `higherIsBetter` for fps. */
function level(v: number, ok: number, bad: number, higherIsBetter = false) {
  if (higherIsBetter) return v >= ok ? "good" : v >= bad ? "ok" : "bad";
  return v >= bad ? "bad" : v >= ok ? "ok" : "";
}

/** Live readout for the current canvas: agent status, fps (3D), files, data, memory, CPU, watchdog warnings. */
function Status() {
  const { canvas, data, stats, proc, status, statusDetail } = useUi();
  const files = Object.values(canvas.resources).sort((a, b) => a.name.localeCompare(b.name));
  const total = files.reduce((n, r) => n + r.size, 0);
  const dataBytes = useMemo(() => new TextEncoder().encode(JSON.stringify(data)).length, [data]);
  const dataKeys = Object.keys(data).length;
  const memMB = proc?.memoryMB ?? stats?.heapMB;
  const warn = stats?.warnings ?? [];
  const busy = status === "thinking" || status === "tool";
  const fps = useSamples(stats?.fps, stats?.ts);
  const cpu = useSamples(proc?.cpu, proc);
  return (
    <div className="tb-status" data-testid="status">
      <span className={`tb-stat st-${status}`} title={`Agent: ${statusText(status, statusDetail)}`}>
        <span className="dot" />
        {(busy || status === "error") && <span className="tb-agent">{statusText(status, statusDetail)}</span>}
      </span>
      {canvas.mode === "3d" && stats && (
        <span
          className={`tb-stat ${level(stats.fps, 50, 30, true)}`}
          title={`${stats.fps} fps · ${stats.frameMs} ms/frame (max ${stats.frameMsMax})${stats.three ? `\n${stats.three.objects} objects · ${stats.three.calls} draw calls · ${stats.three.triangles} triangles` : ""}`}
          data-testid="fps"
        >
          <Sparkline values={fps} floor={60} />
          {stats.fps}
          <small>fps</small>
        </span>
      )}
      <span
        className="tb-stat"
        title={files.length ? files.map((r) => `${r.name}  ${fmtBytes(r.size)}`).join("\n") : "No canvas files yet"}
        data-testid="files"
      >
        <Glyph d={GLYPH.file} />
        {files.length}
        <small>{fmtBytes(total)}</small>
      </span>
      <span
        className="tb-stat"
        title={`Data store: ${dataKeys} ${dataKeys === 1 ? "key" : "keys"}, ${fmtBytes(dataBytes)}`}
        data-testid="data-size"
      >
        <Glyph d={GLYPH.data} />
        {fmtBytes(dataBytes)}
      </span>
      {memMB !== undefined && (
        <span
          className={`tb-stat ${level(memMB, 512, 1024)}`}
          title={`Memory: ${memMB} MB · ${proc?.memoryMB !== undefined ? `canvas process ${proc.pid}${proc.separateFromHost ? "" : " (shared with the app)"}` : "canvas JS heap"}`}
          data-testid="mem"
        >
          <Glyph d={GLYPH.mem} />
          {memMB}
          <small>MB</small>
        </span>
      )}
      {proc?.cpu !== undefined && (
        <span
          className={`tb-stat ${level(proc.cpu, 50, 85)}`}
          title={`Canvas process CPU: ${proc.cpu}%`}
          data-testid="cpu"
        >
          <Sparkline values={cpu} floor={10} />
          {proc.cpu.toFixed(proc.cpu < 10 ? 1 : 0)}
          <small>% cpu</small>
        </span>
      )}
      {warn.length > 0 && (
        <span className="tb-stat ok" data-testid="warnings" title={warn.map((w) => `⚠ ${w}`).join("\n")}>
          <Glyph d={GLYPH.warn} />
          {warn.length}
        </span>
      )}
    </div>
  );
}

/** A title the user chose, else the saved file's name, else the agent's title, else the first prompt line. */
function useTitle() {
  const file = useUi((s) => s.file);
  const chosen = useUi((s) => s.title);
  const first = useUi((s) =>
    s.history
      .find((h) => h.kind === "user")
      ?.text.split("\n")[0]
      .slice(0, TITLE_MAX),
  );
  const title = chosen?.by === "user" ? chosen.text : (file ?? chosen?.text ?? first);
  useEffect(() => {
    document.title = title ? `${title} — Caddis` : "Caddis";
  }, [title]);
  return title;
}

/** Inline title editor. Enter or blur saves, Escape cancels; an empty title goes back to the automatic one. */
function RenameInput({ initial, current }: { initial: string; current: string }) {
  const [draft, setDraft] = useState(initial);
  const done = (commit: boolean) => {
    if (!useUi.getState().renaming) return;
    useUi.setState({ renaming: false });
    const next = draft.replace(/\s+/g, " ").trim();
    if (commit && next !== current) renameSession(next);
  };
  return (
    <input
      className="tb-rename"
      autoFocus
      onFocus={(e) => e.target.select()}
      value={draft}
      maxLength={TITLE_MAX}
      placeholder="Automatic title"
      aria-label="Session title"
      data-testid="title-input"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(true);
        else if (e.key === "Escape") done(false);
      }}
    />
  );
}

/** The session title; double-click (or File → Rename…) to edit it. */
function Title() {
  const title = useTitle();
  const inSession = useUi((s) => s.phase === "session");
  const renaming = useUi((s) => s.renaming && s.phase === "session");
  const chosen = useUi((s) => s.title);
  const file = useUi((s) => s.file);
  const agent = useSessionProvider()?.label ?? "the agent";
  if (renaming)
    return (
      <div className="tb-title">
        <RenameInput initial={chosen?.text ?? title ?? ""} current={chosen?.text ?? ""} />
      </div>
    );
  const hint = [
    file && `Saved as ${file}`,
    chosen?.by === "agent" && `Named by ${agent}: ${chosen.text}`,
    inSession && "Double-click to rename",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div
      className="tb-title"
      title={hint || undefined}
      data-testid="title"
      onDoubleClick={inSession ? () => useUi.setState({ renaming: true }) : undefined}
    >
      <span className={inSession ? "tb-title-text" : undefined}>{title ?? "Caddis"}</span>
    </div>
  );
}

export function TitleBar() {
  const inSession = useUi((s) => s.phase === "session");
  const os = window.caddis?.os;
  return (
    <header
      className={`titlebar${os === "darwin" ? " mac" : os ? " wco" : ""}`}
      style={{ zIndex: HOST_Z }}
      data-testid="titlebar"
    >
      {!NATIVE_MENU && <AppMenu />}
      {inSession && <SessionControls />}
      <Title />
      {inSession && <Status />}
    </header>
  );
}

/** Brief notices (saved, downloaded) and errors that would otherwise go unseen during a session. */
export function Toast() {
  const toast = useUi((s) => s.toast);
  const error = useUi((s) => (s.phase === "session" ? s.error : undefined));
  const text = error ?? toast;
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(
      () => useUi.setState(error ? { error: undefined } : { toast: undefined }),
      error ? 8000 : 3000,
    );
    return () => clearTimeout(t);
  }, [text, error]);
  if (!text) return null;
  return (
    <div className={`toast${error ? " toast-err" : ""}`} style={{ zIndex: HOST_Z + 1 }} data-testid="toast">
      {text}
    </div>
  );
}
