// Screenshots of key spots on the floor, for visual review:  npx tsx scripts/tour.ts /tmp/es-tour
import { chromium } from "playwright";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const OUT = process.argv[2] ?? "/tmp/es-tour";
const BASE = process.env.BASE ?? "http://localhost:5173";
mkdirSync(OUT, { recursive: true });
const cache = join(homedir(), "Library/Caches/ms-playwright");
const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().find((d) => existsSync(join(cache, d, "chrome-mac-arm64")));
const browser = await chromium.launch({ executablePath: dir ? join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing") : undefined, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["camera", "microphone"] });
const p = await ctx.newPage();
await p.goto(`${BASE}/auth/dev?email=admin@example.com&name=Alex%20Admin`);
await p.getByRole("button", { name: "Join the office" }).click();
await p.waitForFunction(() => (window as any).__es?.state?.me, null, { timeout: 20000 });
await p.keyboard.press("c"); // hide panel for a clean view
// Every room at working zoom, plus the whole floor.
const floor = await p.evaluate(() => (window as any).__es.state.floor);
const only = process.env.ONLY?.split(",");
const spots: [string, number, number, number][] = [
  ["overview", floor.width / 2, floor.height / 2, 0.36],
  ...([[1, 1], [3, 1], [1, 3], [3, 3]] as const).map(([qx, qy], i) => [`quad${i + 1}`, (floor.width * qx) / 4, (floor.height * qy) / 4, 0.62] as [string, number, number, number]),
  ...floor.rooms.map((r: any) => [r.id, r.x + r.w / 2, r.y + r.h / 2, Math.min(1, Math.max(0.55, 1100 / Math.max(r.w, r.h * 1.5)))] as [string, number, number, number]),
].filter(([n]) => !only || only.includes(n));
for (const [name, x, y, z] of spots) {
  await p.evaluate(([x, y, z]) => { const es = (window as any).__es; es.camera.zoom = z; es.jump({ x, y }); }, [x, y, z]);
  await p.waitForTimeout(900);
  await p.screenshot({ path: `${OUT}/${name}.png` });
}
await browser.close();
console.log("done");
