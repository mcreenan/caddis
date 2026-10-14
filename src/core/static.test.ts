import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { safeJoin } from "./static";

describe("safeJoin", () => {
  const base = path.resolve("/srv/frame");

  it("resolves paths inside the base", () => {
    expect(safeJoin(base, "vendor/three.js")).toBe(path.join(base, "vendor/three.js"));
    expect(safeJoin(base, "")).toBe(base);
  });

  it("refuses paths that escape the base", () => {
    expect(safeJoin(base, "../secret")).toBeUndefined();
    expect(safeJoin(base, "/etc/passwd")).toBeUndefined();
    expect(safeJoin(base, "a/../../frame-other/x")).toBeUndefined();
  });
});
