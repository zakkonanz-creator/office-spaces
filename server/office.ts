// The live office: who is on the floor, where, in what status, which doors are
// shut. The server is authoritative for room membership and doors (so a closed
// door actually keeps people out); clients are trusted for smooth movement and
// corrected when they try to walk somewhere they can't be.

import { isEmote, unlocked } from "../shared/emotes";
import { firstName } from "../shared/names";
import { sinceOf } from "./tenure";
import { award, breakdown, countToday, eggFoundByAnyone, eggsFound } from "./points";
import { POINTS, anniversaryYears } from "../shared/points";
import { petUnlocked, petDef } from "../shared/pets";
import { outfitUnlocked } from "../shared/outfits";
import { EGGS, EGG_RADIUS, eggSpots } from "../shared/eggs";
import { streakFor, dayIn, MILESTONES } from "./streaks";
import { tzOf } from "./time/hours";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server, Socket } from "socket.io";
import { blocked, doorPoint, guestFloor, roomAt, seatOf, AUDIO_RANGES, type Floor, type Pt } from "../shared/floor";
import { isTz } from "../shared/time";
import type { C2S, Person, RoomState, S2C, Status } from "../shared/protocol";
import { config } from "./config";
import { cookieFromHeader, lkId, viewerFrom, type Viewer } from "./auth";
import { getSetting, q } from "./db";
import { firstArrival, tellNewMember } from "./onboarding";
import { floor } from "./floorStore";
export { floor };
const roomsById = new Map(floor.rooms.map((r) => [r.id, r]));

type Sock = Socket<C2S, S2C, object, { viewer: Viewer }>;

interface Live extends Person {
  sockets: Set<string>;
  /** When they last stepped out of each room: they may finish walking out through its closed door. */
  leftAt: Map<string, number>;
  userId: number | null;
  calendarLinked: boolean;
  /** Easter eggs they've found (loaded on arrival; teammates only). */
  eggs?: Set<string>;
}

const people = new Map<string, Live>();
const rooms = new Map<string, RoomState>(floor.rooms.map((r) => [r.id, { closed: false, admitted: [], recording: null, transcribing: null }]));
const dirty = new Set<string>();
/** People who dropped in the last minute and a half, so a reconnect lands them back where they were. */
const RECENT_MS = 90_000;
const recent = new Map<string, { x: number; y: number; status: Status; statusText: string; mic: boolean; cam: boolean; at: number }>();
setInterval(() => {
  for (const [id, m] of recent) if (Date.now() - m.at > RECENT_MS) recent.delete(id);
}, 60_000).unref();
let io: Server<C2S, S2C>;

const pub = ({ sockets, userId, calendarLinked, leftAt, eggs, ...p }: Live): Person => p;
const toPerson = (id: string) => people.get(id);
const emitTo = <E extends keyof S2C>(personId: string, ev: E, ...args: Parameters<S2C[E]>) => {
  const p = people.get(personId);
  if (p) for (const s of p.sockets) (io.to(s).emit as any)(ev, ...args);
};

export function deskSeat(deskId: string | null): Pt | null {
  const d = floor.desks.find((x) => x.id === deskId);
  return d ? seatOf(d) : null;
}

/** A newcomer's welcome: when it went out, and who said hi first (their "Say hi" brings the newcomer over). */
const WELCOME_MS = 15 * 60e3;
const welcomed = new Map<string, { at: number; by: string | null }>();

const EXIT_GRACE_MS = 6000; // a touch longer than the client's 5 s, so the server never disagrees first

function passableFor(p: Live) {
  return (roomId: string) => {
    const r = rooms.get(roomId)!;
    if (p.guestRoom) return roomId === p.guestRoom; // guests can only use their own room's door
    return !r.closed || r.admitted.includes(p.id) || p.roomId === roomId || Date.now() - (p.leftAt.get(roomId) ?? 0) < EXIT_GRACE_MS;
  };
}

// ── Status stretches (the analytics source) ───────────────────────────────

// Writes for one person run strictly in order, so two quick status changes can
// never interleave into two open stretches (double-counted analytics).
const chains = new Map<number, Promise<void>>();
function serial(userId: number, work: () => Promise<unknown>) {
  const next = (chains.get(userId) ?? Promise.resolve())
    .then(work)
    .then(() => undefined, (e) => console.error(`status write for user ${userId} failed:`, e));
  chains.set(userId, next);
  next.then(() => chains.get(userId) === next && chains.delete(userId));
  return next;
}
const openStretch = (userId: number, status: Status) =>
  serial(userId, async () => {
    await q(`UPDATE status_events SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL`, [userId]);
    await q(`INSERT INTO status_events (user_id, status) VALUES ($1, $2)`, [userId, status]);
  });
const closeStretch = (userId: number) =>
  serial(userId, async () => {
    await q(`UPDATE status_events SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL`, [userId]);
    await q(`UPDATE users SET last_seen = now() WHERE id = $1`, [userId]);
  });

// ── Rooms ──────────────────────────────────────────────────────────────────

/** What one person may know about a room: the Meet link only if they're a member inside it. */
function roomFor(viewer: Live, roomId: string): RoomState {
  const r = rooms.get(roomId)!;
  const inside = viewer.roomId === roomId && !viewer.guestRoom;
  return { ...r, recording: r.recording ? { ...r.recording, meetUrl: inside ? r.recording.meetUrl : "" } : null };
}
function sendRoom(viewer: Live, roomId: string) {
  if (viewer.guestRoom && viewer.guestRoom !== roomId) return;
  for (const s of viewer.sockets) io.to(s).emit("room", { roomId, ...roomFor(viewer, roomId) });
}
function broadcastRoom(roomId: string) {
  for (const p of people.values()) sendRoom(p, roomId);
}

function occupants(roomId: string) {
  return [...people.values()].filter((p) => p.roomId === roomId);
}

/** A shut room with nobody in it opens again, and any meeting badge goes. */
function settleRoom(roomId: string | null) {
  if (!roomId) return;
  const r = rooms.get(roomId)!;
  if (occupants(roomId).length) return;
  if (r.closed || r.admitted.length || r.recording || r.transcribing) {
    r.closed = false;
    r.admitted = [];
    r.recording = null;
    r.transcribing = null; // the transcription sweep sees this and closes the transcript
    broadcastRoom(roomId);
  }
}

