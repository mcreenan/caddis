import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { MCP_SERVER_NAME, type ToolOutput, type ToolSet } from "./tools";

/**
 * The canvas tools as a Model Context Protocol server for agents that run out
 * of process (Codex, ACP agents). Claude gets them in-process through the
 * Agent SDK instead.
 *
 * One loopback HTTP listener serves every session: each run registers its
 * ToolSet under an unguessable path. It speaks the stateless subset of the
 * Streamable HTTP transport (POST a JSON-RPC message, get a JSON reply).
 * `stdio` describes a tiny bridge for agents that only launch stdio servers.
 */

export interface McpEndpoint {
  name: string;
  url: string;
  /** Same server over stdio: a Node one-liner that forwards each line to `url`. */
  stdio: { command: string; args: string[]; env: Record<string, string> };
  dispose(): void;
}

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 32 * 1024 * 1024;

/** Forwards newline-delimited JSON-RPC from stdin to the HTTP endpoint and writes replies to stdout. */
const BRIDGE = `
const url = process.argv[1];
let buf = "", chain = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) chain = chain.then(() => forward(line));
  }
});
process.stdin.on("end", () => chain.then(() => process.exit(0)));
async function forward(line) {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: line });
    const t = await r.text();
    if (t.trim()) process.stdout.write(t.trim() + "\\n");
  } catch (e) {
    let id = null;
    try { id = JSON.parse(line).id ?? null; } catch {}
    if (id !== null) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e) } }) + "\\n");
  }
}`;

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

export class McpHost {
  private server?: http.Server;
  private port?: Promise<number>;
  private readonly routes = new Map<string, ToolSet>();

  private listen(): Promise<number> {
    this.port ??= new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res));
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
      server.unref();
      this.server = server;
    });
    return this.port;
  }

  /** Serve `tools` until the returned endpoint is disposed. */
  async register(tools: ToolSet): Promise<McpEndpoint> {
    const port = await this.listen();
    const token = randomBytes(24).toString("base64url");
    this.routes.set(token, tools);
    const url = `http://127.0.0.1:${port}/mcp/${token}`;
    return {
      name: MCP_SERVER_NAME,
      url,
      stdio: { command: process.execPath, args: ["-e", BRIDGE, url], env: { ELECTRON_RUN_AS_NODE: "1" } },
      dispose: () => this.routes.delete(token),
    };
  }

  close() {
    this.server?.close();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const tools = this.routes.get(/^\/mcp\/([\w-]+)$/.exec(req.url ?? "")?.[1] ?? "");
    if (!tools) return void res.writeHead(404).end();
    if (req.method === "DELETE") return void res.writeHead(200).end();
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();

    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) throw new Error("request too large");
        chunks.push(c);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (e: any) {
      return reply(res, 400, rpcError(null, -32700, e?.message ?? "parse error"));
    }

    const batch = Array.isArray(body);
    const msgs = (batch ? body : [body]) as Rpc[];
    const out = (await Promise.all(msgs.map((m) => this.dispatch(tools, m)))).filter(Boolean);
    if (!out.length) return void res.writeHead(202).end();
    reply(res, 200, batch ? out : out[0]);
  }

  /** Returns a response for requests, nothing for notifications and responses. */
  private async dispatch(tools: ToolSet, m: Rpc): Promise<object | undefined> {
    if (!m || typeof m !== "object" || typeof m.method !== "string") return undefined;
    const isRequest = m.id !== undefined && m.id !== null;
    if (!isRequest) return undefined;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize": {
        const asked = m.params?.protocolVersion;
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: "2.0.0" },
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: listTools(tools) });
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        const def = tools.defs.find((d) => d.name === name);
        if (!def) return ok(toResult({ text: `unknown tool ${name}`, isError: true }));
        const args = z.object(def.shape).safeParse(m.params?.arguments ?? {});
        if (!args.success)
          return ok(toResult({ text: `Invalid arguments: ${z.prettifyError(args.error)}`, isError: true }));
        return ok(toResult(await tools.run(name, args.data as Record<string, unknown>)));
      }
      case "resources/list":
        return ok({ resources: [] });
      case "resources/templates/list":
        return ok({ resourceTemplates: [] });
      case "prompts/list":
        return ok({ prompts: [] });
    }
    return rpcError(m.id, -32601, `method not found: ${m.method}`);
  }
}

const schemas = new WeakMap<ToolSet, object[]>();

function listTools(tools: ToolSet) {
  let list = schemas.get(tools);
  if (!list) {
    list = tools.defs.map((d) => {
      const { $schema: _, ...inputSchema } = z.toJSONSchema(z.object(d.shape), { io: "input" }) as Record<
        string,
        unknown
      >;
      return { name: d.name, description: d.description, inputSchema };
    });
    schemas.set(tools, list);
  }
  return list;
}

function toResult(out: ToolOutput) {
  const content: object[] = [{ type: "text", text: out.text }];
  if (out.image) content.push({ type: "image", data: out.image.data, mimeType: out.image.mimeType });
  return { content, isError: Boolean(out.isError) };
}

const rpcError = (id: Rpc["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

function reply(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
