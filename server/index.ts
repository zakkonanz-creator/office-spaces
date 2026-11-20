// Office Spaces server: one process serves the SPA, the API, the Socket.IO
// office, and the Fathom webhook. LiveKit (the media server) is separate.

import "./env";
import { sinceOf } from "./tenure";
import { postAward, checkWins, fillWinImages } from "./wins";
import { backfillWelcome, award, breakdown, eggsFound, leaderboard, recentLedger } from "./points";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { Server } from "socket.io";
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import { config, assertConfig } from "./config";
import { openDb, one, q, getSetting, setSetting } from "./db";
import { currentVersion, floorAt, floorVersions, geometryShift, loadFloor, saveFloorVersion, setRoomName, takeGeometry } from "./floorStore";
import type { Floor } from "../shared/floor";
import { design, getDraft, handDraft } from "./designer";
import { checkFloor } from "../shared/floorCheck";
import { fixSeats } from "../shared/seatFix";
import { migrateTime } from "./time/db";
import { applyPendingDeputy } from "./time/deputy";
import { accrueLeave } from "./time/accrual";
import { registerTimeRoutes } from "./time/routes";
import { migratePayroll } from "./payroll/schema";
import { registerPayroll } from "./payroll/routes";
import { isPayrollAdmin } from "./payroll/grants";
import { addWin, registerJumbotron, startJumbotron } from "./jumbotron";
import { migratePreassign, registerPreassign } from "./preassign";
import { migrateTranscripts, registerTranscribe, usage as transcribeUsage } from "./transcribe";
import { registerFeedback } from "./feedback";
import { migrateOnboarding, registerOnboarding, roleChanged, progress, type Onboarding } from "./onboarding";
import {
  COOKIE, OAUTH_COOKIE, domainAllowed, exchange, googleAuthUrl, guestLink, newGuestKey, newNonce, safeNext, seal, sessionCookie,
  fillSlackProfiles, upsertUser, verify, viewerFrom, LinkExpired, lkId, nameMatches as nameMatchesUser, type GoogleState, type Viewer,
} from "./auth";
import { attach, broadcastFloor, shiftPeople, connectedGuestInvites, guestLkIds, liveLkIds, floor, kickUser, onlineCount, peopleInRoom, personById, revokeGuests, roomRecording, setCalendarLinked, setRecording, updateUser, busyPool, onDoorClosed, tellPerson, pointsChanged, ringWin } from "./office";
import { normalizeGhlUrl, parsePool, parseRoomLinks, pickRoom, type PoolRoom } from "../shared/ghlRooms";
import { startFathomMeeting, MeetingError } from "./meetings";
import { handleFathom, verifyFathom } from "./fathom";
import { analytics, toCsv } from "./analytics";
import { runBackup, scheduleBackups } from "./backup";
import { AUDIO_RANGES, guestFloor } from "../shared/floor";
import type { C2S, S2C } from "../shared/protocol";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// A bug in one handler must never take the office down for everyone.
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e));
process.on("uncaughtException", (e) => console.error("uncaught exception:", e));

assertConfig();
await openDb();
await loadFloor();
// The layout file can change between releases (e.g. a re-imported floor):
// seats that no longer exist are cleared, and their people re-seated at their
// roster desk in the new layout.
await unseatMissingDesks();
await reseatFromRoster();
await migratePayroll(); // grants (who manages which team), audit log, and the tables time tracking checks (server/payroll)
await migrateTime(); // Time & Payroll: clock, shifts, leave (server/time)
await migratePreassign(); // access set up for an email before its first sign-in (needs grants + locations)
await migrateOnboarding(); // getting-started checklist + admin tour progress
await migrateTranscripts(); // "Transcribe this room": clips, transcripts, notes
// Deputy imports waiting on a timezone: the office sets it on join too, so sweep now and hourly.
const deputySweep = () => applyPendingDeputy().catch((e) => console.error("deputy apply", e));
void deputySweep();
// Slack photos and ids for anyone added before the office had a Slack token (and new Slack joiners).
const slackFill = () => fillSlackProfiles().then((n) => n && console.log(`slack: filled ${n} profiles`)).catch((e) => console.error("slack fill", e));
void slackFill();
// The win bell: new #wins posts ring softly in the office (server/wins.ts).
const winsTick = () => checkWins().then(() => fillWinImages()).catch((e) => console.error("wins", e));
setInterval(winsTick, 60_000).unref();
void winsTick();
// After the migrations have run: the welcome bonus for people who arrived before it existed (once each; see backfillWelcome).
setTimeout(() => void backfillWelcome().then((n) => n && console.log(`points: welcome bonus backfilled for ${n}`)).catch((e) => console.error("welcome backfill", e)), 20_000).unref();
setInterval(slackFill, 6 * 3600_000).unref();
setInterval(deputySweep, 3600_000).unref();
// Leave accrual: on the 1st, last month's share of everyone's yearly entitlement (once per month, however often this runs).
const accrual = () => accrueLeave().then((n) => n && console.log(`leave: accrued ${n} balances`)).catch((e) => console.error("leave accrual", e));
void accrual();
setInterval(accrual, 3600_000).unref();

const app = Fastify({
  logger: {
    level: config.production ? "info" : "warn",
    // Never log query strings or the path tail of guest links: they carry
    // one-time OAuth codes, OAuth state and invite tokens.
    serializers: {
      req: (req) => ({ method: req.method, url: req.url.split("?")[0].replace(/^\/(g|api\/guest)\/.+/, "/$1/…") }),
    },
  },
  trustProxy: true,
});
await app.register(cookie);

// ── Helpers ────────────────────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyRequest { viewer: Viewer | null }
}
app.decorateRequest("viewer", null);
// One address: anything reaching the office on another host (the old *.up.railway.app one,
// once PUBLIC_BASE_URL is the custom domain) is sent to the same path there. The
// office only accepts sockets from its own host, so without this old links would
// load a page that can't connect. /health (the watchdog) and webhooks are left alone.
const home = new URL(config.publicUrl);
app.addHook("onRequest", async (req, reply) => {
  if (!config.production || req.method !== "GET") return;
  // Host only: Railway keeps the original one, and X-Forwarded-Host is the client's to spoof.
  const host = String(req.headers.host ?? "").trim().toLowerCase();
  if (!host || host === home.host || req.url === "/health" || req.url.startsWith("/health?") || req.url.startsWith("/webhooks/")) return;
  if (!host.endsWith(".up.railway.app")) return; // only our own Railway address; never bounce an unknown host
  // Temporary and uncached while the domain settles, so falling back to the Railway address stays possible.
  reply.header("cache-control", "no-store");
  return reply.redirect(`${home.origin}${req.url}`, 302);
});

