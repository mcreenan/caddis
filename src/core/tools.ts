import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ANCHORS, CANVAS_MODES, CHROME_COMPONENTS, DOM_OPS, FONTS, SHADOWS, TITLE_MAX } from "../shared/protocol";
import type { Session } from "./session";

export const MCP_SERVER_NAME = "canvas";
export const mcpToolName = (name: string) => `mcp__${MCP_SERVER_NAME}__${name}`;

export interface ToolOutput {
  text: string;
  image?: { data: string; mimeType: string };
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  shape: z.ZodRawShape;
}

/** Provider-agnostic: each provider exposes `defs` its own way and calls `run`. */
export interface ToolSet {
  defs: ToolDef[];
  run(name: string, args: Record<string, unknown>): Promise<ToolOutput>;
}

const chromeProps = z
  .object({
    anchor: z.enum(ANCHORS).nullable(),
    x: z.number().nullable().describe("px offset from the anchored position"),
    y: z.number().nullable(),
    width: z.number().nullable(),
    height: z.number().nullable().describe("history only"),
    opacity: z.number().nullable(),
    accent: z.string().nullable(),
    background: z.string().nullable(),
    foreground: z.string().nullable(),
    blur: z.number().nullable().describe("backdrop blur px"),
    radius: z.number().nullable(),
    font: z.enum(FONTS).nullable(),
    fontSize: z.number().nullable(),
    shadow: z.enum(SHADOWS).nullable(),
    mode: z.enum(["full", "mini"]).nullable().describe("history only"),
  })
  .partial()
  .describe("Only the keys you want to change; null resets a key to base.");

const DEFS: ToolDef[] = [
  { name: "resource_list", description: "List canvas resources (name, kind, size) and the current mode.", shape: {} },
  {
    name: "resource_read",
    description: "Read a resource with line numbers. Optional 1-based line range.",
    shape: { name: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).optional() },
  },
  {
    name: "resource_write",
    description:
      "Create or replace a resource; applied live (css swapped, index.html DOM-morphed, js module disposed and re-run). Returns errors it caused. Binary assets: encoding base64.",
    shape: {
      name: z.string().describe("index.html | *.css | *.js | asset name"),
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]).optional(),
      mime: z.string().optional(),
    },
  },
  {
    name: "resource_edit",
    description: "Exact string replacement in a text resource (old_string must be unique unless replace_all). Applied live; returns errors it caused.",
    shape: { name: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() },
  },
  { name: "resource_delete", description: "Delete a resource (js modules are disposed).", shape: { name: z.string() } },
  {
    name: "canvas_set_mode",
    description: "Switch surface: html (DOM only), canvas (full-window 2D canvas, ctx.g), 3d (three.js renderer/scene/camera/controls). Resources are kept and re-run.",
    shape: { mode: z.enum(CANVAS_MODES) },
  },
  {
    name: "canvas_dom",
    description:
      "Targeted DOM op on the live page. persist (default true) also applies it to index.html; persist:false touches only the live DOM (e.g. elements your JS created). attr content is a JSON object; style content is CSS declarations.",
    shape: { selector: z.string(), op: z.enum(DOM_OPS), content: z.string().optional(), all: z.boolean().optional(), persist: z.boolean().optional() },
  },
  {
    name: "canvas_eval",
    description: "Run JS (async function body) in the live page with the module ctx in scope (canvas, THREE, scene, camera, renderer, g, data, modules). Returns the value. Not saved.",
    shape: { js: z.string() },
  },
  {
    name: "canvas_view",
    description: "What the user sees: errors and console since your last view, a compact DOM outline, runtime stats, and optionally a screenshot.",
    shape: { screenshot: z.boolean().optional(), outline: z.boolean().optional(), selector: z.string().optional(), maxWidth: z.number().optional() },
  },
  {
    name: "canvas_set_title",
    description: `Name the canvas: a short title (max ${TITLE_MAX} chars) for the titlebar, window and saved file. Set it once you know what you're building; change it only if the canvas becomes something else. A title the user chose is kept.`,
    shape: { title: z.string() },
  },
  { name: "canvas_stats", description: "Runtime stats: fps, frame time, heap, three.js renderer.info, WebGL contexts, live timers/listeners/rAF, leak warnings.", shape: {} },
  { name: "canvas_reload", description: "Fallback only: rebuild the page from resources (loses runtime state).", shape: {} },
  { name: "data_get", description: "Get a value from the session data store shared with the page.", shape: { key: z.string() } },
  {
    name: "data_set",
    description: "Set a JSON value in the data store; the page re-renders via ctx.data.subscribe(key, cb).",
    shape: { key: z.string(), value: z.any() },
  },
  { name: "data_delete", description: "Delete a key from the data store.", shape: { key: z.string() } },
  { name: "data_list", description: "List data keys (optionally by prefix) with value previews.", shape: { prefix: z.string().optional() } },
  {
    name: "data_append",
    description: "Append an item to an array value (created if missing), keeping at most `max` items.",
    shape: { key: z.string(), value: z.any(), max: z.number().int().min(1).optional() },
  },
  {
    name: "events_read",
    description: "Read canvas activity (ctx.emit events and page data writes) since you last read it. wait_ms > 0 blocks until something arrives (max 60000).",
    shape: { wait_ms: z.number().int().min(0).max(60000).optional() },
  },
  {
    name: "chrome_get",
    description: "Current props, base values, clamp limits and on-screen rects of the floating prompt and history panel.",
    shape: {},
  },
  {
    name: "chrome_set",
    description:
      "Restyle/move the floating prompt or history panel: anchor (top-left|top|top-right|left|center|right|bottom-left|bottom|bottom-right) + x/y offset, width, height, opacity, accent/background/foreground colours, blur, radius, font, fontSize, shadow, history mode full|mini. Values are clamped; the applied values are returned.",
    shape: { component: z.enum(CHROME_COMPONENTS), props: chromeProps },
  },
  { name: "chrome_reset", description: "Reset one or both chrome components to base.", shape: { component: z.enum(CHROME_COMPONENTS).optional() } },
];

