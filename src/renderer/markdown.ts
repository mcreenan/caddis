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