app.addHook("onRequest", async (req) => {
  // Only routes that act on who you are. Scripts, images, the page shell and /health
  // skip the users lookup, so a 9am rush of page loads doesn't queue on the DB pool.
  if (!/^\/(api|auth)\//.test(req.url)) return;
  req.viewer = await viewerFrom(req.cookies[COOKIE]);
});

/** Browser errors (web/src/clientErrors.ts) → the server log, with who saw them. Capped per person. */
const clientErrorCount = new Map<string, { n: number; since: number }>();
app.post("/api/client-error", async (req, reply) => {
  const v = req.viewer;
  if (!v) return reply.code(204).send();
  const who = v.kind === "user" ? v.user.name : `guest ${v.name}`;
  const key = v.kind === "user" ? `u${v.user.id}` : `g${v.inviteId}`;
  const c = clientErrorCount.get(key);
  const now = Date.now();
  if (!c || now - c.since > 3600_000) clientErrorCount.set(key, { n: 1, since: now });
  else if (++c.n > 30) return reply.code(204).send();
  const b = (req.body ?? {}) as Record<string, unknown>;
  const s = (x: unknown, n: number) => String(x ?? "").replace(/[\u0000-\u001f]+/g, " ").slice(0, n);
  console.error(`client error · ${who} · ${s(b.where, 20)} · ${s(b.bundle, 40)} · ${s(b.path, 40)}${b.visible === false ? " (tab hidden)" : ""}: ${s(b.message, 300)}\n  ${s(b.stack, 1200).replace(/ at /g, "\n   at ")}`);
  return reply.code(204).send();
});

const needUser = (req: FastifyRequest, reply: FastifyReply) => {
  if (req.viewer?.kind !== "user") {
    reply.code(401).send({ error: "sign in" });
    return null;
  }
  return req.viewer.user;
};
const needAdmin = (req: FastifyRequest, reply: FastifyReply) => {
  const u = needUser(req, reply);
  if (u && u.role !== "admin") {
    reply.code(403).send({ error: "admins only" });
    return null;
  }
  return u;
};
// The linked Drive account writes the nightly backup, and that backup is every table,
// pay included. So linking it (and running the backup) is for payroll admins only.
const DRIVE_PAYROLL_ONLY = "Only a payroll admin can link Drive or run the backup: the nightly backup holds pay data.";
const needPayrollAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
  const u = needUser(req, reply);
  if (!u) return null;
  if (u.removed || !(await isPayrollAdmin(u.id))) {
    reply.code(403).send({ error: DRIVE_PAYROLL_ONLY });
    return null;
  }
  return u;
};
registerTimeRoutes(app, needUser); // /api/time/* — no LiveKit dependency
await registerPayroll(app); // /api/payroll/me and /api/payroll/grants: who manages which team (time admins only)
registerJumbotron(app, needUser, needAdmin); // /api/jumbotron — teammates only (client names on it)
registerPreassign(app, needAdmin); // /api/admin/preassigned — roles waiting for a first sign-in
registerOnboarding(app, needUser); // /api/onboarding — getting started + the admin tour
registerFeedback(app, needUser, needAdmin); // /api/feedback, /api/admin/feedback, /api/agent/feedback — the Report button
registerTranscribe(app, needUser); // /api/rooms/:id/transcribe, /api/transcripts — room notes via the Whisper service

const startOAuth = (reply: FastifyReply, flow: "login" | "calendar" | "drive", next: string, uid?: number) => {
  const nonce = newNonce();
  reply.setCookie(OAUTH_COOKIE, nonce, { path: "/auth", httpOnly: true, sameSite: "lax", secure: config.production, maxAge: 600 });
  reply.redirect(googleAuthUrl(flow, next, nonce, uid));
};

// ── Health ─────────────────────────────────────────────────────────────────

app.get("/health", async () => {
  await q("SELECT 1");
  return { ok: true, online: onlineCount() };
});

// ── Sign-in ────────────────────────────────────────────────────────────────

app.get("/auth/google", async (req, reply) => {
  if (!config.google.login.id) return reply.redirect("/?signin=not-configured");
  startOAuth(reply, "login", safeNext((req.query as any).next));
});

app.get("/auth/calendar", async (req, reply) => {
  const u = needUser(req, reply);
  if (u) startOAuth(reply, "calendar", safeNext((req.query as any).next), u.id);
});

app.get("/auth/drive", async (req, reply) => {
  const u = await needPayrollAdmin(req, reply);
  if (u) startOAuth(reply, "drive", "/admin/settings", u.id);
});

app.get("/auth/google/callback", async (req, reply) => {
  const { code, state, error } = req.query as Record<string, string>;
  const st = verify<GoogleState & { exp: number }>("oauth", state);
  const nonce = req.cookies[OAUTH_COOKIE];
  reply.clearCookie(OAUTH_COOKIE, { path: "/auth" });
  if (error) return reply.redirect(`/?signin=${encodeURIComponent(error === "access_denied" ? "access_denied" : "failed")}`);
  if (!code || !st || !nonce || st.nonce !== nonce) return reply.redirect("/?signin=expired");
  st.n = safeNext(st.n);
  try {
    const tok = await exchange(st.f, code);
    const email = tok.info.email?.toLowerCase() ?? "";
    if (st.f === "login") {
      if (!email || tok.info.email_verified === false) return reply.redirect("/?signin=unverified");
      if (!domainAllowed(email)) return reply.redirect(`/?signin=domain&email=${encodeURIComponent(email)}`);
      const existing = await one(`SELECT removed FROM users WHERE email = $1`, [email]);
      if (existing?.removed) return reply.redirect("/?signin=removed");
      const user = await upsertUser(email, tok.info.name || email.split("@")[0], tok.info.picture);
      const c = sessionCookie({ u: user.id, v: (user as { session_version?: number }).session_version ?? 0 });
      reply.setCookie(COOKIE, c.value, c.options);
      return reply.redirect(st.n);
    }
    // Calendar / Drive linking must be the same person who started it.
    const me = req.viewer?.kind === "user" ? req.viewer.user : null;
    if (!me || me.id !== st.u) return reply.redirect("/?signin=expired");
    if (!tok.refresh_token) return reply.redirect(`${st.n}?link=no-refresh-token`);
    if (st.f === "calendar") {
      if (email !== me.email) return reply.redirect(`${st.n}?link=wrong-account&email=${encodeURIComponent(email)}`);
      await q(`UPDATE users SET google_refresh_token = $1 WHERE id = $2`, [seal(tok.refresh_token), me.id]);
      setCalendarLinked(me.id);
      return reply.redirect(`${st.n}?link=calendar`);
    }
    // Checked again here: access could have changed while they were at Google.
    if (!(await isPayrollAdmin(me.id))) return reply.redirect("/admin/settings?link=payroll-only");
    await setSetting("driveRefreshToken", seal(tok.refresh_token));
    await setSetting("driveAccount", email);
    return reply.redirect("/admin/settings?link=drive");
  } catch (e) {
    req.log.error(e);
    return reply.redirect("/?signin=failed");
  }
});

