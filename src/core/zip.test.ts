import { describe, expect, it } from "vite-plus/test";
import { readZip, writeZip } from "./zip";

describe("zip", () => {
  it("round-trips stored and deflated entries", () => {
    const entries = [
      { path: "manifest.json", data: Buffer.from(JSON.stringify({ a: 1 })) },
      { path: "canvas/scene.js", data: Buffer.from("x".repeat(10_000)) },
      { path: "ünïcode.txt", data: Buffer.from("héllo") },
    ];
    const files = readZip(writeZip(entries));
    expect([...files.keys()]).toEqual(entries.map((e) => e.path));
    for (const e of entries) expect(files.get(e.path)?.equals(e.data)).toBe(true);
  });

  it("rejects archives over the size limit", () => {
    const zip = writeZip([{ path: "big.bin", data: Buffer.alloc(4096) }]);
    expect(() => readZip(zip, 1024)).toThrow();
  });
});
