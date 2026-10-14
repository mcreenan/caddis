// End-to-end: drive the real UI in headless Chromium against a running server.
//   BASE=http://192.168.86.73:5317 npm run e2e
//   PROMPTS='first prompt||second prompt' npm run e2e   # free-form: run prompts, dump tool calls
// Artifacts (screenshots, summary.json) go to .e2e/.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";

const BASE = process.env.BASE ?? "http://127.0.0.1:5317";
const OUT = path.resolve(".e2e");
const DATA = path.resolve(process.env.CANVAS_DATA_DIR ?? "data", "sessions");
const MODEL = process.env.MODEL ?? "";
const EFFORT = process.env.EFFORT ?? "low";
const TURN_TIMEOUT = 300_000;
mkdirSync(OUT, { recursive: true });

const log = (...a: unknown[]) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);

async function waitTurns(page: Page, n: number) {
  await page.waitForFunction((n) => document.querySelectorAll("#history .hi-turn, #history .hi-notice.error").length >= n, n, {
    timeout: TURN_TIMEOUT,
    polling: 500,
  });
}

const sessionFile = (page: Page) => {
  const id = new URL(page.url()).searchParams.get("s");
  return JSON.parse(readFileSync(path.join(DATA, `${id}.json`), "utf8"));
};

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("console", (m) => m.type() === "error" && log("page console error:", m.text()));
  const summary: Record<string, unknown> = { base: BASE };

  log("open", BASE);
  await page.goto(BASE);
  if (process.env.PROMPTS) return freeform(page, process.env.PROMPTS.split("||")).finally(() => browser.close());
  await page.waitForSelector("#start:not([hidden])");
  summary.startScreen = {
    historyHidden: await page.locator("#history").isHidden(),
    promptHidden: await page.locator("#prompt").isHidden(),
    providers: await page.locator("#opt-provider option").allTextContents(),
  };
  await page.screenshot({ path: `${OUT}/0-start.png` });

  await page.fill("#opt-model", MODEL);
  await page.selectOption("#opt-effort", EFFORT);
  await page.fill("#opt-cwd", process.cwd());
  await page.fill("#start-input", "make the canvas a 3d spinning cube");
  await page.press("#start-input", "Enter");
  await page.waitForURL(/\?s=/);
  log("session", page.url());
  await waitTurns(page, 1);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/1-cube.png` });

  let s = sessionFile(page);
  const tools1 = s.history.filter((h: any) => h.kind === "tool").map((h: any) => `${h.name} [${h.state}]`);
  log("turn 1 tools:", tools1);
  summary.turn1 = {
    tools: tools1,
    canvas: { mode: s.canvas.mode, version: s.canvas.version, scriptChars: s.canvas.script.length },
    afterFirstMessage: {
      startHidden: await page.locator("#start").isHidden(),
      historyVisible: await page.locator("#history").isVisible(),
      promptVisible: await page.locator("#prompt").isVisible(),
    },
    lastText: s.history.filter((h: any) => h.kind === "assistant").at(-1)?.text,
    turn: s.history.filter((h: any) => h.kind === "turn").at(-1),
  };

  // Turn 2: exercise eval/snapshot round-trips and clamped chrome updates.
  const ta = page.locator("#prompt textarea");
  await ta.fill(
    "Use canvas_eval to report the cube's current rotation.y, then canvas_snapshot to look at it. " +
      "Then set the prompt's opacity to 0.1 and move it to x=-2000,y=20, and make the history panel accent orange and mini. Keep replies short.",
  );
  await ta.press("Enter");
  await waitTurns(page, 2);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/2-chrome.png` });
  s = sessionFile(page);
  const tools2 = s.history
    .slice(s.history.findLastIndex((h: any) => h.kind === "user"))
    .filter((h: any) => h.kind === "tool")
    .map((h: any) => ({ name: h.name, state: h.state, result: String(h.result ?? "").slice(0, 300) }));
  log("turn 2 tools:", tools2.map((t: any) => t.name));
  const promptBox = await page.locator("#prompt").boundingBox();
  summary.turn2 = {
    tools: tools2,
    chrome: s.chrome,
    promptComputed: await page.evaluate(() => ({ opacity: getComputedStyle(document.querySelector("#prompt")!).opacity })),
    promptBox,
    miniVisible: await page.locator("#mini").isVisible(),
    lastText: s.history.filter((h: any) => h.kind === "assistant").at(-1)?.text,
  };

  // Escape hatch.
  await page.keyboard.press("Control+Shift+Escape");
  summary.safeModeVisible = await page.locator("#safe").isVisible();
  await page.screenshot({ path: `${OUT}/3-safe.png` });
  await page.click('#safe [data-act="chrome.reset"]');
  await page.waitForTimeout(300);
  summary.afterReset = sessionFile(page).chrome;
  await page.keyboard.press("Escape");

  // Reload restores from the server.
  const before = sessionFile(page);
  await page.reload();
  await page.waitForSelector("#prompt:not([hidden])");
  await page.waitForTimeout(1500);
  summary.reload = {
    historyItems: await page.locator("#history .hi").count(),
    serverHistoryItems: before.history.length,
    canvasVersion: before.canvas.version,
  };
  await page.screenshot({ path: `${OUT}/4-reload.png` });

  writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
}

async function freeform(page: Page, prompts: string[]) {
  await page.waitForSelector("#start:not([hidden])");
  await page.selectOption("#opt-effort", EFFORT);
  await page.fill("#opt-model", MODEL);
  await page.fill("#opt-cwd", process.cwd());
  const out: unknown[] = [];
  for (const [i, p] of prompts.entries()) {
    if (i === 0) {
      await page.fill("#start-input", p);
      await page.press("#start-input", "Enter");
      await page.waitForURL(/\?s=/);
    } else {
      await page.fill("#prompt textarea", p);
      await page.press("#prompt textarea", "Enter");
    }
    await waitTurns(page, i + 1);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/ff-${i + 1}.png` });
    const s = sessionFile(page);
    const turn = s.history.slice(s.history.findLastIndex((h: any) => h.kind === "user"));
    out.push({
      prompt: p,
      tools: turn.filter((h: any) => h.kind === "tool").map((h: any) => `${h.name.replace("mcp__canvas__", "")} [${h.state}] ${String(h.result ?? "").slice(0, 160).replace(/\n/g, " ")}`),
      canvas: { mode: s.canvas.mode, version: s.canvas.version, html: s.canvas.html.slice(0, 200) },
      reply: turn.filter((h: any) => h.kind === "assistant").at(-1)?.text,
    });
  }
  console.log(JSON.stringify({ url: page.url(), turns: out }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