app.get("/auth/dev", async (req, reply) => {
  if (!config.devLogin || config.production) return reply.code(404).send();
  const { email, name } = req.query as Record<string, string>;
  if (!email || !domainAllowed(email)) return reply.code(400).send({ error: "email on an allowed domain required" });
  const user = await upsertUser(email, name || email.split("@")[0]);
  const c = sessionCookie({ u: user.id, v: (user as { session_version?: number }).session_version ?? 0 });
  reply.setCookie(COOKIE, c.value, c.options);
  reply.redirect("/");
});

// Local testing only: wipe your awarded points (the test suites start each run from here).
app.post("/api/dev/points/reset", async (req, reply) => {
  if (!config.devLogin || config.production) return reply.code(404).send();
  const u = needUser(req, reply);
  if (!u) return;
  await q(`DELETE FROM points_ledger WHERE user_id = $1`, [u.id]);
  await pointsChanged(u.id);
  return { ok: true };
});

// Local testing only: give yourself points (to see the unlock card).
app.post("/api/dev/points", async (req, reply) => {
  if (!config.devLogin || config.production) return reply.code(404).send();
  const u = needUser(req, reply);
  if (!u) return;
  const pts = Math.round(Number((req.body as any)?.points) || 0);
  await award(u.id, "grant", pts, "Dev test", null, u.id);
  await pointsChanged(u.id);
  return { ok: true };
});

// Local testing only: ring the win bell as if someone posted in #wins.
app.post("/api/dev/win", async (req, reply) => {
  if (!config.devLogin || config.production) return reply.code(404).send();
  const b = (req.body ?? {}) as { name?: string; text?: string; png?: string };
  const text = b.text ?? "Closed the Smith deal, 12 months upfront!";
  // `png` (base64): a screenshot post, like most real #wins posts.
  const img = b.png ? (await one<{ id: number }>(`INSERT INTO win_images (ts, mime, bytes) VALUES ($1, 'image/png', $2) RETURNING id`, [`dev-${Date.now()}`, Buffer.from(b.png, "base64")]))?.id ?? null : null;
  ringWin(b.name || "Morgan Lee", text, img);
  await addWin(b.name || "Morgan Lee", text, Date.now(), { img });
  return { ok: true, img };
});

// Local testing only: pretend a Fathom meeting started in a room (no Google needed).
app.post("/api/dev/recording", async (req, reply) => {
  if (!config.devLogin || config.production) return reply.code(404).send();
  const u = needUser(req, reply);
  if (!u) return;
  const { roomId, meetUrl } = (req.body ?? {}) as { roomId: string; meetUrl: string };
  setRecording(roomId, { by: String(u.id), byName: u.name, meetUrl, startedAt: Date.now() });
  return { ok: true };
});

app.post("/auth/logout", async (req, reply) => {
  // Signing out ends every session (other browsers, a lost laptop), not just this cookie.
  if (req.viewer?.kind === "user") await q(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [req.viewer.user.id]);
  reply.clearCookie(COOKIE, { path: "/" });
  return { ok: true };
});

// ── Guests ─────────────────────────────────────────────────────────────────

app.get("/api/guest/:token", async (req, reply) => {
  const t = verify<{ i: number; exp?: number }>("guest-link", (req.params as any).token);
  const inv = t && (await one(`SELECT * FROM guest_invites WHERE id = $1`, [t.i]));
  if (!inv || inv.revoked || (inv.expires_at && new Date(inv.expires_at) < new Date())) return reply.code(410).send({ error: "This invite link has expired." });
  const room = floor.rooms.find((r) => r.id === inv.room_id);
  return { label: inv.label, room: room?.name || "a room" };
});

app.post("/api/guest/:token", async (req, reply) => {
  const t = verify<{ i: number; exp?: number }>("guest-link", (req.params as any).token);
  const name = String((req.body as any)?.name ?? "").trim().slice(0, 40);
  const inv = t && (await one(`SELECT * FROM guest_invites WHERE id = $1`, [t.i]));
  if (!inv || inv.revoked || (inv.expires_at && new Date(inv.expires_at) < new Date())) return reply.code(410).send({ error: "This invite link has expired." });
  if (!name) return reply.code(400).send({ error: "Tell us your name" });
  const c = sessionCookie({ g: inv.id, n: `${name} (guest)`, k: newGuestKey() }, 1);
  reply.setCookie(COOKIE, c.value, c.options);
  return { ok: true };
});

// ── The office ─────────────────────────────────────────────────────────────

app.get("/api/me", async (req) => {
  const v = req.viewer;
  if (!v) return { signedIn: false, devLogin: config.devLogin && !config.production };
  if (v.kind === "guest") return { signedIn: true, guest: true, name: v.name };
  return { signedIn: true, guest: false, name: v.user.name, role: v.user.role, email: v.user.email };
});

app.get("/api/floor", async (req, reply) => {
  if (!req.viewer) return reply.code(401).send({ error: "sign in" });
  // Guests get the layout without the staff directory or the office's internal links.
  return req.viewer.kind === "guest" ? guestFloor(floor, req.viewer.roomId) : floor;
});

/** Who sits where, for desk nameplates. Unclaimed desks fall back to the roster name in the floor file. */
app.get("/api/desks", async (req, reply) => {
  if (!needUser(req, reply)) return;
  return q(`SELECT desk_id, name, title FROM users WHERE desk_id IS NOT NULL AND NOT removed`);
});

/** Claim a free desk (people who weren't on the roster when the floor was generated). */
app.post("/api/desks/:deskId/claim", async (req, reply) => {
  const u = needUser(req, reply);
  if (!u) return;
  const deskId = (req.params as any).deskId as string;
  const desk = floor.desks.find((d) => d.id === deskId);
  if (!desk) return reply.code(404).send({ error: "no such desk" });
  // Roster desks are saved for their person; an admin can reassign them in Members.
  if (desk.owner && !nameMatchesUser(u.name, desk.owner) && u.role !== "admin") return reply.code(403).send({ error: `That desk is saved for ${desk.owner}. Ask an admin to reassign it.` });
  const taken = await one(`SELECT id FROM users WHERE desk_id = $1`, [deskId]);
  if (taken && taken.id !== u.id) return reply.code(409).send({ error: "That desk is taken." });
  // Two people clicking the same free desk at once: the unique index decides, the loser gets a clear answer.
  try {
    await q(`UPDATE users SET desk_id = $1 WHERE id = $2`, [deskId, u.id]);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return reply.code(409).send({ error: "Someone just took that desk." });
    throw e;
  }
  updateUser(u.id, { deskId });
  return { ok: true };
});

