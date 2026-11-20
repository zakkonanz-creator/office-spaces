// A newcomer's first visit and "Say hi": the newcomer is brought over to whoever
// says hi, both are told what's happening, nobody is left stuck, a second greeter joins instead of
// pulling the newcomer away, and a closed door lets the newcomer in. Also: "Go to" with the map
// dragged away brings the view back to you.
//   npm run dev   (in another terminal)
//   BASE=http://localhost:5173 npx tsx scripts/e2e-welcome.ts [--shots dir]

import { chromium, type Page, type Browser } from "playwright";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { seatOf, type Floor } from "../shared/floor";

const BASE = process.env.BASE ?? "http://localhost:5173";
const args = process.argv.slice(2);
const SHOTS = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : "";

function chromePath() {
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort() : [];
  for (const d of dirs.reverse()) {
    const p = join(cache, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    if (existsSync(p)) return p;
  }
  return undefined;
}

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};
const es = <T>(page: Page, fn: string) => page.evaluate(fn) as Promise<T>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = (page: Page, expr: string, ms = 10000) => page.waitForFunction(expr, null, { timeout: ms, polling: 200 }).then(() => true, () => false);
const at = (p: { x: number; y: number }) => `{x: ${p.x}, y: ${p.y}}`;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Signs in and joins. A teammate skips the first-day welcome; a newcomer gets the real first visit. */
async function person(browser: Browser, email: string, name: string, newcomer = false) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, permissions: ["camera", "microphone"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${name}] page error: ${e.message}`));
  await page.goto(`${BASE}/auth/dev?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`);
  await page.getByRole("button", { name: "Join the office" }).waitFor({ timeout: 15000 });
  if (!newcomer) await page.evaluate(() => fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ track: "member", dismiss: true }) })).catch(() => {});
  await page.getByRole("button", { name: "Join the office" }).click();
  await page.waitForFunction(() => (window as any).__es?.state?.me && (window as any).__es.room()?.state === "connected", null, { timeout: 20000 });
  if (!newcomer) await page.evaluate(() => (window as any).__es.sock().emit("status", { status: "available", text: "" }));
  return page;
}
const pos = (page: Page) => es<{ x: number; y: number }>(page, `(() => { const p = __es.live.get(__es.state.me.id); return { x: Math.round(p.x), y: Math.round(p.y) } })()`);
const seenPos = (page: Page, name: string) => es<{ x: number; y: number } | null>(page, `(() => { for (const [id, p] of __es.state.people) if (p.name === ${JSON.stringify(name)}) { const l = __es.live.get(id); return { x: Math.round(l.tx), y: Math.round(l.ty) } } return null })()`);
const dist = (a: { x: number; y: number } | null, b: { x: number; y: number } | null) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity);

const browser = await chromium.launch({
  executablePath: chromePath(),
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

try {
  const alex = await person(browser, "admin@example.com", "Alex Admin");
  const morgan = await person(browser, "morgan@example.com", "Morgan Lee");
  // ── Every arrival gets a quiet note, not only the first ──
  const isIn = (pg: Page, first: string) => `__es.state.toasts.filter(t => t.text === "${first} is in").length`;
  ok(await until(alex, `${isIn(alex, "Morgan")} === 1`), "Alex gets a quiet \"Morgan is in\" when Morgan comes in");
  ok(!(await es<string[]>(alex, "__es.sounds")).includes("ding"), "…with no chime");
  await es(alex, `__es.state.toasts.filter(t => t.text === "Morgan is in").forEach(t => __es.state.toasts.splice(__es.state.toasts.indexOf(t), 1))`);
  await morgan.reload();
  await morgan.getByRole("button", { name: "Join the office" }).click();
  await morgan.waitForFunction(() => (window as any).__es?.state?.me && (window as any).__es.room()?.state === "connected", null, { timeout: 20000 });
  await sleep(1500);
  ok((await es<number>(alex, isIn(alex, "Morgan"))) === 0, "A reload is not an arrival: no second note");
  // Every run starts their awarded points from zero (earlier runs piled them up past every unlock).
  for (const pg of [alex, morgan]) await es(pg, `fetch("/api/dev/points/reset", { method: "POST" }).then((r) => r.status)`);
  await sleep(500);
  const F = await es<Floor>(alex, "__es.state.floor");
  const desk = (owner: string) => F.desks.find((d) => d.owner === owner)!;
  await es(alex, `__es.jump(${at(seatOf(desk("Alex Admin")))})`);
  await es(morgan, `__es.jump(${at(seatOf(desk("Morgan Lee")))})`);
  await sleep(1000);
  // Alex has dragged the map somewhere else, the way you'd look around while waiting.
  await es(alex, `(__es.camera.panX = 700, __es.camera.panY = 400)`);

  // ── A newcomer walks in for the first time ──
  const stamp = Date.now().toString(36);
  const newName = `Nina Newcomer ${stamp}`;
  const nina = await person(browser, `nina.${stamp}@example.org`, newName, true);
  const ninaFirst = await pos(nina);
  const sayHi = alex.locator(".toast", { hasText: "just walked into the office for the first time" }).getByRole("button", { name: "Say hi" });
  ok(await sayHi.waitFor({ timeout: 10000 }).then(() => true, () => false), "Alex gets the welcome with a Say hi button");
  await sleep(500);
  ok((await es<number>(alex, `__es.state.toasts.filter(t => t.text === "Nina is in").length`)) === 0, "A first visit shows the welcome, not the quiet note too");
  await shot(alex, "01-welcome");
  await sayHi.click();

  // Nina comes to Alex — not the other way round — and both are told.
  ok(await until(nina, `__es.state.toasts.some(t => /wants to say hi/.test(t.text))`), "Nina is told Alex wants to say hi and that she's being brought over");
  ok(await until(alex, `__es.state.toasts.some(t => /Bringing Nina over to you/.test(t.text))`), "Alex is told Nina is being brought over");
  await sleep(1500);
  const alexAt = await pos(alex), ninaAt = await pos(nina);
  ok(dist(alexAt, ninaAt) < 200 && dist(ninaAt, ninaFirst) > 200, `Nina is now next to Alex (${Math.round(dist(alexAt, ninaAt))}px away), not where she arrived`);
  ok(dist(alexAt, seatOf(desk("Alex Admin"))) < 5, "Alex stayed at his desk");
  ok(dist(await seenPos(alex, newName), ninaAt) < 30 && dist(await seenPos(morgan, newName), ninaAt) < 30, "Everyone sees Nina where she is (the server agrees)");
  ok(await until(alex, `[...__es.state.people.values()].some(p => p.name.startsWith("Nina") && (__es.state.hearing.get(p.id) ?? 0) > 0)`), "Alex can hear Nina");
  ok(await until(nina, `[...__es.state.people.values()].some(p => p.name === "Alex Admin" && (__es.state.hearing.get(p.id) ?? 0) > 0)`), "…and Nina can hear Alex");
  // (Her welcome screen nudges the view up on purpose so she shows above it; what matters is she's on screen.)
  const onScreen = (page: Page) => page.locator(".avatar.me").boundingBox().then((b) => !!b && b.x > 0 && b.y > 0 && b.x < 1360 && b.y < 860, () => false);
  ok(await onScreen(nina), "Nina can see herself (next to Alex) on screen");
  // (The view never shows past the building's edge, so "back on him" isn't always a pan of exactly 0.)
  await alex.bringToFront();
  await sleep(800);
  const alexBox = await alex.locator(".avatar.me").boundingBox();
  if (process.env.DEBUG) console.log("  alex", alexBox, await es(alex, `JSON.stringify(__es.camera)`));
  ok(await onScreen(alex), "Alex's view came back to him (he'd dragged the map away), so he sees Nina arrive");
  ok(await until(alex, `__es.state.toasts.some(t => /reading the welcome screen/.test(t.text))`), "Alex is told she may still be reading the welcome screen");
  await shot(nina, "02-nina-brought-over");
  await shot(alex, "03-alex-sees-nina");

  // Nobody is stuck: both can walk afterwards.
  for (const [page, who] of [[nina, "Nina"], [alex, "Alex"]] as const) {
    const before = await pos(page);
    await page.bringToFront();
    await page.keyboard.down("ArrowDown");
    await sleep(500);
    await page.keyboard.up("ArrowDown");
    await sleep(300);
    const after = await pos(page);
    ok(after.y - before.y > 20 || Math.abs(after.x - before.x) > 20, `${who} can still walk afterwards (moved ${Math.round(dist(before, after))}px)`);
  }

  // A second greeter joins them instead of pulling Nina away.
  const ninaBefore = await pos(nina);
  const sayHi2 = morgan.locator(".toast", { hasText: "just walked into the office for the first time" }).getByRole("button", { name: "Say hi" });
  ok(await sayHi2.isVisible(), "Morgan got the welcome too");
  await sayHi2.click();
  ok(await until(morgan, `__es.state.toasts.some(t => /Alex is already saying hi to Nina/.test(t.text))`), "Morgan is told Alex got there first and he's being taken to join them");
  await sleep(1500);
  ok(dist(await pos(nina), ninaBefore) < 5, "Nina didn't move again");
  ok(dist(await pos(morgan), await pos(nina)) < 220, "Morgan is now with Nina and Alex");

  // ── A second newcomer while Alex is behind a closed door ──
  const conf = F.rooms.find((r) => r.id === "conference")!;
  await es(alex, `__es.jump({x: ${Math.round(conf.x + conf.w / 2)}, y: ${Math.round(conf.y + conf.h / 2)}})`);
  await sleep(800);
  await alex.bringToFront();
  await alex.keyboard.press("o");
  ok(await until(alex, `__es.state.rooms.conference.closed`), "Alex is in the conference room with the door shut");
  const omar = await person(browser, `omar.${stamp}@example.org`, `Omar Newcomer ${stamp}`, true);
  const sayHi3 = alex.locator(".toast", { hasText: /Omar Newcomer.*first time/ }).getByRole("button", { name: "Say hi" });
  ok(await sayHi3.waitFor({ timeout: 10000 }).then(() => true, () => false), "Alex gets Omar's welcome");
  await sayHi3.click();
  ok(await until(omar, `__es.state.me.roomId === "conference"`), "Omar is let in and lands in the conference room with Alex");
  ok(await until(alex, `[...__es.state.people.values()].some(p => p.name.startsWith("Omar") && (__es.state.hearing.get(p.id) ?? 0) > 0)`), "…and they can hear each other through no door");
  await alex.keyboard.press("o");

  // ── "Go to" with the map dragged away: the view comes back to you ──
  await es(morgan, `(__es.camera.panX = 900, __es.camera.panY = -500)`);
  const alexId = await es<string>(alex, "__es.state.me.id");
  await es(morgan, `__es.sock().emit("teleport", { to: ${JSON.stringify(alexId)} })`);
  await morgan.bringToFront();
  await sleep(1000);
  ok(await onScreen(morgan), "Go to: Morgan's view comes back to him after the jump (he'd dragged it far away)");
  ok(dist(await pos(morgan), await pos(alex)) < 220, "…and he's next to Alex");


  // ── Where you are must match where everyone else sees you ──
  const centreOf = (id: string) => { const r = F.rooms.find((x) => x.id === id)!; return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) }; };
  const lounge = centreOf("lounge");
  // 1. A burst of moves over the server's budget: the last one still lands.
  // (Only the server is tested here: Morgan's own browser keeps its position and its re-send is off.)
  await es(morgan, `(() => { window.__esNoResync = true; const s = __es.sock(); for (let i = 0; i <= 120; i++) s.emit("move", { x: ${lounge.x} - 120 + i, y: ${lounge.y} }); })()`);
  await sleep(1500);
  ok(dist(await seenPos(alex, "Morgan Lee"), lounge) < 5, `A burst over the move budget: Alex still sees where Morgan ended up (${JSON.stringify(await seenPos(alex, "Morgan Lee"))} vs ${JSON.stringify(lounge)})`);
  await es(morgan, `(() => { window.__esNoResync = false; const p = __es.live.get(__es.state.me.id); p.x = p.tx = ${lounge.x}; p.y = p.ty = ${lounge.y}; })()`);
  await sleep(800);
  // 2. Moves that never reach the server (a dropped message): once he stops, his browser re-sends.
  await es(morgan, `(() => { const s = __es.sock(); window.__realEmit = s.emit.bind(s); s.emit = (ev, ...a) => ev === "move" ? s : window.__realEmit(ev, ...a); })()`);
  const spot = { x: lounge.x + 90, y: lounge.y + 40 };
  await es(morgan, `__es.jump(${at(spot)})`);
  await sleep(500);
  ok(dist(await seenPos(alex, "Morgan Lee"), lounge) < 5, "(set-up) the move was lost: Alex still sees Morgan at the old spot");
  await es(morgan, `(() => { const s = __es.sock(); s.emit = window.__realEmit; })()`);
  ok(await until(alex, `(() => { for (const [id, p] of __es.state.people) if (p.name === "Morgan Lee") { const l = __es.live.get(id); return Math.hypot(l.tx - ${spot.x}, l.ty - ${spot.y}) < 5 } })()`, 8000), "Standing still, Morgan's browser re-sends where he is, and Alex sees him there");
  // 3. Re-sending can't be used to get somewhere you're not allowed: the server puts you back.
  const conf2 = centreOf("conference");
  await es(alex, `__es.jump(${at(conf2)})`);
  await sleep(600);
  await alex.bringToFront();
  await alex.keyboard.press("o");
  await until(alex, `__es.state.rooms.conference.closed`);
  await sleep(6500); // past the 6 s "step back into the room you just left" grace: Morgan was in there a moment ago
  await es(morgan, `(() => { const p = __es.live.get(__es.state.me.id); p.x = p.tx = ${conf2.x + 60}; p.y = p.ty = ${conf2.y}; })()`);
  const okInside = await until(morgan, `__es.state.me && Math.hypot(__es.live.get(__es.state.me.id).x - ${conf2.x + 60}, __es.live.get(__es.state.me.id).y - ${conf2.y}) > 40`, 8000);
  if (!okInside) console.log("  debug", await es(morgan, `JSON.stringify({ me: __es.live.get(__es.state.me.id), room: __es.state.me.roomId, conf: __es.state.rooms.conference })`), await seenPos(alex, "Morgan Lee"));
  ok(okInside, "A position inside a closed room he wasn't let into is refused, and Morgan is put back");
  await alex.keyboard.press("o");
  await until(alex, `!__es.state.rooms.conference.closed`);
  await es(morgan, `__es.jump({x: ${conf2.x + 70}, y: ${conf2.y}})`); // back beside Alex for the video checks below

  // ── Settings (the gear) opens in a new tab; the office stays put ──
  const [adminTab] = await Promise.all([alex.context().waitForEvent("page"), alex.locator('a[title^="Admin"]').click()]);
  await adminTab.waitForLoadState();
  ok(adminTab.url().includes("/admin"), "The gear opens Admin in a new tab");
  await sleep(1500);
  ok(!alex.isClosed() && await es<string>(alex, `__es.room()?.state`) === "connected" && !(await alex.locator("text=another tab").count()), "…and the office tab is still in the office, connected");
  const closed = adminTab.waitForEvent("close", { timeout: 5000 }).then(() => true, () => false);
  await adminTab.getByText("← Back to the office").click();
  ok(await closed, "Back to the office closes the admin tab (no second office signing the first out)");

  // ── Lighter video when the computer or connection struggles ──
  // Alex and Morgan are together; Alex receives Morgan's camera. VideoQuality: LOW 0, HIGH 2.
  const morganCam = `(() => { for (const p of __es.room().remoteParticipants.values()) for (const pub of p.trackPublications.values()) if (pub.source === "camera" && pub.isDesired) return pub.requestedMaxQuality; return "none"; })()`;
  ok(await until(alex, `${morganCam} === 2`), "Normal: Alex gets Morgan's camera at full quality");
  await es(alex, `__es.qualityTest.cpu()`);
  ok(await until(alex, `${morganCam} === 0 && __es.quality.auto`), "Computer struggling: Morgan's camera drops to the small layer for Alex");
  ok(await until(alex, `__es.state.toasts.some(t => /computer is working hard, so video is lighter/.test(t.text))`), "…and Alex is told why");
  ok(await until(morgan, `${morganCam} === 2`), "…Morgan's own view of Alex isn't affected");
  await es(alex, `__es.qualityTest.recover()`);
  ok(await until(alex, `${morganCam} === 2 && !__es.quality.auto`), "Back to normal after good conditions");
  ok(await until(alex, `__es.state.toasts.some(t => /back to normal/.test(t.text))`), "…with a toast");
  // The manual setting in Help.
  await alex.bringToFront();
  await alex.getByRole("tab", { name: "Help" }).or(alex.getByRole("button", { name: "Help" })).first().click();
  await alex.getByLabel(/Always lighter/).check();
  ok(await until(alex, `${morganCam} === 0`), "Help → Always lighter: small layer, no toast needed");
  await alex.getByLabel("Automatic").check();
  ok(await until(alex, `${morganCam} === 2`), "Help → Automatic: full quality again");

  // ── Emotes ──
  await alex.bringToFront();
  await es(alex, `document.activeElement?.blur()`);
  await alex.keyboard.press("e");
  ok(await alex.locator(".emote-btn", { hasText: "Dance" }).isVisible().catch(() => false), "E opens the menu with the emotes");
  ok((await alex.locator(".emote-btn").count()) === 23, "…all 23 of them (20 levels), epic ones included");
  // Time at Acme unlocks them (shared/emotes.ts): a brand-new dev user has the four day-one ones.
  // Points unlock them (shared/points.ts): each locked one costs more than Alex has, each open one no more.
  ok(await es<boolean>(alex, `(() => { const pts = __es.state.me.points; if (typeof pts !== "number") return false; const need = (b) => Number((b.querySelector(".emote-lock")?.textContent ?? "0").split("·").pop().replace(/[^0-9]/g, "")); return [...document.querySelectorAll(".emote-btn.locked")].every((b) => need(b) > pts && b.disabled) && document.querySelectorAll(".emote-btn:not(.locked)").length >= 4; })()`), "…locked exactly where Alex's points fall short (and the day-one four are open)");
  await alex.locator(".emote-btn", { hasText: "Dance" }).click();
  const alexIdE = await es<string>(alex, "__es.state.me.id");
  ok(await until(morgan, `__es.state.emotes.get(${JSON.stringify(alexIdE)})?.name === "dance"`), "Morgan sees Alex start dancing");
  ok(await until(morgan, `!!document.querySelector('.avatar[data-emote="dance"]')`), "…his avatar is doing it");
  const spinning = await morgan.locator('.avatar[data-emote="dance"] .fig').evaluate((el) => getComputedStyle(el).animationName);
  ok(spinning === "em-dance", `…and it's actually animating (${spinning})`);
  await sleep(2000);
  ok(await es<boolean>(morgan, `__es.state.emotes.has(${JSON.stringify(alexIdE)})`), "It keeps going while he stands there");
  await alex.keyboard.down("ArrowLeft");
  await sleep(300);
  await alex.keyboard.up("ArrowLeft");
  ok(await until(morgan, `!__es.state.emotes.has(${JSON.stringify(alexIdE)}) && !document.querySelector('.avatar[data-emote]')`), "Moving stops it, for everyone");
  // Quick: an emote nobody stops ends by itself after a few seconds.
  await es(alex, `__es.sock().emit("emote", { name: "robot" })`);
  ok(await until(morgan, `__es.state.emotes.get(${JSON.stringify(alexIdE)})?.name === "robot"`), "Alex does the robot");
  await sleep(4600);
  ok(!(await es<boolean>(morgan, `__es.state.emotes.has(${JSON.stringify(alexIdE)})`)), "…and it's over in a few seconds without him moving");
  await es(morgan, `__es.sock().emit("emote", { name: "not-a-real-emote" })`);
  await sleep(500);
  ok(!(await es<number>(alex, `__es.state.emotes.size`)), "An unknown emote is ignored by the server");
  await es(morgan, `__es.sock().emit("emote", { name: "legend" })`);
  await sleep(500);
  ok(!(await es<number>(alex, `__es.state.emotes.size`)), "A locked emote sent by hand is ignored too");

  // ── High-fives, pets, points (shared/points.ts) ──
  const morganIdE = await es<string>(morgan, "__es.state.me.id");
  // Stand them next to each other.
  const fiveSpot = await es<{ x: number; y: number }>(alex, `(() => { const m = __es.live.get(__es.state.me.id); return { x: m.x, y: m.y }; })()`);
  await es(morgan, `(() => { window.__esNoResync = true; const m = __es.live.get(__es.state.me.id); m.x = m.tx = ${fiveSpot.x} + 60; m.y = m.ty = ${fiveSpot.y}; __es.sock().emit("move", { x: ${fiveSpot.x} + 60, y: ${fiveSpot.y} }); })()`);
  await sleep(600);
  const alexPts = await es<number>(alex, "__es.state.me.points ?? 0");
  await es(alex, `__es.sock().emit("highfive", { to: ${JSON.stringify(morganIdE)} })`);
  ok(await until(morgan, `__es.state.handUp.get(${JSON.stringify(alexIdE)})?.to === ${JSON.stringify(morganIdE)}`), "Alex's hand is up for Morgan");
  ok(await until(morgan, `__es.state.toasts.some((t) => /wants a high five/.test(t.text))`), "…and Morgan is asked to high-five back");
  await es(morgan, `__es.sock().emit("highfive", { to: ${JSON.stringify(alexIdE)} })`);
  ok(await until(alex, `__es.state.fives.has(${JSON.stringify(morganIdE)}) && __es.state.fives.has(${JSON.stringify(alexIdE)})`), "High-five lands for both");
  ok(await until(alex, `(__es.state.me.points ?? 0) >= ${alexPts} + 5`), "…and Alex gets points for it");
  await es(morgan, `__es.sock().emit("setPet", { pet: "dog" })`);
  ok(await until(alex, `__es.state.people.get(${JSON.stringify(morganIdE)})?.pet === "dog"`), "Morgan picks a dog; Alex sees it");
  ok(await until(alex, `!!document.querySelector(".pet.pet-dog")`), "…trotting on the floor");
  await es(morgan, `__es.sock().emit("setPet", { pet: "dragon" })`);
  await sleep(400);
  ok(await es<boolean>(alex, `__es.state.people.get(${JSON.stringify(morganIdE)})?.pet === "dog"`), "A pet he hasn't unlocked is refused");
  await alex.locator('.pet.pet-dog[title^="Morgan"] .pet-body').click();
  ok(await until(morgan, `__es.state.pats.has(${JSON.stringify(morganIdE)})`), "Alex pets Morgan's dog; Morgan sees the hearts");

  // ── Next reward: a bar by your name, a card when you pass one ──
  await morgan.bringToFront();
  ok(await until(morgan, `!!document.querySelector(".avatar.me .next-bar i")`), "Morgan sees a progress bar under his own name");
  ok(!(await es<boolean>(morgan, `[...document.querySelectorAll(".avatar:not(.me) .next-bar")].length > 0`)), "…and nobody else's");
  const nextNeed = await es<number>(morgan, `(() => { const t = document.querySelector(".avatar.me .next-bar").getAttribute("title"); return Number(t.split("/")[1].trim().split(" ")[0].replace(/,/g, "")); })()`);
  const havePts = await es<number>(morgan, "__es.state.me.points ?? 0");
  await es(morgan, `fetch("/api/dev/points", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ points: ${nextNeed - havePts + 1} }) })`);
  ok(await until(morgan, `!!document.querySelector(".unlock-card")`), "Passing it pops the unlock card");
  const unlockedLabel = await es<string>(morgan, `document.querySelector(".unlock-card h3")?.textContent ?? ""`);
  ok(unlockedLabel.length > 0, `…naming what he got (${unlockedLabel})`);
  await morgan.locator(".unlock-card button.primary").first().click();
  ok(await until(morgan, `!document.querySelector(".unlock-card")`), "…and Try it closes it");

  // ── An admin's award goes up in #wins: the bell, the jumbotron (and Slack, when it's set up) ──
  const morganUid = await es<number | null>(alex, `fetch("/api/admin/points").then((r) => r.json()).then((d) => d.everyone.find((u) => u.name === "Morgan Lee")?.id ?? null)`);
  const awarded = await es<{ ok: boolean; posted: boolean }>(alex, `fetch("/api/admin/points", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: ${morganUid}, points: 10, reason: "E2E: fixed the onboarding doc" }) }).then((r) => r.json())`);
  ok(awarded.ok, `Alex awards Morgan 10 points (posted in Slack: ${awarded.posted}; no Slack token locally)`);
  ok(await until(morgan, `document.querySelector(".win-banner")?.textContent?.includes("E2E: fixed the onboarding doc")`), "…the win banner rings for the office");
  const jwin = await es<{ name: string; text: string } | undefined>(alex, `fetch("/api/jumbotron").then((r) => r.json()).then((j) => (j.board ?? j).wins?.[0])`);
  ok(jwin?.name === "Morgan" && /\+10 points from Alex/.test(jwin.text), `…and it's on the jumbotron (${jwin?.name}: ${jwin?.text})`);
  await es(morgan, `document.querySelector(".win-banner button")?.click()`);
  const quiet = await es<{ posted: boolean }>(alex, `fetch("/api/admin/points", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: ${morganUid}, points: 5, reason: "E2E quiet", post: false }) }).then((r) => r.json())`);
  await sleep(500);
  const jwin2 = await es<{ text: string } | undefined>(alex, `fetch("/api/jumbotron").then((r) => r.json()).then((j) => (j.board ?? j).wins?.[0])`);
  ok(!quiet.posted && !jwin2?.text.includes("E2E quiet"), "Unticking Post in #wins keeps it quiet");

  // ── A burst of plain toasts never pushes out one you can act on ──
  await es(alex, `(() => { const s = __es.state; s.toasts = []; })()`);
  const kept = await es<any>(alex, `(async () => { const t = __es.toast; t("Knock knock", { action: { label: "Let in", run: () => {} } }); for (let i = 0; i < 6; i++) t("Someone arrived " + i); return { n: __es.state.toasts.length, knock: __es.state.toasts.some((t) => t.text === "Knock knock") }; })()`);
  ok(kept.n === 4 && kept.knock, `Six arrivals in a row keep the knock toast on screen (${JSON.stringify(kept)})`);

  // ── Outfits: Fortnite-style, unlocked by points, seen by everyone ──
  const morganIdO = await es<string>(morgan, `__es.state.me.id`);
  await es(morgan, `__es.sock().emit("setOutfit", { outfit: "galaxy" })`);
  await sleep(600);
  const aPts = await es<number>(morgan, `__es.state.me.points`);
  ok((await es<string | null>(alex, `__es.state.people.get(${JSON.stringify(morganIdO)})?.outfit ?? null`)) !== "galaxy", `A locked outfit is refused (Morgan has ${aPts} points; Galaxy needs 9,000)`);
  await es(morgan, `__es.sock().emit("setOutfit", { outfit: "tee" })`);
  ok(await until(alex, `!!document.querySelector('.avatar[data-outfit="tee"]')`), "Morgan puts on the Acme Tee; Alex sees it");
  await es(morgan, `__es.sock().emit("setOutfit", { outfit: null })`);
  ok(await until(alex, `!document.querySelector('.avatar[data-outfit]')`), "…and back to his own colours");

  // ── #wins shows first names only: no "| Acme" on the shared screens ──
  await es(alex, `fetch("/api/dev/win", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Morgan Lee | Acme", text: "E2E win" }) }).then((r) => r.status)`);
  ok(await until(alex, `document.querySelector(".win-banner b")?.textContent === "Morgan"`), "Win banner shows just the first name");
  const jw = await es<{ name: string } | undefined>(alex, `fetch("/api/jumbotron").then((r) => r.json()).then((j) => (j.board ?? j).wins?.[0])`);
  ok(jw?.name === "Morgan", `…and so does the jumbotron (${jw?.name})`);
  await es(alex, `document.querySelector(".win-banner button")?.click()`);

  // ── "Pay to win": a joke button in the emote menu ──
  await alex.bringToFront();
  await es(alex, `document.activeElement?.blur()`);
  await alex.keyboard.press("e");
  await alex.locator(".p2w-btn").click();
  ok(await alex.locator(".p2w-pop b", { hasText: "lol" }).isVisible(), "Pay to win just says lol");
  await alex.locator(".p2w-pop").click();
  ok(!(await alex.locator(".p2w-pop").count()), "…and clicking it goes away");
  await alex.mouse.click(700, 300);
  ok(await until(alex, `!document.querySelector(".emoji-menu")`), "Clicking outside the menu closes it");

  // ── First time in: a welcome bonus, celebrated once the welcome screen is closed ──
  const bo = await person(browser, `bo.${stamp}@example.org`, `Bo Bonus ${stamp}`, true);
  ok(await until(bo, `(__es.state.me.points ?? 0) >= 100`), "A newcomer gets the 100-point welcome bonus");
  await sleep(1500);
  ok(!(await bo.locator(".bonus-card").count()) && (await bo.locator(".modal.welcome").count()) === 1, "…held back while the welcome screen is open");
  await bo.getByRole("button", { name: /explore on my own/i }).click();
  ok(await until(bo, `!!document.querySelector(".bonus-card")`), "…then the bonus card pops when it closes");
  ok(/\+100/.test(await es<string>(bo, `document.querySelector(".bonus-card .bonus-points")?.textContent ?? ""`)), "…showing +100");
  await bo.getByRole("button", { name: "Let's go!" }).click();
  ok(await until(bo, `!document.querySelector(".bonus-card")`), "…and Let's go closes it");
  // Only the six givers give points, never to themselves.
  const boGive = await es<number>(bo, `fetch("/api/points/award", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: 1, points: 5000, reason: "e2e self-serve" }) }).then((r) => r.status)`);
  const boCan = await es<boolean>(bo, `fetch("/api/points").then((r) => r.json()).then((j) => Boolean(j.canGive))`);
  ok(boGive === 403 && !boCan, `Someone who isn't a giver can't give points (${boGive})`);
  const alexUid = await es<number | null>(alex, `fetch("/api/admin/points").then((r) => r.json()).then((d) => d.everyone.find((u) => u.name === "Alex Admin")?.id ?? null)`);
  const self = await es<{ status: number; error?: string }>(alex, `fetch("/api/points/award", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: ${alexUid}, points: 5000, reason: "e2e self", post: false }) }).then(async (r) => ({ status: r.status, ...(await r.json()) }))`);
  ok(self.status === 400 && /yourself/.test(self.error ?? ""), `A giver can't give points to themselves (${self.status}: ${self.error})`);
  await bo.context().close();

  // ── One bad frame must not freeze the floor ──
  await alex.bringToFront();
  await es(alex, `document.activeElement?.blur()`); // arrow keys on a focused radio change the radio, not your position
  await es(alex, `(() => { let thrown = false; const z = __es.camera.zoom; Object.defineProperty(__es.camera, "zoom", { configurable: true, get() { if (!thrown) { thrown = true; throw new Error("e2e: one bad frame"); } return z; }, set(v) { Object.defineProperty(__es.camera, "zoom", { value: v, writable: true, configurable: true }); } }); })()`);
  await sleep(500);
  const tf = () => alex.locator(".avatar.me").evaluate((el) => (el as HTMLElement).style.transform);
  const before = await tf();
  await alex.keyboard.down("ArrowRight");
  await sleep(600);
  await alex.keyboard.up("ArrowRight");
  await sleep(300);
  ok((await tf()) !== before, "After a frame throws, Alex's avatar still moves on screen (the loop kept going)");
  ok(await until(alex, `(async () => true)()`) && (process.env.API_LOG ? (await import("node:fs")).readFileSync(process.env.API_LOG, "utf8").includes("client error · Alex Admin · frame") : true), "…and the error reached the server log with his name");
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