export function setRecording(roomId: string, rec: RoomState["recording"]) {
  const r = rooms.get(roomId);
  if (!r) return;
  // Everyone left while Google was creating the Meet: nobody to show it to.
  if (rec && !occupants(roomId).length) return;
  r.recording = rec;
  broadcastRoom(roomId);
  // Everyone else in the room (members only) is asked to join the Meet.
  if (rec) for (const p of occupants(roomId)) if (!p.guestRoom && p.id !== rec.by) emitTo(p.id, "meetingStarted", { roomId, meetUrl: rec.meetUrl, byName: rec.byName, kind: rec.kind, label: rec.label });
}

/** Someone inside closed a room's door (index.ts may start a meeting). */
type DoorClosed = { roomId: string; kind: string; personId: string; userId: number; name: string };
let doorClosed: ((d: DoorClosed) => void) | null = null;
export const onDoorClosed = (fn: (d: DoorClosed) => void) => { doorClosed = fn; };
/** Send one person (all their tabs) an event. */
export const tellPerson = <E extends keyof S2C>(personId: string, ev: E, ...args: Parameters<S2C[E]>) => emitTo(personId, ev, ...args);

/** Shared GHL rooms in use by a meeting Space started (Space can't see inside GHL). */
export function busyPool() {
  const busy = new Set<number>();
  for (const r of rooms.values()) if (r.recording?.kind === "ghl" && r.recording.pool != null) busy.add(r.recording.pool);
  return busy;
}

const GHL_GRACE_MS = 60_000; // nobody has joined yet: the starter's "in a meeting" arrives just after the start
const GHL_MAX_MS = 4 * 3600_000; // a forgotten meeting frees its shared room eventually

/** A GHL meeting ends once nobody from the room is still in it, which frees its shared room. */
function settleGhl(roomId: string | null) {
  if (!roomId) return;
  const r = rooms.get(roomId);
  const rec = r?.recording;
  // Until someone has actually joined, give the starter a moment (their "in a meeting" follows the start).
  if (!r || rec?.kind !== "ghl" || (!rec.joined && Date.now() - rec.startedAt < GHL_GRACE_MS)) return;
  if (occupants(roomId).some((p) => p.inMeeting)) return;
  r.recording = null;
  broadcastRoom(roomId);
}
setInterval(() => {
  for (const [id, r] of rooms) {
    if (r.recording?.kind !== "ghl") continue;
    if (Date.now() - r.recording.startedAt > GHL_MAX_MS) {
      r.recording = null;
      broadcastRoom(id);
    } else settleGhl(id);
  }
}, 30_000).unref();

/** Turn a room's transcription badge on or off for everyone who can see the room. */
export function setTranscribing(roomId: string, t: RoomState["transcribing"]) {
  const r = rooms.get(roomId);
  if (!r) return;
  if (t && !occupants(roomId).length) return;
  r.transcribing = t;
  broadcastRoom(roomId);
}
export const roomTranscribing = (roomId: string) => rooms.get(roomId)?.transcribing ?? null;
/** Teammates (not guests) in a room right now, by user id. */
export const memberIdsInRoom = (roomId: string) => occupants(roomId).flatMap((p) => (p.userId && !p.guestRoom ? [p.userId] : []));
/** A toast for whichever of these people are in the office now. */
export function toastUsers(userIds: number[], text: string) {
  const want = new Set(userIds);
  for (const p of people.values()) if (p.userId && want.has(p.userId)) emitTo(p.id, "toast", { text });
}
export const peopleInRoom = (roomId: string) => occupants(roomId).map(pub);
export const roomRecording = (roomId: string) => rooms.get(roomId)?.recording ?? null;
export const personById = (id: string) => (people.has(id) ? pub(people.get(id)!) : null);
export const personForUser = (userId: number) => [...people.values()].find((p) => p.userId === userId) ?? null;

/** Fathom notes are ready: tell the people who were in the meeting (never guests), wherever they are now. */
export function notifyAttendees(emails: string[], note: { roomId: string; title: string; url: string }) {
  const want = new Set(emails.map((e) => e.toLowerCase()));
  for (const p of people.values()) if (p.email && want.has(p.email.toLowerCase())) emitTo(p.id, "recordingNote", { ...note, summary: "" });
}

/** Guests: everyone in their own room, minus anything that identifies staff beyond a name and face. */
const forGuest = (p: Live | Person): Person => ({ ...pubOf(p), email: null, slackId: null, tz: null, title: p.role === "guest" ? "Guest" : null, deskId: null, clock: null, since: null, points: undefined, streak: null });
const pubOf = (p: Live | Person): Person => ("sockets" in p ? pub(p as Live) : (p as Person));
const guests = () => [...people.values()].filter((g) => g.guestRoom);
/** Who each guest can currently see, so we can send join/leave as people cross their door. */
const guestSees = new Map<string, Set<string>>();

/** Send a person-level event to members in full and to guests only if that person is in the guest's room. */
function tellAll(about: Live, ev: "join" | "person", payload: any) {
  for (const p of people.values()) {
    if (!p.guestRoom) {
      for (const s of p.sockets) io.to(s).emit(ev, payload);
    } else if (guestSees.get(p.id)?.has(about.id) || (ev === "join" && about.roomId === p.guestRoom)) {
      if (ev === "join") guestSees.get(p.id)?.add(about.id);
      const safe = ev === "join" ? forGuest(about) : { ...payload, email: undefined, slackId: undefined, tz: undefined, title: undefined, deskId: undefined, clock: undefined, since: undefined, points: undefined, streak: undefined };
      for (const k of Object.keys(safe)) if (safe[k] === undefined) delete safe[k];
      for (const s of p.sockets) io.to(s).emit(ev, safe);
    }
  }
}

/** LiveKit identities that belong to someone with a live office connection right now. */
export const liveLkIds = () => new Set([...people.values()].map((p) => p.lk));
export const guestLkIds = (inviteId: number) => guests().filter((g) => g.id.startsWith(`g:${inviteId}:`)).map((g) => g.lk);
export const connectedGuestInvites = () => [...new Set(guests().map((g) => Number(g.id.split(":")[1])))];

