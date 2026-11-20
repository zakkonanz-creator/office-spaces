// Second end-to-end pass: the UI paths a person clicks through, not the protocol.
//   npm run dev   then   npx tsx scripts/e2e-ui.ts
import { chromium, type Page } from "playwright";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { doorPoint, seatOf, type Floor } from "../shared/floor";

const BASE = process.env.BASE ?? "http://localhost:5173";
const cache = join(homedir(), "Library/Caches/ms-playwright");
const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().find((d) => existsSync(join(cache, d, "chrome-mac-arm64")));
const browser = await chromium.launch({
  executablePath: dir ? join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing") : undefined,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
let failures = 0;
const ok = (c: unknown, m: string) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errors: string[] = [];

async function join_(email: string, name: string) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"] });
  await ctx.addInitScript(() => { try { localStorage.setItem("es.roombar", "open"); } catch {} }); // keep the room bar open: tests click its buttons
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  // compute-pressure: the YouTube music embed probes the Pressure API, which its iframe isn't granted.
  p.on("console", (m) => m.type() === "error" && !/favicon|ERR_|WebSocket|404|compute-pressure/.test(m.text()) && errors.push(`${name} console: ${m.text().slice(0, 160)}`));
  await p.goto(`${BASE}/auth/dev?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`);
  // Test people skip the first-day welcome: these suites test the office, not onboarding.
  await p.evaluate(() => fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ track: "member", dismiss: true }) })).catch(() => {});
  await p.getByRole("button", { name: "Join the office" }).click();
  await p.waitForFunction(() => (window as any).__es?.room()?.state === "connected", null, { timeout: 20000 });
  await p.evaluate(() => {
    const es = (window as any).__es;
    const d = es.state.floor.desks.find((x: any) => x.id === es.state.me.deskId);
    es.jump(d ? d.seat ?? { x: d.x, y: d.y + (d.facing === "s" ? -40 : 40) } : es.state.floor.spawn);
  });
  return p;
}
const es = <T>(p: Page, f: string) => p.evaluate(f) as Promise<T>;

