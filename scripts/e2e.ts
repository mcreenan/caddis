// End-to-end against a real Claude turn (subscription login; no API key).
//   npm run e2e                                   # Electron (default): launches out/main via Playwright
//   TARGET=web BASE=http://192.168.86.73:5317 npm run e2e   # against a running `npm run serve`
// Env: MODEL (default: host default), EFFORT (default low), DATA (web: the server's data dir).
// Artifacts (screenshots, summary.json) go to .e2e/<target>/.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron, chromium, type ElectronApplication, type Frame, type Page } from "playwright-core";

const TARGET = process.env.TARGET === "web" ? "web" : "electron";
const BASE = process.env.BASE ?? "http://127.0.0.1:5317";
const OUT = path.resolve(".e2e", TARGET);
const DATA = path.resolve(TARGET === "web" ? (process.env.DATA ?? "data") : path.join(OUT, "data"));
const MODEL = process.env.MODEL ?? "";
const EFFORT = process.env.EFFORT ?? "low";
const TURN_TIMEOUT = 360_000;

const log = (...a: unknown[]) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const summary: Record<string, unknown> = { target: TARGET };
const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  checks.push({ name, ok, detail });
  log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

let app: ElectronApplication | undefined;
let page: Page;
let sessionId = "";

const session = () => JSON.parse(readFileSync(path.join(DATA, "sessions", `${sessionId}.json`), "utf8"));
const turns = () => (existsSync(path.join(DATA, "sessions", `${sessionId}.json`)) ? session().history.filter((h: any) => h.kind === "turn").length : 0);
const toolsSince = (n: number) => session().history.slice(n).filter((h: any) => h.kind === "tool");
const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

async function frame(): Promise<Frame> {
  for (let i = 0; i < 100; i++) {
    const f = page.frames().find((f) => /\/frame\/index\.html/.test(f.url()));
    if (f && (await f.evaluate(() => !!(window as any).__ac).catch(() => false))) return f;
    await sleep(200);
  }
  throw new Error("canvas frame not found");
}
const fe = async <T>(fn: string): Promise<T> => (await frame()).evaluate(fn) as Promise<T>;

async function launch(sessionArg?: string) {
  if (TARGET === "electron") {
    const env = { ...process.env, AGENT_CANVAS_DATA_DIR: DATA, AGENT_CANVAS_DEFAULT_CWD: CWD } as Record<string, string>;
    delete env.ANTHROPIC_API_KEY;
    if (!env.XDG_SESSION_TYPE && env.WAYLAND_DISPLAY) env.XDG_SESSION_TYPE = "wayland";
    app = await _electron.launch({ args: [".", ...(sessionArg ? [`--session=${sessionArg}`] : [])], env });
    page = await app.firstWindow();
  } else {
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(sessionArg ? `${BASE}/?s=${sessionArg}` : BASE);
  }
  page.on("console", (m) => m.type() === "error" && log("console error:", m.text()));
}

async function close() {
  if (app) await app.close();
  else await page.context().browser()?.close();
  app = undefined;
}

/** Send a prompt and wait for the turn to finish. Returns the tool calls it made. */
async function turn(text: string) {
  const before = session().history.length;
  const n = turns();
  const ta = page.locator('[data-testid="prompt"] textarea');
  await ta.fill(text);
  await ta.press("Enter");
  log("prompt:", text.slice(0, 90));
  const t0 = Date.now();
  while (turns() <= n) {
    if (Date.now() - t0 > TURN_TIMEOUT) throw new Error("turn timed out");
    await sleep(500);
  }
  await sleep(800);
  const tools = toolsSince(before);
  log(`turn done in ${((Date.now() - t0) / 1000).toFixed(0)}s; tools:`, tools.map((t: any) => t.name.replace("mcp__canvas__", "")).join(", "));
  const last = session().history.filter((h: any) => h.kind === "turn").at(-1);
  if (!last.ok) log("turn error:", last.error);
  return tools as { name: string; input: any; result?: string; state: string }[];
}

