import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CHROME_MARGIN, CHROME_Z, effectiveProps, layoutChrome, safeCssProps, type Rect } from "../../shared/chrome";
import type { ChromeApplyResult, ChromeComponent } from "../../shared/protocol";
import { send } from "../controller";
import { useUi } from "../store";
import { HistoryList, StatsChip, statusText } from "./History";

/**
 * The agent-styleable chrome: the floating prompt and the history panel.
 * Every prop goes through the shared clamps (src/shared/chrome.ts) again here,
 * so whatever the core stored, the result stays usable.
 */

export function useViewport() {
  const [vp, setVp] = useState({ w: innerWidth, h: innerHeight });
  useEffect(() => {
    const on = () => setVp({ w: innerWidth, h: innerHeight });
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  return vp;
}

const SHADOW: Record<string, string> = {
  none: "none",
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
    boxShadow: SHADOW[c.shadow],
    ["--accent" as string]: c.accent,
    ["--bg" as string]: c.background,
    ["--fg" as string]: c.foreground,
    ["--blur" as string]: `${c.blur}px`,
    ["--radius" as string]: `${c.radius}px`,
  };
}

const useApplied = (component: ChromeComponent) => effectiveProps(component, useUi((s) => s.chrome[component]));

export function PromptBar() {
  const applied = useApplied("prompt");
  const status = useUi((s) => s.status);
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
  return (
    <form
      ref={box}
      className="chrome-box chrome-prompt"
      data-testid="prompt"
      style={chromeStyle(applied, rect)}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
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
          }
        }}
      />
      {busy && (
        <button type="button" className="icon stop" title="Stop" onClick={() => send({ t: "interrupt" })}>
          ■
        </button>
      )}
      <button type="submit" className="icon send" title="Send (Enter)" disabled={!text.trim()}>
        ↑
      </button>
    </form>
  );
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
  const { w, h } = useViewport();
  const [peek, setPeek] = useState(false);
  const rect = layoutChrome("history", applied, w, h);
  const mini = applied.mode === "mini" && !peek;
  if (mini) {
    const r = miniRect(rect, applied.anchor);
    const warn = stats?.warnings.length ?? 0;
    return (
      <button
        className={`chrome-mini st-${status}`}
        data-testid="history-mini"
        style={{ ...chromeStyle(applied), left: r.x, top: r.y }}
        title={`${statusText(status, statusDetail)}${warn ? ` · ${warn} watchdog warning(s)` : ""} — click to show history`}
        onClick={() => setPeek(true)}
      >
        <span className="dot" />
        {warn > 0 && <span className="mini-badge">{warn}</span>}
      </button>
    );
  }
  return (
    <section className={`chrome-box chrome-history st-${status}`} data-testid="history" style={{ ...chromeStyle(applied, rect), height: rect.height }}>
      <header>
        <span className="dot" />
        <span className="h-title">Agent</span>
        <span className="h-status">{statusText(status, statusDetail)}</span>
        <StatsChip stats={stats} />
        <button
          className="icon"
          title={peek ? "Back to mini" : "Collapse to a button"}
          onClick={() => (peek ? setPeek(false) : send({ t: "chrome.set", component: "history", props: { mode: "mini" } }))}
        >
          –
        </button>
      </header>
      <HistoryList items={history} />
    </section>
  );
}

export function ChromeLayer() {
  return (
    <div className="chrome-layer" style={{ zIndex: CHROME_Z, ["--margin" as string]: `${CHROME_MARGIN}px` }}>
      <HistoryPanel />
      <PromptBar />
    </div>
  );
}
