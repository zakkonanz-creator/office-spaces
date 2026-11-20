// Screenshots of the Office Designer panel (admin) with a real draft:  npx tsx scripts/shots-designer.ts /tmp/es-designer
import { chromium } from "playwright";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const OUT = process.argv[2] ?? "/tmp/es-designer";
const BASE = process.env.BASE ?? "http://localhost:5173";
mkdirSync(OUT, { recursive: true });
const cache = join(homedir(), "Library/Caches/ms-playwright");
const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().find((d) => existsSync(join(cache, d, "chrome-mac-arm64")));
const browser = await chromium.launch({ executablePath: dir ? join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing") : undefined, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
for (const scheme of ["light", "dark"] as const) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["camera", "microphone"], colorScheme: scheme });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/auth/dev?email=admin@example.com&name=Alex%20Admin`);
  await p.getByRole("button", { name: "Join Space" }).click();
  await p.waitForFunction(() => (window as any).__es?.state?.me, null, { timeout: 20000 });
  await p.getByRole("button", { name: "Design" }).click();
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${OUT}/${scheme}-empty.png` });
  if (scheme === "light") {
    await p.getByPlaceholder(/reading corner/).fill("Add two tall plants either side of the elevator in the Lounge, and make the Kitchen rug teal");
    await p.getByRole("button", { name: "Design it" }).click();
    await p.waitForTimeout(800);
    await p.screenshot({ path: `${OUT}/${scheme}-thinking.png` });
    await p.getByRole("button", { name: "Apply for everyone" }).waitFor({ timeout: 180000 });
    await p.waitForTimeout(800);
    await p.screenshot({ path: `${OUT}/${scheme}-draft.png` });
    await p.locator("details.versions summary").click().catch(() => {});
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${OUT}/${scheme}-history.png` });
  }
  if (errors.length) console.log(scheme, "page errors:", errors.join(" | "));
  await ctx.close();
}
await browser.close();
console.log("done");
