// The crowd: fake teammates for measuring what Proximity Office costs when the
// whole team is in. Each bot is a real browser running the real app, with a fake
// webcam (media/*.mjpeg: a person with sensor grain, not Chrome's test pattern)
// and a fake mic (speech with pauses). It signs in with the dev login, so it only
// runs against a non-production deployment (staging, or local `npm run dev`).
//
// One Railway container tops out around a dozen WebRTC browsers ("Target
// crashed" past that, with memory to spare), so the crowd is split: SLICES
// containers each run every SLICES-th bot, and all of them follow one clock
// (START_AT), so every phase has the whole crowd in place at the same moment.
// Each slice logs raw counters per phase; loadtest/aggregate.ts adds them up.
//
// What the bots *receive* is what the media server *sends* — the egress Railway
// bills — so the totals come straight from the bots' own WebRTC stats.
//
//   BOTS=60 SLICES=6 SLICE=0..5 START_AT=<ISO> BASE=https://… npx tsx crowd.ts

import { chromium, type Browser, type Page } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:5173";
const TOTAL = Number(process.env.BOTS ?? 20);
const SLICES = Number(process.env.SLICES ?? 1);
const SLICE = Number(process.env.SLICE ?? 0);
const CAM = process.env.CAM ?? "media/cam-typical.mjpeg";
const MIC = process.env.MIC ?? "media/mic.wav";
const PHASE_S = Number(process.env.PHASE_SECONDS ?? 180);
const WARMUP_S = Number(process.env.WARMUP_SECONDS ?? 45);
const JOIN_S = Number(process.env.JOIN_SECONDS ?? 90);
const START_AT = process.env.START_AT ? Date.parse(process.env.START_AT) : Date.now() + 30_000;
const PER_BROWSER = 5;
/** Comma list to run a subset, e.g. "desks20,meetings". The same on every slice. */
const ONLY = (process.env.PHASES ?? "").split(",").filter(Boolean);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Plain text, not a bare JSON line: Railway rewrites JSON log lines as key=value, which the reader can't parse back.
const log = (o: object) => console.log(`CROWD ${JSON.stringify({ t: new Date().toISOString(), slice: SLICE, ...o })}`);

interface Bot { g: number; page: Page }
const browsers: Browser[] = [];
const bots = new Map<number, Bot>(); // by global index
const mine = (g: number) => g % SLICES === SLICE;

async function browser(): Promise<Browser> {
  const b = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      // Docker's /dev/shm is 64 MB; Chrome tabs crash when it fills.
      "--disable-dev-shm-usage", "--disable-gpu",
      `--use-file-for-fake-video-capture=${CAM}`, `--use-file-for-fake-audio-capture=${MIC}`,
      "--autoplay-policy=no-user-gesture-required",
      // Screen share without a picker: the presenter shares its own tab.
      "--auto-accept-this-tab-capture", "--auto-select-tab-capture-source-by-title=Acme",
      // Bots in the background still have to act like a visible tab.
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    ],
  });
  browsers.push(b);
  return b;
}

let launching: Promise<Browser> | null = null;
async function browserFor(local: number) {
  const k = Math.floor(local / PER_BROWSER);
  while (!browsers[k]) {
    launching ??= browser().finally(() => (launching = null));
    await launching;
  }
  return browsers[k];
}

async function addBot(g: number, local: number) {
  for (let attempt = 1; ; attempt++) {
    try {
      const b = await browserFor(local);
      const ctx = await b.newContext({ viewport: { width: 1280, height: 760 }, permissions: ["camera", "microphone"] });
      await ctx.addInitScript(() => {
        localStorage.setItem("es.skipJoin", "1");
        localStorage.setItem("es.join.mic", "1");
        localStorage.setItem("es.join.cam", "0");
      });
      const page = await ctx.newPage();
      const n = String(g + 1).padStart(2, "0");
      await page.goto(`${BASE}/auth/dev?email=loadbot${n}@example.com&name=${encodeURIComponent(`Load Bot ${n}`)}`);
      await page.waitForFunction(() => (window as any).__es?.state?.me && (window as any).__es.room()?.state === "connected", null, { timeout: 60_000 });
      // The welcome and checklist would sit over the floor; a bot doesn't need them.
      await page.evaluate(() => fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ track: "member", dismiss: true }) }));
      bots.set(g, { g, page });
      return;
    } catch (e) {
      log({ botRetry: g + 1, attempt, why: String((e as Error).message ?? e).slice(0, 160) });
      if (attempt >= 3) throw e;
      await sleep(3000 * attempt);
    }
  }
}

/** This slice's share of the first n bots, joined two at a time. */
async function ensureBots(n: number) {
  const want = [...Array(n).keys()].filter((g) => mine(g) && !bots.has(g));
  for (let k = 0; k < want.length; k += 2) {
    await Promise.all(want.slice(k, k + 2).map((g) => addBot(g, Math.floor(g / SLICES))));
  }
}

