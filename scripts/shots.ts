// Screenshots of every screen, light and dark, desktop and phone:
//   npx tsx scripts/shots.ts /tmp/es-ui
import { chromium } from "playwright";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? "/tmp/es-ui";
const BASE = process.env.BASE ?? "http://localhost:5173";
mkdirSync(OUT, { recursive: true });
const cache = join(homedir(), "Library/Caches/ms-playwright");
const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().find((d) => existsSync(join(cache, d, "chrome-mac-arm64")));
const browser = await chromium.launch({
  executablePath: dir ? join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing") : undefined,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
for (const [label, viewport, scheme] of [["desk", { width: 1360, height: 860 }, "light"], ["desk-dark", { width: 1360, height: 860 }, "dark"], ["phone", { width: 390, height: 844 }, "light"]] as const) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, permissions: ["camera", "microphone"], isMobile: label === "phone", hasTouch: label === "phone" });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/${label}-signin.png` });
  await page.goto(`${BASE}/auth/dev?email=admin@example.com&name=Alex%20Admin`);
  await page.getByRole("button", { name: "Join the office" }).waitFor();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/${label}-prejoin.png` });
  await page.getByRole("button", { name: "Join the office" }).click();
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}/${label}-office.png` });
  await page.locator(".tool.status-btn").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${label}-status-menu.png` });
  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${label}-shortcuts.png` });
  for (const t of ["members", "guests", "settings", "analytics"]) {
    await page.goto(`${BASE}/admin/${t}`);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/${label}-admin-${t}.png`, fullPage: t !== "members" });
  }
  await ctx.close();
}
await browser.close();
console.log("done", OUT);