const text = (t: string, isError = false): ToolOutput => ({ text: t, isError });
const json = (v: unknown) => JSON.stringify(v, null, 1);

export function buildToolSet(s: Session): ToolSet {
  return {
    defs: DEFS,
    async run(name, a: any) {
      try {
        switch (name) {
          case "resource_list":
            return text(s.describeResources());
          case "resource_read":
            return text(s.readResource(a.name, a.offset, a.limit));
          case "resource_write":
            return text(await s.writeResource(a.name, a.content, { encoding: a.encoding, mime: a.mime }));
          case "resource_edit":
            return text(await s.editResource(a.name, a.old_string, a.new_string, Boolean(a.replace_all)));
          case "resource_delete":
            return text(await s.deleteResource(a.name));
          case "canvas_set_mode":
            return text(await s.setMode(a.mode));
          case "canvas_dom":
            return text(await s.domOp({ selector: a.selector, op: a.op, content: a.content, all: a.all }, a.persist !== false));
          case "canvas_eval": {
            const r = await s.frameRequest({ kind: "eval", js: a.js });
            return r.ok ? text(r.value ?? "undefined") : text(`Error: ${r.error}`, true);
          }
          case "canvas_view":
            return await s.view({ screenshot: Boolean(a.screenshot), outline: a.outline !== false, selector: a.selector, maxWidth: a.maxWidth ?? 1024 });
          case "canvas_set_title":
            return text(s.setTitle(a.title, "agent"));
          case "canvas_stats":
            return text(await s.statsReport());
          case "canvas_reload":
            return text(await s.reload());
          case "data_get":
            return text(s.dataGet(a.key));
          case "data_set":
            return text(s.dataSet(a.key, a.value, "agent"));
          case "data_delete":
            return text(s.dataDelete(a.key, "agent"));
          case "data_list":
            return text(s.dataList(a.prefix));
          case "data_append":
            return text(s.dataAppend(a.key, a.value, a.max));
          case "events_read":
            return text(await s.readEvents(a.wait_ms ?? 0));
          case "chrome_get":
            return text(json(s.chromeGet()));
          case "chrome_set": {
            const r = s.chromeSet(a.component, a.props ?? {}, "agent");
            return text(json(r));
          }
          case "chrome_reset":
            s.chromeReset(a.component);
            return text(`Reset ${a.component ?? "prompt and history"} to base.`);
        }
        return text(`unknown tool ${name}`, true);
      } catch (e: any) {
        return text(`Error: ${e?.message ?? e}`, true);
      }
    },
  };
}

export function createCanvasMcpServer(tools: ToolSet) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "2.0.0",
    alwaysLoad: true,
    timeout: 90_000,
    tools: tools.defs.map((d) =>
      tool(d.name, d.description, d.shape, async (args) => {
        const out = await tools.run(d.name, args as Record<string, unknown>);
        const content: any[] = [{ type: "text", text: out.text }];
        if (out.image) content.push({ type: "image", data: out.image.data, mimeType: out.image.mimeType });
        return { content, isError: out.isError };
      }),
    ),
  });
}
