import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Effort } from "../../shared/protocol";
import { fileOpen, send } from "../controller";
import { useUi } from "../store";
import { transport } from "../transport";
import { ProviderIcon } from "./ProviderIcon";
import { Icon } from "./ToolIcon";

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

/** Closes a popover on a click outside `ref`. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current?.contains(e.target as Node) || close();
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);
  return ref;
}

interface MenuOption {
  value: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
}

/** A styled stand-in for <select>: the native popup can't be themed or hold icons. */
function Menu({
  label,
  testId,
  value,
  options,
  icon,
  disabled,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  options: MenuOption[];
  icon?: ReactNode;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const list = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];
  const show = () => {
    setActive(Math.max(options.indexOf(current), 0));
    setOpen(true);
  };
  const pick = (o: MenuOption) => {
    onChange(o.value);
    setOpen(false);
  };
  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);
  return (
    <div ref={ref} className="menu-wrap">
      <button
        type="button"
        className={`pill${open ? " on" : ""}`}
        title={label}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={testId}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              show();
            }
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((i) => (i + step + options.length) % options.length);
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            pick(options[active]);
          } else if (e.key === "Escape" || e.key === "Tab") {
            if (e.key === "Escape") e.preventDefault();
            setOpen(false);
          }
        }}
      >
        {icon ?? current?.icon}
        <span>{current?.label}</span>
        <Glyph d={CHEVRON} size={12} />
      </button>
      {open && (
        <div ref={list} className="menu" role="listbox" aria-label={label}>
          {options.map((o, i) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === current?.value}
              data-value={o.value}
              className={`menu-opt${i === active ? " act" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
            >
              {o.icon}
              <span className="menu-lbl">{o.label}</span>
              {o.hint && <span className="menu-hint">{o.hint}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EffortBars({ n, level }: { n: number; level: number }) {
  return (
    <span className="bars" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i <= level ? "on" : ""} />
      ))}
    </span>
  );
}

/** Working directory chip: shows the folder name; opens a popover to type, browse or go back to a temporary directory. */
function CwdPicker({ cwd, setCwd }: { cwd: string; setCwd: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(
    open,
    useCallback(() => setOpen(false), []),
  );
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

      <div className="composer bezel">
        <div className="well" onClick={(e) => e.target === e.currentTarget && ta.current?.focus()}>
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
          <button
            className="key send"
            type="submit"
            title="Start (Enter)"
            aria-label="Start"
            disabled={!ready || !prompt.trim()}
          >
            {busy ? <span className="spinner" /> : <Icon name="up" />}
          </button>
        </div>
        <div className="composer-bar">
          <Menu
            label="Model"
            testId="model"
            value={modelId}
            disabled={!models.length}
            options={
              models.length
                ? models.map((m) => ({
                    value: m.id,
                    label: m.label,
                    hint: m.description,
                    icon: <ProviderIcon id="claude" />,
                  }))
                : [{ value: "", label: welcomed ? "Claude" : "Loading models…", icon: <ProviderIcon id="claude" /> }]
            }
            onChange={(v) => {
              setModel(v);
              setEffort(undefined);
            }}
          />
          {efforts.length > 0 && (
            <>
              <span className="composer-sep" />
              <Menu
                label="Effort"
                testId="effort"
                value={shownEffort ?? ""}
                icon={<EffortBars n={efforts.length} level={efforts.indexOf(shownEffort!)} />}
                options={efforts.map((e, i) => ({
                  value: e,
                  label: EFFORT_LABEL[e] ?? e,
                  icon: <EffortBars n={efforts.length} level={i} />,
                }))}
                onChange={(v) => setEffort(v as Effort)}
              />
            </>
          )}
          <span className="composer-sep" />
          <CwdPicker cwd={cwd} setCwd={setCwd} />
          <span className="composer-gap" />
          <span className="hints">
            <span>
              <kbd>⏎</kbd>start
            </span>
            <span>
              <kbd>⇧⏎</kbd>newline
            </span>
          </span>
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
