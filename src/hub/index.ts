import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHubServer } from "./server";

/**
 * `npm run hub`: the optional Caddis hub. Projects, multiplayer artifacts and
 * git history for everyone who joins with the access token. Agents stay on
 * each person's machine (`npm run agent`, or the desktop app).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = path.resolve(process.env.CADDIS_HUB_DIR ?? path.join(ROOT, "hub-data"));
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 5318);

/** CADDIS_HUB_TOKEN, else a token generated once and kept in the hub's directory. */
function token() {
  if (process.env.CADDIS_HUB_TOKEN) return process.env.CADDIS_HUB_TOKEN;
  const file = path.join(DIR, "token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(DIR, { recursive: true });
  const t = randomBytes(18).toString("base64url");
  writeFileSync(file, `${t}\n`, { mode: 0o600 });
  return t;
}

const t = token();
const server = await startHubServer({
  dir: DIR,
  token: t,
  name: process.env.CADDIS_HUB_NAME ?? os.hostname(),
  host: HOST,
  port: PORT,
  root: ROOT,
  ui: path.join(ROOT, "out/renderer"),
});
console.log(`caddis hub on http://${HOST}:${server.port}  (data: ${DIR})`);
console.log(`access token: ${t}`);

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    void server.close().finally(() => process.exit(0));
  });