export function revokeGuests(inviteId: number, reason: string) {
  for (const g of guests()) {
    if (!g.id.startsWith(`g:${inviteId}:`)) continue;
    for (const s of g.sockets) {
      io.to(s).emit("kicked", { reason });
      io.sockets.sockets.get(s)?.disconnect(true);
    }
  }
}

export function updateUser(userId: number, patch: Partial<Person>) {
  const p = personForUser(userId);
  if (!p) return;
  Object.assign(p, patch);
  tellAll(p, "person", { id: p.id, ...patch });
}

/** How the office learns someone's clock when they walk in (set by the time routes, which own the clock). */
type ClockLookup = (userId: number) => Promise<Person["clock"]>;
let clockLookup: ClockLookup | null = null;
export const setClockLookup = (fn: ClockLookup) => { clockLookup = fn; };

/** Whether someone has approved leave today, in their timezone (set by the time routes, which own leave). */
type LeaveLookup = (userId: number, tz: string | null) => Promise<boolean>;
let leaveLookup: LeaveLookup | null = null;
export const setLeaveLookup = (fn: LeaveLookup) => { leaveLookup = fn; };

/** Away · "On leave", with the analytics stretch a status change records. */
function markOnLeave(p: Live) {
  p.status = "away";
  p.statusText = "On leave";
  p.autoAway = false;
  p.statusSince = Date.now();
  tellAll(p, "person", { id: p.id, status: p.status, statusText: p.statusText, statusSince: p.statusSince, autoAway: false });
  if (p.userId) void openStretch(p.userId, "away");
}

/** Their leave was just approved and covers today: show it, if they're in the office. */
export function showOnLeave(userId: number) {
  const p = personForUser(userId);
  if (p) markOnLeave(p);
}

/** Someone's status in the office right now, or null if they aren't in it. */
export const statusOf = (userId: number): Status | null => personForUser(userId)?.status ?? null;

/**
 * Change someone's status from outside the office (clocking in on /time), with
 * the same analytics stretch the status menu records. No-op if they aren't in the office.
 */
export function setStatusFor(userId: number, status: Status): boolean {
  const p = personForUser(userId);
  if (!p || p.status === status) return false;
  p.status = status;
  p.autoAway = false;
  p.statusSince = Date.now();
  tellAll(p, "person", { id: p.id, status: p.status, statusText: p.statusText, statusSince: p.statusSince, autoAway: false });
  void openStretch(userId, status);
  return true;
}

export function kickUser(userId: number, reason: string) {
  const p = personForUser(userId);
  if (!p) return;
  for (const s of p.sockets) {
    io.to(s).emit("kicked", { reason });
    io.sockets.sockets.get(s)?.disconnect(true);
  }
}

/** The plan changed (Office Designer): everyone redraws. */
export function broadcastFloor() {
  for (const p of people.values()) {
    const f = p.guestRoom ? guestFloor(floor, p.guestRoom) : floor;
    for (const s of p.sockets) io.to(s).emit("floor", f);
  }
}

/** The building grew along its top or left edge: everyone moves with the floor, so nobody ends up in a wall. */
export function shiftPeople(dx: number, dy: number) {
  if (!dx && !dy) return;
  for (const p of people.values()) {
    p.x += dx;
    p.y += dy;
    // Shrinking back (an undo) can leave someone outside the walls: send them to the arrival point.
    if (blocked(floor, p, () => true)) ({ x: p.x, y: p.y } = floor.spawn);
    dirty.add(p.id);
    emitTo(p.id, "place", { x: p.x, y: p.y });
  }
  for (const m of recent.values()) {
    m.x += dx;
    m.y += dy;
  }
}

export function setCalendarLinked(userId: number) {
  const p = personForUser(userId);
  if (p) p.calendarLinked = true;
}

// ── Connection ─────────────────────────────────────────────────────────────

