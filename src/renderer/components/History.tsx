import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentStatus, HistoryItem } from "../../shared/protocol";
import { miniMarkdown } from "../markdown";
import { useUi } from "../store";
import { Icon, ToolIcon } from "./ToolIcon";

type ToolItem = Extract<HistoryItem, { kind: "tool" }>;
type ThinkingItem = Extract<HistoryItem, { kind: "thinking" }>;

/** `mcp__canvas__resource_write` → `resource_write`; other MCP servers keep only the tool name. */
export const shortTool = (name: string) => name.replace(/^mcp__.+?__/, "");

export function toolSummary(input: unknown, cwd?: string) {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of [
    "file_path",
    "notebook_path",
    "path",
    "command",
    "pattern",
    "url",
    "query",
    "description",
    "name",
    "mode",
    "component",
    "key",
    "selector",
    "op",
  ])
    if (typeof i[k] === "string") parts.push(String(i[k]));
  if (typeof i.js === "string") parts.push(i.js.slice(0, 80));
  let s = parts.join(" · ").replace(/\s+/g, " ");
  if (cwd) s = s.split(`${cwd.replace(/\/$/, "")}/`).join("");
  return s;
}

/** Consecutive calls to the same tool, shown as one row with a count. */
interface Entry {
  name: string;
  calls: ToolItem[];
}

export interface ToolGroup {
  id: string;
  /** Tool and thinking items in order; thinking only shows in the transcript. */
  members: (ToolItem | ThinkingItem)[];
  entries: Entry[];
  calls: number;
}

type Row = { type: "item"; item: HistoryItem } | { type: "group"; group: ToolGroup };

/**
 * Every run of tool calls between two pieces of text becomes one group.
 * Thinking blocks inside a run don't split it.
 */
export function buildRows(items: HistoryItem[]): Row[] {
  const rows: Row[] = [];
  let run: (ToolItem | ThinkingItem)[] = [];
  const flush = () => {
    if (!run.some((m) => m.kind === "tool")) {
      for (const item of run) rows.push({ type: "item", item });
    } else {
      const entries: Entry[] = [];
      for (const m of run) {
        if (m.kind !== "tool") continue;
        const last = entries[entries.length - 1];
        if (last && last.name === m.name) last.calls.push(m);
        else entries.push({ name: m.name, calls: [m] });
      }
      const first = run.find((m) => m.kind === "tool")!;
      rows.push({
        type: "group",
        group: { id: first.id, members: run, entries, calls: run.filter((m) => m.kind === "tool").length },
      });
    }
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool" || item.kind === "thinking") run.push(item);
    else {
      flush();
      rows.push({ type: "item", item });
    }
  }
  flush();
  return rows;
}

function EntryRow({ entry, cwd }: { entry: Entry; cwd?: string }) {
  const last = entry.calls[entry.calls.length - 1];
  const failed = entry.calls.filter((c) => c.state === "error").length;
  const n = entry.calls.length;
  const name = shortTool(entry.name);
  const cls = `tc${last.state === "error" ? " err" : ""}${last.state === "running" ? " run" : ""}`;
  return (
    <div className={cls} title={entry.name}>
      <ToolIcon tool={name} />
      <span className="nm">{name}</span>
      <span className="ar">{toolSummary(last.input, cwd)}</span>
      {n > 1 && (
        <span className="cnt">
          <span className="x">×</span>
          {n}
          {failed > 0 && <span className="f">{failed} failed</span>}
        </span>
      )}
    </div>
  );
}

