// The README demo clip: three people on the floor, seen from one of them.
// With `npm run dev` running:  npx tsx scripts/demo-video.ts [outDir]
// Optional: DEMO_CAMS=a.y4m,b.y4m gives the two teammates a camera picture other than
// Chrome's test pattern. Writes <outDir>/demo.webm; scripts/demo-gif.sh makes docs/demo.gif.
import { chromium, type Page } from "playwright";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? "/tmp/po-demo";
const BASE = process.env.BASE ?? "http://localhost:5173";
const CAMS = (process.env.DEMO_CAMS ?? "").split(",").filter(Boolean);
const SIZE = { width: 1280, height: 760 };
mkdirSync(OUT, { recursive: true });
const cache = join(homedir(), "Library/Caches/ms-playwright");
const dir = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().find((d) => existsSync(join(cache, d, "chrome-mac-arm64"))) : undefined;
const executablePath = dir ? join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing") : undefined;
const browsers: { close(): Promise<void> }[] = [];

/** One browser each, so each person can have their own camera picture. */
async function person(email: string, name: string, opts: { cam?: string | false; record?: boolean } = {}): Promise<Page> {
  const args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
  if (opts.cam) args.push(`--use-file-for-fake-video-capture=${opts.cam}`);
  const browser = await chromium.launch({ executablePath, args });
  browsers.push(browser);
  const ctx = await browser.newContext({ viewport: SIZE, permissions: ["camera", "microphone"], ...(opts.record ? { recordVideo: { dir: OUT, size: SIZE } } : {}) });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/auth/dev?email=${email}&name=${encodeURIComponent(name)}`);
  if (opts.cam === false) await p.getByRole("button", { name: "Camera off" }).click().catch(() => {});
  await p.getByRole("button", { name: "Join Space" }).click();
  await p.waitForFunction(() => (window as any).__es?.state?.me);
  await p.getByRole("button", { name: "I'll explore on my own" }).click({ timeout: 4000 }).catch(() => {});
  return p;
}
const es = (p: Page, fn: string) => p.evaluate(`(() => { const e = window.__es; ${fn} })()`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A caption pill at the top of the recorded view. */
const caption = (p: Page, text: string) => p.evaluate((t) => {
  let el = document.getElementById("demo-caption");
  if (!el) {
    el = document.createElement("div");
    el.id = "demo-caption";
    el.style.cssText = "position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:99999;background:rgba(20,20,24,.86);color:#fff;font:600 22px/1.2 system-ui,-apple-system,sans-serif;padding:12px 22px;border-radius:999px;transition:opacity .3s;pointer-events:none";
    document.body.appendChild(el);
  }
  el.textContent = t;
  el.style.opacity = t ? "1" : "0";
}, text);

// Two teammates first, so the recorded view opens with people already on the floor.
const morgan = await person("morgan@example.com", "Morgan Lee", { cam: CAMS[0] });
const riley = await person("riley@example.com", "Riley Park", { cam: CAMS[1] ?? CAMS[0] });
await es(morgan, "e.jump({ x: 1180, y: 1230 })");
await es(riley, "e.jump({ x: 1250, y: 1560 })");
const alex = await person("admin@example.com", "Alex Admin", { cam: false, record: true });
// Close the first-day checklist so the floor is clear.
await alex.waitForTimeout(800);
await alex.evaluate(() => {
  const title = [...document.querySelectorAll("*")].find((n) => n.childElementCount === 0 && n.textContent?.trim() === "Getting started");
  let box = title?.parentElement;
  while (box && box.querySelectorAll("button").length === 0) box = box.parentElement;
  const btns = box ? [...box.querySelectorAll("button")] : [];
  btns[btns.length - 1]?.click();
});
await es(alex, "e.camera.zoom = 1.15; e.jump({ x: 1620, y: 1080 })");
await caption(alex, "Everyone is on one floor plan");
await wait(2500);

await caption(alex, "Walk up to someone to talk");
await es(morgan, "e.walk({ x: 1540, y: 1110 })");
await wait(4500);
await caption(alex, "Groups form on their own");
await es(riley, "e.walk({ x: 1600, y: 1175 })");
await wait(4500);
await caption(alex, "Walk away and their voices fade");
await es(alex, "e.walk({ x: 1180, y: 960 })");
await wait(4500);
await caption(alex, "No links, no invites. Just walk over.");
await es(alex, "e.walk({ x: 1600, y: 1060 })");
await wait(3500);

const video = alex.video();
await alex.context().close();
renameSync(await video!.path(), join(OUT, "demo.webm"));
for (const b of browsers) await b.close();
console.log("wrote", join(OUT, "demo.webm"));
