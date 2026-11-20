// Hand editing, growing the building, and editing the jumbotron:
//   npm run dev   (in another terminal)
//   npx tsx scripts/e2e-design.ts
// Alex drags a plant by hand, checks and applies it, and Morgan sees it move.
// Then the building grows 200px on top: everyone moves down with it, and
// restoring the previous version shrinks it back. Leaves the floor as it found it.

import { chromium, type Page } from "playwright";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:5173";
let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};
const cache = join(homedir(), "Library/Caches/ms-playwright");
const exe = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()
  .map((d) => join(cache, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")).find(existsSync) : undefined;
const browser = await chromium.launch({ executablePath: exe, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });

async function person(email: string, name: string) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ["camera", "microphone"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${name}] page error: ${e.message}`));
  await page.goto(`${BASE}/auth/dev?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`);
  // Test people skip the first-day welcome: these suites test the office, not onboarding.
  await page.evaluate(() => fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ track: "member", dismiss: true }) })).catch(() => {});
  await page.getByRole("button", { name: "Join Space" }).click();
  await page.waitForFunction(() => (window as any).__es?.state?.me);
  return page;
}
const es = <T>(p: Page, fn: string) => p.evaluate(fn) as Promise<T>;
const api = (p: Page, url: string, body?: unknown) => p.evaluate(async ([u, b]) => {
  const r = await fetch(u as string, b === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [url, body] as const);

try {
  const alex = await person("admin@example.com", "Alex Admin");
  const andrew = await person("morgan@example.com", "Morgan Lee");
  const startVersion = (await api(alex, "/api/admin/floor/versions")).body.live as number;

  // ── Hand editing ──
  const plant = await es<{ id: string; x: number; y: number; w: number; h: number }>(alex,
    `(() => { const f = __es.state.floor; return f.objects.filter(o => o.type === "plant").sort((a, b) => a.y - b.y)[0]; })()`);
  await es(alex, `__es.jump({ x: ${plant.x + plant.w / 2}, y: ${plant.y + plant.h + 60} })`);
  await es(alex, `__es.camera.zoom = 1`);
  await alex.getByRole("button", { name: "Design" }).click();
  await alex.getByRole("button", { name: /Edit by hand/ }).click();
  const box0 = alex.locator(`.hand-box[data-id="${plant.id}"]`);
  await box0.waitFor();
  const b = (await box0.boundingBox())!;
  // Grab whatever is on top at that spot — that's what a person's click gets.
  const topId = await alex.evaluate(([x, y]) => (document.elementFromPoint(x, y) as HTMLElement)?.dataset?.id ?? "", [b.x + b.width / 2, b.y + b.height / 2]);
  if (topId && topId !== plant.id) Object.assign(plant, await es<typeof plant>(alex, `__es.state.floor.objects.find(o => o.id === "${topId}")`));
  await alex.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await alex.mouse.down();
  await alex.mouse.move(b.x + b.width / 2 + 20, b.y + b.height / 2 + 10, { steps: 6 });
  await alex.mouse.move(b.x + b.width / 2 + 40, b.y + b.height / 2 + 20, { steps: 6 });
  await alex.mouse.up();
  const moved = await es<{ x: number; y: number }>(alex, `__es.state.previewFloor.objects.find(o => o.id === "${plant.id}")`);
  ok(moved.x !== plant.x || moved.y !== plant.y, `Dragging the plant moves it in Alex's preview (${plant.x},${plant.y} → ${moved.x},${moved.y})`);
  ok((await es<any>(andrew, `__es.state.floor.objects.find(o => o.id === "${plant.id}")`)).x === plant.x, "…and only Alex sees that so far");
  await alex.keyboard.press("ArrowRight");
  const nudged = await es<{ x: number }>(alex, `__es.state.previewFloor.objects.find(o => o.id === "${plant.id}")`);
  ok(nudged.x === moved.x + 1, "The arrow key nudges the selection, not Alex's avatar");
  await alex.getByRole("button", { name: "Check it" }).click();
  await alex.getByRole("button", { name: "Apply for everyone" }).click();
  ok(await andrew.waitForFunction(`__es.state.floor.objects.find(o => o.id === "${plant.id}").x === ${nudged.x}`, null, { timeout: 8000 }).then(() => true, () => false), "After Apply, Morgan sees the plant where Alex put it");

  // ── Growing the building ──
  const before = await es<{ h: number; y: number; me: number }>(andrew, `({ h: __es.state.floor.height, y: __es.state.floor.rooms[0].y, me: __es.live.get(__es.state.me.id).ty })`);
  const draft = await api(alex, "/api/admin/designer/hand", { edits: [{ op: "grow_building", side: "n", by: 200 }] });
  ok(draft.status === 200 && !draft.body.problems.length, `Growing the building 200px on top checks clean (${draft.body?.problems?.[0] ?? "ok"})`);
  const applied = await api(alex, `/api/admin/designer/${draft.body.id}/apply`, {});
  ok(applied.status === 200, "…and applies");
  ok(await andrew.waitForFunction(`__es.state.floor.height === ${before.h + 200} && __es.state.floor.rooms[0].y === ${before.y + 200}`, null, { timeout: 8000 }).then(() => true, () => false), "Morgan's office is 200px taller with every room 200px lower");
  ok(await andrew.waitForFunction(`Math.abs(__es.live.get(__es.state.me.id).ty - ${before.me + 200}) < 2`, null, { timeout: 8000 }).then(() => true, () => false), "…and Morgan moved down with the floor instead of ending up in a wall");
  const bad = await api(alex, "/api/admin/designer/hand", { edits: [{ op: "update_room", id: "office-3", name: "x" }] });
  ok(bad.status === 200 && bad.body.problems.some((p: string) => /by hand/.test(p)), "Renaming a room isn't a hand edit — it says to use the Designer");

  // ── Jumbotron editing ──
  const add = await api(alex, "/api/admin/jumbotron/edit", { op: "add", section: "dates", item: { date: "2099-12-31", label: "E2E test date" } });
  ok(add.status === 200, "Alex adds a key date from the jumbotron");
  const seen = await api(andrew, "/api/jumbotron");
  const key = seen.body.dates.find((d: any) => d.label === "E2E test date")?.key;
  ok(key, "…and Morgan sees it");
  const nope = await api(andrew, "/api/admin/jumbotron/edit", { op: "hide", key });
  ok(nope.status === 403, "Morgan (not an admin) can't edit the jumbotron");
  await api(alex, "/api/admin/jumbotron/edit", { op: "remove", key });
  ok(!(await api(andrew, "/api/jumbotron")).body.dates.some((d: any) => d.label === "E2E test date"), "Alex deletes it again");

  // ── Put the office back ──
  const back = await api(alex, "/api/admin/floor/revert", { version: startVersion });
  ok(back.status === 200, `Restoring version ${startVersion} works`);
  ok(await andrew.waitForFunction(`__es.state.floor.height === ${before.h} && __es.state.floor.objects.find(o => o.id === "${plant.id}").x === ${plant.x}`, null, { timeout: 8000 }).then(() => true, () => false), "…the building shrinks back and the plant is home");
  ok(await andrew.waitForFunction(`Math.abs(__es.live.get(__es.state.me.id).ty - ${before.me}) < 2`, null, { timeout: 8000 }).then(() => true, () => false), "…and Morgan moved back up with it");
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