export function attach(server: Server<C2S, S2C>) {
  io = server;

  io.use(async (socket, next) => {
    // Never leave a handshake hanging: a bad Origin ("null") or a database blip must answer, not throw.
    try {
      // Cross-site WebSocket hijacking guard: browsers always send Origin on a WS upgrade.
      const origin = socket.handshake.headers.origin;
      if (origin && config.production) {
        let host = "";
        try { host = new URL(origin).host; } catch { /* "null" and other non-URLs */ }
        if (host !== new URL(config.publicUrl).host) return next(new Error("bad origin"));
      }
      const viewer = await viewerFrom(cookieFromHeader(socket.handshake.headers.cookie));
      if (!viewer) return next(new Error("unauthorized"));
      (socket as Sock).data.viewer = viewer;
      next();
    } catch (e) {
      console.error("socket handshake:", e);
      next(new Error("try again"));
    }
  });

  io.on("connection", (socket: Sock) => {
    // Everything up to registering "disconnect" is synchronous on purpose: a
    // socket that drops while we wait on the database must still be cleaned up,
    // or its person haunts the floor (and the analytics) until a restart.
    const v = socket.data.viewer;
    const auth = (socket.handshake.auth ?? {}) as {
      tz?: string;
      mobile?: boolean;
      /** Sent on reconnect so a network blip doesn't send you back to your desk. */
      resume?: { x: number; y: number; status: Status; statusText: string; mic: boolean; cam: boolean };
      tabId?: string;
    };
    const id = v.kind === "user" ? String(v.user.id) : `g:${v.inviteId}:${v.key}`;

    let p = people.get(id);
    let isNew = false;
    // One tab per person: a new tab (not a reconnect of the same tab) replaces
    // the old one. Register the new socket *first*, so the old socket's
    // disconnect never sees zero sockets and deletes the person mid-handoff.
    if (p) {
      p.sockets.add(socket.id);
      for (const sid of [...p.sockets]) {
        if (sid === socket.id) continue;
        const old = io.sockets.sockets.get(sid) as Sock | undefined;
        if (!old) {
          p.sockets.delete(sid); // a socket that died without telling us
        } else if (old.handshake.auth?.tabId !== auth.tabId) {
          p.sockets.delete(sid);
          old.emit("kicked", { reason: "You opened Office Spaces in another tab or window." });
          old.disconnect(true);
        }
      }
    } else {
      isNew = true;
      let at: Pt = floor.spawn;
      if (v.kind === "user") at = deskSeat(v.user.desk_id) ?? floor.spawn;
      else {
        const r = roomsById.get(v.roomId)!;
        at = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      }
      // Coming back from a network blip: the server's own memory of where you
      // were wins (it can put you back in the room you were just in, door shut
      // or not). After a server restart there's no memory; the client's report
      // is used, checked like any other move.
      const mem = recent.get(id);
      recent.delete(id);
      const fresh = mem && Date.now() - mem.at < RECENT_MS ? mem : undefined;
      const r = fresh ?? (auth.resume && typeof auth.resume === "object" ? auth.resume : undefined);
      const closedAt = (pt: Pt) => {
        const rm = roomAt(floor, pt);
        return Boolean(rm && rooms.get(rm.id)!.closed);
      };
      const resumeOk = Boolean(
        r && Number.isFinite(r.x) && Number.isFinite(r.y) && !blocked(floor, r, () => true) &&
        (v.kind === "user" || roomAt(floor, r)?.id === v.roomId) &&
        (r === fresh || !closedAt(r)),
      );
      if (resumeOk) at = { x: r!.x, y: r!.y };
      // Your desk is behind someone's closed door: you arrive outside it and knock
      // like anyone else. Owning a desk is not a key to a private meeting.
      else if (v.kind === "user" && closedAt(at)) at = outsideDoor(roomAt(floor, at)!.id);
      p = {
        id,
        lk: lkId(id),
        name: v.kind === "user" ? v.user.name : v.name,
        email: v.kind === "user" ? v.user.email : null,
        title: v.kind === "user" ? v.user.title : "Guest",
        avatar: v.kind === "user" ? v.user.avatar_url : null,
        role: v.kind === "user" ? v.user.role : "guest",
        slackId: v.kind === "user" ? v.user.slack_id : null,
        deskId: v.kind === "user" ? v.user.desk_id : null,
        since: v.kind === "user" ? sinceOf(v.user) : null,
        pet: v.kind === "user" ? (v.user as { pet?: string | null }).pet ?? null : null,
        outfit: v.kind === "user" ? (v.user as { outfit?: string | null }).outfit ?? null : null,
        // The device's zone, for the "local time" others see. Only a real IANA zone is kept (it's saved below).
        tz: typeof auth.tz === "string" && auth.tz.length <= 64 && isTz(auth.tz) ? auth.tz : null,
        x: at.x,
        y: at.y,
        roomId: roomAt(floor, at)?.id ?? null,
        status: resumeOk && ["available", "away", "focusing"].includes(r!.status) ? r!.status : "available",
        statusText: resumeOk && typeof r!.statusText === "string" ? r!.statusText.slice(0, 80) : "",
        statusSince: Date.now(),
        autoAway: false,
        mic: resumeOk ? Boolean(r!.mic) : false,
        cam: resumeOk ? Boolean(r!.cam) : false,
        sharing: false,
        clock: null,
        inMeeting: false,
        mobile: Boolean(auth.mobile),
        following: null,
        guestRoom: v.kind === "guest" ? v.roomId : null,
        sockets: new Set([socket.id]),
        leftAt: new Map(),
        userId: v.kind === "user" ? v.user.id : null,
        calendarLinked: v.kind === "user" && Boolean(v.user.google_refresh_token),
      };
      people.set(id, p);
      if (p.guestRoom) guestSees.set(p.id, new Set(occupants(p.guestRoom).map((o) => o.id)));
      tellAll(p, "join", pub(p));
      const uid = p.userId;
      if (uid && clockLookup) clockLookup(uid).then((clock) => { if (clock) updateUser(uid, { clock }); }).catch(() => undefined);
      // Walking in on a day of approved leave: show "On leave". Only over the default
      // Available they arrived with — a reconnect keeps what they had, and anything they
      // set themselves since arriving (status or text) wins.
      if (uid && leaveLookup && !resumeOk) {
        const who = p, since = p.statusSince;
        leaveLookup(uid, who.tz)
          .then((onLeave) => {
            if (onLeave && people.get(id) === who && who.status === "available" && !who.statusText && who.statusSince === since) markOnLeave(who);
          })
          .catch((e) => console.error("leave lookup:", e));
      }
    }
    const me = p;

    // Per-connection message budget (token bucket). The web client moves at ~15 Hz and
    // sends a handful of other messages; a runaway or hostile client can't fan out
    // thousands of broadcasts a second to everyone. Persistent flooding disconnects.
    const budget = { move: { tokens: 40, at: Date.now() }, other: { tokens: 20, at: Date.now() } };
    let strikes = 0;
    const allow = (ev: string) => {
      const b = ev === "move" ? budget.move : budget.other;
      const [rate, cap] = ev === "move" ? [30, 40] : [8, 20];
      const now = Date.now();
      b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 1000) * rate);
      b.at = now;
      if (b.tokens >= 1) { b.tokens -= 1; if (strikes) strikes--; return true; }
      if (++strikes > 200) socket.disconnect(true);
      return false;
    };
    /** Every handler: payload must be an object; nothing a client sends can throw out of here. */
    // A move over budget isn't thrown away: the latest one is applied as soon as there's budget.
    // Dropping it left the server with an old position for good (the client never re-sends
    // where it's standing), so you saw yourself in one place and everyone else saw you in another.
    let pendingMove: unknown = null;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const on = <E extends keyof C2S>(ev: E, fn: (payload: Parameters<C2S[E]>[0]) => void | Promise<void>) => {
      const run = (payload: unknown) => {
        try {
          const r = fn(payload as any);
          if (r instanceof Promise) r.catch((e) => console.error(`socket ${ev}:`, e));
        } catch (e) {
          console.error(`socket ${ev}:`, e);
        }
      };
      socket.on(ev as any, (payload: unknown) => {
        if (!payload || typeof payload !== "object") return;
        if (!allow(ev as string)) {
          if (ev !== "move") return;
          pendingMove = payload;
          const retry = () => {
            pendingTimer = null;
            if (!pendingMove || !socket.connected) return;
            if (!allow("move")) { pendingTimer = setTimeout(retry, 100); return; }
            const p = pendingMove;
            pendingMove = null;
            run(p);
          };
          if (!pendingTimer) pendingTimer = setTimeout(retry, 100);
          return;
        }
        if (ev === "move") pendingMove = null; // a newer move supersedes a held one
        run(payload);
      });
    };
    const str = (x: unknown): x is string => typeof x === "string" && x.length < 200;

    socket.on("disconnect", () => {
      me.sockets.delete(socket.id);
      if (me.sockets.size) return;
      people.delete(me.id);
      dirty.delete(me.id);
      guestSees.delete(me.id);
      recent.set(me.id, { x: me.x, y: me.y, status: me.status, statusText: me.statusText, mic: me.mic, cam: me.cam, at: Date.now() });
      for (const [rid, r] of rooms) {
        if (r.admitted.includes(me.id)) r.admitted = r.admitted.filter((a) => a !== me.id);
        if (me.roomId === rid) {
          settleRoom(rid);
          settleGhl(rid);
        }
      }
      for (const other of people.values()) {
        if (other.following === me.id) {
          other.following = null;
          tellAll(other, "person", { id: other.id, following: null });
        }
        guestSees.get(other.id)?.delete(me.id);
      }
      io.emit("leave", { id: me.id });
      if (me.userId) closeStretch(me.userId);
    });

    on("move", ({ x, y }) => {
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x + y)) return;
      const to = { x, y };
      // A big jump (teleport/home) is fine, but it can't land in a wall or a room you can't enter.
      if (blocked(floor, to, passableFor(me))) {
        socket.emit("place", { x: me.x, y: me.y });
        return;
      }
      const room = roomAt(floor, to)?.id ?? null;
      if (me.guestRoom && room !== me.guestRoom) {
        socket.emit("place", { x: me.x, y: me.y });
        return;
      }
      if (room && room !== me.roomId) {
        const r = rooms.get(room)!;
        if (r.closed && !r.admitted.includes(me.id) && Date.now() - (me.leftAt.get(room) ?? 0) >= EXIT_GRACE_MS) {
          socket.emit("place", { x: me.x, y: me.y });
          return;
        }
      }
      const left = me.roomId !== room ? me.roomId : null;
      me.x = Math.round(x);
      me.y = Math.round(y);
      me.roomId = room;
      dirty.add(me.id);
      if (me.eggs) checkEggs(me);
      if (room !== left && room) sendRoom(me, room); // walking into a recorded room: now you get its Meet link
      if (left) {
        me.leftAt.set(left, Date.now());
        sendRoom(me, left); // …and walking out, you lose it
        const r = rooms.get(left)!;
        if (r.admitted.includes(me.id)) r.admitted = r.admitted.filter((a) => a !== me.id);
        settleRoom(left);
        settleGhl(left);
      }
    });

    on("status", ({ status, text, auto }) => {
      if (!["available", "away", "focusing"].includes(status)) return;
      const changed = status !== me.status;
      me.status = status;
      me.autoAway = Boolean(auto) && status === "away";
      if (typeof text === "string") me.statusText = text.slice(0, 80);
      if (changed) me.statusSince = Date.now();
      tellAll(me, "person", { id: me.id, status: me.status, statusText: me.statusText, statusSince: me.statusSince, autoAway: me.autoAway });
      if (changed && me.userId) openStretch(me.userId, status);
    });

    on("media", (m) => {
      const patch: Partial<Person> = {};
      if (typeof m.mic === "boolean") patch.mic = m.mic;
      if (typeof m.cam === "boolean") patch.cam = m.cam;
      if (typeof m.inMeeting === "boolean") patch.inMeeting = m.inMeeting && !me.guestRoom;
      if (typeof m.sharing === "boolean") {
        const guestBlocked = v.kind === "guest" && !v.canPresent;
        patch.sharing = guestBlocked ? false : m.sharing;
      }
      Object.assign(me, patch);
      tellAll(me, "person", { id: me.id, ...patch });
      const rec = me.roomId ? rooms.get(me.roomId)?.recording : null;
      if (patch.inMeeting && rec?.kind === "ghl") rec.joined = true;
      if (patch.inMeeting === false) settleGhl(me.roomId);
    });

    on("door", ({ roomId, closed }) => {
      if (!str(roomId)) return;
      const def = roomsById.get(roomId);
      const r = rooms.get(roomId);
      if (!def || !r || !def.closable || me.role === "guest") return;
      if (me.roomId !== roomId && me.role !== "admin") return; // only people inside work the door
      r.closed = Boolean(closed);
      r.admitted = [];
      broadcastRoom(roomId);
      if (r.closed && me.userId && !me.guestRoom && me.roomId === roomId && !r.recording) doorClosed?.({ roomId, kind: def.kind, personId: me.id, userId: me.userId, name: me.name });
    });

    let lastKnock = 0;
    on("knock", ({ roomId }) => {
      if (!str(roomId) || Date.now() - lastKnock < 4000) return;
      if (me.guestRoom && roomId !== me.guestRoom) return;
      lastKnock = Date.now();
      const r = rooms.get(roomId);
      if (!r?.closed) return;
      const inside = occupants(roomId);
      if (!inside.length) return;
      for (const o of inside) if (!o.guestRoom) emitTo(o.id, "knock", { roomId, from: { id: me.id, name: me.name } });
      socket.emit("toast", { text: `Knocked on ${floor.rooms.find((r) => r.id === roomId)?.name || "the door"}` });
    });

    on("admit", ({ roomId, personId }) => {
      if (!str(roomId) || !str(personId)) return;
      const r = rooms.get(roomId);
      if (!r || me.roomId !== roomId || me.role === "guest" || !people.has(personId)) return;
      if (!r.admitted.includes(personId)) r.admitted.push(personId);
      broadcastRoom(roomId);
      emitTo(personId, "admitted", { roomId });
    });

    // Emotes: the same audience as reactions (guests only see people in their room).
    on("emote", ({ name }) => {
      if (name !== null && !isEmote(name)) return;
      // Locked until they've been here long enough (shared/emotes.ts). The menu hides these; this stops a crafted emit.
      if (name !== null && !unlocked(name, me.points)) return;
      for (const o of people.values()) {
        if (o.guestRoom && !guestSees.get(o.id)?.has(me.id) && o.id !== me.id) continue;
        for (const s of o.sockets) io.to(s).emit("emote", { id: me.id, name });
      }
    });

    on("react", ({ emoji }) => {
      if (typeof emoji !== "string" || emoji.length > 16) return;
      for (const o of people.values()) {
        if (o.guestRoom && !guestSees.get(o.id)?.has(me.id) && o.id !== me.id) continue;
        for (const s of o.sockets) io.to(s).emit("react", { id: me.id, emoji });
      }
    });

    // High-fives: offer one to someone close; when they offer one back, it lands (both get points).
    on("highfive", ({ to }) => {
      if (!me.userId) return;
      const t = str(to) ? people.get(to) : nearestTeammate(me, HIGH_FIVE_REACH);
      if (!t || !t.userId || t.id === me.id || Math.hypot(t.x - me.x, t.y - me.y) > HIGH_FIVE_REACH) {
        return void socket.emit("toast", { text: "Walk up to someone first, then high-five (Y)." });
      }
      const theirs = handUp.get(t.id);
      if (theirs && theirs.to === me.id && Date.now() - theirs.at < HIGH_FIVE_MS) {
        handUp.delete(t.id);
        handUp.delete(me.id);
        nearBoth(me, t, "highfive", { a: t.id, b: me.id, done: true });
        void highFivePoints(me, t).catch((e) => console.error("highfive points", e));
        return;
      }
      handUp.set(me.id, { to: t.id, at: Date.now() });
      nearBoth(me, t, "highfive", { a: me.id, b: t.id, done: false });
    });

    // Pets: pick one you've unlocked; pet a teammate's (the one petting gets a point, a few a day).
    on("setPet", ({ pet }) => {
      if (!me.userId) return;
      if (pet !== null && (!str(pet) || !petUnlocked(pet, me.points))) return;
      me.pet = pet;
      tellAll(me, "person", { id: me.id, pet });
      void q(`UPDATE users SET pet = $1 WHERE id = $2`, [pet, me.userId]).catch((e) => console.error("pet save", e));
    });
    // Outfits: wear one you've unlocked.
    on("setOutfit", ({ outfit }) => {
      if (!me.userId) return;
      if (outfit !== null && (!str(outfit) || !outfitUnlocked(outfit, me.points))) return;
      me.outfit = outfit;
      tellAll(me, "person", { id: me.id, outfit });
      void q(`UPDATE users SET outfit = $1 WHERE id = $2`, [outfit, me.userId]).catch((e) => console.error("outfit save", e));
    });
    on("pat", ({ to }) => {
      const t = str(to) ? people.get(to) : undefined;
      if (!t?.pet || Math.hypot(t.x - me.x, t.y - me.y) > 320) return;
      nearBoth(me, t, "pat", { from: me.id, to: t.id });
      if (me.userId && t.id !== me.id) void (async () => {
        if ((await countToday(me.userId!, "pat")) >= POINTS.patsPerDay) return;
        if (await award(me.userId!, "pat", POINTS.pat, `Petted ${firstName(t.name)}'s ${petDef(t.pet)?.label.toLowerCase() ?? "pet"}`, null)) await refreshPoints(me);
      })().catch((e) => console.error("pat points", e));
    });

    const reachable = (to: unknown): to is string =>
      str(to) && people.has(to) && to !== me.id && (!me.guestRoom || people.get(to)!.roomId === me.guestRoom);

    on("nudge", ({ to }) => {
      if (!reachable(to)) return;
      emitTo(to, "nudge", { from: { id: me.id, name: me.name } });
      socket.emit("toast", { text: `Nudged ${people.get(to)!.name}` });
    });

    on("follow", ({ to }) => {
      if (to !== null && !reachable(to)) return;
      me.following = to;
      tellAll(me, "person", { id: me.id, following: to });
    });

    on("requestFollow", ({ to }) => {
      if (!reachable(to)) return;
      emitTo(to, "followRequest", { from: { id: me.id, name: me.name } });
      socket.emit("toast", { text: `Asked ${people.get(to)!.name} to follow you` });
    });

    on("teleport", ({ to }) => {
      const t = str(to) ? toPerson(to) : undefined;
      if (!t || me.guestRoom) return;
      socket.emit("place", spotNear(t, me));
    });

    // "Say hi" on a welcome: the newcomer comes to you, and both of you are told what's happening
    // (the owner, 2026-11-05: being teleported to them with no explanation looked like a freeze).
    on("sayHi", ({ to }) => {
      if (!reachable(to) || me.guestRoom) return;
      const t = people.get(to)!;
      const w = welcomed.get(t.id);
      const goToThem = (text: string) => void socket.emit("bring", { ...rounded(spotNear(t, me)), text });
      if (!w || Date.now() - w.at > WELCOME_MS) return goToThem(`Taking you to ${firstName(t.name)}.`);
      if (t.inMeeting) return void socket.emit("toast", { text: `${firstName(t.name)} is in a meeting right now. Say hi on Slack, or try again in a bit.` });
      // Behind a closed door with someone (QA 2026-11-06): don't pull them out mid-conversation.
      if (t.roomId && t.roomId !== me.roomId && rooms.get(t.roomId)?.closed) return void socket.emit("toast", { text: `${firstName(t.name)} is behind a closed door right now. Knock, or say hi on Slack.` });
      // Someone got there first: join them rather than pull the newcomer back and forth.
      const first = w.by && w.by !== me.id ? people.get(w.by) : undefined;
      if (first) return goToThem(`${firstName(first.name)} is already saying hi to ${firstName(t.name)}. Taking you over to join them.`);
      w.by = me.id;
      // You're behind a closed door: they're your guest, so let them in.
      if (me.roomId) {
        const r = rooms.get(me.roomId)!;
        if (r.closed && !r.admitted.includes(t.id)) {
          r.admitted.push(t.id);
          broadcastRoom(me.roomId);
        }
      }
      emitTo(t.id, "bring", { ...rounded(spotNear(me, t)), text: `👋 ${firstName(me.name)} wants to say hi, so we've brought you over to them.` });
      // Their first minutes are usually on the welcome screen, which looks like they've frozen.
      socket.emit("toast", { text: `Bringing ${firstName(t.name)} over to you. Say hi! It's their first time in, so they may still be reading the welcome screen. Give them a moment.` });
    });

    // Now the slow parts.
    let welcomeBonus = false;
    (async () => {
      if (isNew && me.userId) {
        openStretch(me.userId, me.status);
        // What their browser says, as a last resort for time and pay: a pay-profile timezone wins over it (tzOf).
        if (me.tz) await q(`UPDATE users SET tz = $1, last_seen = now() WHERE id = $2`, [me.tz, me.userId]);
        // Their streak (never holds up their arrival). Arriving counts today straight away.
        void refreshStreak(me, true).catch((e) => console.error("streak:", e));
        // Their first time on the floor: tell the team, so someone walks over and says hi.
        if (await firstArrival(me.userId)) {
          // Their first time in: a welcome bonus, celebrated once the snapshot is in (below).
          welcomeBonus = await award(me.userId, "welcome", POINTS.welcome, "Welcome to Office Spaces", "welcome").catch(() => false);
          welcomed.set(me.id, { at: Date.now(), by: null });
          for (const [k, v] of welcomed) if (Date.now() - v.at > WELCOME_MS) welcomed.delete(k);
          // …and send them the tour on Slack, to read when they like. Never holds up their arrival.
          if (me.email) void tellNewMember({ id: me.userId, email: me.email, slack_id: me.slackId, name: me.name }).catch((e) => console.error("welcome dm:", e));
          for (const o of people.values()) {
            if (o.id === me.id || o.guestRoom) continue;
            for (const sid of o.sockets) io.to(sid).emit("welcome", { id: me.id, name: me.name, title: me.title });
          }
        }
      }
      if (me.userId) {
        // Points before the snapshot, so the emote and pet menus open right; eggs for the floor check.
        await refreshPoints(me).catch((e) => console.error("points:", e));
        if (!me.eggs) me.eggs = new Set(await eggsFound(me.userId).catch(() => []));
        if (isNew) void anniversary(me).catch((e) => console.error("anniversary:", e));
      }
      const range = AUDIO_RANGES[await getSetting<"small" | "normal" | "large">("audioRange", "normal")] ?? AUDIO_RANGES.normal;
      if (!socket.connected) return;
      const others = [...people.values()].filter((x) => x.id !== id);
      socket.emit("snapshot", {
        me: { ...pub(me), livekitUrl: config.livekit.url, floorId: floor.id, slackTeamId: config.slack.teamId || null, calendarLinked: me.calendarLinked },
        people: me.guestRoom ? others.filter((o) => o.roomId === me.guestRoom).map(forGuest) : others.map(pub),
        rooms: Object.fromEntries(floor.rooms.filter((r) => !me.guestRoom || r.id === me.guestRoom).map((r) => [r.id, roomFor(me, r.id)])),
        audioRange: range,
        build: BUILD,
      });
      if (welcomeBonus) socket.emit("bonus", { points: POINTS.welcome, title: `Welcome to Acme, ${firstName(me.name)}!`, text: "Here's a head start. Earn more by being in the office, high-fiving teammates, posting wins and hunting for hidden easter eggs." });
    })().catch((e) => {
      console.error("connection setup failed:", e);
      socket.emit("kicked", { reason: "The office server hit an error. Reload to try again." });
      socket.disconnect(true);
    });
  });

  // Positions go out in one batch, ten times a second.
  setInterval(() => {
    if (!dirty.size) return;
    const batch: [string, number, number, string | null][] = [];
    for (const id of dirty) {
      const p = people.get(id);
      if (p) batch.push([id, p.x, p.y, p.roomId]);
    }
    dirty.clear();
    const gs = guests();
    if (!gs.length) {
      io.emit("moves", batch);
      return;
    }
    for (const p of people.values()) {
      if (!p.guestRoom) for (const s of p.sockets) io.to(s).emit("moves", batch);
    }
    for (const g of gs) {
      const sees = guestSees.get(g.id) ?? new Set<string>();
      const mine: typeof batch = [];
      for (const m of batch) {
        const other = people.get(m[0]);
        if (!other || other.id === g.id) {
          if (other) mine.push(m);
          continue;
        }
        const inRoom = other.roomId === g.guestRoom;
        if (inRoom && !sees.has(other.id)) {
          sees.add(other.id);
          for (const s of g.sockets) io.to(s).emit("join", forGuest(other));
        } else if (!inRoom && sees.has(other.id)) {
          sees.delete(other.id);
          for (const s of g.sockets) io.to(s).emit("leave", { id: other.id });
        }
        if (inRoom) mine.push(m);
      }
      guestSees.set(g.id, sees);
      if (mine.length) for (const s of g.sockets) io.to(s).emit("moves", mine);
    }
  }, 100);

  // last_seen doubles as the crash-recovery end time for open status stretches.
  setInterval(() => {
    const ids = [...people.values()].map((p) => p.userId).filter((x): x is number => x !== null);
    if (ids.length) q(`UPDATE users SET last_seen = now() WHERE id = ANY($1::int[])`, [ids]).catch((e) => console.error("last_seen:", e));
  }, 60_000);
}