app.post("/api/livekit-token", async (req, reply) => {
  const v = req.viewer;
  if (!v) return reply.code(401).send({ error: "sign in" });
  const identity = lkId(v.kind === "user" ? String(v.user.id) : `g:${v.inviteId}:${v.key}`);
  // No name and an opaque identity: LiveKit lists every participant to everyone
  // in the room, guests included. Names come from the office server instead.
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity,
    ttl: v.kind === "user" ? "12h" : "2h",
  });
  const sources = [TrackSource.MICROPHONE, TrackSource.CAMERA];
  if (v.kind === "user" || v.canPresent) sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  at.addGrant({ roomJoin: true, room: floor.id, canPublish: true, canSubscribe: true, canPublishData: false, canPublishSources: sources });
  return { token: await at.toJwt(), url: config.livekit.url };
});

app.post("/api/rooms/:roomId/fathom", async (req, reply) => {
  const u = needUser(req, reply);
  if (!u) return;
  const roomId = (req.params as any).roomId as string;
  const room = floor.rooms.find((r) => r.id === roomId);
  if (!room) return reply.code(404).send({ error: "no such room" });
  const inside = peopleInRoom(roomId);
  if (!inside.some((p) => p.id === String(u.id))) return reply.code(403).send({ error: "You need to be in the room to record it." });
  if (!u.google_refresh_token) return reply.code(409).send({ error: "calendar-not-linked", link: `/auth/calendar?next=/` });
  if (roomRecording(roomId) || starting.has(roomId)) return reply.code(409).send({ error: "This room is already being recorded." });
  starting.add(roomId);
  try {
    const emails = inside.map((p) => p.email).filter((e): e is string => Boolean(e));
    const m = await startFathomMeeting(u, roomId, room.name || "Room meeting", emails);
    setRecording(roomId, { by: String(u.id), byName: u.name, meetUrl: m.meetUrl, startedAt: Date.now() });
    return { meetUrl: m.meetUrl, autoRecord: m.autoRecord };
  } catch (e) {
    if (e instanceof LinkExpired || (e instanceof MeetingError && e.message === "calendar-not-linked")) {
      await q(`UPDATE users SET google_refresh_token = NULL WHERE id = $1`, [u.id]);
      return reply.code(409).send({ error: "calendar-not-linked", link: `/auth/calendar?next=/` });
    }
    req.log.error(e);
    return reply.code(502).send({ error: (e as Error).message });
  } finally {
    starting.delete(roomId);
  }
});
const starting = new Set<string>();

// ── Start meeting (GHL Meeting Rooms) ─────────────────────────────────────
// Your own room if you saved one, else a free shared room from Admin → Settings.
// Everyone else in the room (members only) gets a Join prompt.

app.get("/api/me/ghl-room", async (req, reply) => {
  const u = needUser(req, reply);
  if (!u) return;
  return { url: await ownRoom(u.id), sharedRooms: (await getSetting<PoolRoom[]>("ghlRooms", [])).length };
});

app.put("/api/me/ghl-room", async (req, reply) => {
  const u = needUser(req, reply);
  if (!u) return;
  const raw = String((req.body as any)?.url ?? "").trim();
  const url = raw ? normalizeGhlUrl(raw) : null;
  if (raw && !url) return reply.code(400).send({ error: "That isn't a GHL Meeting Room link. It looks like https://crm.example.com/meet/your-name?pwd=…" });
  await q(`UPDATE users SET ghl_room_url = $1 WHERE id = $2`, [url, u.id]);
  return { url };
});

const startingMeeting = new Set<string>();

// ── Names ──────────────────────────────────────────────────────────────────
// Everyone can change the name the office shows (e.g. "Margaret Smith" goes by Maggie S.).
// It's only set from Google on the first sign-in, so a change sticks. Admins can change anyone's.

/** A clean display name, or an error message. */
export function cleanName(raw: unknown): { name: string } | { error: string } {
  const name = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!name) return { error: "Your name can't be empty." };
  if (name.length > 60) return { error: "Keep it to 60 characters." };
  return { name };
}

async function rename(id: number, raw: unknown): Promise<{ name: string } | { error: string } | null> {
  const c = cleanName(raw);
  if ("error" in c) return c;
  const r = await one<{ name: string }>(`UPDATE users SET name = $2 WHERE id = $1 AND NOT removed RETURNING name`, [id, c.name]);
  if (!r) return null;
  updateUser(id, { name: r.name });
  return r;
}

app.put("/api/me/name", async (req, reply) => {
  const u = needUser(req, reply);
  if (!u) return;
  const r = await rename(u.id, (req.body as any)?.name);
  if (!r) return reply.code(404).send({ error: "no such member" });
  if ("error" in r) return reply.code(400).send(r);
  return r;
});

/** Your own room: the link you saved, else the one an admin imported for your email. */
async function ownRoom(userId: number) {
  const u = await one<{ ghl_room_url: string | null; email: string }>(`SELECT ghl_room_url, email FROM users WHERE id = $1`, [userId]);
  if (u?.ghl_room_url) return u.ghl_room_url;
  const imported = await getSetting<Record<string, string>>("ghlRoomLinks", {});
  return (u && imported[u.email.toLowerCase()]) || null;
}

/** Pick a GHL room for this person and start the room's meeting (everyone else in it is asked to join). */
async function startGhlMeeting(userId: number, name: string, roomId: string) {
  const pick = pickRoom(await ownRoom(userId), await getSetting<PoolRoom[]>("ghlRooms", []), busyPool());
  if (pick.ok) setRecording(roomId, { kind: "ghl", by: String(userId), byName: name, meetUrl: pick.url, label: pick.label, pool: pick.pool, startedAt: Date.now() });
  return pick;
}

// Closing a door can start the meeting too (Admin → Settings: off, meeting rooms, or every room with a door).
// The person who closed it goes straight in; everyone else in the room gets the Join prompt.
onDoorClosed(async ({ roomId, kind, personId, userId, name }) => {
  const scope = await getSetting<"off" | "meeting" | "all">("autoMeetOnClose", "meeting");
  if (scope === "off" || (scope === "meeting" && kind !== "meeting")) return;
  if (roomRecording(roomId) || startingMeeting.has(roomId)) return;
  startingMeeting.add(roomId);
  try {
    const pick = await startGhlMeeting(userId, name, roomId);
    if (pick.ok) tellPerson(personId, "meetingStarted", { roomId, meetUrl: pick.url, byName: name, kind: "ghl", label: pick.pool === null ? "Meeting" : pick.label, auto: true });
    // No rooms set up at all: closing a door just closes the door, no nagging.
    else if (pick.reason === "all-busy") tellPerson(personId, "toast", { text: "Door closed. Every shared meeting room is in use, so no meeting started." });
  } catch (e) {
    app.log.warn({ err: e }, "auto meeting on door close failed");
  } finally {
    startingMeeting.delete(roomId);
  }
});

