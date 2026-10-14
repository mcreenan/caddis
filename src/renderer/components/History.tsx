import { useLayoutEffect, useRef } from "react";
import type { AgentStatus, CanvasStats, HistoryItem } from "../../shared/protocol";
import { miniMarkdown } from "../markdown";
import { useUi } from "../store";

const shortTool = (name: string) => name.replace(/^mcp__canvas__/, "");

function toolSummary(input: unknown) {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of ["name", "mode", "component", "key", "selector", "op", "file_path", "pattern"]) if (typeof i[k] === "string") parts.push(String(i[k]));
  if (typeof i.js === "string") parts.push(i.js.slice(0, 60));
  return parts.join(" · ");
}

function Item({ item }: { item: HistoryItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="hi hi-user">
          {item.text}
          {item.attached && <span className="hi-attached">+ {item.attached}</span>}
        </div>
      );
    case "assistant":
      return <div className="hi hi-assistant" dangerouslySetInnerHTML={{ __html: miniMarkdown(item.text) }} />;
    case "thinking":
      return (
        <details className="hi hi-thinking">
          <summary>thinking</summary>
          <div className="hi-body">{item.text || "…"}</div>
        </details>
      );
    case "tool":
      return (
        <details className={`hi hi-tool state-${item.state}`}>
          <summary>
            <span className="tool-icon">{item.state === "running" ? "◌" : item.state === "error" ? "✕" : "✓"}</span>
            <span className="tool-name">{shortTool(item.name)}</span>
            <span className="tool-sum">{toolSummary(item.input)}</span>
          </summary>
          <pre className="hi-body">{JSON.stringify(item.input, null, 2)}</pre>
          {item.result !== undefined && <pre className="hi-body hi-result">{item.result}</pre>}
        </details>
      );
    case "turn": {
      const bits = [item.ok ? "done" : `stopped${item.error ? `: ${item.error}` : ""}`];
      if (item.durationMs) bits.push(`${(item.durationMs / 1000).toFixed(1)}s`);
      // The SDK reports cumulative, list-price cost; meaningless on a subscription.
      const metered = !/subscription/i.test(useUi.getState().providers.find((p) => p.id === "claude")?.auth ?? "");
      if (item.costUsd && metered) bits.push(`session $${item.costUsd.toFixed(3)}`);
      return <div className={`hi hi-turn${item.ok ? "" : " bad"}`}>{bits.join(" · ")}</div>;
    }
    case "notice":
      return <div className={`hi hi-notice ${item.level}`}>{item.text}</div>;
  }
}

/** Scrolls to the end on new content unless the user has scrolled up. */
export function HistoryList({ items, className = "h-items" }: { items: HistoryItem[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  return (
    <div
      ref={ref}
      className={className}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      {items.map((it) => (
        <Item key={it.id} item={it} />
      ))}
    </div>
  );
}

export function statusText(status: AgentStatus, detail?: string) {
  if (status === "thinking") return "thinking…";
  if (status === "tool") return `running ${detail ?? "a tool"}…`;
  if (status === "error") return detail ? `error: ${detail}` : "error";
  return "ready";
}

/** fps + watchdog indicator. */
export function StatsChip({ stats }: { stats?: CanvasStats }) {
  if (!stats) return null;
  const warn = stats.warnings.length;
  const title = [
    `${stats.fps} fps · ${stats.frameMs} ms/frame (max ${stats.frameMsMax})`,
    stats.heapMB ? `heap ${stats.heapMB} MB` : "",
    `timers ${stats.timers} · rAF ${stats.rafs} · listeners ${stats.listeners} · webgl ${stats.webglContexts} · dom ${stats.dom}`,
    stats.three ? `three: ${stats.three.objects} objects, ${stats.three.geometries} geometries, ${stats.three.textures} textures, ${stats.three.calls} calls` : "",
    ...stats.warnings.map((w) => `⚠ ${w}`),
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className={`stats-chip${warn ? " warn" : ""}`} title={title} data-testid="stats-chip">
      {warn ? `⚠ ${warn}` : `${stats.fps} fps`}
    </span>
  );
}