function outsideDoor(roomId: string): Pt {
  const def = roomsById.get(roomId)!;
  const d = doorPoint(def);
  const out = { n: [0, -60], s: [0, 60], w: [-60, 0], e: [60, 0] }[def.door.side];
  return { x: d.x + out[0], y: d.y + out[1] };
}

// ── Streaks ────────────────────────────────────────────────────────────────

const cheered = new Map<number, string>(); // userId → the day a milestone was last cheered
async function refreshStreak(p: Live, arriving = false) {
  if (!p.userId) return;
  const tz = await tzOf(p.userId, p.tz);
  const st = await streakFor(p.userId, tz, true);
  if (!people.has(p.id)) return; // left while we were counting
  const changed = p.streak?.days !== st.days || p.streak?.today !== st.today;
  p.streak = st;
  if (changed) tellAll(p, "person", { id: p.id, streak: st });
  const today = dayIn(Date.now(), tz);
  // Not only on arrival: someone online across midnight reaches the milestone in the 30-minute recount (QA 2026-11-06).
  if (st.today && MILESTONES.has(st.days) && cheered.get(p.userId) !== today) {
    cheered.set(p.userId, today);
    void award(p.userId, "streak", st.days * POINTS.streakPerDay, `${st.days}-day streak`, `streak:${st.days}:${today}`).then((n) => { if (n) return refreshPoints(p); }).catch(() => {});
    for (const sid of p.sockets) io.to(sid).emit("toast", { text: `🔥 ${st.days} days in a row in the office! Keep the streak going.` });
  }
}
// Past midnight, an online person's "today" moves on: recount everyone in now and then.
setInterval(() => { for (const p of people.values()) if (p.userId) { void refreshStreak(p).catch(() => {}); void refreshPoints(p).catch(() => {}); } }, 30 * 60e3).unref();