function Group({
  group,
  live,
  cwd,
  onTranscript,
}: {
  group: ToolGroup;
  live: boolean;
  cwd?: string;
  onTranscript: () => void;
}) {
  const { entries } = group;
  const collapse = !live && entries.length > 6;
  const shown = collapse ? [...entries.slice(0, 3), null, entries[entries.length - 1]] : entries;
  return (
    <div className="tg" data-testid="tool-group">
      <div className="tg-hd">
        {group.calls} call{group.calls === 1 ? "" : "s"}
        <button type="button" className="txbtn" title="Open the full transcript" onClick={onTranscript}>
          <Icon name="scroll" />
          transcript
        </button>
      </div>
      {shown.map((e) =>
        e ? (
          <EntryRow key={e.calls[0].id} entry={e} cwd={cwd} />
        ) : (
          <button type="button" key="more" className="tc more" onClick={onTranscript}>
            +{entries.length - 4} more
          </button>
        ),
      )}
    </div>
  );
}

function Item({ item }: { item: HistoryItem }) {
  switch (item.kind) {
    case "user": {
      // On a hub, other people's (and agents') messages sit on the left with their name.
      const me = useUi.getState().me;
      const other = item.by && item.by.id !== me?.id;
      return (
        <div className={`hi hi-user${other ? " other" : ""}${item.by?.kind === "agent" ? " from-agent" : ""}`}>
          {item.by && (
            <span className="hi-from">
              {other ? item.by.name : "you"} → {item.to ?? "everyone"}
            </span>
          )}
          {item.text}
          {item.attached && <span className="hi-attached">+ {item.attached}</span>}
        </div>
      );
    }
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
      return null; // always rendered inside a group
    case "turn": {
      const bits = [item.ok ? "done" : `stopped${item.error ? `: ${item.error}` : ""}`];
      if (item.by) bits.unshift(item.by.name);
      if (item.durationMs) bits.push(`${(item.durationMs / 1000).toFixed(1)}s`);
      // The SDK reports cumulative, list-price cost; meaningless on a subscription.
      const { providers, config } = useUi.getState();
      const auth = providers.find((p) => p.id === (config?.provider ?? "claude"))?.auth ?? "";
      // On a hub the agent ran on someone's machine, whose login this window can't see.
      const metered = !item.by && !/subscription/i.test(auth);
      if (item.costUsd && metered) bits.push(`session $${item.costUsd.toFixed(3)}`);
      return <div className={`hi hi-turn${item.ok ? "" : " bad"}`}>{bits.join(" · ")}</div>;
    }
    case "notice":
      return <div className={`hi hi-notice ${item.level}`}>{item.text}</div>;
  }
}

/** Seconds since `since`, ticking while mounted. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  return <span className="tm">{Math.max(0, Math.floor((now - since) / 1000))}s</span>;
}

/** The agent is busy but nothing is streaming and no tool runs: show a pending row after a short quiet spell. */
function useQuiet(status: AgentStatus, items: HistoryItem[], ms = 350) {
  const [quietSince, setQuietSince] = useState<number>();
  const busy = status === "thinking";
  useEffect(() => {
    setQuietSince(undefined);
    if (!busy) return;
    const start = Date.now();
    const t = setTimeout(() => setQuietSince(start), ms);
    return () => clearTimeout(t);
  }, [busy, items, ms]);
  return quietSince;
}

function Pending({ since }: { since: number }) {
  return (
    <div className="tg pend" data-testid="thinking">
      <div className="tc">
        <Icon name="spark" />
        <span className="nm">thinking</span>
        <span className="ghost" />
        <Elapsed since={since} />
      </div>
    </div>
  );
}

/** Hub: the agent's name above its work whenever the speaker changes. */
export function agentLabels(rows: Row[]): (string | undefined)[] {
  let last: string | undefined;
  return rows.map((r) => {
    const by = r.type === "group" ? r.group.members[0]?.by : r.item.by;
    if (!by) return undefined;
    const kind = r.type === "group" ? "tool" : r.item.kind;
    const show =
      by.kind === "agent" && by.id !== last && (kind === "tool" || kind === "assistant" || kind === "thinking");
    last = kind === "user" ? undefined : by.id;
    return show ? by.name : undefined;
  });
}

