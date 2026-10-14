import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  CANVAS_TOOLS,
  MCP_SERVER_NAME,
  type CanvasContextKind,
  type CanvasDoc,
  type CanvasMode,
  type CanvasPatch,
  type CanvasToolName,
  type ChromeComponent,
  type ChromeProps,
  type ConsoleEntry,
} from "../shared/protocol";

export interface RenderReport {
  version: number;
  /** A live viewer confirmed it rebuilt this version. */
  verified: boolean;
  errors: ConsoleEntry[];
}

export interface FrameResult {
  ok: boolean;
  value?: string;
  error?: string;
  image?: { data: string; mimeType: string };
}

/** What the tools need from a session. Implemented by Session. */
export interface CanvasToolHost {
  setMode(mode: CanvasMode, context?: CanvasContextKind): Promise<RenderReport>;
  write(doc: Partial<Pick<CanvasDoc, "mode" | "html" | "css" | "script" | "context">>): Promise<RenderReport>;
  patch(patch: CanvasPatch): { matched: number; version: number };
  evalJs(js: string): Promise<FrameResult>;
  snapshot(maxWidth: number): Promise<FrameResult>;
  getState(): { canvas: CanvasDoc; console: ConsoleEntry[] };
  chromeUpdate(component: ChromeComponent, props: Record<string, unknown>): { props: ChromeProps; notes: string[] };
  chromeReset(component?: ChromeComponent): void;
}

export interface ToolOutput {
  text: string;
  image?: { data: string; mimeType: string };
  isError?: boolean;
}

const fmtErrors = (errs: ConsoleEntry[]) =>
  errs.length ? `\nErrors:\n${errs.map((e) => `- [${e.level}] ${e.message}`).join("\n")}` : "";

const fmtRender = (r: RenderReport) =>
  r.verified
    ? `Rendered v${r.version}${r.errors.length ? " WITH ERRORS" : " OK"}.${fmtErrors(r.errors)}`
    : `Saved v${r.version} (no live viewer confirmed render yet).`;

/** Provider-agnostic tool dispatch. */
export async function runCanvasTool(host: CanvasToolHost, name: CanvasToolName, args: any): Promise<ToolOutput> {
  try {
    switch (name) {
      case "canvas_set_mode": {
        const r = await host.setMode(args.mode, args.context);
        return { text: fmtRender(r), isError: r.errors.length > 0 };
      }
      case "canvas_write": {
        const r = await host.write(args);
        return { text: fmtRender(r), isError: r.errors.length > 0 };
      }
      case "canvas_patch": {
        const r = host.patch(args);
        return r.matched
          ? { text: `Patched ${r.matched} element(s); now v${r.version}.` }
          : { text: `No element matched ${JSON.stringify(args.selector)}; nothing changed.`, isError: true };
      }
      case "canvas_eval": {
        const r = await host.evalJs(args.js);
        return r.ok ? { text: r.value ?? "undefined" } : { text: `Error: ${r.error}`, isError: true };
      }
      case "canvas_get_state": {
        const { canvas, console } = host.getState();
        const src = { version: canvas.version, mode: canvas.mode, context: canvas.context, html: canvas.html, css: canvas.css, script: canvas.script };
        const logs = console.length
          ? console.map((e) => `[${e.level}] ${e.message}`).join("\n")
          : "(none)";
        return { text: `${JSON.stringify(src, null, 2)}\n\nConsole (current version):\n${logs}` };
      }
      case "canvas_snapshot": {
        const r = await host.snapshot(args.maxWidth ?? 768);
        if (!r.ok || !r.image) return { text: `Snapshot failed: ${r.error ?? "no image"}`, isError: true };
        return { text: "Snapshot:", image: r.image };
      }
      case "chrome_update": {
        const r = host.chromeUpdate(args.component, args.props ?? {});
        const notes = [...r.notes, "position/size are further clamped to the viewport (>=80% on-screen)"];
        return { text: `Applied ${JSON.stringify(r.props)}\nNotes: ${notes.join("; ")}` };
      }
      case "chrome_reset": {
        host.chromeReset(args.component);
        return { text: `Reset ${args.component ?? "all chrome"} to defaults.` };
      }
    }
  } catch (e: any) {
    return { text: `Error: ${e?.message ?? String(e)}`, isError: true };
  }
}

/** In-process MCP server exposing the canvas tools to the Claude Agent SDK. */
export function createCanvasMcpServer(host: CanvasToolHost) {
  const tools = (Object.keys(CANVAS_TOOLS) as CanvasToolName[]).map((name) => {
    const spec = CANVAS_TOOLS[name];
    return tool(name, spec.description, spec.shape as any, async (args: any) => {
      const out = await runCanvasTool(host, name, args);
      const content: any[] = [{ type: "text", text: out.text }];
      if (out.image) content.push({ type: "image", data: out.image.data, mimeType: out.image.mimeType });
      return { content, isError: out.isError };
    });
  });
  return createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools, alwaysLoad: true, timeout: 60_000 });
}

export const mcpToolName = (name: CanvasToolName) => `mcp__${MCP_SERVER_NAME}__${name}`;