// ── Points, high-fives, pets, eggs, anniversaries (shared/points.ts) ─────────

/** Recount someone's points; tell everyone if it changed. */
async function refreshPoints(p: Live) {
  if (!p.userId) return;
  const { total } = await breakdown(p.userId, p.since ?? null);
  if (!people.has(p.id) || p.points === total) return;
  p.points = total;
  tellAll(p, "person", { id: p.id, points: total });
}

/** Someone's points changed from outside the office (an admin award, a #wins post): recount, and tell them why. */
export async function pointsChanged(userId: number, text?: string) {
  const p = personForUser(userId);
  if (!p) return;
  await refreshPoints(p);
  if (text) for (const sid of p.sockets) io.to(sid).emit("toast", { text });
}

const HIGH_FIVE_REACH = 150;
const HIGH_FIVE_MS = 6000;
/** Whose hand is up, for whom. */
const handUp = new Map<string, { to: string; at: number }>();

function nearestTeammate(me: Live, reach: number): Live | undefined {
  let best: Live | undefined, bestD = reach;
  for (const o of people.values()) {
    if (o.id === me.id || !o.userId) continue;
    const d = Math.hypot(o.x - me.x, o.y - me.y);
    if (d <= bestD) { best = o; bestD = d; }
  }
  return best;
}

