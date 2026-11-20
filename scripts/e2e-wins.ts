// A screenshot posted in #wins shows as the picture itself (the owner, 2026-11-16): on the jumbotron, in
// its full view and in the bell banner, not "posted a win". Guests can't fetch it.
//   npm run dev   (in another terminal)
//   BASE=http://localhost:5173 npx tsx scripts/e2e-wins.ts [--shots dir]

import { chromium, type Page, type Browser } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:5173";
const args = process.argv.slice(2);
const SHOTS = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : "";
let failures = 0;
const ok = (cond: unknown, msg: string) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; };
const es = <T>(page: Page, fn: string) => page.evaluate(fn) as Promise<T>;
const until = (page: Page, expr: string, ms = 10000) => page.waitForFunction(expr, null, { timeout: ms, polling: 200 }).then(() => true, () => false);
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function person(browser: Browser, email: string, name: string) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, permissions: ["camera", "microphone"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${name}] page error: ${e.message}`));
  await page.goto(`${BASE}/auth/dev?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`);
  await page.getByRole("button", { name: "Join Space" }).waitFor({ timeout: 15000 });
  await page.evaluate(() => fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ track: "member", dismiss: true }) })).catch(() => {});
  await page.getByRole("button", { name: "Join Space" }).click();
  await page.waitForFunction(() => (window as any).__es?.state?.me && (window as any).__es.room()?.state === "connected", null, { timeout: 20000 });
  return page;
}

const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
try {
  // A stand-in for a customer's kind words, screenshotted the way people post them.
  const art = await (await browser.newContext({ viewport: { width: 640, height: 300 } })).newPage();
  await art.setContent(`<body style="margin:0;font:22px system-ui;background:#fff;display:grid;place-items:center;height:100vh"><div style="max-width:520px;padding:24px;border:1px solid #ddd;border-radius:12px"><b>Maria (client)</b><p>Kai fixed our whole onboarding in one call. Best support we've ever had! ⭐⭐⭐⭐⭐</p></div></body>`);
  const png = (await art.screenshot()).toString("base64");

  const alex = await person(browser, "admin@example.com", "Alex Admin");
  // The local floor has no wall screen (production's does): hang one beside Alex, on his screen only.
  await es(alex, `(() => { const me = __es.live.get(__es.state.me.id); __es.state.floor = { ...__es.state.floor, objects: [...__es.state.floor.objects, { id: "e2e-jumbo", type: "jumbotron", x: Math.round(me.x) + 60, y: Math.round(me.y) - 200, w: 320, h: 180 }] }; __es.toast("e2e", { ttl: 300 }); })()`);
  ok(await until(alex, `!!document.querySelector(".obj-jumbotron")`), "(test setup) a wall screen beside Alex");
  const r = await es<{ ok: boolean; img: number }>(alex, `fetch("/api/dev/win", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Kai Moreno", text: "", png: ${JSON.stringify(png)} }) }).then((r) => r.json())`);
  ok(r.ok && r.img > 0, "A screenshot-only win is saved with its picture");

  // The banner shows the picture.
  ok(await until(alex, `(() => { const i = document.querySelector(".win-banner img.win-img"); return i && i.complete && i.naturalWidth > 100 })()`), "The bell banner shows the screenshot");
  ok(!(await es<string>(alex, `document.querySelector(".win-banner")?.textContent ?? ""`)).includes("posted a win: "), "…not just a line of text");
  await shot(alex, "01-banner");

  // Every jumbotron on the floor jumps to it and shows the picture.
  ok(await until(alex, `(() => { const i = document.querySelector(".jumbo-screen .jumbo-pic img"); return i && i.complete && i.naturalWidth > 100 })()`, 15000), "The jumbotron shows the screenshot itself");
  const title = await es<string>(alex, `document.querySelector(".jumbo-screen .jumbo-bar span:last-child")?.textContent ?? ""`);
  ok(title.includes("Kai"), `…titled with who posted it (${title})`);
  ok(!(await es<string>(alex, `document.querySelector(".jumbo-screen")?.textContent ?? ""`)).includes("posted a win"), "…and never \"posted a win\"");
  await alex.locator(".jumbo-screen").first().scrollIntoViewIfNeeded().catch(() => {});
  await shot(alex, "02-jumbotron");

  // The full view lists it with the picture.
  const board = await es<any>(alex, `fetch("/api/jumbotron").then((r) => r.json())`);
  ok(board.wins?.[0]?.img === r.img, "/api/jumbotron carries the picture's id");
  await alex.locator(".obj-jumbotron").first().click();
  ok(await until(alex, `(() => { const i = document.querySelector(".jumbo-full img.jumbo-win-img"); return i && i.complete && i.naturalWidth > 100 })()`), "Clicking the screen: the Wins card shows the screenshot");
  await shot(alex, "03-full");

  // Guests never get it (customers' words, like the rest of the screen).
  const outsider = await (await browser.newContext()).newPage();
  const st = await outsider.goto(`${BASE}/api/jumbotron/win/${r.img}`).then((x) => x?.status());
  ok(st === 401 || st === 403, `Someone not signed in can't open the picture (${st})`);
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
