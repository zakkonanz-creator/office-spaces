// The whole floor in one image (no UI), for checking the layout:  npx tsx scripts/floor-shot.ts out.png [scale]
import { chromium } from "playwright";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const OUT = process.argv[2] ?? "/tmp/floor.png";
const BASE = process.env.BASE ?? "http://localhost:5173";
const cache = join(homedir(), "Library/Caches/ms-playwright");
const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().find((d) => existsSync(join(cache, d, "chrome-mac-arm64")));
const browser = await chromium.launch({ executablePath: dir ? join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing") : undefined, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const ctx = await browser.newContext({ viewport: { width: 2400, height: 2160 }, permissions: ["camera", "microphone"] });
  await ctx.addInitScript(() => { try { localStorage.setItem("es.roombar", "open"); } catch {} }); // keep the room bar open: tests click its buttons
const p = await ctx.newPage();
await p.goto(`${BASE}/auth/dev?email=admin@example.com&name=Alex%20Admin`);
// Test people skip the first-day welcome: these suites test the office, not onboarding.
await p.evaluate(() => fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ track: "member", dismiss: true }) })).catch(() => {});
await p.getByRole("button", { name: "Join the office" }).click();
await p.waitForFunction(() => (window as any).__es?.state?.me, null, { timeout: 20000 });
await p.keyboard.press("c");
await p.waitForTimeout(500);
// Draw the floor 1:1, top-left at the viewport's top-left, with the UI hidden.
await p.addStyleTag({ content: ".toolbar-wrap,.roombar,.side,.rail,.map-btns,.stage-controls,.toasts,.avatar,[class*=toolbar],[class*=rail]{display:none!important}" });
await p.evaluate(`(() => {
  const w = document.querySelector(".world");
  window.__es.camera.zoom = 1;
  const freeze = () => { w.style.transform = "translate(0px,0px) scale(1)"; requestAnimationFrame(freeze); };
  freeze();
})()`);
await p.waitForTimeout(1200);
await p.screenshot({ path: OUT, clip: { x: 0, y: 0, width: 2400, height: 2160 } });
await browser.close();
console.log("wrote", OUT);