try {
  const alex = await join_("admin@example.com", "Alex Admin");
  const riley = await join_("riley@example.com", "Riley Park");

  // Positions come from the live floor plan, so the suite follows layout changes.
  const F = await es<Floor>(alex, "__es.state.floor");
  const room = (id: string) => F.rooms.find((r) => r.id === id)!;
  const centre = (id: string, dx = 0) => { const r = room(id); return { x: Math.round(r.x + r.w / 2 + dx), y: Math.round(r.y + r.h / 2) }; };
  const out = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] } as const;
  const byDoor = (id: string, d: number) => { const r = room(id); const p = doorPoint(r); const [ox, oy] = out[r.door.side]; return { x: Math.round(p.x + ox * d), y: Math.round(p.y + oy * d) }; };
  const at = (p: { x: number; y: number }) => `{x: ${p.x}, y: ${p.y}}`;
  /** Somewhere to stand next to an object (inside its room), so it's on screen and clickable. */
  const nextTo = (pred: (o: Floor["objects"][number]) => boolean) => {
    const o = F.objects.find(pred)!;
    const r = F.rooms.find((q) => o.x >= q.x && o.x <= q.x + q.w && o.y >= q.y && o.y <= q.y + q.h);
    const y = r && o.y + o.h + 60 > r.y + r.h - 30 ? o.y - 60 : o.y + o.h + 60;
    return { x: Math.round(o.x + o.w / 2), y: Math.round(y) };
  };
  // Start everyone at their roster desk (earlier runs may have moved them).
  for (const [page, owner] of [[alex, "Alex Admin"], [riley, "Riley Park"]] as const) {
    const d = F.desks.find((x) => x.owner === owner);
    if (!d) continue;
    const id = await es<string>(page, "__es.state.me.id");
    await alex.evaluate(async ([uid, desk]) => fetch(`/api/admin/members/${uid}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ desk_id: desk }) }), [id, d.id] as const);
    await es(page, `__es.jump(${at(seatOf(d))})`);
  }
  await sleep(1000);

  // Background blur on, then off, without killing the camera.
  await alex.locator('button[aria-label="Camera settings"]').click();
  await alex.getByRole("button", { name: "Blur", exact: true }).click();
  await sleep(2500);
  ok(await es<boolean>(alex, `!!__es.room().localParticipant.getTrackPublication("camera")?.track?.getProcessor?.()`), "Background blur applies a processor to the camera");
  await alex.getByRole("button", { name: "None", exact: true }).click();
  await sleep(1000);
  ok(!(await es<boolean>(alex, `!!__es.room().localParticipant.getTrackPublication("camera")?.track?.getProcessor?.()`)), "…and turning it off removes it");
  ok(await es<boolean>(alex, `!__es.room().localParticipant.getTrackPublication("camera").isMuted`), "Camera still live after blur toggles");
  await alex.keyboard.press("Escape");
  await alex.mouse.click(700, 400);

  // Camera + mic toggles from the bar, mirrored to others.
  await alex.keyboard.press("1");
  await sleep(600);
  ok(await es<boolean>(riley, `(() => { for (const p of __es.state.people.values()) if (p.name === "Alex Admin") return p.cam === false })()`), "Key 1 turns Alex's camera off and Riley sees it");
  await alex.keyboard.press("1");
  await alex.keyboard.press("2");
  await sleep(600);
  ok(await es<boolean>(riley, `(() => { for (const p of __es.state.people.values()) if (p.name === "Alex Admin") return p.mic === false })()`), "Key 2 mutes Alex and Riley sees the muted badge state");
  ok(await es<boolean>(alex, `!__es.room().localParticipant.isMicrophoneEnabled`), "…and the mic really stopped publishing");
  await alex.keyboard.press("2");

  // Knock with the UI: Alex shuts his office door; Riley walks up and presses Knock.
  await alex.keyboard.press("o");
  await sleep(500);
  await es(riley, `__es.jump(${at(byDoor("office-3", 40))})`); // just outside the COO door
  await sleep(1200);
  await riley.getByRole("button", { name: "Knock" }).click();
  await sleep(700);
  ok(await alex.getByText(/Riley Park is knocking/).isVisible(), "The Knock button in the room bar reaches Alex");
  await alex.getByRole("button", { name: "Let in" }).click();
  await sleep(400);
  ok(await riley.getByText(/You've been let in/).isVisible(), "Riley is told she's been let in");

  // Minimap click walks.
  await riley.keyboard.press("m");
  await riley.locator(".minimap-floor").click({ position: { x: 300, y: 260 } });
  await sleep(300);
  ok(!(await riley.locator(".minimap").isVisible()), "Clicking the map closes it and walks there");

  // Objects: timer, music, empty link, real link.
  await es(alex, `__es.jump(${at(nextTo((o) => o.type === "timer"))})`);
  await sleep(800);
  await alex.locator(".obj-timer").click();
  await alex.getByRole("button", { name: "Start", exact: true }).click();
  await sleep(1300);
  ok(/0[0-4]:5[0-9]/.test((await alex.locator(".timer-face").textContent()) ?? ""), "The timer counts down");
  await alex.keyboard.press("Escape");
  await alex.mouse.click(30, 840);
  await es(alex, `__es.jump(${at(nextTo((o) => o.type === "music"))})`);
  await sleep(800);
  await alex.locator(".obj-music").click();
  await alex.getByRole("button", { name: "Play" }).click();
  await sleep(300);
  ok(await alex.locator("iframe.music-player").count() === 1, "Music starts in a hidden player");
  await alex.mouse.click(700, 300);
  await sleep(300);
  ok(await alex.locator("iframe.music-player").count() === 1, "…and keeps playing after the popover closes");
  await es(alex, `__es.state.music = null; __es.state.version++`);
  await es(alex, `__es.jump(${at(nextTo((o) => o.type === "link" && !o.url))})`);
  await sleep(800);
  await alex.locator(".obj-link.unset").first().click();
  await sleep(300);
  ok(await alex.getByText("This link hasn't been set yet.").isVisible(), "An unset link explains itself instead of opening nothing");
  await alex.mouse.click(700, 300);
  await es(alex, `__es.jump(${at(nextTo((o) => o.type === "link" && o.label === "Setup guide"))})`);
  await sleep(800);
  const [popup] = await Promise.all([alex.context().waitForEvent("page", { timeout: 5000 }).catch(() => null), alex.locator(".obj-link", { hasText: "Setup guide" }).click()]);
  const guide = F.objects.find((o) => o.label === "Setup guide")!.url!;
  ok(popup && popup.url().startsWith(new URL(guide).origin), `The Setup guide link opens in a new tab (${popup?.url().slice(0, 50)})`);
  await popup?.close();

  // Claim a free desk (Riley's roster desk is in KB; claim a spare).
  const free = await es<string>(riley, `__es.state.floor.desks.find(d => !d.owner && !__es.state.desks.has(d.id)).id`);
  const freeDesk = F.desks.find((d) => d.id === free)!;
  // Stand a little away from the desk so Riley's own figure doesn't cover it.
  await es(riley, `__es.jump(${at({ x: freeDesk.x + 120, y: freeDesk.y })})`);
  await sleep(900);
  const box = await riley.evaluate(`(() => { const d = __es.state.floor.desks.find(x => x.id === "${free}"); const el = document.querySelector('.desk[data-desk="${free}"]'); const r = el.getBoundingClientRect(); return d.bare ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : { x: r.x + r.width - 8, y: r.y + r.height - 6 } })()`) as { x: number; y: number };
  await riley.mouse.click(box.x, box.y);
  await riley.getByRole("button", { name: "Make this my desk" }).click();
  await sleep(500);
  ok(await es<string>(riley, "__es.state.me.deskId") === free, `Riley claims free desk ${free}`);
  await es(riley, `__es.jump(${at(F.spawn)})`);
  await sleep(600);
  await riley.keyboard.press("h");
  // It's a walk, not a teleport: give a cross-floor trip time to arrive.
  await riley.waitForFunction(`(() => { const d = __es.state.floor.desks.find(x => x.id === __es.state.me.deskId); const s = d.seat ?? { x: d.x, y: d.y + (d.facing === "s" ? -40 : 40) }; const p = __es.live.get(__es.state.me.id); return Math.hypot(p.x - s.x, p.y - s.y) < 30 })()`, null, { timeout: 30000, polling: 250 }).catch(() => {});
  const near = await es<number>(riley, `(() => { const d = __es.state.floor.desks.find(x => x.id === __es.state.me.deskId); const s = d.seat ?? { x: d.x, y: d.y + (d.facing === "s" ? -40 : 40) }; const p = __es.live.get(__es.state.me.id); return Math.round(Math.hypot(p.x - s.x, p.y - s.y)) })()`);
  ok(near < 30, `H walks Riley home to her new desk (${near}px away)`);

  // Panels.
  await alex.getByRole("button", { name: "Recordings" }).click();
  await sleep(500);
  await alex.getByText("Notes from rooms you were in").waitFor({ timeout: 5000 }).catch(() => {}); // past "Loading…"
  ok(await alex.getByText("No notes yet").isVisible() || await alex.locator(".rec").count() > 0, "Recordings tab renders");
  await alex.getByRole("button", { name: "Help" }).click();
  await alex.getByText("Everything looks good.").waitFor({ timeout: 10000 });
  ok(true, "Help self-test passes: mic, camera, office server, media server");

  // Role change in the admin UI reaches the live office.
  const admin = await alex.context().newPage();
  await admin.goto(`${BASE}/admin/members`);
  const row = admin.locator("tr", { hasText: "riley@example.com" });
  await row.locator("select").first().selectOption("admin");
  await sleep(700);
  ok(await es<string>(riley, "__es.state.me.role") === "admin", "Promoting Riley in Members updates her live session");
  await row.locator("select").first().selectOption("member");
  await admin.close();

  // Office Designer (real Claude call, so opt-in): preview only for the admin, Apply updates everyone, Undo restores.
  if (process.argv.includes("--designer")) {
    // Start from the layout file, whatever an earlier run left applied.
    await alex.evaluate(() => fetch("/api/admin/floor/revert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 0 }) }));
    await sleep(1500);
    await alex.getByRole("button", { name: "Design" }).click();
    await alex.getByPlaceholder(/reading corner/).fill("Rename the Kitchen to Café and make its floor oak");
    await alex.getByRole("button", { name: "Design it" }).click();
    await alex.getByRole("button", { name: "Apply for everyone" }).waitFor({ timeout: 180000 });
    ok(await es<string>(alex, `(__es.state.previewFloor ?? __es.state.floor).rooms.find(r => r.id === "kitchen").name`) === "Café", "Alex sees the redesign as a preview");
    ok(await es<string>(riley, `__es.state.floor.rooms.find(r => r.id === "kitchen").name`) !== "Café", "…and Riley doesn't, until it's applied");
    await alex.getByRole("button", { name: "Apply for everyone" }).click();
    await sleep(1500);
    ok(await es<string>(riley, `__es.state.floor.rooms.find(r => r.id === "kitchen").name`) === "Café", "After Apply, Riley's office shows the Café");
    ok(await riley.getByText("The office was just redesigned.").isVisible(), "…with a heads-up");
    await alex.locator("details.versions summary").click();
    alex.once("dialog", (d) => d.accept());
    await alex.locator(`details.versions li[data-version="0"]`).getByRole("button", { name: "Restore" }).click();
    await sleep(1500);
    ok(await es<string>(riley, `__es.state.floor.rooms.find(r => r.id === "kitchen").name`) === "Café", "A Designer rename sticks as the room's name, even after restoring the layout");
    await alex.evaluate(async () => fetch("/api/admin/rooms/kitchen/name", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "" }) }));
  }

  // Room names: rooms start unnamed; an admin names one from the room bar and everyone sees it.
  await es(alex, `__es.jump(${at(centre("sales"))})`);
  await sleep(900);
  await alex.getByTitle("Rename this room").click();
  await alex.locator(".roombar-rename").fill("Sales Floor");
  await alex.locator(".roombar-rename").press("Enter");
  await sleep(1200);
  ok(await es<string>(riley, `__es.state.floor.rooms.find(r => r.id === "sales").name`) === "Sales Floor", "An admin names a room from the room bar, and Riley sees the new name");
  ok(await riley.locator(".room-plaque", { hasText: "Sales Floor" }).count() === 1, "…on the room's sign too");
  await alex.evaluate(async () => fetch("/api/admin/rooms/sales/name", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "" }) }));

  // Fathom hand-off: Alex "starts" a recorded meeting in the conference room; Riley, in the room, is asked to join;
  // while her Meet tab is open the office is muted for her, and closing it brings her back.
  await es(alex, `__es.jump(${at(centre("conference", -60))})`);
  await es(riley, `__es.jump(${at(centre("conference", 60))})`);
  await sleep(1200);
  await riley.evaluate(() => (window as any).__es.sock().emit("media", { mic: true }));
  await alex.evaluate(async () => fetch("/api/dev/recording", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roomId: "conference", meetUrl: "about:blank#meet" }) }));
  const joinBtn = riley.getByRole("button", { name: "Join Meet" }).first();
  await joinBtn.waitFor({ timeout: 5000 });
  ok(true, "Riley, in the room, is asked to join the recorded meeting");
  const [meetTab] = await Promise.all([riley.context().waitForEvent("page"), joinBtn.click()]);
  await sleep(1200);
  ok(await es<boolean>(riley, `!__es.room().localParticipant.isMicrophoneEnabled`), "While she's in the Meet, her office mic is off");
  ok(await es<boolean>(alex, `[...__es.state.people.values()].find(p => p.name === "Riley Park")?.inMeeting === true`), "…and Alex sees her as 'in a recorded meeting'");
  await sleep(2500);
  ok(await es<boolean>(riley, `!__es.room().localParticipant.isMicrophoneEnabled`), "She stays in meeting mode (Meet's security cuts the tab link, so we don't guess from it)");
  await meetTab.close();
  await riley.getByRole("button", { name: "I'm back" }).click();
  await sleep(1200);
  ok(await es<boolean>(riley, `__es.room().localParticipant.isMicrophoneEnabled`), "Pressing “I'm back” turns her office mic back on");
  ok(await es<boolean>(alex, `[...__es.state.people.values()].find(p => p.name === "Riley Park")?.inMeeting === false`), "…and she's back in the office for everyone");

  // Start meeting on GHL Meeting Rooms: Alex starts one in Sales and gets the first shared room inside
  // the office; Riley is asked to join; the office mutes for both; leaving frees the room.
  // (example.com stands in for GHL: the test checks the office's side, not GHL's page.)
  const POOL = "Huddle | https://example.com/meet/space-e2e-1\nhttps://example.com/meet/space-e2e-2";
  await alex.evaluate(async (p) => fetch("/api/admin/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ghlRooms: p }) }), POOL);
  for (const p of [alex, riley]) await p.evaluate(async () => fetch("/api/me/ghl-room", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "" }) }));
  await es(alex, `__es.jump(${at(centre("sales", -60))})`);
  await es(riley, `__es.jump(${at(centre("sales", 60))})`);
  await sleep(1200);
  await riley.evaluate(() => (window as any).__es.sock().emit("media", { mic: true }));
  await alex.getByRole("button", { name: "Start meeting" }).click();
  await alex.locator(".meet-frame iframe").waitFor({ timeout: 5000 });
  ok(await alex.locator(".meet-frame iframe").getAttribute("src") === "https://example.com/meet/space-e2e-1", "Start meeting opens the first free shared room inside the office");
  ok(await alex.locator(".meet-frame header", { hasText: "Huddle" }).count() === 1, "…under its name");
  ok((await alex.locator(".meet-frame iframe").getAttribute("allow"))?.includes("microphone"), "…with the camera and mic passed to it");
  const ghlJoin = riley.getByRole("button", { name: "Join", exact: true }).first();
  await ghlJoin.waitFor({ timeout: 5000 });
  ok(true, "Riley, in the room, is asked to join");
  await ghlJoin.click();
  await riley.locator(".meet-frame iframe").waitFor({ timeout: 5000 });
  ok(await riley.locator(".meet-frame iframe").getAttribute("src") === "https://example.com/meet/space-e2e-1", "…and lands in the same room");
  await sleep(1000);
  ok(await es<boolean>(riley, `!__es.room().localParticipant.isMicrophoneEnabled`), "Her office mic is off while she's in the meeting");
  ok(await es<boolean>(alex, `[...__es.state.people.values()].find(p => p.name === "Riley Park")?.inMeeting === true`), "…and Alex sees her in the meeting");
  ok(await es<number>(alex, `__es.state.rooms.sales.recording?.pool`) === 0, "The shared room is marked in use");
  await riley.getByRole("button", { name: "Leave meeting" }).click();
  await sleep(1200);
  ok(await es<boolean>(riley, `__es.room().localParticipant.isMicrophoneEnabled`) && (await riley.locator(".meet-frame").count()) === 0, "Leave meeting closes the panel and turns her office mic back on");
  ok(await es<boolean>(riley, `__es.state.rooms.sales.recording?.kind === "ghl"`), "…while Alex is still in it, the meeting stays open");
  await alex.getByRole("button", { name: "Leave meeting" }).click();
  await sleep(1500);
  ok(await es<boolean>(alex, `__es.state.rooms.sales.recording === null`), "When the last person leaves, the meeting ends and the shared room is free again");
  // No shared rooms left: Start meeting asks for your own link, then uses it.
  const quietFrom = errors.length; // the 409 (no room) and 400 (bad link) below are the point of these steps
  await alex.evaluate(async () => fetch("/api/admin/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ghlRooms: "" }) }));
  await riley.getByRole("button", { name: "Start meeting" }).click();
  await riley.getByLabel("Your GHL Meeting Room link").fill("not a link");
  await riley.getByRole("button", { name: "Save" }).click();
  await sleep(600);
  ok(await riley.locator(".meet-frame").count() === 0, "With no rooms set up, a bad link is refused");
  await riley.getByLabel("Your GHL Meeting Room link").fill("https://example.com/meet/riley?pwd=e2e");
  await riley.getByRole("button", { name: "Save" }).click();
  await sleep(600);
  await riley.getByRole("button", { name: "Start meeting" }).click();
  await riley.locator(".meet-frame iframe").waitFor({ timeout: 5000 });
  ok(await riley.locator(".meet-frame iframe").getAttribute("src") === "https://example.com/meet/riley?pwd=e2e", "…and her own room, once saved, is what Start meeting opens");
  await riley.getByRole("button", { name: "Leave meeting" }).click();
  await riley.evaluate(async () => fetch("/api/me/ghl-room", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "" }) }));
  await sleep(800);
  // An admin imports people's rooms by email; Start meeting opens yours without you pasting anything.
  await alex.evaluate(async () => fetch("/api/admin/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ghlRoomLinks: "riley@example.com | crm.example.com/meet/riley-imported?pwd=1" }) }));
  await riley.getByRole("button", { name: "Start meeting" }).click();
  await riley.locator(".meet-frame iframe").waitFor({ timeout: 5000 });
  ok(await riley.locator(".meet-frame iframe").getAttribute("src") === "https://crm.example.com/meet/riley-imported?pwd=1", "A room an admin imported for your email is what Start meeting opens");
  await riley.getByRole("button", { name: "Leave meeting" }).click();
  await alex.evaluate(async () => fetch("/api/admin/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ghlRoomLinks: "" }) }));
  await sleep(800);
  errors.splice(quietFrom, errors.length - quietFrom, ...errors.slice(quietFrom).filter((e) => !/status of (409|400)/.test(e)));

  // Closing a meeting room's door starts the meeting: the closer goes straight in, the others are asked.
  const put = (body: object) => alex.evaluate(async (b) => fetch("/api/admin/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }), body);
  await put({ ghlRooms: "https://example.com/meet/space-e2e-door" });
  await put({ autoMeetOnClose: "meeting" });
  await es(alex, `__es.jump(${at(centre("breakout", -40))})`);
  await es(riley, `__es.jump(${at(centre("breakout", 40))})`);
  await sleep(1200);
  await alex.getByRole("button", { name: "Close door" }).click();
  await alex.locator(".meet-frame iframe").waitFor({ timeout: 5000 });
  ok(await alex.locator(".meet-frame iframe").getAttribute("src") === "https://example.com/meet/space-e2e-door", "Closing a meeting room's door starts its meeting, and the closer is in it");
  await riley.getByRole("button", { name: "Join", exact: true }).first().waitFor({ timeout: 5000 });
  ok(true, "…and Riley, inside, is asked to join");
  await alex.getByRole("button", { name: "Leave meeting" }).click();
  await sleep(1500);
  ok(await es<boolean>(alex, `__es.state.rooms.breakout.recording === null`), "…which ends when the closer leaves and nobody joined");
  await alex.getByRole("button", { name: "Open door" }).click();
  await put({ autoMeetOnClose: "off" });
  await sleep(500);
  await alex.getByRole("button", { name: "Close door" }).click();
  await sleep(1500);
  ok(await alex.locator(".meet-frame").count() === 0 && await es<boolean>(alex, `__es.state.rooms.breakout.recording === null`), "With the setting off, closing the door just closes it");
  await alex.getByRole("button", { name: "Open door" }).click();
  await put({ autoMeetOnClose: "meeting" });
  await put({ ghlRooms: "" });
  await sleep(500);

  // Looking around: a mouse wheel zooms, a trackpad scroll pans, and the view stays where you leave it.
  await alex.bringToFront();
  await es(alex, `(() => { const e = __es; e.camera.zoom = 0.9; e.jump(${at({ x: Math.round(F.width / 2), y: Math.round(F.height / 2) })}); })()`);
  await sleep(800);
  const vp = (await alex.locator(".viewport").boundingBox())!;
  const z0 = await es<number>(alex, "__es.camera.zoom");
  await alex.mouse.move(vp.x + vp.width * 0.8, vp.y + vp.height * 0.3);
  await alex.mouse.wheel(0, -100);
  await sleep(300);
  ok((await es<number>(alex, "__es.camera.zoom")) > z0, "A mouse-wheel notch zooms in");
  await alex.mouse.wheel(0, 100);
  await sleep(300);
  const before = await es<{ x: number; y: number }>(alex, "({x: __es.camera.x, y: __es.camera.y})");
  await alex.evaluate(() => document.querySelector(".viewport")!.dispatchEvent(new WheelEvent("wheel", { deltaX: 28.5, deltaY: 12.25, bubbles: true, cancelable: true })));
  await sleep(300);
  const after = await es<{ x: number; y: number }>(alex, "({x: __es.camera.x, y: __es.camera.y})");
  ok(after.x > before.x && after.y > before.y, "A trackpad two-finger scroll pans the floor");
  // Drag far into the top-left corner, then wait: it must stay, not snap back to Alex.
  await alex.mouse.move(vp.x + 200, vp.y + 200);
  await alex.mouse.down();
  await alex.mouse.move(vp.x + vp.width - 50, vp.y + vp.height - 50, { steps: 12 });
  await alex.mouse.up();
  await sleep(300);
  const dragged = await es<{ x: number; y: number }>(alex, "({x: __es.camera.x, y: __es.camera.y})");
  await sleep(2000);
  const later = await es<{ x: number; y: number }>(alex, "({x: __es.camera.x, y: __es.camera.y})");
  ok(Math.hypot(dragged.x - later.x, dragged.y - later.y) < 2, `After dragging to a corner the view stays put (moved ${Math.round(Math.hypot(dragged.x - later.x, dragged.y - later.y))}px in 2s)`);
  const vw = vp.width / 2 / (await es<number>(alex, "__es.camera.zoom"));
  ok(later.x >= vw - 1, "…and never past the building's edge");

  ok(errors.length === 0, `No page errors${errors.length ? `:\n  ${errors.join("\n  ")}` : ""}`);

  // Self-demotion guard (this request fails on purpose).
  const self = await alex.evaluate(async () => (await fetch(`/api/admin/members/${(window as any).__es.state.me.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "member" }) })).status);
  ok(self === 400, "An admin can't demote themselves (no locking everyone out)");
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
