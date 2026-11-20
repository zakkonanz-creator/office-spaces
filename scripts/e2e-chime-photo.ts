// Chimes you weren't looking at, the chime switch, and your own photo.
// Needs `npm run dev`. BASE defaults to the Vite dev server.
import { chromium, type Page } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:5173";
const browser = await chromium.launch();
const errors: string[] = [];
let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "✓" : "✗"} ${what}`); if (!cond) failed++; };

async function join_(email: string, name: string) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, permissions: ["camera", "microphone"] });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await p.goto(`${BASE}/auth/dev?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`);
  await p.evaluate(() => fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ track: "member", dismiss: true }) })).catch(() => {});
  await p.getByRole("button", { name: "Join the office" }).click();
  await p.waitForFunction(() => (window as any).__es?.room()?.state === "connected", null, { timeout: 20000 });
  return p;
}
const es = <T>(p: Page, f: string) => p.evaluate(f) as Promise<T>;
/** Pretend this tab is in the background (another window in front). */
const hide = (p: Page, hidden: boolean) => p.evaluate(`Object.defineProperty(document, "hidden", { configurable: true, get: () => ${hidden} }); document.dispatchEvent(new Event("visibilitychange"))`);

try {
  const morgan = await join_("morgan.chime@example.com", "Morgan Chime");
  const riley = await join_("riley.chime@example.com", "Riley Chime");
  const rileyId = await es<string>(riley, "__es.state.me.id");
  await morgan.waitForFunction((id) => (window as any).__es.state.people.has(id), rileyId, { timeout: 8000 });

  // 1. Riley is looking at the office: the nudge chimes and goes away by itself, title untouched.
  const title = await riley.title();
  await es(morgan, `__es.sock().emit("nudge", { to: "${rileyId}" })`);
  await riley.waitForFunction(() => (window as any).__es.state.toasts.some((t: any) => /nudged you/.test(t.text)), null, { timeout: 5000 });
  ok((await es<string[]>(riley, "__es.sounds")).includes("ding"), "A nudge chimes");
  ok(!(await es<boolean>(riley, `__es.state.toasts.find(t => /nudged you/.test(t.text)).sticky ?? false`)), "…and, while you're looking, the note goes away by itself");
  await riley.waitForFunction(() => !(window as any).__es.state.toasts.some((t: any) => /nudged you/.test(t.text)), null, { timeout: 7000 });

  // 2. Riley is in another window: the note stays, says when, and the tab title counts it.
  await hide(riley, true);
  await es(morgan, `__es.sock().emit("nudge", { to: "${rileyId}" })`);
  await riley.waitForFunction(() => (window as any).__es.state.toasts.some((t: any) => /nudged you/.test(t.text)), null, { timeout: 5000 });
  const missed = await es<{ text: string; sticky: boolean }>(riley, `__es.state.toasts.find(t => /nudged you/.test(t.text))`);
  ok(missed.sticky && /\d:\d\d/.test(missed.text), `A chime you weren't looking at stays, with its time ("${missed.text}")`);
  ok((await riley.title()) === `(1) ${title}`, `The tab title counts it ("${await riley.title()}")`);
  await riley.waitForTimeout(6000);
  ok(await es<boolean>(riley, `__es.state.toasts.some(t => /nudged you/.test(t.text))`), "…still there 6 s later");
  await hide(riley, false);
  ok((await riley.title()) === title, "Coming back to the tab clears the count");
  ok(await riley.getByText(/nudged you ·/).isVisible(), "…and the note is on screen to read");
  await riley.getByText(/nudged you ·/).locator("..").getByRole("button", { name: "Dismiss" }).click();
  ok(!(await es<boolean>(riley, `__es.state.toasts.some(t => /nudged you/.test(t.text))`)), "Dismiss closes it");

  // 3. The chime switch in Help.
  await riley.evaluate(() => localStorage.setItem("es.chimes", "0"));
  const before = (await es<string[]>(riley, "__es.sounds")).filter((x) => x === "ding").length;
  await es(morgan, `__es.sock().emit("nudge", { to: "${rileyId}" })`);
  await riley.waitForTimeout(1200);
  const after = (await es<string[]>(riley, "__es.sounds")).filter((x) => x === "ding").length;
  ok(after === before, "With the chime off, a nudge is silent");
  ok(await es<boolean>(riley, `__es.state.toasts.some(t => /nudged you/.test(t.text))`), "…but the note still shows");
  await riley.evaluate(() => localStorage.removeItem("es.chimes"));

  // 4. Your own photo.
  const png = await morgan.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 800; c.height = 500;
    const g = c.getContext("2d")!; g.fillStyle = "#2a7"; g.fillRect(0, 0, 800, 500); g.fillStyle = "#fff"; g.beginPath(); g.arc(400, 250, 180, 0, 7); g.fill();
    return c.toDataURL("image/png").split(",")[1];
  });
  const morganId = await es<string>(morgan, "__es.state.me.id");
  const pos = await es<{ x: number; y: number }>(morgan, `(() => { const r = document.querySelector("canvas").getBoundingClientRect(); const m = __es.live.get(__es.state.me.id); const c = __es.camera; return { x: r.left + (m.x - c.x) * c.zoom + r.width / 2, y: r.top + (m.y - c.y) * c.zoom + r.height / 2 }; })()`).catch(() => null);
  // Open my own card the way people do: click myself (fallback: the side panel's "you" row).
  let opened = false;
  if (pos) { await morgan.mouse.click(pos.x, pos.y - 20); opened = await morgan.getByRole("button", { name: "Change my name" }).isVisible().catch(() => false); }
  if (!opened) { await morgan.getByText("Morgan Chime").first().click(); opened = await morgan.getByRole("button", { name: "Change my name" }).isVisible({ timeout: 3000 }).catch(() => false); }
  ok(opened, "My profile card opens");
  ok(await morgan.getByText("Change my photo").isVisible(), "It has Change my photo");
  ok(await morgan.getByRole("button", { name: "Use my Slack photo" }).isVisible(), "…and Use my Slack photo");
  await morgan.locator('.photo-form input[type="file"]').setInputFiles({ name: "me.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await morgan.waitForFunction(() => /^\/api\/photos\/[a-f0-9]{32}$/.test((window as any).__es.state.me.avatar ?? ""), null, { timeout: 8000 });
  const avatar = await es<string>(morgan, "__es.state.me.avatar");
  ok(true, `Upload sets my photo (${avatar})`);
  await riley.waitForFunction(([id, a]) => (window as any).__es.state.people.get(id)?.avatar === a, [morganId, avatar] as const, { timeout: 8000 });
  ok(true, "Riley sees the new photo without a reload");
  const img = await riley.evaluate(async (a) => { const r = await fetch(a); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, type: r.headers.get("content-type"), jpeg: b[0] === 0xff && b[1] === 0xd8, size: b.length }; }, avatar);
  ok(img.status === 200 && img.type === "image/jpeg" && img.jpeg && img.size < 60_000, `The photo is a small square JPEG (${img.size} bytes)`);
  const rendered = await riley.evaluate(async (a) => { const i = new Image(); i.src = a; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }, avatar);
  ok(rendered[0] === 256 && rendered[1] === 256, `…256×256 (${rendered.join("×")})`);
  const bad = await morgan.evaluate(async () => (await fetch("/api/me/photo", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: "data:image/png;base64," + btoa("<svg onload=alert(1)>".padEnd(300)) }) })).status);
  ok(bad === 400, "Something that isn't a picture is refused");
  const guess = await riley.evaluate(async () => (await fetch("/api/photos/00000000000000000000000000000000")).status);
  ok(guess === 404, "A made-up photo address finds nothing");
  const slack = await morgan.evaluate(async () => { const r = await fetch("/api/me/photo/slack", { method: "POST" }); return { s: r.status, j: await r.json() }; });
  ok(slack.s === 404 && /Slack/.test(slack.j.error), `No Slack photo → a plain message, photo kept ("${slack.j.error}")`);
  ok((await es<string>(morgan, "__es.state.me.avatar")) === avatar, "…and my uploaded photo stays");
  // Reload: it's saved, not just in the tab.
  await morgan.reload();
  await morgan.getByRole("button", { name: "Join the office" }).click();
  await morgan.waitForFunction((a) => (window as any).__es?.state.me?.avatar === a, avatar, { timeout: 15000 });
  ok(true, "After a reload my photo is still the one I uploaded");
} catch (e) {
  failed++;
  console.error("✗ crashed:", e);
} finally {
  for (const e of errors) console.log(`✗ page error: ${e}`);
  await browser.close();
  console.log(failed || errors.length ? `\n${failed + errors.length} problem(s)` : "\nall good");
  process.exit(failed || errors.length ? 1 : 0);
}
