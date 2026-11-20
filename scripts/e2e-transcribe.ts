// End-to-end check for "Transcribe this room", with real browsers whose fake mics
// play a recorded voice, real LiveKit, and the real Whisper service:
//   npm run dev                       (with TRANSCRIBER_URL + TRANSCRIBER_KEY set)
//   (cd transcriber && TRANSCRIBER_KEY=… uvicorn app:app --port 8790)
//   ZAK_WAV=a.wav sam_WAV=b.wav npx tsx scripts/e2e-transcribe.ts
// Each browser needs its own voice, so each person gets their own browser.

import { chromium, type Page } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:5173";
let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const es = <T>(page: Page, fn: string) => page.evaluate(fn) as Promise<T>;

async function person(email: string, name: string, wav?: string) {
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required",
      ...(wav ? [`--use-file-for-fake-audio-capture=${wav}`] : [])],
  });
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"] });
  await ctx.addInitScript(() => { try { localStorage.setItem("es.roombar", "open"); } catch {} }); // keep the room bar open: tests click its buttons
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${name}] page error: ${e.message}`));
  await page.goto(`${BASE}/auth/dev?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`);
  await page.getByRole("button", { name: "Join the office" }).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Camera off" }).click();
  // Test people skip the first-day welcome: these suites test the office, not onboarding.
  await page.evaluate(() => fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ track: "member", dismiss: true }) })).catch(() => {});
  await page.getByRole("button", { name: "Join the office" }).click();
  await page.waitForFunction(() => (window as any).__es?.state?.me && (window as any).__es.room()?.state === "connected", null, { timeout: 20000 });
  return { page, browser };
}

const roomCentre = (dx: number) => `(() => { const r = __es.state.floor.rooms.find((r) => r.id === "conference"); __es.jump({ x: r.x + r.w / 2 + ${dx}, y: r.y + r.h / 2 }); })()`;
const post = (page: Page, url: string, body: object) =>
  es<{ status: number; j: any }>(page, `fetch(${JSON.stringify(url)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) }))`);

const alex = await person("alex.e2e@example.com", "Alex Tester", process.env.ZAK_WAV);
const sam = await person("sam.e2e@example.com", "sam Tester", process.env.sam_WAV);
const victor = await person("victor.e2e@example.com", "Victor Elsewhere");
try {
  await es(alex.page, roomCentre(-40));
  await es(sam.page, roomCentre(40));
  await sleep(1500);

  const out = await post(victor.page, "/api/rooms/conference/transcribe", { on: true });
  ok(out.status === 403, "someone outside the room can't start it");

  const start = await post(alex.page, "/api/rooms/conference/transcribe", { on: true });
  ok(start.status === 200 && start.j.id, `anyone in the room can start it (${start.status})`);
  const id = start.j.id;
  await sleep(1500);
  ok(await es(sam.page, `Boolean(__es.state.rooms.conference?.transcribing)`), "everyone in the room sees the badge");
  ok(await es(victor.page, `Boolean(__es.state.rooms.conference?.transcribing)`), "the badge is visible from outside the room too");
  const again = await post(sam.page, "/api/rooms/conference/transcribe", { on: true });
  ok(again.status === 409, "a second start in the same room is refused");

  const sneak = await es<number>(victor.page, `fetch("/api/transcripts/${id}/chunks?dur=5000", { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array(2000) }).then((r) => r.status)`);
  ok(sneak === 403, "someone outside the room can't send audio into it");

  const huge = await es<number>(alex.page, `fetch("/api/transcripts/${id}/chunks?dur=1000", { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array(2_000_000) }).then((r) => r.status)`);
  ok(huge === 413, `a clip far bigger than its length is refused (${huge})`);

  // Victor pokes his head in for a few seconds: walking through isn't attending.
  await es(victor.page, roomCentre(0));
  await sleep(5000);
  await es(victor.page, `__es.jump({ x: 40, y: 40 })`);

  console.log("  …letting both mics run for one clip (~35 s)");
  await sleep(31_000);
  const stop = await post(sam.page, "/api/rooms/conference/transcribe", { on: false });
  ok(stop.status === 200, "anyone in the room can stop it");
  await sleep(1500);
  ok(!(await es(alex.page, `Boolean(__es.state.rooms.conference?.transcribing)`)), "the badge goes when it stops");

  console.log("  …waiting for the late-clip window, Whisper and the notes (up to 5 min)");
  let t: any = null;
  for (let i = 0; i < 90; i++) {
    const list = await es<any[]>(alex.page, `fetch("/api/transcripts").then((r) => r.json())`);
    t = list.find((x) => x.id === id);
    if (t?.status === "done") break;
    await sleep(5000);
  }
  ok(t?.status === "done", `notes are written (status ${t?.status}${t?.error ? `, ${t.error}` : ""})`);
  const full = await es<any>(sam.page, `fetch("/api/transcripts/${id}").then((r) => r.json())`);
  console.log(`  transcript:\n${String(full.transcript_md ?? "").split("\n").slice(0, 4).map((l) => "    " + l.slice(0, 140)).join("\n")}`);
  console.log(`  notes:\n${String(full.summary_md ?? "").split("\n").slice(0, 6).map((l) => "    " + l.slice(0, 140)).join("\n")}`);
  ok(/Alex Tester:/.test(full.transcript_md) && /sam Tester:/.test(full.transcript_md), "both speakers are in the transcript, by name");
  ok(/toronto/i.test(full.transcript_md), "the words came through (\"Toronto\")");
  ok(Boolean(full.summary_md?.trim()) && !/couldn't be written/.test(full.summary_md), "Claude wrote notes (needs a working ANTHROPIC_API_KEY)");
  const vl = await es<any[]>(victor.page, `fetch("/api/transcripts").then((r) => r.json())`);
  ok(!vl.some((x) => x.id === id), "someone who only passed through the room doesn't get the notes");
  const vr = await es<number>(victor.page, `fetch("/api/transcripts/${id}").then((r) => r.status)`);
  ok(vr === 404, "…nor open it by id");
} finally {
  for (const p of [alex, sam, victor]) await p.browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll transcription checks passed");
process.exit(failures ? 1 : 0);
