// End-to-end check with real browsers, fake cameras and real LiveKit:
//   npm run dev   (in another terminal; .env needs ADMIN_EMAILS=admin@example.com and
//                 ALLOWED_EMAIL_DOMAINS=example.com,example.org)
//   npx tsx scripts/e2e.ts [--shots dir] [--crowd N]
// Signs people in with the dev login, joins, and checks the things that matter:
// they see each other, walking close subscribes audio, a closed door seals a
// room, knocking lets you in, statuses land in analytics.

import { chromium, type Page, type Browser } from "playwright";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { doorPoint, seatOf, type Floor } from "../shared/floor";

const BASE = process.env.BASE ?? "http://localhost:5173";
const args = process.argv.slice(2);
const SHOTS = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : "";
const CROWD = args.includes("--crowd") ? Number(args[args.indexOf("--crowd") + 1]) : 0;

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

async function person(browser: Browser, email: string, name: string, opts: { cam?: boolean } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, permissions: ["camera", "microphone"] });
  await ctx.addInitScript(() => { try { localStorage.setItem("es.roombar", "open"); } catch {} }); // keep the room bar open: tests click its buttons
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${name}] page error: ${e.message}`));
  await page.goto(`${BASE}/auth/dev?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`);
  await page.getByRole("button", { name: "Join Space" }).waitFor({ timeout: 15000 });
  if (opts.cam === false) await page.getByRole("button", { name: "Camera off" }).click();
  // Test people skip the first-day welcome: these suites test the office, not onboarding.
  await page.evaluate(() => fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ track: "member", dismiss: true }) })).catch(() => {});
  await page.getByRole("button", { name: "Join Space" }).click();
  await page.waitForFunction(() => (window as any).__es?.state?.me && (window as any).__es.room()?.state === "connected", null, { timeout: 20000 });
  // A rerun within 90 s resumes people where the last run left them; start from desks.
  await page.evaluate(() => {
    const es = (window as any).__es;
    const d = es.state.floor.desks.find((x: any) => x.id === es.state.me.deskId);
    if (d) es.jump(d.seat ?? { x: d.x, y: d.y + (d.facing === "s" ? -40 : 40) });
    es.sock().emit("status", { status: "available", text: "" });
  });
  return page;
}

const es = <T>(page: Page, fn: string) => page.evaluate(fn) as Promise<T>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const browser = await chromium.launch({
  executablePath: chromePath(),
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

try {
  const alex = await person(browser, "admin@example.com", "Alex Admin");
  const andrew = await person(browser, "morgan@example.com", "Morgan Lee");
  const victor = await person(browser, "victor@example.org", "Victor Stone", { cam: false });
  await sleep(1500);

  // Positions come from the live floor plan, so the suite follows layout changes.
  const F = await es<Floor>(alex, "__es.state.floor");
  const room = (id: string) => F.rooms.find((r) => r.id === id)!;
  const centre = (id: string, dx = 0) => { const r = room(id); return { x: Math.round(r.x + r.w / 2 + dx), y: Math.round(r.y + r.h / 2) }; };
  const out = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] } as const;
  /** A point `d` px from a room's door: positive is out in the corridor, negative is inside. */
  const byDoor = (id: string, d: number) => { const r = room(id); const p = doorPoint(r); const [ox, oy] = out[r.door.side]; return { x: Math.round(p.x + ox * d), y: Math.round(p.y + oy * d) }; };
  const deskOf = (owner: string) => F.desks.find((x) => x.owner === owner)!;
  const at = (p: { x: number; y: number }) => `{x: ${p.x}, y: ${p.y}}`;
  /** Wait (up to `ms`) for an expression in the page to be truthy. */
  const until = (page: Page, expr: string, ms = 10000) => page.waitForFunction(expr, null, { timeout: ms, polling: 200 }).then(() => true, () => false);
  // Earlier runs (or the UI suite) may have moved people to other desks: put
  // everyone back on their roster seat so the run starts from a known layout.
  for (const [page, owner] of [[alex, "Alex Admin"], [andrew, "Morgan Lee"], [victor, "Victor Stone"]] as const) {
    const d = deskOf(owner);
    if (!d) continue;
    const id = await es<string>(page, "__es.state.me.id");
    await alex.evaluate(async ([uid, desk]) => fetch(`/api/admin/members/${uid}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ desk_id: desk }) }), [id, d.id] as const);
    await es(page, `__es.jump(${at(seatOf(d))})`);
  }
  await sleep(1200);

  ok(await es<number>(alex, "__es.state.people.size") === 2, "Alex sees the other two on the floor");
  const alexDesk = await es<string | null>(alex, "__es.state.me.deskId");
  ok(alexDesk === deskOf("Alex Admin").id && deskOf("Alex Admin").roomId === "office-3", `Alex was seated at the COO desk from the roster (${alexDesk})`);
  ok((await es<string | null>(andrew, "__es.state.me.deskId")) === deskOf("Morgan Lee").id && deskOf("Morgan Lee").roomId === "team-south", "Morgan was seated in Enterprise");
  await shot(alex, "01-alex-at-desk");

  // Far apart: nobody is subscribed to anybody.
  const subs = (p: Page) => es<number>(p, `[...__es.room().remoteParticipants.values()].reduce((n, rp) => n + [...rp.trackPublications.values()].filter(t => t.isSubscribed).length, 0)`);
  ok((await subs(alex)) === 0, "Far apart: Alex subscribes to nothing");

  // Alex is "working in Slack": his office tab goes to the background.
  // Headless Chrome never marks background tabs hidden, so simulate what a real browser does.
  const setHidden = (page: Page, hidden: boolean) =>
    page.evaluate(`(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => ${hidden} });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "${hidden ? "hidden" : "visible"}" });
      document.dispatchEvent(new Event("visibilitychange"));
    })()`);
  await setHidden(alex, true);
  ok(await alex.evaluate(() => document.hidden), "Alex's office tab is in the background");

  // Morgan walks to Alex (Find → Enter).
  await andrew.bringToFront();
  await andrew.keyboard.press("f");
  await andrew.keyboard.type("Alex");
  await andrew.keyboard.press("Enter");
  await sleep(2500);
  const heard = await es<number>(alex, `__es.state.hearing.get(String(__es.state.people.keys().next().value)) ?? 0`);
  const alexHearsAndrew = await es<number>(alex, `(() => { for (const [id,p] of __es.state.people) if (p.name === "Morgan Lee") return __es.state.hearing.get(id) ?? 0; return -1 })()`);
  ok(alexHearsAndrew > 0, `Morgan walked over; Alex hears him at volume ${alexHearsAndrew.toFixed(2)}`);
  ok((await subs(alex)) >= 2, "Alex subscribed to Morgan's mic + camera — with his tab in the background");
  await setHidden(alex, false);
  await shot(alex, "02-andrew-walked-over");
  void heard;

  // Cameras reach fewer people than voices: in a big open team room you hear
  // everyone, but only get the camera of whoever is close.
  const alexGets = (src: string) => es<boolean>(alex, `(() => { for (const p of __es.state.people.values()) if (p.name === "Morgan Lee") return !!__es.room().remoteParticipants.get(p.lk)?.getTrackPublication("${src}")?.isSubscribed; return false })()`);
  await es(alex, `__es.jump(${at(centre("engineering", -40))})`);
  await es(andrew, `__es.jump(${at(centre("engineering", 40))})`);
  ok(await until(alex, `(() => { for (const p of __es.state.people.values()) if (p.name === "Morgan Lee") return !!__es.room().remoteParticipants.get(p.lk)?.getTrackPublication("camera")?.isSubscribed })()`), "Tech Support, a desk apart: Alex gets Morgan's camera");
  await es(alex, `__es.jump(${at(centre("engineering", -300))})`);
  await es(andrew, `__es.jump(${at(centre("engineering", 300))})`);
  await sleep(3000);
  ok((await alexGets("microphone")) && !(await alexGets("camera")), "Tech Support, across the room: Alex still hears Morgan but doesn't stream his camera");

  // A camera nobody is in front of pauses, and comes back by itself.
  await es(andrew, `__es.sock().emit("status", { status: "away" })`);
  ok(await until(andrew, `!__es.room().localParticipant.isCameraEnabled && __es.state.me.cam === false`), "Morgan goes Away: his camera pauses");
  ok(await until(andrew, `!__es.officeAudio() && !__es.state.me.mic`), "…his mic mutes and the office goes silent for him (pilot feedback)");
  await es(andrew, `__es.sock().emit("status", { status: "available" })`);
  ok(await until(andrew, `__es.room().localParticipant.isCameraEnabled && __es.state.me.cam === true`), "…and comes back when he's Available");
  await es(andrew, `__es.sock().emit("status", { status: "away" })`);
  await until(andrew, `!__es.room().localParticipant.isCameraEnabled`);
  await andrew.bringToFront();
  await andrew.keyboard.press("1");
  ok(await until(andrew, `__es.room().localParticipant.isCameraEnabled`), "Turning the camera on while Away keeps it on");
  await es(andrew, `__es.sock().emit("status", { status: "available" })`);
  await sleep(800);

  // Focusing mutes the mic and turns the camera off; Available brings both back (the owner, 2026-11-05).
  if (!(await es<boolean>(andrew, `__es.state.me.mic`))) { await andrew.bringToFront(); await andrew.keyboard.press("2"); await until(andrew, `__es.state.me.mic`); }
  await until(andrew, `__es.room().localParticipant.isCameraEnabled`);
  await andrew.bringToFront();
  await andrew.keyboard.press("5");
  ok(await until(andrew, `__es.state.me.status === "focusing" && !__es.room().localParticipant.isMicrophoneEnabled && !__es.room().localParticipant.isCameraEnabled && !__es.state.me.mic && !__es.state.me.cam`), "Focusing: Morgan's mic mutes and his camera turns off");
  ok(await until(alex, `[...__es.state.people.values()].some(p => p.name === "Morgan Lee" && !p.mic && !p.cam)`), "…and Alex sees him muted with no camera");
  ok(await until(andrew, `!__es.officeAudio()`), "…and Morgan stops hearing the office");
  await andrew.keyboard.press("3");
  ok(await until(andrew, `__es.room().localParticipant.isMicrophoneEnabled && __es.room().localParticipant.isCameraEnabled && __es.state.me.mic && __es.state.me.cam`), "…Available again: mic and camera come back");
  ok(await until(andrew, `__es.officeAudio()`), "…and he hears the office again");
  // Unmuting yourself while Focusing sticks: going Available doesn't touch it again.
  await andrew.keyboard.press("5");
  await until(andrew, `!__es.state.me.mic`);
  await andrew.keyboard.press("2");
  ok(await until(andrew, `__es.state.me.mic && __es.state.me.status === "focusing"`), "Morgan can unmute himself while Focusing");
  ok(await until(andrew, `__es.officeAudio()`), "…and unmuting brings the office sound back");
  await andrew.keyboard.press("3");
  ok(await until(andrew, `__es.state.me.mic && __es.state.me.cam`), "…and going Available leaves his mic on and brings the camera back");
  await sleep(500);

  // Reloading while Focusing keeps the mic and camera off; Available brings them back (the owner, 2026-11-09).
  await until(andrew, `__es.room().localParticipant.isCameraEnabled && __es.state.me.mic`);
  await andrew.bringToFront();
  await andrew.keyboard.press("5");
  await until(andrew, `!__es.state.me.mic && !__es.state.me.cam`);
  await sleep(500);
  await andrew.reload();
  await andrew.getByRole("button", { name: "Join Space" }).click();
  await andrew.waitForFunction(() => (window as any).__es?.state?.me && (window as any).__es.room()?.state === "connected", null, { timeout: 20000 });
  await sleep(1500);
  ok(await es<boolean>(andrew, `__es.state.me.status === "focusing" && !__es.room().localParticipant.isMicrophoneEnabled && !__es.room().localParticipant.isCameraEnabled && !__es.state.me.mic && !__es.state.me.cam`), "Reload while Focusing: still Focusing, mic and camera stay off");
  ok(await until(alex, `[...__es.state.people.values()].some(p => p.name === "Morgan Lee" && p.status === "focusing" && !p.mic && !p.cam)`), "…and Alex sees him muted with no camera");
  await andrew.bringToFront();
  await andrew.keyboard.press("3");
  ok(await until(andrew, `__es.room().localParticipant.isMicrophoneEnabled && __es.room().localParticipant.isCameraEnabled && __es.state.me.mic && __es.state.me.cam`), "…Available after the reload: mic and camera come on");
  await sleep(500);

  // Anyone can change the name everyone sees; admins can change anyone's (the owner, 2026-11-09).
  const put = (page: Page, url: string, method: string, body: object) => page.evaluate(([u, m, b]) => fetch(u, { method: m, headers: { "content-type": "application/json" }, body: b }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) })), [url, method, JSON.stringify(body)] as const);
  const sees = (page: Page, name: string) => until(page, `[...__es.state.people.values()].some(p => p.name === ${JSON.stringify(name)})`);
  const r1 = await put(andrew, "/api/me/name", "PUT", { name: "  Mo   L. " });
  ok(r1.status === 200 && r1.j.name === "Mo L.", `Morgan renames himself; spaces tidied (${JSON.stringify(r1.j)})`);
  ok(await sees(alex, "Mo L.") && await until(andrew, `__es.state.me.name === "Mo L."`), "…Alex sees the new name live, and so does Morgan");
  ok((await put(andrew, "/api/me/name", "PUT", { name: "   " })).status === 400 && (await put(andrew, "/api/me/name", "PUT", { name: "x".repeat(61) })).status === 400, "An empty or 61-character name is refused");
  const moId = await alex.evaluate(() => fetch("/api/admin/members").then((r) => r.json()).then((j) => j.users.find((u: any) => u.name === "Mo L.").id));
  ok((await put(victor, `/api/admin/members/${moId}`, "PATCH", { name: "Hacked" })).status === 403, "A member can't rename someone else");
  ok((await put(alex, `/api/admin/members/${moId}`, "PATCH", { name: "Morgan Lee" })).status === 200 && await sees(victor, "Morgan Lee"), "An admin can rename anyone (Morgan's name back), live");

  // Conference room with the door shut.
  await es(alex, `__es.jump(${at(centre("conference", -60))})`);
  await es(andrew, `__es.jump(${at(centre("conference", 60))})`);
  await sleep(1200);
  await alex.keyboard.press("o");
  await sleep(800);
  ok(await es<boolean>(victor, `__es.state.rooms.conference.closed`) === true, "Door closed (Victor sees it shut)");
  await shot(alex, "03-conference-door-closed");

  // Sounds (pilot feedback): the door you're behind thuds shut; someone who turned sounds off hears nothing.
  const played = (p: Page, what: string, since = 0) => es<boolean>(p, `__es.sounds.slice(${since}).includes(${JSON.stringify(what)})`);
  const logLen = (p: Page) => es<number>(p, `__es.sounds.length`);
  ok(await played(andrew, "door:closed"), "Sounds: Morgan, in the room, hears the door shut");
  await es(andrew, `localStorage.setItem("es.sounds", "0")`);
  const [alexAt, andrewAt] = [await logLen(alex), await logLen(andrew)];
  await alex.bringToFront();
  await alex.keyboard.press("o");
  await sleep(800);
  ok(await played(alex, "door:open", alexAt), "Sounds: Alex hears his door open");
  ok(!(await played(andrew, "door:open", andrewAt)), "Sounds: …and Morgan, who turned sounds off, doesn't");
  await es(andrew, `localStorage.removeItem("es.sounds")`);
  await alex.keyboard.press("o");
  await sleep(800);
  ok(await es<boolean>(victor, `__es.state.rooms.conference.closed`) === true, "Door shut again");
  const alexBefore = await logLen(alex);

  // Leaving through your own closed door works (and re-entering within a few seconds).
  const outside = byDoor("conference", 40);
  await es(andrew, `__es.walk(${at(outside)})`);
  await until(andrew, `(() => { const p = __es.live.get(__es.state.me.id); return Math.hypot(p.x - ${outside.x}, p.y - ${outside.y}) < 30 })()`);
  const aPos = await es<{ x: number; y: number }>(andrew, `__es.live.get(__es.state.me.id)`);
  // Out through the door: the hallway, or the next room when the door opens into it (as in Kumospace).
  ok(await es<string | null>(andrew, `__es.state.me.roomId`) !== "conference" && Math.hypot(aPos.x - outside.x, aPos.y - outside.y) < 30, "Morgan walks out through the closed door without getting stuck in it");
  ok(await until(alex, `__es.sounds.slice(${alexBefore}).includes("leave")`), "Sounds: Alex hears Morgan leave the room");
  await es(andrew, `__es.walk(${at(centre("conference", 60))})`);
  ok(await until(andrew, `__es.state.me.roomId === "conference"`), "…and straight back in");

  // Victor tries to walk in: blocked. He knocks; Alex lets him in.
  await es(victor, `__es.jump(${at(byDoor("conference", 40))})`);
  await sleep(600);
  const walked = await es<boolean>(victor, `__es.walk(${at(centre("conference", -60))})`);
  ok(!walked, "Victor can't path into the closed room");
  const victorHearsAlex = await es<number>(victor, `(() => { for (const [id,p] of __es.state.people) if (p.name === "Alex Admin") return __es.state.hearing.get(id) ?? 0; return -1 })()`);
  ok(victorHearsAlex === 0, "Victor right outside the closed door hears nothing");
  await es(victor, `__es.sock().emit("knock", {roomId: "conference"})`);
  await sleep(800);
  await shot(alex, "04-knock-toast");
  const letIn = alex.getByRole("button", { name: "Let in" }).first();
  ok(await letIn.isVisible(), "Alex gets a knock with a 'Let in' button");
  await letIn.click();
  await sleep(600);
  ok(await es<boolean>(victor, `__es.walk(${at(byDoor("conference", -90))})`), "After being let in, Victor can walk in");
  ok(await until(victor, `__es.state.me.roomId === "conference"`), "Victor is in the conference room");
  ok(await until(alex, `__es.sounds.slice(-3).includes("arrive")`), "Sounds: Alex hears Victor come in");

  // Eavesdropping: Victor walks back out, then a tampered client force-subscribes
  // to Alex through the closed door. Alex's browser must refuse.
  await es(victor, `__es.walk(${at(byDoor("conference", 40))})`);
  ok(await until(victor, `__es.state.me.roomId !== "conference"`), "Victor walked back out of the conference room");
  // …and off to his desk across the floor (the conference door opens into the lobby, where Alex will present).
  await es(victor, `__es.jump(${at({ x: Math.round(F.width * 0.8), y: Math.round(F.height * 0.15) })})`);
  await sleep(4000); // past the speaker-side 3 s grace period
  const alexId = await es<string>(alex, "__es.state.me.lk");
  const forced = await victor.evaluate(async (zid) => {
    const rp = (window as any).__es.room().remoteParticipants.get(zid);
    for (const pub of rp.trackPublications.values()) pub.setSubscribed(true);
    await new Promise((r) => setTimeout(r, 2500));
    return [...rp.trackPublications.values()].filter((t: any) => t.track).length;
  }, alexId);
  ok(forced === 0, `A tampered client outside the closed door receives none of Alex's tracks (got ${forced})`);

  // Interactions: react, nudge, follow, status text, typing doesn't trigger shortcuts.
  const andrewId = await es<string>(andrew, "__es.state.me.id");
  await es(andrew, `__es.walk(${at(centre("conference", 0))})`);
  await sleep(1500);
  await alex.keyboard.press(":"); // opens the emoji panel
  await alex.getByRole("button", { name: "🎉" }).click();
  await sleep(400);
  ok(await andrew.locator(".avatar .reaction").filter({ hasText: "🎉" }).count() === 1, "Alex's 🎉 reaction floats over his avatar on Morgan's screen");
  await es(alex, `__es.sock().emit("nudge", {to: "${andrewId}"})`);
  await sleep(500);
  ok(await andrew.getByText("Alex Admin nudged you").isVisible(), "Morgan gets the nudge");
  await andrew.locator(".tool.status-btn").click();
  await andrew.getByPlaceholder(/What's your status/).fill("Heads down on the KES proposal");
  await andrew.keyboard.press("Enter");
  await sleep(500);
  ok(await es<string>(alex, `__es.state.people.get("${andrewId}").statusText`) === "Heads down on the KES proposal", "Morgan's status message reaches Alex");
  ok(await es<string>(andrew, "__es.state.me.status") === "available", "Typing '5' or 'g' in the status box didn't trigger shortcuts");

  await es(andrew, `__es.sock().emit("follow", {to: "${await es<string>(alex, "__es.state.me.id")}"})`);
  await es(alex, `__es.walk(${at(F.spawn)})`);
  await sleep(6000);
  // Give the follower time to catch up after Alex stops (a longer walk on some layouts).
  await until(andrew, `(() => { const es = __es; const a = es.live.get(es.state.me.id); const z = es.live.get(es.state.me.following); return Math.hypot(a.x - z.tx, a.y - z.ty) < 200 })()`);
  const gap = await andrew.evaluate(`(() => { const es = __es; const a = es.live.get(es.state.me.id); const z = es.live.get(es.state.me.following); return Math.round(Math.hypot(a.x - z.tx, a.y - z.ty)) })()`);
  ok((gap as number) < 200, `Morgan follows Alex out of the room and down the hall (${gap}px behind)`);
  await es(andrew, `__es.sock().emit("follow", {to: null})`);

  // Only admins name rooms.
  const renameStatus = await andrew.evaluate(`fetch("/api/admin/rooms/sales/name", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Hacked" }) }).then((r) => r.status)`);
  ok(renameStatus === 403 || renameStatus === 401, `A member can't rename rooms (${renameStatus})`);

  // Present: nearby people see the share, far people don't.
  const shared = await alex.evaluate(async () => {
    try { await (window as any).__es.room().localParticipant.setScreenShareEnabled(true); (window as any).__es.sock().emit("media", { sharing: true }); return true; } catch (e) { return String(e); }
  });
  ok(shared === true, `Alex can present (${shared})`);
  await sleep(2500);
  ok(await andrew.locator(".share-mini").isVisible(), "Morgan, next to Alex, sees 'Alex is presenting'");
  ok(!(await victor.locator(".share-mini").isVisible()), "Victor, across the floor, doesn't get Alex's screen");
  await alex.evaluate(async () => { await (window as any).__es.room().localParticipant.setScreenShareEnabled(false); (window as any).__es.sock().emit("media", { sharing: false }); });

  // Transcribe (replaced Record with Fathom): with no transcriber configured it says so plainly.
  // The full path (badge, clips, Whisper, notes, privacy) is scripts/e2e-transcribe.ts.
  await es(alex, `__es.jump(${at(centre("meeting"))})`);
  await sleep(800);
  ok(await alex.getByRole("button", { name: "Record with Fathom" }).count() === 0, "The room bar no longer offers Record with Fathom");
  await alex.getByRole("button", { name: "Transcribe", exact: true }).click();
  await sleep(800);
  ok(await alex.getByText(/isn't set up|Transcribing/).first().isVisible(), "Transcribe either starts or says plainly that it isn't set up");

  // Status → analytics.
  await andrew.keyboard.press("5");
  await sleep(500);
  ok(await es<string>(alex, `(() => { for (const p of __es.state.people.values()) if (p.name === "Morgan Lee") return p.status })()`) === "focusing", "Morgan set Focusing (key 5); Alex sees it");

  // Profile card.
  const andrewPos = await es<{ x: number; y: number }>(alex, `(() => { for (const [id,p] of __es.state.people) if (p.name === "Morgan Lee") return __es.live.get(id) })()`);
  void andrewPos;
  // Bring Morgan on screen next to Alex so his avatar can be clicked.
  const zp = await es<{ x: number; y: number }>(alex, `__es.live.get(__es.state.me.id)`);
  await es(andrew, `__es.jump(${at({ x: Math.round(zp.x + 90), y: Math.round(zp.y) })})`);
  await sleep(1200);
  await alex.locator(".avatar:not(.me)").filter({ hasText: "Morgan" }).first().locator(".bubble").click();
  await sleep(400);
  ok(await alex.getByText("Ask Morgan to follow you").count() === 0 && (await alex.locator(".popover h3").textContent()) === "Morgan Lee", "Clicking Morgan opens his profile card");
  await shot(alex, "05-profile-card");
  await alex.keyboard.press("Escape");

  // Gallery and map render.
  await alex.keyboard.press("g");
  await sleep(800);
  const canHear = await es<number>(alex, `[...__es.state.hearing.values()].filter(v => v > 0).length`);
  ok(await alex.locator(".gallery .tile").count() === 1 + canHear, `Gallery shows Alex plus the ${canHear} people he can hear`);
  await shot(alex, "06-gallery");
  await alex.keyboard.press("Escape");
  await alex.keyboard.press("m");
  await sleep(400);
  await shot(alex, "07-map");
  await alex.keyboard.press("Escape");

  // Admin analytics has rows.
  const admin = await alex.context().newPage();
  await admin.goto(`${BASE}/admin/analytics`);
  await admin.locator(".tl-row").first().waitFor({ timeout: 8000 });
  ok((await admin.locator(".tl-row").count()) >= 3, "Analytics lists everyone who was in today");
  await shot(admin, "08-analytics");
  const csv = await admin.evaluate(async () => {
    const a = document.querySelector<HTMLAnchorElement>('a[href*="analytics.csv"]')!;
    return (await fetch(a.href)).text();
  });
  ok(csv.split("\n").length >= 4 && csv.startsWith("date,name"), "CSV export has a row per person");

  // Reconnect: a network blip must not send Morgan back to his desk.
  const before = await es<{ x: number; y: number }>(andrew, `(() => { const p = __es.live.get(__es.state.me.id); return { x: Math.round(p.x), y: Math.round(p.y) } })()`);
  await es(andrew, `(__es.sock().io.engine.close(), 0)`);
  await sleep(3500);
  const after = await es<{ x: number; y: number }>(andrew, `(() => { const p = __es.live.get(__es.state.me.id); return { x: Math.round(p.x), y: Math.round(p.y) } })()`);
  ok(Math.hypot(before.x - after.x, before.y - after.y) < 5, `After a reconnect Morgan is where he was (${before.x},${before.y} → ${after.x},${after.y})`);
  ok(await es<string>(andrew, "__es.state.me.status") === "focusing", "…and still Focusing");

  // A second tab replaces the first.
  const andrew2 = await andrew.context().newPage();
  await andrew2.goto(BASE);
  // Test people skip the first-day welcome: these suites test the office, not onboarding.
  await andrew2.evaluate(() => fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ track: "member", dismiss: true }) })).catch(() => {});
  await andrew2.getByRole("button", { name: "Join Space" }).click();
  await andrew2.waitForFunction(() => (window as any).__es?.state?.me, null, { timeout: 15000 });
  await sleep(1000);
  ok(await andrew.getByText("You opened Office Spaces in another tab").isVisible(), "Opening a second tab ends the first one with a clear message");
  ok(await es<number>(alex, `[...__es.state.people.values()].filter(p => p.name === "Morgan Lee").length`) === 1, "…and Morgan appears once, not twice");

  // Make sure nobody is in the Meeting Room before the guest arrives.
  await es(alex, `__es.jump(${at(byDoor("meeting", 40))})`);
  await sleep(800);

  // Guest link: confined to its room, no screen share.
  const inv = await alex.evaluate(async () => (await fetch("/api/admin/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "E2E guest", roomId: "meeting", hours: 2, canPresent: false }) })).json());
  ok(typeof inv.link === "string" && inv.link.includes("/g/"), "Admin created a guest link");
  const gctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, permissions: ["camera", "microphone"] });
  await gctx.addInitScript(() => { try { localStorage.setItem("es.roombar", "open"); } catch {} }); // keep the room bar open: tests click its buttons
  const guest = await gctx.newPage();
  await guest.goto(inv.link.replace(/^https?:\/\/[^/]+/, BASE));
  await guest.getByPlaceholder("First and last name").fill("Jane Client");
  await guest.getByRole("button", { name: "Continue" }).click();
  // Test people skip the first-day welcome: these suites test the office, not onboarding.
  await guest.evaluate(() => fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ track: "member", dismiss: true }) })).catch(() => {});
  await guest.getByRole("button", { name: "Join Space" }).click();
  await guest.waitForFunction(() => (window as any).__es?.state?.me && (window as any).__es.room()?.state === "connected", null, { timeout: 20000 });
  ok(await es<string | null>(guest, "__es.state.me.roomId") === "meeting", "The guest lands in the Meeting Room");
  ok(!(await es<boolean>(guest, `__es.walk(${at(F.spawn)})`)), "The guest can't walk out of the room");
  await es(guest, `__es.sock().emit("move", ${at(F.spawn)})`);
  await sleep(500);
  ok(await es<string | null>(guest, "__es.state.me.roomId") === "meeting", "A forged move out of the room is refused by the server");
  const guestShare = await guest.evaluate(async () => {
    try { await (window as any).__es.room().localParticipant.setScreenShareEnabled(true); return "published"; } catch (e: any) { return String(e?.message ?? e); }
  });
  ok(guestShare !== "published", `A guest without permission can't publish a screen share (${guestShare.slice(0, 60)})`);
  const guestAdmin = await guest.evaluate(async () => (await fetch("/api/admin/members")).status);
  ok(guestAdmin === 401, "Guests can't reach admin APIs");
  const guestView = await guest.evaluate(`(() => { const ps = [...__es.state.people.values()]; return { n: ps.length, outside: ps.filter(p => p.roomId !== "meeting").length, emails: ps.filter(p => p.email || p.slackId || p.tz).length, rooms: Object.keys(__es.state.rooms).length } })()`) as any;
  ok(guestView.outside === 0 && guestView.emails === 0 && guestView.rooms === 1, `A guest sees only people in their room, with no emails/Slack/timezones (${JSON.stringify(guestView)})`);
  // QA 2026-11-06: points, levels, streaks and since-dates are for the team; a guest's menu is just the day-one emotes.
  await es(alex, `__es.walk(${at(centre("meeting"))})`);
  await sleep(4000);
  const leak = await es<any>(guest, `(() => { const ps = [...__es.state.people.values()]; return { points: ps.filter(p => p.points != null).length, since: ps.filter(p => p.since).length, streak: ps.filter(p => p.streak).length, eggs: ps.filter(p => p.eggs).length, n: ps.length } })()`);
  ok(leak.n >= 1 && leak.points + leak.since + leak.streak + leak.eggs === 0, `A guest sees no teammate points, start dates, streaks or eggs (${JSON.stringify(leak)})`);
  await guest.keyboard.press("e");
  await sleep(300);
  const gm = await es<any>(guest, `({ emotes: document.querySelectorAll(".emote-btn").length, epic: !!document.querySelector(".epic-head"), p2w: !!document.querySelector(".p2w-btn"), level: /Level/.test(document.querySelector(".emoji-menu")?.textContent ?? "") })`);
  ok(gm.emotes === 4 && !gm.epic && !gm.p2w && !gm.level, `A guest's React menu has just the four day-one emotes, no levels or Pay to win (${JSON.stringify(gm)})`);
  await guest.keyboard.press("Escape");
  await guest.mouse.click(600, 400);
  await es(alex, `__es.walk(${at(F.spawn)})`);
  await sleep(3000);
  ok((await guest.evaluate(async () => (await fetch("/api/desks")).status)) === 401, "Guests can't pull the staff desk directory");
  ok((await guest.evaluate(async () => (await fetch("/api/people/1")).status)) === 401, "…or staff profiles");
  const lkView = await guest.evaluate(`(() => { const ps = [...__es.room().remoteParticipants.values()]; return { names: ps.filter(p => p.name).length, numericIds: ps.filter(p => /^\\d+$/.test(p.identity) || p.identity.startsWith("g:")).length, total: ps.length } })()`) as any;
  ok(lkView.names === 0 && lkView.numericIds === 0, `LiveKit shows the guest no staff names or user ids (${JSON.stringify(lkView)})`);
  // Alex walks into the guest's room: the guest sees him arrive; walks out: he disappears for them.
  await es(alex, `__es.walk(${at(centre("meeting"))})`);
  await sleep(4000);
  ok(await es<number>(guest, `[...__es.state.people.values()].filter(p => p.name === "Alex Admin").length`) === 1, "When Alex walks into the guest's room, the guest sees him");
  // Alex drops and reconnects while standing still in the guest's room: the guest must still get his updates.
  await es(alex, `(__es.sock().io.engine.close(), 0)`);
  await sleep(3500);
  await es(alex, `__es.sock().emit("media", {mic: false})`);
  await sleep(700);
  ok(await es<boolean>(guest, `[...__es.state.people.values()].find(p => p.name === "Alex Admin")?.mic === false`), "After Alex reconnects in the room, the guest still sees him mute");
  await es(alex, `__es.sock().emit("media", {mic: true})`);
  await es(alex, `__es.walk(${at(byDoor("meeting", 40))})`);
  await sleep(4000);
  ok(await es<number>(guest, `[...__es.state.people.values()].filter(p => p.name === "Alex Admin").length`) === 0, "…and when he leaves, he's gone from the guest's view");
  await es(alex, `__es.walk(${at(centre("meeting"))})`);
  await alex.evaluate(async (id) => fetch(`/api/admin/invites/${id}`, { method: "DELETE" }), inv.id);
  await sleep(1000);
  ok(await guest.getByText("This invite link was revoked").isVisible(), "Revoking the link removes the connected guest immediately");
  const after2 = await (await gctx.newPage()).goto(`${BASE}/api/guest/${inv.link.split("/g/")[1]}`);
  ok(after2?.status() === 410, "A revoked link stops working");

  // Malformed events from a client must not crash the server.
  await victor.evaluate(`(() => { const s = __es.sock(); s.emit("move"); s.emit("door", null); s.emit("status", 5); s.emit("knock", {roomId: {}}); s.emit("admit", {roomId: "conference", personId: ["x"]}); s.emit("nudge", {to: null}); s.emit("react"); s.emit("teleport", {to: 42}); s.emit("media", "x"); s.emit("follow", {to: {}}); })()`);
  await sleep(1200);
  ok((await (await fetch(`${BASE}/health`)).json()).ok === true, "Garbage socket messages don't crash the server");
  ok(await es<boolean>(alex, `__es.sock().connected`), "…and everyone stays connected");

  // A roster desk can't be claimed by someone else.
  const claim = await victor.evaluate(async (id) => (await fetch(`/api/desks/${id}/claim`, { method: "POST" })).status, deskOf("Avery Brooks").id);
  ok(claim === 403, "Victor can't claim someone else's roster desk");

  // Removing someone signs them out on the spot.
  const victorId = await es<string>(victor, "__es.state.me.id");
  await alex.evaluate(async (id) => fetch(`/api/admin/members/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ removed: true }) }), victorId);
  await sleep(800);
  ok(await victor.getByText("An admin removed you").isVisible(), "A removed member is kicked out with a message");
  const back = await victor.evaluate(async () => (await fetch("/api/me")).json());
  ok(back.signedIn === false, "…and their session no longer works");
  await alex.evaluate(async (id) => fetch(`/api/admin/members/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ removed: false }) }), victorId);

  if (CROWD) {
    console.log(`\nCrowd: adding ${CROWD} more people…`);
    const t0 = Date.now();
    const crowd: Page[] = [];
    for (let i = 0; i < CROWD; i++) crowd.push(await person(browser, `crowd${i}@example.org`, `Crowd Person ${i}`, { cam: i % 2 === 0 }));
    console.log(`  joined in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await sleep(3000);
    // Victor was removed and the guest revoked earlier in this run; Morgan is the only other original.
    const names = await es<string[]>(alex, "[...__es.state.people.values()].map(p => p.name)");
    const crowdSeen = names.filter((n) => n.startsWith("Crowd Person")).length;
    ok(crowdSeen === CROWD && names.includes("Morgan Lee") && names.length === 1 + CROWD, `Alex sees all ${CROWD} newcomers plus Morgan (${names.length} others: ${crowdSeen} crowd)`);
    await shot(alex, "09-crowd");
  }
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