app.post("/api/rooms/:roomId/meeting", async (req, reply) => {
  const u = needUser(req, reply);
  if (!u) return;
  const roomId = (req.params as any).roomId as string;
  const room = floor.rooms.find((r) => r.id === roomId);
  if (!room) return reply.code(404).send({ error: "no such room" });
  if (!peopleInRoom(roomId).some((p) => p.id === String(u.id))) return reply.code(403).send({ error: "You need to be in the room to start its meeting." });
  const running = roomRecording(roomId);
  if (running) return reply.code(409).send({ error: "This room already has a meeting.", url: running.meetUrl, label: running.label ?? null });
  if (startingMeeting.has(roomId)) return reply.code(409).send({ error: "A meeting is starting in this room." });
  startingMeeting.add(roomId);
  try {
    const pick = await startGhlMeeting(u.id, u.name, roomId);
    if (!pick.ok) {
      return reply.code(409).send({
        error: pick.reason === "all-busy" ? "All the shared meeting rooms are in use. Add your own GHL Meeting Room, or try again in a bit." : "No meeting room yet. Add your own GHL Meeting Room link.",
        reason: pick.reason,
      });
    }
    return { url: pick.url, label: pick.label, own: pick.pool === null };
  } finally {
    startingMeeting.delete(roomId);
  }
});

/** Revoked or expired invite: out of the office and out of the call, now. */
const livekitAdmin = () => new RoomServiceClient(config.livekit.url.replace(/^ws/, "http"), config.livekit.apiKey, config.livekit.apiSecret);
async function dropGuests(inviteId: number, reason: string) {
  const ids = guestLkIds(inviteId);
  revokeGuests(inviteId, reason);
  try {
    const lk = livekitAdmin();
    for (const identity of ids) await lk.removeParticipant(floor.id, identity).catch(() => {});
  } catch (e) {
    app.log.warn({ err: e }, "could not remove guest from LiveKit");
  }
}

// Anyone in the call without a live office connection (a revoked guest whose
// removal failed, a tampered client) is removed. 30 s grace covers the normal
// gap between a socket reconnecting and its LiveKit session catching up.
setInterval(async () => {
  try {
    const live = liveLkIds();
    const lk = livekitAdmin();
    for (const p of await lk.listParticipants(floor.id)) {
      const age = Date.now() / 1000 - Number(p.joinedAt ?? 0);
      if (!live.has(p.identity) && age > 30) await lk.removeParticipant(floor.id, p.identity).catch(() => {});
    }
  } catch {
    /* LiveKit unreachable: the watchdog reports that */
  }
}, 60_000).unref();
setInterval(async () => {
  try {
    for (const id of connectedGuestInvites()) {
      const inv = await one(`SELECT revoked, expires_at FROM guest_invites WHERE id = $1`, [id]);
      if (!inv || inv.revoked || (inv.expires_at && new Date(inv.expires_at) < new Date())) await dropGuests(id, "This invite link has expired.");
    }
  } catch (e) {
    app.log.warn({ err: e }, "guest expiry sweep failed");
  }
}, 60_000).unref();

// ── Points (shared/points.ts) ─────────────────────────────────────────────
/** May this person give points by hand? (config.pointGivers; admin isn't enough on its own.) */
const canGivePoints = (u: { email: string }) => config.pointGivers.has(u.email.toLowerCase());
const needGiver = (req: FastifyRequest, reply: FastifyReply) => {
  const u = needUser(req, reply);
  if (!u) return null;
  if (!canGivePoints(u)) { reply.code(403).send({ error: "Only the people in POINT_GIVERS (or ADMIN_EMAILS) can give points." }); return null; }
  return u;
};

app.get("/api/points", async (req, reply) => {
  const u = needUser(req, reply);
  if (!u) return;
  const [mine, board, eggs] = await Promise.all([breakdown(u.id, sinceOf(u)), leaderboard(10), eggsFound(u.id)]);
  return { ...mine, eggs, leaderboard: board.top, highfives: board.highfives, canGive: canGivePoints(u) };
});

/** Everyone a giver can pick (the office's Give points form). */
app.get("/api/points/people", async (req, reply) => {
  const u = needGiver(req, reply);
  if (!u) return;
  return q(`SELECT id, name FROM users WHERE NOT removed AND id <> $1 ORDER BY name`, [u.id]);
});

app.get("/api/admin/points", async (req, reply) => {
  if (!needAdmin(req, reply)) return;
  const [recent, board] = await Promise.all([recentLedger(80), leaderboard(200)]);
  return { recent, everyone: board.top };
});

// Award (or take back) points for anything work-related. Shows up in their total right away.
// Only the givers (config.pointGivers), never to yourself.
async function givePoints(req: FastifyRequest, reply: FastifyReply) {
  const admin = needGiver(req, reply);
  if (!admin) return;
  const b = (req.body ?? {}) as { userId?: number; points?: number; reason?: string; post?: boolean };
  const pts = Math.round(Number(b.points));
  const reason = String(b.reason ?? "").trim();
  if (!Number.isFinite(pts) || pts === 0 || Math.abs(pts) > 10000) return reply.code(400).send({ error: "Points must be a whole number between -10,000 and 10,000 (not 0)." });
  if (!reason) return reply.code(400).send({ error: "Say what it's for: the reason is shown to them." });
  const target = await one<{ id: number; name: string; slack_id: string | null }>(`SELECT id, name, slack_id FROM users WHERE id = $1 AND NOT removed`, [Number(b.userId)]);
  if (!target) return reply.code(404).send({ error: "no such member" });
  if (target.id === admin.id) return reply.code(400).send({ error: "You can't give points to yourself." });
  await award(target.id, "grant", pts, reason, null, admin.id);
  await pointsChanged(target.id, pts > 0 ? `⭐ +${pts} points from ${admin.name.split(" ")[0]}: ${reason}` : `${pts} points (${reason})`);
  // An award goes up in #wins, like any win: the post, the office bell, the jumbotron.
  // Not a deduction, and not when the admin unticks "Post in #wins".
  let posted = false;
  if (pts > 0 && b.post !== false) {
    posted = await postAward({ toName: target.name, toSlackId: target.slack_id, byName: admin.name, points: pts, reason });
    const text = `+${pts.toLocaleString("en-US")} points from ${admin.name.split(" ")[0]}: ${reason}`;
    ringWin(target.name, text);
    await addWin(target.name, text);
  }
  return { ok: true, posted };
}
app.post("/api/admin/points", givePoints);
app.post("/api/points/award", givePoints);