const CWD = mkdtempSync(path.join(os.tmpdir(), "ac-e2e-cwd-"));

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  check("no ANTHROPIC_API_KEY in the test env (subscription auth)", !process.env.ANTHROPIC_API_KEY);

  // ---------------------------------------------------------------- 0. start screen
  await launch();
  await page.waitForSelector('[data-testid="start"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="start"] select option:nth-child(2)'), null, { timeout: 60_000 });
  const auth = (await page.locator('[data-testid="auth"]').textContent()) ?? "";
  summary.auth = auth;
  check("start screen shows subscription auth", /subscription/i.test(auth), auth);
  check("no chrome before the session starts", (await page.locator('[data-testid="prompt"], [data-testid="history"]').count()) === 0);
  await shot("0-start");

  // ---------------------------------------------------------------- 1. 3d scene
  const start = page.locator('[data-testid="start"]');
  if (MODEL) await start.locator("select").nth(0).selectOption(MODEL);
  await start.locator("select").nth(1).selectOption(EFFORT).catch(() => log("effort", EFFORT, "not offered"));
  await start.locator("input").fill(CWD);
  await start.locator("textarea").fill(
    "Make this window a 3D scene with a single spinning cube. Use 3d mode and one module named scene.js. " +
      "Keep the rotation angle in ctx.state.angle (initialise it only if undefined) and advance it in onFrame, so later edits keep the angle. Keep it minimal.",
  );
  await start.locator("textarea").press("Enter");
  await page.waitForURL(/[?&]s=/, { timeout: 30_000 });
  sessionId = new URL(page.url()).searchParams.get("s")!;
  summary.sessionId = sessionId;
  log("session", sessionId);
  const t0 = Date.now();
  while (turns() < 1) {
    if (Date.now() - t0 > TURN_TIMEOUT) throw new Error("first turn timed out");
    await sleep(500);
  }
  await sleep(1500);
  const firstTools = toolsSince(0);
  summary.turn1Tools = firstTools.map((t: any) => t.name);
  const s1 = await fe<any>(`({ mode: __ac.rt.mode, entries: [...__ac.entries.keys()], angle: __ac.states.get("scene.js")?.angle, stats: __ac.stats() })`);
  summary.turn1 = s1;
  check("3d mode with scene.js running", s1.mode === "3d" && s1.entries.includes("scene.js"), { mode: s1.mode, entries: s1.entries });
  check("ctx.state.angle is advancing", typeof s1.angle === "number" && s1.angle > 0, s1.angle);
  check("three.js scene renders", (s1.stats.three?.triangles ?? 0) > 0, s1.stats.three);
  await shot("1-cube");

  if (app) {
    const procs = await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      return { host: wc.mainFrame.osProcessId, frames: wc.mainFrame.framesInSubtree.map((f) => ({ url: f.url, pid: f.osProcessId })) };
    });
    summary.processes = procs;
    const cf = procs.frames.find((f) => f.url.startsWith("canvas://"));
    check("canvas iframe runs out of process (OOPIF)", !!cf && cf.pid !== procs.host, procs);
  }

  // ---------------------------------------------------------------- 2. in-place JS edit
  await fe(`window.__e2eMark = "kept"`);
  const before = await fe<any>(`({ angle: __ac.states.get("scene.js")?.angle, stats: __ac.stats() })`);
  const tools2 = await turn("Make the cube red. Change only the colour with a small resource_edit on scene.js; do not rewrite the file.");
  summary.turn2Tools = tools2.map((t) => ({ name: t.name, result: t.result?.slice(0, 300) }));
  check("agent used resource_edit", tools2.some((t) => t.name.endsWith("resource_edit")), tools2.map((t) => t.name));
  const after = await fe<any>(`(() => {
    const mesh = []; __ac.rt.scene.traverse((o) => o.isMesh && mesh.push(o));
    return { mark: window.__e2eMark, angle: __ac.states.get("scene.js")?.angle, stats: __ac.stats(), colors: mesh.map((m) => m.material?.color?.getHexString?.()) };
  })()`);
  summary.turn2 = after;
  check("no reload: frame globals survived the edit", after.mark === "kept");
  check("state survived the edit (angle continued, not reset)", after.angle > before.angle, { before: before.angle, after: after.angle });
  check("cube is red", after.colors.some((c: string) => /^(f|e|d|c)[0-9a-f]0{4}$|^ff[0-3][0-9a-f][0-3][0-9a-f]$/.test(c ?? "")), after.colors);
  const keys = ["timers", "rafs", "listeners", "webglContexts"] as const;
  check(
    "no growth in timers/rafs/listeners/GL contexts across the swap",
    keys.every((k) => after.stats[k] <= before.stats[k]) && (after.stats.three?.geometries ?? 0) <= (before.stats.three?.geometries ?? 0) + 0,
    Object.fromEntries([...keys, "geometries"].map((k) => [k, [before.stats[k] ?? before.stats.three?.[k], after.stats[k] ?? after.stats.three?.[k]]])),
  );
  check("no watchdog warnings after the edit", after.stats.warnings.length === 0, after.stats.warnings);
  await shot("2-red");

  // ---------------------------------------------------------------- 3. watchdog
  for (let i = 0; i < 4; i++) await fe(`__ac.rerun("scene.js")`);
  const clean = await fe<any>(`__ac.stats()`);
  check("4 re-runs of the agent's module: no leak warnings", clean.warnings.length === 0, clean.warnings);
  const LEAK = `export default function setup(ctx) {
    const d = document.createElement("div"); d.className = "e2e-leak"; document.body.append(d);   // never removed
    const g = new ctx.THREE.BoxGeometry(0.1, 0.1, 0.1);
    window.__e2eLeak = (window.__e2eLeak || []).concat(new ctx.THREE.Mesh(g));                  // kept alive outside the scene
  }`;
  await fe(`__ac.inject("leak.js", ${JSON.stringify(LEAK)})`);
  for (let i = 0; i < 3; i++) await fe(`__ac.rerun("leak.js")`);
  const leaky = await fe<any>(`__ac.stats()`);
  summary.leak = leaky.warnings;
  check("watchdog flags a deliberately leaky module", leaky.warnings.some((w: string) => /possible leak: dom/.test(w)), leaky.warnings);
  await page.waitForFunction(() => document.querySelector('[data-testid="stats-chip"].warn'), null, { timeout: 5000 }).then(
    () => check("UI shows the warning indicator", true),
    () => check("UI shows the warning indicator", false),
  );
  await shot("3-leak-warning");
  await fe(`__ac.inject("leak.js", null)`);
  await fe(`document.querySelectorAll(".e2e-leak").forEach((d) => d.remove()); window.__e2eLeak = []`);
  const cleared = await fe<any>(`__ac.stats()`);
  check("warning clears once the module is removed", cleared.warnings.length === 0, cleared.warnings);

  // ---------------------------------------------------------------- 4. data store
  const tools4 = await turn(
    "Add a task list overlay at the top-left of the canvas. Keep the tasks in the data store under key `tasks` " +
      "(array of {title, done}) — seed it with data_set with three short tasks, then add a fourth with data_append. " +
      "Render it with canvas.data.subscribe('tasks') so it re-renders when the data changes, with a button labelled Done on each task " +
      "that marks it done in the data store and calls canvas.emit('task-done', {title}). Keep the cube.",
  );
  summary.turn4Tools = tools4.map((t) => t.name);
  check("agent used data_set and data_append", ["data_set", "data_append"].every((n) => tools4.some((t) => t.name.endsWith(n))), summary.turn4Tools);
  const f = await frame();
  const tasks = session().data.tasks;
  summary.tasks = tasks;
  check("data store holds 4 tasks", Array.isArray(tasks) && tasks.length === 4, tasks?.length);
  const firstTitle = String(tasks?.[0]?.title ?? "");
  await f.waitForFunction((t) => document.body.innerText.includes(t), firstTitle, { timeout: 10_000 }).then(
    () => check("tasks rendered from the data store", true, firstTitle),
    () => check("tasks rendered from the data store", false, firstTitle),
  );
  const fourth = String(tasks?.[3]?.title ?? "");
  check("appended task rendered", fourth !== "" && (await f.evaluate((t) => document.body.innerText.includes(t), fourth)), fourth);
  await shot("4-tasks");

  // ---------------------------------------------------------------- 5. canvas -> agent
  const doneBtn = f.getByRole("button", { name: /done/i }).first();
  await doneBtn.click();
  await sleep(800);
  const afterClick = session();
  check("click wrote through to the data store", afterClick.data.tasks?.[0]?.done === true, afterClick.data.tasks?.[0]);
  check("emit recorded as a canvas event", afterClick.events.some((e: any) => e.type === "emit" && e.name === "task-done"), afterClick.events.slice(-3));
  const histBefore = session().history.length;
  await turn("What did I just do in the canvas? One sentence, naming the task.");
  const h5 = session().history.slice(histBefore);
  const userItem = h5.find((h: any) => h.kind === "user");
  const reply = h5.filter((h: any) => h.kind === "assistant").map((h: any) => h.text).join(" ");
  summary.turn5 = { attached: userItem?.attached, reply };
  check("canvas activity attached to the next turn", !!userItem?.attached, userItem?.attached);
  check("agent reports the emitted event", reply.toLowerCase().includes(firstTitle.toLowerCase().slice(0, 12)), reply);
  await shot("5-agent-read-emit");

  // ---------------------------------------------------------------- 6. chrome
  const promptBox0 = await page.locator('[data-testid="prompt"]').boundingBox();
  const tools6 = await turn(
    "Restyle the chrome with chrome_set: move the prompt bar to the top centre, set its opacity to 0.3, use the mono font for both the prompt and the history, and switch the history panel to mini mode.",
  );
  summary.turn6Tools = tools6.map((t) => ({ name: t.name, input: t.input, result: t.result?.slice(0, 400) }));
  check("agent used chrome_set", tools6.some((t) => t.name.endsWith("chrome_set")));
  const chrome = session().chrome;
  summary.chrome = chrome;
  const promptBox = await page.locator('[data-testid="prompt"]').boundingBox();
  check("prompt moved to the top", !!promptBox && !!promptBox0 && promptBox.y < 120 && promptBox0.y > 400, { before: promptBox0, after: promptBox });
  check("opacity clamped to 0.6 (asked 0.3)", chrome.prompt?.opacity === 0.6, chrome);
  check(
    "clamp echoed back to the agent",
    tools6.some((t) => t.name.endsWith("chrome_set") && /0\.6/.test(t.result ?? "")),
    tools6.filter((t) => t.name.endsWith("chrome_set")).map((t) => t.result),
  );
  const font = await page.locator('[data-testid="prompt"] textarea').evaluate((el) => getComputedStyle(el).fontFamily);
  check("prompt uses a monospace font", /mono|courier|consolas/i.test(font), font);
  check("history is mini", (await page.locator('[data-testid="history-mini"]').count()) === 1);
  await shot("6-chrome");

  // ---------------------------------------------------------------- 7. safe mode: reset + undo
  await page.keyboard.press("Control+Shift+Escape");
  await page.waitForSelector('[data-testid="safe"]', { timeout: 5000 });
  await shot("7-safe-mode");
  await page.locator('[data-testid="safe"]').getByRole("button", { name: /reset chrome/i }).click();
  await sleep(500);
  const reset = session().chrome;
  check("safe mode: reset chrome", !Object.keys(reset.prompt).length && !Object.keys(reset.history).length, reset);
  await page.locator('[data-testid="safe"]').getByRole("button", { name: /^undo/i }).click();
  await sleep(500);
  const undone = session().chrome;
  check("undo restores the agent's chrome", undone.prompt?.anchor === "top", undone);
  await page.keyboard.press("Control+Shift+Escape");
  await sleep(300);

  // ---------------------------------------------------------------- 8. persistence across restart
  await close();
  await launch(sessionId);
  const f2 = await frame();
  await sleep(1500);
  const restored = await f2.evaluate(`(() => {
    const mesh = []; __ac.rt.scene?.traverse((o) => o.isMesh && mesh.push(o));
    return { mode: __ac.rt.mode, entries: [...__ac.entries.keys()], colors: mesh.map((m) => m.material?.color?.getHexString?.()), text: document.body.innerText.slice(0, 400) };
  })()`) as any;
  summary.restored = restored;
  check("restart restores the 3d scene", restored.mode === "3d" && restored.entries.includes("scene.js"), restored.entries);
  check("restart restores the data-driven tasks", restored.text.includes(firstTitle), restored.text.slice(0, 120));
  const pb = await page.locator('[data-testid="prompt"]').boundingBox();
  check("restart restores the chrome (prompt at top)", !!pb && pb.y < 120, pb);
  await shot("8-restored");
  await close();
}

main()
  .catch(async (e) => {
    log("ERROR", e?.stack ?? e);
    checks.push({ name: "run completed", ok: false, detail: String(e?.message ?? e) });
    await page?.screenshot({ path: path.join(OUT, "error.png") }).catch(() => {});
    await close().catch(() => {});
  })
  .finally(() => {
    summary.checks = checks;
    writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
    const failed = checks.filter((c) => !c.ok);
    log(`${checks.length - failed.length}/${checks.length} checks passed`);
    rmSync(CWD, { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
  });