type Spot = { x: number; y: number };
const ev = <T>(p: Page, fn: string) => p.evaluate(fn) as Promise<T>;

async function floorInfo(page: Page) {
  return ev<{ desks: (Spot & { roomId: string | null })[]; rooms: { id: string; name: string; kind: string; x: number; y: number; w: number; h: number }[] }>(page, `(() => {
    const f = __es.state.floor;
    const seat = (d) => ({ ...(d.seat ?? { x: d.x, y: d.y + (d.facing === "s" ? -40 : 40) }), roomId: d.roomId ?? null });
    return { desks: f.desks.map(seat), rooms: f.rooms.map((r) => ({ id: r.id, name: r.name, kind: r.kind, x: r.x, y: r.y, w: r.w, h: r.h })) };
  })()`);
}

async function place(b: Bot, at: Spot, cam: boolean, gallery = false, share = false) {
  await ev(b.page, `(async () => {
    __es.jump(${JSON.stringify({ x: at.x, y: at.y })});
    const lp = __es.room().localParticipant;
    if (lp.isCameraEnabled !== ${cam}) { await lp.setCameraEnabled(${cam}); __es.sock().emit("media", { cam: ${cam} }); }
    if (lp.isScreenShareEnabled !== ${share}) { await lp.setScreenShareEnabled(${share}).catch(() => {}); __es.sock().emit("media", { sharing: lp.isScreenShareEnabled }); }
  })()`);
  const open = await ev<boolean>(b.page, `Boolean(document.querySelector(".gallery"))`);
  if (gallery !== open) await b.page.keyboard.press("g");
}

/** Cumulative counters from one bot: what it receives (= media-server egress) and sends. */
const STATS = `(async () => {
  const r = __es.room();
  const out = { rxBytes: 0, rxVideoBytes: 0, rxAudioBytes: 0, txBytes: 0, lost: 0, recv: 0, jitter: [], freezes: 0, videoTracks: 0, heights: [] };
  for (const p of r.remoteParticipants.values()) for (const pub of p.trackPublications.values()) {
    if (!pub.track) continue;
    const rep = await pub.track.getRTCStatsReport?.();
    if (!rep) continue;
    rep.forEach((s) => {
      if (s.type !== "inbound-rtp") return;
      out.rxBytes += s.bytesReceived ?? 0;
      if (s.kind === "video") { out.rxVideoBytes += s.bytesReceived ?? 0; out.videoTracks++; if (s.frameHeight) out.heights.push(s.frameHeight); out.freezes += s.freezeCount ?? 0; }
      else out.rxAudioBytes += s.bytesReceived ?? 0;
      out.lost += s.packetsLost ?? 0; out.recv += s.packetsReceived ?? 0;
      if (s.jitter != null) out.jitter.push(s.jitter);
    });
  }
  for (const pub of r.localParticipant.trackPublications.values()) {
    const rep = await pub.track?.getRTCStatsReport?.();
    rep?.forEach((s) => { if (s.type === "outbound-rtp") out.txBytes += s.bytesSent ?? 0; });
  }
  return out;
})()`;

type S = { rxBytes: number; rxVideoBytes: number; rxAudioBytes: number; txBytes: number; lost: number; recv: number; jitter: number[]; freezes: number; videoTracks: number; heights: number[] };
const snap = async (active: Bot[]) => Promise.all(active.map((b) => ev<S>(b.page, STATS).catch(() => null)));

/** Raw counters for this slice; aggregate.ts adds the slices up. */
async function measure(name: string, active: Bot[], meta: object) {
  await sleep(WARMUP_S * 1000);
  const t0 = Date.now();
  const a = await snap(active);
  const tracks: number[] = [], heights: number[] = [], jitter: number[] = [];
  const end = t0 + PHASE_S * 1000;
  while (Date.now() < end - 10_000) {
    await sleep(10_000);
    const s = await snap(active);
    tracks.push(s.reduce((n, x) => n + (x?.videoTracks ?? 0), 0));
    heights.push(...s.flatMap((x) => x?.heights ?? []));
    jitter.push(...s.flatMap((x) => x?.jitter ?? []));
  }
  await sleep(Math.max(0, end - Date.now()));
  const b = await snap(active);
  const sum = (k: keyof S, arr: (S | null)[]) => arr.reduce((n, x) => n + ((x?.[k] as number) ?? 0), 0);
  const d = (k: keyof S) => sum(k, b) - sum(k, a);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : 0);
  log({
    result: name, bots: active.length, seconds: (Date.now() - t0) / 1000, from: new Date(t0).toISOString(), ...meta,
    rxBytes: d("rxBytes"), rxVideoBytes: d("rxVideoBytes"), rxAudioBytes: d("rxAudioBytes"), txBytes: d("txBytes"),
    lost: d("lost"), recv: d("recv"), freezes: d("freezes"),
    videoTracksAvg: avg(tracks), heightAvg: avg(heights), jitterAvgMs: avg(jitter) * 1000, crashed: b.filter((x) => !x).length,
  });
}