app.delete("/api/admin/points/:id", async (req, reply) => {
  if (!needGiver(req, reply)) return;
  const r = await one<{ user_id: number }>(`DELETE FROM points_ledger WHERE id = $1 AND kind IN ('grant', 'win') RETURNING user_id`, [Number((req.params as any).id)]);
  if (!r) return reply.code(404).send({ error: "Only admin awards and #wins points can be removed." });
  await pointsChanged(r.user_id);
  return { ok: true };
});

app.get("/api/recordings", async (req, reply) => {
  const u = needUser(req, reply);
  if (!u) return;
  // Notes from a closed-door meeting belong to the people who were in it.
  return q(
    `SELECT r.id, r.room_id, r.title, r.meet_url, r.fathom_url, r.summary_md, r.drive_file_url, r.auto_record, r.created_at, s.name AS started_by
       FROM recordings r LEFT JOIN users s ON s.id = r.started_by
      WHERE $1::boolean OR r.started_by = $2 OR $3 = ANY(r.attendee_emails)
      ORDER BY r.created_at DESC LIMIT 50`,
    [u.role === "admin", u.id, u.email],
  );
});

app.get("/api/people/:id", async (req, reply) => {
  if (!needUser(req, reply)) return;
  const p = personById((req.params as any).id);
  if (!p) return reply.code(404).send();
  const desk = floor.desks.find((d) => d.id === p.deskId);
  return { ...p, deskRoom: desk ? floor.rooms.find((r) => r.id === desk.roomId)?.name : null };
});

// ── Fathom webhook (raw body for the signature) ───────────────────────────

app.register(async (scope) => {
  scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
  scope.post("/webhooks/fathom", async (req, reply) => {
    const raw = req.body as string;
    if (!verifyFathom(req.headers, raw)) return reply.code(401).send({ error: "bad signature" });
    const result = await handleFathom(JSON.parse(raw));
    req.log.info({ result }, "fathom webhook");
    return { result };
  });
});

// ── Admin ──────────────────────────────────────────────────────────────────

app.get("/api/admin/members", async (req, reply) => {
  if (!needAdmin(req, reply)) return;
  const rows = await q(`SELECT id, email, name, title, role, desk_id, removed, last_seen, slack_id, (google_refresh_token IS NOT NULL) AS calendar, onboarding, first_office_at, to_char(COALESCE(started_on, created_at::date), 'YYYY-MM-DD') AS started_on, (started_on IS NULL) AS started_guessed FROM users ORDER BY removed, name`);
  // Getting-started progress, so an admin can see a new teammate who's stuck.
  const users = rows.map(({ onboarding, ...u }) => ({ ...u, gettingStarted: progress(onboarding as Onboarding, "member") }));
  return { users, desks: floor.desks.map((d) => ({ id: d.id, room: floor.rooms.find((r) => r.id === d.roomId)?.name || "Unnamed room", owner: d.owner ?? null })) };
});

