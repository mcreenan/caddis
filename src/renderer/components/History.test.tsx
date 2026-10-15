import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { HistoryItem } from "../../shared/protocol";
import { HistoryList, Transcript, buildRows, shortTool } from "./History";

let n = 0;
const tool = (name: string, input: unknown, state: "running" | "done" | "error" = "done"): HistoryItem => ({
  id: `t${++n}`,
  ts: n,
  kind: "tool",
  name,
  input,
  state,
  result: state === "error" ? "Error: old_string not unique" : "ok",
});
const text = (t: string): HistoryItem => ({ id: `a${++n}`, ts: n, kind: "assistant", text: t });
const think = (): HistoryItem => ({ id: `k${++n}`, ts: n, kind: "thinking", text: "hmm" });

const ITEMS: HistoryItem[] = [
  { id: "u1", ts: 0, kind: "user", text: "Make tool calls compact" },
  text("Looking at the history panel."),
  tool("Read", { file_path: "/repo/src/History.tsx" }),
  tool("Read", { file_path: "/repo/src/Chrome.tsx" }),
  think(),
  tool("Read", { file_path: "/repo/src/styles.css" }),
  tool("Grep", { pattern: "hi-tool" }),
  tool("Edit", { file_path: "/repo/src/styles.css" }, "error"),
  tool("Edit", { file_path: "/repo/src/styles.css" }),
  tool("Bash", { command: "npm run check" }, "error"),
  tool("mcp__canvas__canvas_view", { screenshot: true }, "running"),
];

describe("history tool groups", () => {
  it("groups every tool run between text, merging consecutive repeats", () => {
    const rows = buildRows(ITEMS);
    expect(rows.map((r) => r.type)).toEqual(["item", "item", "group"]);
    const g = rows[2].type === "group" ? rows[2].group : undefined;
    expect(g?.calls).toBe(8);
    expect(g?.entries.map((e) => [e.name, e.calls.length])).toEqual([
      ["Read", 3],
      ["Grep", 1],
      ["Edit", 2],
      ["Bash", 1],
      ["mcp__canvas__canvas_view", 1],
    ]);
  });

  it("keeps thinking blocks that are not inside a tool run", () => {
    const rows = buildRows([think(), text("hi"), think()]);
    expect(rows.every((r) => r.type === "item")).toBe(true);
  });

  it("shortens MCP tool names", () => {
    expect(shortTool("mcp__canvas__resource_write")).toBe("resource_write");
    expect(shortTool("mcp__claude_ai_Slack__send_message")).toBe("send_message");
    expect(shortTool("Bash")).toBe("Bash");
  });

  it("renders rows without status glyphs, with counts, failures and the running call", () => {
    const html = renderToStaticMarkup(<HistoryList items={ITEMS} status="tool" />);
    expect(html).not.toMatch(/[✓✕◌]/);
    expect(html).toContain('class="tc err"'); // Bash, last call failed
    expect(html).toContain('class="tc run"');
    expect(html).toMatch(/<span class="f">1 failed<\/span>/); // Edit ×2, one failed
    const row = buildRows(ITEMS)[2];
    const groupId = row.type === "group" ? row.group.id : "";
    const tx = renderToStaticMarkup(<Transcript items={ITEMS} groupId={groupId} onClose={() => {}} />);
    expect(tx).toContain("8 calls");
    expect(tx.match(/class="tx[ "]/g)).toHaveLength(9); // 8 calls + 1 thinking block
    expect(tx).toContain("tx tx-think"); // thinking inside the run is kept for the transcript
  });
});
