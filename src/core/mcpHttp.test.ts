import { spawn } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { McpHost } from "./mcpHttp";
import type { ToolSet } from "./tools";

const tools: ToolSet = {
  defs: [{ name: "echo", description: "Echo text back", shape: { text: z.string(), times: z.number().optional() } }],
  async run(_name, args) {
    return { text: String(args.text).repeat(Number(args.times ?? 1)) };
  },
};

const rpc = async (url: string, body: unknown) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: r.status === 200 ? await r.json() : undefined };
};

describe("McpHost", () => {
  it("serves a tool set over Streamable HTTP", async () => {
    const host = new McpHost();
    const ep = await host.register(tools);
    try {
      const init = await rpc(ep.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      });
      expect(init.json.result.protocolVersion).toBe("2025-06-18");
      expect((await rpc(ep.url, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

      const list = await rpc(ep.url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      const [echo] = list.json.result.tools;
      expect(echo.name).toBe("echo");
      expect(echo.inputSchema).toMatchObject({ type: "object", required: ["text"] });

      const call = await rpc(ep.url, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "ab", times: 2 } },
      });
      expect(call.json.result).toEqual({ content: [{ type: "text", text: "abab" }], isError: false });

      const bad = await rpc(ep.url, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "echo", arguments: { times: 2 } },
      });
      expect(bad.json.result.isError).toBe(true);

      expect((await rpc(ep.url.replace(/[^/]+$/, "nope"), { jsonrpc: "2.0", id: 5, method: "ping" })).status).toBe(404);
      ep.dispose();
      expect((await rpc(ep.url, { jsonrpc: "2.0", id: 6, method: "ping" })).status).toBe(404);
    } finally {
      host.close();
    }
  });

  it("bridges stdio to the endpoint", async () => {
    const host = new McpHost();
    const ep = await host.register(tools);
    try {
      const child = spawn(ep.stdio.command, ep.stdio.args, { env: { ...process.env, ...ep.stdio.env } });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "echo", arguments: { text: "hi" } },
        }) + "\n",
      );
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      child.stdin.end();
      await new Promise((r) => child.on("exit", r));
      const lines = out
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines).toEqual([
        { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "hi" }], isError: false } },
      ]);
    } finally {
      host.close();
    }
  });
});
