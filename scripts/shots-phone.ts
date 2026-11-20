// Phone QA: every panel at phone sizes, plus an overflow check (anything poking past
// the screen edge, or a page that scrolls sideways). the owner, 2026-11-09: "make this mobile friendly".
//   npx tsx scripts/shots-phone.ts /tmp/es-phone        (needs `npm run dev`, or BASE=…)
// Prints one line per screen: ✓ or ✗ with what overflowed. Exit code 1 if anything did.
import { chromium, type Page } from "playwright";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? "/tmp/es-phone";
const BASE = process.env.BASE ?? "http://localhost:5173";
mkdirSync(OUT, { recursive: true });
const cache = join(homedir(), "Library/Caches/ms-playwright");
const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().find((d) => existsSync(join(cache, d, "chrome-mac-arm64")));
const browser = await chromium.launch({
  executablePath: dir ? join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing") : undefined,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});

let bad = 0;
/** Visible elements whose box pokes past the viewport (fixed UI only: the floor itself is meant to be bigger). */
async function overflow(page: Page, W: number) {
  return page.evaluate((W) => {
    const H = innerHeight;
    // A too-wide page on a phone zooms out to fit (innerWidth grows past the screen): that's the bug.
    if (innerWidth > W + 1) return [`page is ${innerWidth}px wide on a ${W}px screen (zoomed out to fit)`];
    const out: string[] = [];
    if (document.documentElement.scrollWidth > W + 1) out.push(`page scrolls sideways (${document.documentElement.scrollWidth}px > ${W}px)`);
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      if (el.closest(".world, .viewport > *:not(.world), svg, video, .minimap-floor, table, .table-wrap, .tl-row, .scroll-x")) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      // Only things that are on screen at all, and stick out sideways (vertical scrolling is fine).
      if (r.bottom < 0 || r.top > H) continue;
      if (r.right > W + 1 || r.left < -1) {
        // Ignore children of an element that scrolls horizontally on purpose.
        let p = el.parentElement, scroller = false;
        while (p) { const s = getComputedStyle(p); if ((s.overflowX === "auto" || s.overflowX === "scroll" || s.overflowX === "hidden" || s.overflow === "hidden") && p.getBoundingClientRect().right <= W + 1) { scroller = true; break; } p = p.parentElement; }
        if (scroller) continue;
        const name = `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""}`;
        out.push(`${name} ${Math.round(r.left)}→${Math.round(r.right)}`);
      }
    }
    return [...new Set(out)].slice(0, 6);
  }, W);
}
/** Tap targets smaller than 36px in the always-visible bars. */
async function smallTargets(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".toolbar button, .map-controls button, .room-bar button, .side-panel button, .tool-menu button")]
    .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.width < 32 || r.height < 32); })
    .map((b) => `${b.getAttribute("title") || b.getAttribute("aria-label") || b.textContent?.trim().slice(0, 20)} ${Math.round(b.getBoundingClientRect().width)}×${Math.round(b.getBoundingClientRect().height)}`).slice(0, 8));
}
async function shot(page: Page, label: string, name: string, opts: { targets?: boolean } = {}) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${OUT}/${label}-${name}.png` });
  const o = await overflow(page, page.viewportSize()!.width);
  const t = opts.targets ? await smallTargets(page) : [];
  if (o.length || t.length) bad++;
  console.log(`${o.length || t.length ? "✗" : "✓"} ${label} ${name}${o.length ? "  overflow: " + o.join(" · ") : ""}${t.length ? "  small: " + t.join(" · ") : ""}`);
}
const tap = async (page: Page, sel: string) => { const l = page.locator(sel).first(); if (await l.count()) { await l.tap({ timeout: 3000 }).catch(() => l.click({ timeout: 3000 }).catch(() => {})); return true; } return false; };
const esc = (page: Page) => page.keyboard.press("Escape").catch(() => {});

const sizes = [
  ["iphone", { width: 390, height: 844 }],
  ["small", { width: 360, height: 640 }],
  ["landscape", { width: 844, height: 390 }],
] as const;
const only = process.env.ONLY;
for (const [label, viewport] of sizes) {
  if (only && only !== label) continue;
  const ctx = await browser.newContext({ viewport, permissions: ["camera", "microphone"], isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${label}] page error: ${e.message}`));
  await page.goto(BASE);
  await page.waitForTimeout(600);
  await shot(page, label, "signin");
  await page.goto(`${BASE}/auth/dev?email=admin@example.com&name=Alex%20Admin`);
  await page.getByRole("button", { name: "Join Space" }).waitFor();
  await page.evaluate(() => fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ track: "member", dismiss: true }) })).catch(() => {});
  await shot(page, label, "prejoin");
  await page.getByRole("button", { name: "Join Space" }).click();
  await page.waitForFunction(() => (window as any).__es?.state?.me, null, { timeout: 20000 });
  await page.waitForTimeout(2500);
  // Into a room so the room bar shows its buttons.
  await page.evaluate(() => { const es = (window as any).__es; const r = es.state.floor.rooms.find((x: any) => x.kind === "meeting") ?? es.state.floor.rooms[0]; es.jump({ x: r.x + r.w / 2, y: r.y + r.h / 2 }); });
  await page.waitForTimeout(1200);
  await shot(page, label, "office", { targets: true });
  // Pinch: two fingers apart zooms in, never walks (real touch events through CDP).
  {
    const cdp = await ctx.newCDPSession(page);
    const cx = viewport.width / 2, cy = viewport.height / 2;
    const before = await page.evaluate(() => { const es = (window as any).__es; const m = es.live.get(es.state.me.id); return { zoom: es.camera.zoom, x: m.tx, y: m.ty }; });
    const pts = (d: number) => [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(30) });
    for (let d = 40; d <= 110; d += 10) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d) }); await page.waitForTimeout(16); }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => { const es = (window as any).__es; const m = es.live.get(es.state.me.id); return { zoom: es.camera.zoom, x: m.tx, y: m.ty }; });
    const zoomed = after.zoom > before.zoom * 1.5, stayed = Math.hypot(after.x - before.x, after.y - before.y) < 2;
    if (!zoomed || !stayed) bad++;
    console.log(`${zoomed && stayed ? "✓" : "✗"} ${label} pinch zooms in (${before.zoom.toFixed(2)} → ${after.zoom.toFixed(2)}) and doesn't walk (${stayed ? "stayed" : "moved"})`);
    await page.evaluate(() => { const es = (window as any).__es; es.camera.zoom = 0.6; });
  }
  if (await tap(page, '.tool[title^="People"]')) { await shot(page, label, "people"); await tap(page, '[aria-label="Close panel"]'); }
  // Your own card (and Change my name) opens from People → your name: your avatar ignores taps on purpose.
  if (await tap(page, '.tool[title^="People"]')) {
    await page.getByText("(you)").first().tap().catch(() => {});
    await page.getByRole("button", { name: "Change my name" }).tap().catch(() => {});
    await shot(page, label, "profile-me");
    await tap(page, '[aria-label="Close panel"]');
  }
  if (await tap(page, ".tool.status-btn")) { await shot(page, label, "status"); await esc(page); }
  if (await tap(page, '.tool[title^="React"]')) { await shot(page, label, "emoji"); await tap(page, '.tool[title^="React"]'); }
  if (await tap(page, '.tool[title^="Gallery"]')) { await shot(page, label, "gallery"); await tap(page, '.tool[title^="Gallery"]'); await esc(page); }
  if (await tap(page, '[title^="Map"]')) { await shot(page, label, "map"); await esc(page); await tap(page, '[title^="Map"]'); }
  if (await tap(page, '.tool[aria-label="Microphone settings"]')) { await shot(page, label, "mic-menu"); await esc(page); }
  for (const path of ["/time", "/admin/members", "/admin/analytics", "/admin/points", "/admin/settings"]) {
    await page.goto(`${BASE}${path}`);
    await page.waitForTimeout(1500);
    await shot(page, label, path.slice(1).replace(/\//g, "-"));
  }
  await ctx.close();
}
await browser.close();
console.log(bad ? `${bad} screen(s) need work — ${OUT}` : `All phone screens fit — ${OUT}`);
process.exit(bad ? 1 : 0);