/** To teammates, and to guests who can see either of the two. */
function nearBoth<E extends "highfive" | "pat">(a: Live, b: Live, ev: E, payload: Parameters<S2C[E]>[0]) {
  for (const o of people.values()) {
    if (o.guestRoom && !(guestSees.get(o.id)?.has(a.id) || guestSees.get(o.id)?.has(b.id) || o.id === a.id || o.id === b.id)) continue;
    for (const sid of o.sockets) (io.to(sid).emit as any)(ev, payload);
  }
}

async function highFivePoints(a: Live, b: Live) {
  for (const [x, y] of [[a, b], [b, a]] as const) {
    if (!x.userId || (await countToday(x.userId, "highfive")) >= POINTS.highFivesPerDay) continue;
    if (await award(x.userId, "highfive", POINTS.highFive, `High-five with ${firstName(y.name)}`, null)) await refreshPoints(x);
  }
}

let spotsFor: Floor | null = null;
let spots: ReturnType<typeof eggSpots> = [];
/** Standing on an egg you haven't found: it's yours. */
function checkEggs(me: Live) {
  if (spotsFor !== floor) { spotsFor = floor; spots = eggSpots(floor); }
  for (const s of spots) {
    if (me.eggs!.has(s.id) || Math.hypot(s.at.x - me.x, s.at.y - me.y) > EGG_RADIUS) continue;
    me.eggs!.add(s.id); // straight away: one find, however many moves arrive meanwhile
    const egg = EGGS.find((e) => e.id === s.id)!;
    void (async () => {
      const first = !(await eggFoundByAnyone(egg.id));
      if (!(await award(me.userId!, "egg", POINTS.egg + (first ? POINTS.firstFinder : 0), `Found ${egg.name}${first ? " (first!)" : ""}`, egg.id))) return;
      emitTo(me.id, "egg", { id: egg.id, first });
      emitTo(me.id, "toast", { text: `${egg.badge} You found ${egg.name}! +${POINTS.egg + (first ? POINTS.firstFinder : 0)} points${first ? " (first ever to find it)" : ""}.` });
      if (first) for (const o of people.values()) if (o.id !== me.id && !o.guestRoom) for (const sid of o.sockets) io.to(sid).emit("toast", { text: `${egg.badge} ${firstName(me.name)} was the first to find ${egg.name}. There are more hidden around the office…` });
      await refreshPoints(me);
    })().catch((e) => console.error("egg:", e));
  }
}