// ── Scenarios ───────────────────────────────────────────────────────────────

interface Phase { name: string; n: number; layout: (g: number) => { at: Spot; cam: boolean; gallery?: boolean; share?: boolean }; meta: object }

async function main() {
  log({ start: true, base: BASE, total: TOTAL, slices: SLICES, cam: CAM, startAt: new Date(START_AT).toISOString() });
  const first = [...Array(TOTAL).keys()].find(mine)!;
  await addBot(first, 0);
  const f = await floorInfo(bots.get(first)!.page);
  const byArea = [...f.rooms].sort((a, b) => b.w * b.h - a.w * a.h);
  const open = f.rooms.find((r) => r.id === "engineering") ?? byArea[0];
  // Cameras are room-wide only in meeting rooms and offices (media.ts seesVideo); team rooms are desk-radius.
  const meetingRooms = [...byArea.filter((r) => r.kind === "meeting"), ...byArea.filter((r) => r.kind === "office")].slice(0, 3);
  const openDesks = f.desks.filter((d) => d.roomId === open.id);
  const inRoom = (r: { x: number; y: number; w: number; h: number }, k: number, n: number): Spot => {
    const cols = Math.ceil(Math.sqrt(n));
    const row = Math.floor(k / cols), col = k % cols;
    return { x: Math.round(r.x + (r.w * (col + 1)) / (cols + 1)), y: Math.round(r.y + (r.h * (row + 1)) / (Math.ceil(n / cols) + 1)) };
  };
  const desk = (g: number) => f.desks[(g * 7) % f.desks.length]; // spread across the floor, like a normal day
  const ts = Math.min(25, openDesks.length, TOTAL);

  const all: Phase[] = [
    ...[20, 40, 60].filter((n) => n <= TOTAL).map((n) => ({ name: `desks${n}`, n, layout: (g: number) => ({ at: desk(g), cam: g % 2 === 0 }), meta: { camerasOn: Math.ceil(n / 2) } })),
    { name: "techsupport", n: TOTAL, layout: (g) => (g < ts ? { at: openDesks[g], cam: g % 2 === 0 } : { at: desk(g), cam: false }),
      meta: { room: open.name || open.id, atItsDesks: ts, camerasOn: Math.ceil(ts / 2) } },
    { name: "meetings", n: TOTAL, layout: (g) => (Math.floor(g / 6) < meetingRooms.length ? { at: inRoom(meetingRooms[Math.floor(g / 6)], g % 6, 6), cam: true } : { at: desk(g), cam: false }),
      meta: { rooms: meetingRooms.map((r) => r.name || r.id), perRoom: 6, camerasOn: Math.min(18, TOTAL) } },
    { name: "presenting", n: TOTAL, layout: (g) => (g < 8 ? { at: inRoom(meetingRooms[0], g, 8), cam: true, gallery: g > 0, share: g === 0 } : { at: desk(g), cam: false }),
      meta: { room: meetingRooms[0].name || meetingRooms[0].id, inRoom: 8, camerasOn: 8 } },
  ];
  const phases = all.filter((p) => !ONLY.length || ONLY.includes(p.name));
  const STEP = (JOIN_S + WARMUP_S + PHASE_S + 15) * 1000;
  log({ floor: true, openRoom: open.id, openDesks: openDesks.length, meetingRooms: meetingRooms.map((r) => r.id), schedule: phases.map((p, k) => `${p.name}@${new Date(START_AT + k * STEP).toISOString().slice(11, 19)}`) });

  for (const [k, p] of phases.entries()) {
    const at = START_AT + k * STEP;
    if (Date.now() > at + JOIN_S * 1000) { log({ skipped: p.name, why: "behind schedule" }); continue; }
    await sleep(Math.max(0, at - Date.now()));
    await ensureBots(p.n);
    const active = [...bots.values()].filter((b) => b.g < p.n);
    await Promise.all(active.map((b) => { const l = p.layout(b.g); return place(b, l.at, l.cam, l.gallery, l.share).catch(() => {}); }));
    // Everyone settles into place before the warm-up starts, on every slice at once.
    await sleep(Math.max(0, at + JOIN_S * 1000 - Date.now()));
    await measure(p.name, active, p.meta);
  }
  log({ done: true });
}

main()
  .catch((e) => log({ error: String(e?.stack ?? e) }))
  .finally(async () => {
    for (const b of browsers) await b.close().catch(() => {});
    process.exit(0);
  });
