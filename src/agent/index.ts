import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AgentLink } from "../core/agentLink";
import { SessionManager } from "../core/manager";

/**
 * `npm run agent -- --hub http://host:5318 --name Matt --token …`
 *
 * Lends the coding agents installed on this machine to a Caddis hub. Turns
 * run here, with your own logins and in a working directory here; the hub
 * only sees the canvas tool calls and the agent's replies. The desktop app
 * does this by itself when it connects to a hub.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { values } = parseArgs({
  options: {
    hub: { type: "string", default: process.env.CADDIS_HUB_URL },
    name: { type: "string", default: process.env.CADDIS_HUB_NAME },
    token: { type: "string", default: process.env.CADDIS_HUB_TOKEN },
    cwd: { type: "string", default: process.env.CADDIS_DEFAULT_CWD },
    "no-handoffs": { type: "boolean", default: false },
  },
});
if (!values.hub || !values.name || !values.token) {
  console.error(
    "usage: npm run agent -- --hub <url> --name <your name> --token <hub token> [--cwd <dir>] [--no-handoffs]",
  );
  process.exit(2);
}

const DATA = path.resolve(process.env.CADDIS_DATA_DIR ?? path.join(ROOT, "data"));
const manager = new SessionManager(DATA);
await manager.discover();
const ready = manager.providerInfos().filter((p) => p.enabled);
console.log(`[caddis agent] agents here: ${ready.map((p) => p.label).join(", ") || "none signed in"}`);

const link = new AgentLink({
  url: values.hub,
  token: values.token,
  name: values.name,
  providers: manager.providers,
  infos: () => manager.providerInfos(),
  onProviders: (cb) => manager.onProviders(cb),
  dataDir: DATA,
  cwd: values.cwd ? path.resolve(values.cwd) : undefined,
  handoffs: !values["no-handoffs"],
}).start();

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    link.close();
    manager.shutdown();
    process.exit(0);
  });