/** Their work anniversary today: points once a year, a hat (drawn by the browser) and a cheer from the office. */
async function anniversary(p: Live) {
  if (!p.userId) return;
  const tz = await tzOf(p.userId, p.tz);
  const today = dayIn(Date.now(), tz);
  const years = anniversaryYears(p.since, today);
  if (!years) return;
  // The year's points are in tenure (POINTS.perYear); this row only makes the cheer happen once.
  if (!(await award(p.userId, "anniversary", 0, `${years} year${years === 1 ? "" : "s"} at Acme`, `anniv:${today.slice(0, 4)}`))) return;
  await refreshPoints(p);
  for (const o of people.values()) {
    if (o.guestRoom) continue;
    for (const sid of o.sockets) {
      io.to(sid).emit("celebrate", { id: p.id, years });
      io.to(sid).emit("toast", { text: o.id === p.id ? `🎉 Happy ${years}-year Acme anniversary! +${POINTS.perYear} points for the year.` : `🎉 ${p.name} has been at Acme ${years} year${years === 1 ? "" : "s"} today. Go say congrats!` });
    }
  }
}

/** A #wins post (server/wins.ts): a quiet bell and a banner for every teammate in the office. */
export function ringWin(name: string, text: string, img: number | null = null) {
  for (const o of people.values()) if (!o.guestRoom) for (const sid of o.sockets) io.to(sid).emit("win", { name: firstName(name), text, img });
}

/** The web build being served (web/dist/index.html → its index-*.js). Null in dev. */
const BUILD: string | null = (() => {
  try {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "web/dist/index.html"), "utf8");
    return html.match(/index-[\w-]+\.js/)?.[0] ?? null;
  } catch {
    return null;
  }
})();

const rounded = (p: Pt): Pt => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** A free spot beside someone. If they're behind a closed door you can't pass, outside that door. */
function spotNear(t: Live, me: Live): Pt {
  const pass = passableFor(me);
  if (t.roomId) {
    const r = rooms.get(t.roomId)!;
    if (r.closed && !pass(t.roomId)) return outsideDoor(t.roomId);
  }
  for (let rad = 60; rad <= 180; rad += 30) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
      const p = { x: t.x + Math.cos(a) * rad, y: t.y + Math.sin(a) * rad };
      if (!blocked(floor, p, pass) && (roomAt(floor, p)?.id ?? null) === t.roomId) return p;
    }
  }
  return { x: t.x, y: t.y };
}

export const onlineCount = () => people.size;