app.patch("/api/admin/members/:id", async (req, reply) => {
  const admin = needAdmin(req, reply);
  if (!admin) return;
  const id = Number((req.params as any).id);
  const b = (req.body ?? {}) as { name?: string; role?: string; desk_id?: string | null; title?: string; removed?: boolean; replayOnboarding?: boolean; started_on?: string | null };
  // Show someone the first-day welcome and checklist again (for people who were here before it existed).
  if (b.name !== undefined) {
    const r = await rename(id, b.name);
    if (!r) return reply.code(404).send({ error: "no such member" });
    if ("error" in r) return reply.code(400).send(r);
    if (b.role === undefined && b.desk_id === undefined && b.title === undefined && b.removed === undefined && b.started_on === undefined) return { ok: true, name: r.name };
  }
  if (b.replayOnboarding === true) {
    const r = await one(`UPDATE users SET onboarding = onboarding - 'member', first_office_at = now() WHERE id = $1 AND NOT removed RETURNING id`, [id]);
    return r ? { ok: true } : reply.code(404).send({ error: "no such member" });
  }
  if (id === admin.id && (b.role && b.role !== "admin" || b.removed)) return reply.code(400).send({ error: "You can't demote or remove yourself." });
  if (b.role && !["admin", "member"].includes(b.role)) return reply.code(400).send({ error: "bad role" });
  if (b.desk_id && !floor.desks.some((d) => d.id === b.desk_id)) return reply.code(400).send({ error: "no such desk" });
  // Their first day at Acme (shared/tenure.ts): unlocks emotes and sets the pin on their avatar.
  if (b.started_on !== undefined) {
    const d = b.started_on;
    if (d !== null && !(/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && d >= "2015-01-01" && Date.parse(d) <= Date.now())) return reply.code(400).send({ error: "Start date must be a real past date (YYYY-MM-DD)." });
    const r = await one<{ started_on: Date | null; created_at: Date }>(`UPDATE users SET started_on = $2 WHERE id = $1 RETURNING started_on, created_at`, [id, d]);
    if (!r) return reply.code(404).send();
    updateUser(id, { since: sinceOf(r) });
    await pointsChanged(id); // tenure is part of their points: recount now, so the right emotes/pets/outfits open straight away
    if (b.role === undefined && b.desk_id === undefined && b.title === undefined && b.removed === undefined) return { ok: true, started_on: sinceOf(r) };
  }
  const before = b.role ? await one<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [id]) : null;
  try {
    if (b.desk_id) {
      const prev = await q<{ id: number }>(`UPDATE users SET desk_id = NULL WHERE desk_id = $1 AND id <> $2 RETURNING id`, [b.desk_id, id]);
      for (const p of prev) updateUser(p.id, { deskId: null });
    }
    const u = await one(
      `UPDATE users SET role = COALESCE($2, role),
              desk_id = CASE WHEN $6::boolean IS TRUE THEN NULL WHEN $3::boolean THEN $4 ELSE desk_id END,
              title = COALESCE($5, title), removed = COALESCE($6, removed)
        WHERE id = $1 RETURNING id, role, desk_id, title, removed`,
      [id, b.role ?? null, b.desk_id !== undefined, b.desk_id ?? null, b.title ?? null, b.removed ?? null],
    );
    if (!u) return reply.code(404).send();
    if (b.role && before) await roleChanged(id, before.role, u.role, { id: admin.id, name: admin.name }).catch((e) => console.error("role change", e));
    if (u.removed) kickUser(id, "An admin removed you from Office Spaces.");
    else updateUser(id, { role: u.role, deskId: u.desk_id, title: u.title });
    return u;
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

app.get("/api/admin/invites", async (req, reply) => {
  if (!needAdmin(req, reply)) return;
  const rows = await q(`SELECT i.*, u.name AS created_by_name FROM guest_invites i LEFT JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC LIMIT 100`);
  return rows.map((r) => ({ ...r, link: guestLink(r.id), room: floor.rooms.find((x) => x.id === r.room_id)?.name || "a room" }));
});

app.post("/api/admin/invites", async (req, reply) => {
  const admin = needAdmin(req, reply);
  if (!admin) return;
  const b = (req.body ?? {}) as { label?: string; roomId?: string; hours?: number | null; canPresent?: boolean };
  if (!b.roomId || !floor.rooms.some((r) => r.id === b.roomId)) return reply.code(400).send({ error: "pick a room" });
  const hours = b.hours == null || b.hours === 0 ? null : Number(b.hours);
  if (hours !== null && (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 366)) return reply.code(400).send({ error: "hours must be a positive number (or empty for no expiry)" });
  const expires = hours ? new Date(Date.now() + hours * 3600e3).toISOString() : null;
  const r = await one(
    `INSERT INTO guest_invites (label, room_id, created_by, expires_at, can_present) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [String(b.label || "Guest").slice(0, 80), b.roomId, admin.id, expires, Boolean(b.canPresent)],
  );
  return { ...r, link: guestLink(r!.id) };
});

app.delete("/api/admin/invites/:id", async (req, reply) => {
  if (!needAdmin(req, reply)) return;
  const id = Number((req.params as any).id);
  await q(`UPDATE guest_invites SET revoked = TRUE WHERE id = $1`, [id]);
  await dropGuests(id, "This invite link was revoked.");
  return { ok: true };
});

const windowOf = (query: any) => {
  const from = new Date(String(query.from));
  const to = new Date(String(query.to));
  if (isNaN(+from) || isNaN(+to) || to <= from || +to - +from > 32 * 864e5) return null;
  return { from, to };
};

app.get("/api/admin/analytics", async (req, reply) => {
  if (!needAdmin(req, reply)) return;
  const w = windowOf(req.query);
  if (!w) return reply.code(400).send({ error: "from/to required, at most 31 days" });
  return analytics(w.from, w.to);
});

app.get("/api/admin/analytics.csv", async (req, reply) => {
  if (!needAdmin(req, reply)) return;
  const w = windowOf(req.query);
  if (!w) return reply.code(400).send({ error: "from/to required" });
  const tz = String((req.query as any).tz || "UTC");
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    return reply.code(400).send({ error: "bad tz" });
  }
  reply.header("content-type", "text/csv; charset=utf-8");
  reply.header("content-disposition", `attachment; filename="office-spaces-${w.from.toISOString().slice(0, 10)}.csv"`);
  return toCsv(await analytics(w.from, w.to), tz);
});

app.get("/api/admin/settings", async (req, reply) => {
  if (!needAdmin(req, reply)) return;
  return {
    audioRange: await getSetting("audioRange", "normal"),
    driveAccount: await getSetting<string | null>("driveAccount", null),
    driveFolderConfigured: Boolean(config.drive.folderId),
    backupFolderConfigured: Boolean(config.drive.backupFolderId),
    lastBackup: await getSetting("lastBackup", null),
    slackConfigured: Boolean(config.slack.botToken),
    fathomWebhooks: config.fathom.webhookSecrets.length,
    webhookUrl: `${config.publicUrl}/webhooks/fathom`,
    transcriberConfigured: Boolean(config.transcriber.url && config.transcriber.key),
    transcription: await transcribeUsage(),
    ghlRooms: await getSetting<PoolRoom[]>("ghlRooms", []),
    ghlRoomLinks: await getSetting<Record<string, string>>("ghlRoomLinks", {}),
    autoMeetOnClose: await getSetting("autoMeetOnClose", "meeting"),
  };
});

// Name (or rename, or clear) a room. Admins only; applies for everyone straight away.
app.put("/api/admin/rooms/:id/name", async (req, reply) => {
  if (!needAdmin(req, reply)) return;
  const id = String((req.params as any).id);
  if (!floor.rooms.some((r) => r.id === id)) return reply.code(404).send({ error: "No such room." });
  const name = String((req.body as any)?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  await setRoomName(id, name);
  broadcastFloor();
  return { ok: true, name };
});

// Run the Drive export now (payroll admins only), e.g. right after linking Drive.
app.post("/api/admin/backup", async (req, reply) => {
  if (!(await needPayrollAdmin(req, reply))) return;
  const r = await runBackup();
  return r.ok ? r : reply.code(409).send(r);
});
scheduleBackups((m) => app.log.info(m));

app.put("/api/admin/settings", async (req, reply) => {
  if (!needAdmin(req, reply)) return;
  const b = (req.body ?? {}) as { audioRange?: string; transcribeMonthlyHours?: number; ghlRooms?: string; autoMeetOnClose?: string };
  if (typeof (b as any).ghlRoomLinks === "string") {
    const { links, bad } = parseRoomLinks((b as any).ghlRoomLinks);
    if (bad.length) return reply.code(400).send({ error: `Not "email | GHL room link": ${bad.slice(0, 3).join(", ")}` });
    await setSetting("ghlRoomLinks", links);
    return { ok: true, ghlRoomLinks: links };
  }
  if (b.autoMeetOnClose !== undefined) {
    if (!["off", "meeting", "all"].includes(b.autoMeetOnClose)) return reply.code(400).send({ error: "bad value" });
    await setSetting("autoMeetOnClose", b.autoMeetOnClose);
    return { ok: true };
  }
  if (typeof b.ghlRooms === "string") {
    const { rooms, bad } = parsePool(b.ghlRooms);
    if (bad.length) return reply.code(400).send({ error: `Not a GHL Meeting Room link: ${bad.slice(0, 3).join(", ")}` });
    await setSetting("ghlRooms", rooms);
    return { ok: true, ghlRooms: rooms };
  }
  if (b.transcribeMonthlyHours !== undefined) {
    const h = Number(b.transcribeMonthlyHours);
    if (!Number.isFinite(h) || h < 0 || h > 2000) return reply.code(400).send({ error: "hours must be 0–2000" });
    await setSetting("transcribeMonthlyHours", h);
  }
  if (b.audioRange) {
    if (!(b.audioRange in AUDIO_RANGES)) return reply.code(400).send({ error: "bad range" });
    await setSetting("audioRange", b.audioRange);
  }
  return { ok: true, note: "Audio range applies as people next join or reload." };
});

// ── Office Designer (admins) ──────────────────────────────────────────────

const designing = new Set<number>();
app.post("/api/admin/designer", async (req, reply) => {
  const admin = needAdmin(req, reply);
  if (!admin) return;
  const prompt = String((req.body as any)?.prompt ?? "").trim();
  if (!prompt || prompt.length > 1500) return reply.code(400).send({ error: "Describe the change in under 1,500 characters." });
  if (!process.env.ANTHROPIC_API_KEY) return reply.code(503).send({ error: "The designer needs ANTHROPIC_API_KEY on the server." });
  if (designing.has(admin.id)) return reply.code(429).send({ error: "Still working on your last request." });
  designing.add(admin.id);
  try {
    const claimed = new Map((await q<{ desk_id: string; name: string }>(`SELECT desk_id, name FROM users WHERE desk_id IS NOT NULL AND NOT removed`)).map((r) => [r.desk_id, r.name]));
    const d = await design(prompt, admin.id, claimed, currentVersion());
    return { id: d.id, summary: d.summary, edits: d.edits, changes: d.changes, spots: d.spots, problems: d.problems, floor: d.floor };
  } catch (e) {
    req.log.error(e);
    // Our own messages are written for admins; raw API errors aren't, so translate those.
    const status = typeof (e as any)?.status === "number" ? (e as any).status as number : null;
    const error = status === null ? (e as Error).message
      : status === 429 || status === 529 || status >= 500 ? "Claude is busy right now — try again in a minute."
      : status === 401 || status === 403 ? "The designer's API key isn't working — check ANTHROPIC_API_KEY on the server."
      : "The designer couldn't send that request. It's been logged — try rephrasing, or tell Alex if it keeps happening.";
    return reply.code(502).send({ error });
  } finally {
    designing.delete(admin.id);
  }
});

// Applying and restoring both write a version: one at a time, so two admins
// clicking at once can't both pass the version check and overwrite each other.
let floorWriteBusy = false;
async function oneFloorWrite<T>(reply: any, fn: () => Promise<T>) {
  if (floorWriteBusy) return reply.code(409).send({ error: "Another change to the office is going live right now — try again in a moment." });
  floorWriteBusy = true;
  try {
    return await fn();
  } finally {
    floorWriteBusy = false;
  }
}

/** Hand edits from the Design panel → a draft with the same checks and Apply as a Claude one. */
app.post("/api/admin/designer/hand", async (req, reply) => {
  const admin = needAdmin(req, reply);
  if (!admin) return;
  try {
    return handDraft((req.body as any)?.edits, admin.id, currentVersion());
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

app.post("/api/admin/designer/:id/apply", async (req, reply) => {
  const admin = needAdmin(req, reply);
  if (!admin) return;
  return oneFloorWrite(reply, async () => {
    const d = getDraft((req.params as any).id);
    if (!d) return reply.code(404).send({ error: "That design expired — ask again." });
    if (d.problems.length) return reply.code(400).send({ error: "This design still has problems, so it can't go live." });
    if (d.baseVersion !== currentVersion()) return reply.code(409).send({ error: "The office changed since this was designed — ask again so nothing gets undone." });
    const problems = checkFloor(d.floor);
    if (problems.length) return reply.code(400).send({ error: problems[0] });
    if (!geometryShift(d.floor)) return reply.code(400).send({ error: "Rooms can only move together, by growing the building." });
    const { version, moved } = await saveFloorVersion(d.floor, d.summary, d.prompt, admin.id);
    shiftPeople(moved.dx, moved.dy);
    await unseatMissingDesks();
    broadcastFloor();
    return { ok: true, version };
  });
});

app.get("/api/admin/floor/versions", async (req, reply) => {
  if (!needAdmin(req, reply)) return;
  // `live` is what's actually running: the newest row isn't, if it failed the boot check.
  return { live: currentVersion(), versions: await floorVersions() };
});

app.post("/api/admin/floor/revert", async (req, reply) => {
  const admin = needAdmin(req, reply);
  if (!admin) return;
  const to = Number((req.body as any)?.version);
  const saved = Number.isInteger(to) ? await floorAt(to) : null;
  if (!saved) return reply.code(404).send({ error: "No such version." });
  return oneFloorWrite(reply, async () => {
    // An old version was saved against an older building. Lay its desks and
    // furniture into today's rooms, then hold it to the same checks as a new design.
    const target = structuredClone(floor);
    target.desks = saved.desks;
    target.objects = saved.objects;
    for (const r of target.rooms) {
      const n = saved.rooms.find((x) => x.id === r.id);
      if (n) Object.assign(r, { name: n.name, floor: n.floor, closable: n.closable });
    }
    // Its building size too: restoring from before a grow shrinks the building back.
    if (geometryShift(saved)) takeGeometry(target, saved);
    else takeGeometry(target, await floorAt(0) as Floor);
    fixSeats(target); // versions from before the seat rule come back with seats people fit in
    const problems = checkFloor(target);
    if (problems.length) return reply.code(400).send({ error: `That version doesn't fit the office any more: ${problems[0]}` });
    const { version, moved } = await saveFloorVersion(target, to === 0 ? "Back to the original layout" : `Reverted to version ${to}`, null, admin.id, true);
    shiftPeople(moved.dx, moved.dy);
    await unseatMissingDesks();
    broadcastFloor();
    return { ok: true, version };
  });
});

/** People without a seat get the roster desk with their name on it, if it's free. */
async function reseatFromRoster() {
  const users = await q<{ id: number; name: string; desk_id: string | null }>(`SELECT id, name, desk_id FROM users WHERE NOT removed`);
  const taken = new Set(users.map((u) => u.desk_id).filter(Boolean));
  for (const u of users) {
    if (u.desk_id) continue;
    const desk = floor.desks.find((d) => d.owner && !taken.has(d.id) && nameMatchesUser(u.name, d.owner));
    if (!desk) continue;
    taken.add(desk.id);
    await q(`UPDATE users SET desk_id = $1 WHERE id = $2 AND desk_id IS NULL`, [desk.id, u.id]);
    updateUser(u.id, { deskId: desk.id });
  }
}

/** A redesign removed someone's desk: they're unseated (they can claim another). */
async function unseatMissingDesks() {
  const ids = floor.desks.map((d) => d.id);
  const gone = await q<{ id: number }>(`UPDATE users SET desk_id = NULL WHERE desk_id IS NOT NULL AND NOT (desk_id = ANY($1::text[])) RETURNING id`, [ids]);
  for (const u of gone) updateUser(u.id, { deskId: null });
}

// ── The web app ────────────────────────────────────────────────────────────

const dist = join(root, "web/dist");
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== "GET" || req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    return reply.sendFile("index.html");
  });
}

// ── Go ─────────────────────────────────────────────────────────────────────

await app.ready();
const io = new Server<C2S, S2C>(app.server, {
  cors: { origin: false },
  pingInterval: 20000,
  pingTimeout: 25000,
  // Refuse cross-site handshakes before a session even exists.
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    if (!config.production || !origin) return cb(null, true);
    // "null" (sandboxed iframes, file://) isn't a URL: refuse it, never throw (a throw here hangs the request).
    let host = "";
    try { host = new URL(origin).host; } catch { /* not a URL */ }
    cb(null, host === new URL(config.publicUrl).host);
  },
});
attach(io);
await app.listen({ port: config.port, host: "0.0.0.0" });
void startJumbotron();
console.log(`Office Spaces on :${config.port} — ${config.production ? "production" : "dev"}; LiveKit at ${config.livekit.url}`);
