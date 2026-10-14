import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Effort } from "../../shared/protocol";
import { fileOpen, send } from "../controller";
import { useUi } from "../store";
import { transport } from "../transport";
import { ProviderIcon } from "./ProviderIcon";

const IDEAS = [
  "A 3D solar system",
  "A kanban board for this repo",
  "A step-sequencer synth",
  "A pixel-art drawing pad",
];
const EFFORT_LABEL: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function Glyph({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

const CHEVRON = "m4.5 6.5 3.5 3.5 3.5-3.5";
const FOLDER =
  "M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z";

function Pill({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="pill" title={label}>
      {children}
      <Glyph d={CHEVRON} size={12} />
    </label>
  );
}

/** Working directory chip: shows the folder name; opens a popover to type, browse or go back to a temporary directory. */
function CwdPicker({ cwd, setCwd }: { cwd: string; setCwd: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current?.contains(e.target as Node) || setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const name =
    cwd
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || cwd;
  return (
    <div ref={ref} className="cwd">
      <button
        type="button"
        className={`pill${open ? " on" : ""}`}
        title={cwd || "A new temporary directory"}
        data-testid="cwd"
        onClick={() => setOpen(!open)}
      >
        <Glyph d={FOLDER} size={13} />
        <span className="cwd-name">{cwd ? name : "Temporary directory"}</span>
        <Glyph d={CHEVRON} size={12} />
      </button>
      {open && (
        <div className="cwd-pop">
          <div className="cwd-head">Working directory</div>
          <input
            autoFocus
            aria-label="Working directory"
            value={cwd}
            placeholder="A new temporary directory"
            spellCheck={false}
            onChange={(e) => setCwd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
              }
            }}
          />
          <div className="cwd-actions">
            {transport.pickDirectory && (
              <button
                type="button"
                className="link"
                onClick={async () => {
                  const dir = await transport.pickDirectory!();
                  if (dir) setCwd(dir);
                  setOpen(false);
                }}
              >
                Browse…
              </button>
            )}
            <button
              type="button"
              className="link"
              disabled={!cwd}
              onClick={() => {
                setCwd("");
                setOpen(false);
              }}
            >
              Use a temporary directory
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function StartCard() {
  const { providers, welcomed, defaultCwd, error, connected } = useUi();
  const claude = providers.find((p) => p.id === "claude");
  const [model, setModel] = useState<string>();
  const [effort, setEffort] = useState<Effort>();
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setCwd((c) => c || defaultCwd), [defaultCwd]);
  useEffect(() => setBusy(false), [error]);

  // Nothing chosen yet means the CLI's own defaults, shown as the concrete model and effort they resolve to.
  const models = claude?.models ?? [];
  const modelId = model ?? claude?.defaultModel ?? models[0]?.id ?? "";
  const info = models.find((m) => m.id === modelId);
  const efforts = info?.efforts ?? [];
  const shownEffort = effort ?? info?.defaultEffort ?? (efforts.includes("high") ? "high" : efforts[0]);

  const ready = Boolean(claude?.enabled) && connected;
  const start = () => {
    if (!prompt.trim() || !ready) return;
    setBusy(true);
    useUi.setState({ error: undefined });
    send({
      t: "session.start",
      config: { provider: "claude", model: modelId, effort: effort ?? "", cwd },
      prompt: prompt.trim(),
    });
  };
  const status = !connected
    ? "Connecting…"
    : !welcomed
      ? "Asking Claude Code for models…"
      : claude?.enabled
        ? (claude.auth?.replace(/^Claude /, "") ?? "Signed in")
        : (claude?.note ?? "Claude unavailable");

  return (
    <form
      className={`start${busy ? " busy" : ""}`}
      data-testid="start"
      onSubmit={(e) => {
        e.preventDefault();
        start();
      }}
    >
      <h1 className="start-title">What should we make?</h1>

      <div className="composer" onClick={(e) => e.target === e.currentTarget && ta.current?.focus()}>
        <textarea
          ref={ta}
          autoFocus
          rows={2}
          value={prompt}
          placeholder="Ask Claude to build anything…"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              start();
            }
          }}
        />
        <div className="composer-bar">
          <Pill label={info?.description ?? "Model"}>
            <ProviderIcon id="claude" />
            <select
              aria-label="Model"
              value={modelId}
              onChange={(e) => {
                setModel(e.target.value);
                setEffort(undefined);
              }}
              disabled={!models.length}
            >
              {(models.length ? models : [{ id: "", label: welcomed ? "Claude" : "Loading models…" }]).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Pill>
          {efforts.length > 0 && (
            <>
              <span className="composer-sep" />
              <Pill label="Effort">
                <select aria-label="Effort" value={shownEffort} onChange={(e) => setEffort(e.target.value as Effort)}>
                  {efforts.map((e) => (
                    <option key={e} value={e}>
                      {EFFORT_LABEL[e] ?? e}
                    </option>
                  ))}
                </select>
              </Pill>
            </>
          )}
          <span className="composer-sep" />
          <CwdPicker cwd={cwd} setCwd={setCwd} />
          <span className="composer-gap" />
          <button
            className="send"
            type="submit"
            title="Start (Enter)"
            aria-label="Start"
            disabled={!ready || !prompt.trim()}
          >
            {busy ? <span className="spinner" /> : <Glyph d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />}
          </button>
        </div>
      </div>

      <div className="start-meta">
        <span className={`provider ${claude?.enabled || !welcomed ? "" : "err"}`} title={status}>
          <ProviderIcon id="claude" size={13} />
          <b>Claude</b>
          <span className="provider-auth" data-testid="auth">
            {status}
          </span>
        </span>
        <button
          type="button"
          className="link"
          title="Open a saved .caddis artifact"
          disabled={!connected}
          onClick={fileOpen}
        >
          <Glyph d="M4 2h5l3 3v9H4ZM9 2v3h3" size={13} />
          Open .caddis file…
        </button>
      </div>

      <div className="ideas">
        {IDEAS.map((idea) => (
          <button
            key={idea}
            type="button"
            className="idea"
            onClick={() => {
              setPrompt(idea);
              ta.current?.focus();
            }}
          >
            {idea}
          </button>
        ))}
      </div>
      {error && <div className="err start-err">{error}</div>}
    </form>
  );
}
