import { parseHTML } from "linkedom";
import type { DomPatch } from "../shared/protocol";

/**
 * Apply a CanvasPatch to body markup. The same semantics are implemented in
 * src/canvas/runtime.js for live application inside the iframe.
 */
export function applyPatch(html: string, patch: DomPatch): { html: string; matched: number } {
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`);
  let nodes: Element[];
  try {
    nodes = Array.from(document.body.querySelectorAll(patch.selector)) as Element[];
  } catch (e) {
    throw new Error(`invalid selector: ${patch.selector}`);
  }
  if (!patch.all) nodes = nodes.slice(0, 1);
  const content = patch.content ?? "";
  for (const el of nodes) {
    switch (patch.op) {
      case "replace":
        el.outerHTML = content;
        break;
      case "inner":
        el.innerHTML = content;
        break;
      case "append":
        el.insertAdjacentHTML("beforeend", content);
        break;
      case "prepend":
        el.insertAdjacentHTML("afterbegin", content);
        break;
      case "before":
        el.insertAdjacentHTML("beforebegin", content);
        break;
      case "after":
        el.insertAdjacentHTML("afterend", content);
        break;
      case "remove":
        el.remove();
        break;
      case "text":
        el.textContent = content;
        break;
      case "style": {
        const prev = el.getAttribute("style") ?? "";
        el.setAttribute("style", prev && !prev.trim().endsWith(";") ? `${prev}; ${content}` : `${prev}${content}`);
        break;
      }
      case "attr": {
        let attrs: Record<string, unknown>;
        try {
          attrs = JSON.parse(content || "{}");
        } catch {
          throw new Error("attr op: content must be a JSON object");
        }
        for (const [k, v] of Object.entries(attrs)) {
          if (v === null || v === false) el.removeAttribute(k);
          else el.setAttribute(k, String(v));
        }
        break;
      }
    }
  }
  return { html: document.body.innerHTML, matched: nodes.length };
}
