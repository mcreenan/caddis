import type { HistoryItem } from "../shared/protocol";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Tiny, escape-first markdown: fenced code, inline code, bold, italics. */
export function miniMarkdown(src: string): string {
  return escapeHtml(src)
    .split(/```/)
    .map((chunk, i) => {
      if (i % 2) return `<pre class="md-code">${chunk.replace(/^[\w-]*\n/, "")}</pre>`;
      return chunk
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, "$1<em>$2</em>");
    })
    .join("");
}

const shortTool = (name: string) => name.replace(/^mcp__canvas__/, "");

function toolSummary(item: Extract<HistoryItem, { kind: "tool" }>) {
  const input = item.input as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object") return "";
  const parts: string[] = [];
  for (const k of ["mode", "selector", "op", "component", "file_path", "pattern"]) if (typeof input[k] === "string") parts.push(String(input[k]));
  if (typeof input.js === "string") parts.push(input.js.slice(0, 60));
  return parts.join(" · ");
}

/** Renders history items into a container; used by both the agent-styleable panel and the safe-mode base panel. */
export class HistoryView {
  private nodes = new Map<string, HTMLElement>();

  constructor(readonly root: HTMLElement) {}

  reset(items: HistoryItem[]) {
    this.root.replaceChildren();
    this.nodes.clear();
    for (const item of items) this.append(item, false);
    this.scrollToEnd(true);
  }

  append(item: HistoryItem, scroll = true) {
    const stick = this.nearEnd();
    const el = this.build(item);
    this.nodes.set(item.id, el);
    this.root.append(el);
    if (scroll) this.scrollToEnd(stick);
  }

  update(id: string, item: HistoryItem | undefined) {
    const old = this.nodes.get(id);
    if (!old || !item) return;
    const stick = this.nearEnd();
    const el = this.build(item);
    // Keep <details> open state across rebuilds.
    const wasOpen = old.querySelector("details")?.open;
    if (wasOpen) el.querySelector("details")?.setAttribute("open", "");
    old.replaceWith(el);
    this.nodes.set(id, el);
    this.scrollToEnd(stick);
  }

  private nearEnd() {
    const r = this.root;
    return r.scrollHeight - r.scrollTop - r.clientHeight < 60;
  }

  private scrollToEnd(stick: boolean) {
    if (stick) this.root.scrollTop = this.root.scrollHeight;
  }

  private build(item: HistoryItem): HTMLElement {
    switch (item.kind) {
      case "user":
        return h("div", "hi hi-user", item.text);
      case "assistant": {
        const el = h("div", "hi hi-assistant");
        el.innerHTML = miniMarkdown(item.text);
        return el;
      }
      case "thinking": {
        const d = h("details", "hi hi-thinking");
        d.append(h("summary", "", "thinking"), h("div", "hi-body", item.text || "…"));
        return d;
      }
      case "tool": {
        const d = h("details", `hi hi-tool state-${item.state}`);
        const s = h("summary");
        s.append(h("span", "tool-icon", item.state === "running" ? "◌" : item.state === "error" ? "✕" : "✓"), h("span", "tool-name", shortTool(item.name)), h("span", "tool-sum", toolSummary(item)));
        d.append(s);
        d.append(h("pre", "hi-body", JSON.stringify(item.input, null, 2)));
        if (item.result !== undefined) d.append(h("pre", "hi-body hi-result", item.result));
        return d;
      }
      case "turn": {
        const bits = [item.ok ? "done" : `stopped${item.error ? `: ${item.error}` : ""}`];
        if (item.durationMs) bits.push(`${(item.durationMs / 1000).toFixed(1)}s`);
        if (item.costUsd) bits.push(`$${item.costUsd.toFixed(3)}`);
        return h("div", `hi hi-turn${item.ok ? "" : " bad"}`, bits.join(" · "));
      }
      case "notice":
        return h("div", `hi hi-notice ${item.level}`, item.text);
    }
  }
}