/** Scrolls to the end on new content unless the user has scrolled up. */
export function HistoryList({
  items,
  status = "idle",
  className = "h-items",
  onTranscript,
}: {
  items: HistoryItem[];
  status?: AgentStatus;
  className?: string;
  onTranscript?: (groupId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const rows = useMemo(() => buildRows(items), [items]);
  const labels = useMemo(() => agentLabels(rows), [rows]);
  const cwd = useUi((s) => s.config?.cwd);
  const quietSince = useQuiet(status, items);
  const busy = status === "thinking" || status === "tool";
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, quietSince]);
  return (
    <div
      ref={ref}
      className={className}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      {rows.map((r, i) => {
        const label = labels[i];
        const row =
          r.type === "group" ? (
            <Group
              key={r.group.id}
              group={r.group}
              cwd={cwd}
              live={busy && i === rows.length - 1}
              onTranscript={() => onTranscript?.(r.group.id)}
            />
          ) : (
            <Item key={r.item.id} item={r.item} />
          );
        return label
          ? [
              <div key={`by-${i}`} className="hi-agent">
                {label}
              </div>,
              row,
            ]
          : row;
      })}
      {quietSince !== undefined && <Pending since={quietSince} />}
    </div>
  );
}

/** All tool groups in the same turn as `groupId` (between the surrounding user messages). */
function turnMembers(items: HistoryItem[], groupId: string) {
  const at = items.findIndex((i) => i.id === groupId);
  if (at < 0) return [];
  let start = at;
  while (start > 0 && items[start - 1].kind !== "user") start--;
  let end = at;
  while (end < items.length - 1 && items[end + 1].kind !== "user") end++;
  return items
    .slice(start, end + 1)
    .filter((i): i is ToolItem | ThinkingItem => i.kind === "tool" || i.kind === "thinking");
}

const pretty = (v: unknown) => {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

/** Full inputs and outputs for a group (or its whole turn), over the history list. */
export function Transcript({
  items,
  groupId,
  onClose,
}: {
  items: HistoryItem[];
  groupId: string;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<"group" | "turn">("group");
  const rows = useMemo(() => buildRows(items), [items]);
  const group = rows.find((r) => r.type === "group" && r.group.id === groupId) as { group: ToolGroup } | undefined;
  const members = scope === "group" ? (group?.group.members ?? []) : turnMembers(items, groupId);
  const calls = members.filter((m) => m.kind === "tool").length;
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);
  let n = 0;
  return (
    <div className="transcript" data-testid="transcript">
      <div className="tx-hd">
        <Icon name="scroll" />
        Transcript
        <span className="tx-count">
          {calls} call{calls === 1 ? "" : "s"}
        </span>
        <div className="seg">
          <button type="button" className={scope === "group" ? "on" : ""} onClick={() => setScope("group")}>
            this group
          </button>
          <button type="button" className={scope === "turn" ? "on" : ""} onClick={() => setScope("turn")}>
            whole turn
          </button>
        </div>
        <button type="button" className="tx-x" title="Close (Esc)" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="tx-body">
        {members.map((m) =>
          m.kind === "thinking" ? (
            <div key={m.id} className="tx tx-think">
              <span className="n" />
              <div>
                <div className="h">thinking</div>
                <pre>{m.text || "…"}</pre>
              </div>
            </div>
          ) : (
            <div key={m.id} className={`tx${m.state === "error" ? " err" : ""}${m.state === "running" ? " run" : ""}`}>
              <span className="n">{String(++n).padStart(2, "0")}</span>
              <div>
                <div className="h" title={m.name}>
                  <ToolIcon tool={shortTool(m.name)} />
                  {shortTool(m.name)}
                </div>
                <pre>{pretty(m.input)}</pre>
                <pre className="out">{m.state === "running" ? "… running" : (m.result ?? "")}</pre>
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

export function statusText(status: AgentStatus, detail?: string) {
  if (status === "thinking") return "thinking…";
  if (status === "tool") return `running ${detail ?? "a tool"}…`;
  if (status === "error") return detail ? `error: ${detail}` : "error";
  return "ready";
}
