import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CHROME_MARGIN, CHROME_Z, effectiveProps, layoutChrome, safeCssProps, type Rect } from "../../shared/chrome";
import type { ChromeApplyResult, ChromeComponent, Effort } from "../../shared/protocol";
import { TITLEBAR_H, send, setHistoryMode } from "../controller";
import { useSessionProvider, useUi } from "../store";
import { HistoryList, Transcript, statusText } from "./History";
import { Icon } from "./ToolIcon";

/**
 * The agent-styleable chrome: the floating prompt and the history panel.
 * Every prop goes through the shared clamps (src/shared/chrome.ts) again here,
 * so whatever the core stored, the result stays usable.
 */

/** The area below the titlebar, where the canvas and the overlay live. */
export function useViewport() {
  const [vp, setVp] = useState({ w: innerWidth, h: innerHeight - TITLEBAR_H });
  useEffect(() => {
    const on = () => setVp({ w: innerWidth, h: innerHeight - TITLEBAR_H });
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  return vp;
}

const SHADOW: Record<string, string> = {
  none: "0 0 #0000",
  soft: "0 18px 50px #0006",
  strong: "0 24px 70px #000b, 0 2px 8px #0008",
  glow: "0 0 30px color-mix(in srgb, var(--accent) 55%, transparent), 0 10px 30px #0006",
};

export function chromeStyle(applied: ChromeApplyResult["applied"], rect?: Rect): CSSProperties {
  const c = safeCssProps(applied);
  return {
    ...(rect ? { left: rect.x, top: rect.y, width: rect.width } : {}),
    opacity: c.opacity,
    fontFamily: c.font,
    fontSize: c.fontSize,
    // Composed in CSS so the prompt's bevel insets survive any shadow choice.
    ["--shadow" as string]: SHADOW[c.shadow],
    ["--accent" as string]: c.accent,
    ["--bg" as string]: c.background,
    ["--fg" as string]: c.foreground,
    ["--blur" as string]: `${c.blur}px`,
    ["--radius" as string]: `${c.radius}px`,
  };
}

const useApplied = (component: ChromeComponent) =>
  effectiveProps(
    component,
    useUi((s) => s.chrome[component]),
  );

export function PromptBar() {
  const applied = useApplied("prompt");
  const status = useUi((s) => s.status);
  const statusDetail = useUi((s) => s.statusDetail);
  const meta = usePromptMeta();
  const { w, h } = useViewport();
  const box = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [height, setHeight] = useState<number>();
  const [text, setText] = useState("");
  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const ta = input.current!;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
    ta.style.overflowY = ta.scrollHeight > 220 ? "auto" : "hidden";
  }, [text, applied.fontSize]);
  const rect = layoutChrome("prompt", applied, w, h, height);
  const busy = status === "thinking" || status === "tool";
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    send({ t: "prompt", text: t });
    setText("");
  };
  const hints: [string, string][] = busy
    ? [
        ["⏎", "queue"],
        ["esc", "stop"],
      ]
    : [
        ["⏎", "send"],
        ["⇧⏎", "newline"],
      ];
  return (
    <form
      ref={box}
      className={`chrome-box chrome-prompt bezel st-${status}`}
      data-testid="prompt"
      style={chromeStyle(applied, rect)}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="well">
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={busy ? "Queue a follow-up…" : "Ask for a change…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape" && busy) {
              e.preventDefault();
              send({ t: "interrupt" });
            }
          }}
        />
        {busy && (
          <button type="button" className="key stop" title="Stop (Esc)" onClick={() => send({ t: "interrupt" })}>
            <svg className="ic fill" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="7" y="7" width="10" height="10" rx="2" />
            </svg>
          </button>
        )}
        <button
          type="submit"
          className="key send"
          title={busy ? "Queue (Enter)" : "Send (Enter)"}
          disabled={!text.trim()}
        >
          <Icon name={busy ? "queue" : "up"} />
        </button>
      </div>
      <div className="pfoot">
        {meta.model && <span className="model">{meta.model}</span>}
        {meta.effort && (
          <span className="eff" title={`Effort: ${meta.effort}`}>
            <span className="bars">
              {Array.from({ length: meta.levels }, (_, i) => (
                <i key={i} className={i <= meta.level ? "on" : ""} />
              ))}
            </span>
            {meta.effort}
          </span>
        )}
        {status === "tool" && <span className="busy">running {statusDetail ?? "a tool"}</span>}
        {status === "error" && (
          <span className="perr">{statusDetail ? `turn failed · ${statusDetail}` : "turn failed"}</span>
        )}
        <span className="hints">
          {hints.map(([k, l]) => (
            <span key={l}>
              <kbd>{k}</kbd>
              {l}
            </span>
          ))}
        </span>
      </div>
    </form>
  );
}

/** The session's model and effort, resolved to the CLI defaults when none were chosen. */
function usePromptMeta() {
  const config = useUi((s) => s.config);
  const provider = useSessionProvider();
  const id = config?.model || provider?.defaultModel || "";
  const info = provider?.models.find((m) => m.id === id);
  const efforts: Effort[] = info?.efforts ?? [];
  const effort = config?.effort || info?.defaultEffort || "";
  return {
    model: info?.label ?? id,
    effort,
    levels: Math.max(efforts.length, 1),
    level: effort ? Math.max(efforts.indexOf(effort), 0) : -1,
  };
}

/** Position of the 40px mini button at the history panel's anchor. */
function miniRect(full: Rect, anchor: string): Rect {
  const s = 40;
  const right = anchor.endsWith("right");
  const bottom = anchor.startsWith("bottom");
  const centerX = !right && !anchor.endsWith("left");
  return {
    x: right ? full.x + full.width - s : centerX ? full.x + (full.width - s) / 2 : full.x,
    y: bottom ? full.y + full.height - s : full.y,
    width: s,
    height: s,
  };
}

export function HistoryPanel() {
  const applied = useApplied("history");
  const { history, status, statusDetail, stats } = useUi();
  const [transcript, setTranscript] = useState<string>();
  const closeTranscript = useCallback(() => setTranscript(undefined), []);
  const { w, h } = useViewport();
  const rect = layoutChrome("history", applied, w, h);
  if (applied.mode === "mini") {
    const r = miniRect(rect, applied.anchor);
    const warn = stats?.warnings.length ?? 0;
    return (
      <button
        className={`chrome-mini st-${status}`}
        data-testid="history-mini"
        style={{ ...chromeStyle(applied), left: r.x, top: r.y }}
        title={`${statusText(status, statusDetail)}${warn ? ` · ${warn} watchdog warning(s)` : ""} — click to show history`}
        onClick={() => setHistoryMode("full")}
      >
        <span className="dot" />
        {warn > 0 && <span className="mini-badge">{warn}</span>}
      </button>
    );
  }
  return (
    <section
      className={`chrome-box chrome-history st-${status}`}
      data-testid="history"
      style={{ ...chromeStyle(applied, rect), height: rect.height }}
    >
      <HistoryList items={history} status={status} onTranscript={setTranscript} />
      {transcript && <Transcript items={history} groupId={transcript} onClose={closeTranscript} />}
    </section>
  );
}

/** Stays mounted while hidden so a half-typed prompt survives. */
export function ChromeLayer({ hidden }: { hidden?: boolean }) {
  return (
    <div
      className="chrome-layer"
      hidden={hidden}
      data-testid="overlay"
      style={{ zIndex: CHROME_Z, ["--margin" as string]: `${CHROME_MARGIN}px` }}
    >
      <HistoryPanel />
      <PromptBar />
    </div>
  );
}
