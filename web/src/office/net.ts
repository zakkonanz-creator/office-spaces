// The socket to the office server, wired into the store.

import { onboard } from "../onboard";
import { hand, stopHand } from "./handEdit";
import { io, type Socket } from "socket.io-client";
import type { C2S, S2C } from "../../../shared/protocol";
import { state, live, bump, toast, roomName, dismiss, personName } from "./store";
import { joinMeet, reassertMeet } from "./meet";
import { doorPoint, roomAt } from "../../../shared/floor";
import { arriveSound, ding, doorSound, highFiveSound, leaveSound, unlockSound, winBell } from "./sounds";
import { emoteDef, emoteMs } from "../../../shared/emotes";
import { playScreenFx } from "./screenFx";
import { stuckBounce } from "./stuck";
import { showWin } from "./Jumbotron";
import { newlyUnlocked } from "../../../shared/rewards";
import { arrivalNote } from "../../../shared/arrivals";
import { arrivalsOn } from "./sounds";

/** When each person last left (this tab's memory): back within minutes is a reload, not an arrival. */
const leftAt = new Map<string, number>();
/** The "is in" note showing for each person, so their first-time welcome can replace it. */
const arrivalToast = new Map<string, number>();

export type Sock = Socket<S2C, C2S>;

/** This tab's web build (the index-*.js it loaded); null in dev, where there's nothing to compare. */
export const myBuild = () => (document.querySelector('script[type="module"][src*="/assets/index-"]') as HTMLScriptElement | null)?.src.split("/").pop() ?? null;

/** Where the server last said *I* am (from position batches, the snapshot, or a correction).
 *  The frame loop re-sends my position if this is still somewhere else once I've stopped. */
export const serverMe = { x: NaN, y: NaN, at: 0 };

/** You'd hear this room's door: you're in the room, or within earshot of its door. */
function nearDoor(roomId: string): boolean {
  const me = state.me && live.get(state.me.id);
  const room = state.floor?.rooms.find((r) => r.id === roomId);
  if (!me || !room) return false;
  if (state.me!.roomId === roomId) return true;
  const d = doorPoint(room);
  return Math.hypot(d.x - me.x, d.y - me.y) <= state.audioRange;
}
let socket: Sock | null = null;
export const sock = () => socket!;

export function connectSocket(onKicked: (why: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tabId = Math.random().toString(36).slice(2);
    socket = io({
      // A function, so a reconnect sends where you are now, not where you were at page load.
      auth: (cb) => {
        const me = state.me;
        const pos = me && live.get(me.id);
        cb({
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          mobile: matchMedia("(pointer: coarse)").matches,
          tabId,
          resume: me && pos ? { x: pos.x, y: pos.y, status: me.status, statusText: me.statusText, mic: me.mic, cam: me.cam } : undefined,
        });
      },
      transports: ["websocket", "polling"],
    });
    const s = socket;
    let first = true;

    s.on("connect_error", (e) => {
      // Give up cleanly on the first failure: a socket left retrying in the
      // background would put you on everyone's floor behind an error screen.
      if (first) {
        first = false;
        s.disconnect();
        reject(e);
      }
    });

    s.on("snapshot", (snap) => {
      state.me = snap.me;
      serverMe.x = snap.me.x; serverMe.y = snap.me.y; serverMe.at = Date.now();
      state.people = new Map(snap.people.map((p) => [p.id, p]));
      state.rooms = snap.rooms;
      state.audioRange = snap.audioRange;
      // A deploy restarts the server, every tab reconnects and gets this: older tabs are told.
      if (snap.build && myBuild() && snap.build !== myBuild()) state.updateReady = true;
      live.clear();
      for (const p of [snap.me, ...snap.people]) live.set(p.id, { x: p.x, y: p.y, tx: p.x, ty: p.y });
      bump();
      if (first) {
        first = false;
        resolve();
      } else reassertMeet(); // a reconnect: the server's fresh view of us doesn't know we're in a Meet
    });

    s.on("join", (p) => {
      if (p.roomId && p.roomId === state.me?.roomId) arriveSound();
      const note = arrivalsOn() ? arrivalNote(p, state.me, leftAt.get(p.id), Date.now()) : null;
      if (note) arrivalToast.set(p.id, toast(note, { ttl: 3500 })); // no sound: a quiet note
      state.people.set(p.id, p);
      live.set(p.id, { x: p.x, y: p.y, tx: p.x, ty: p.y });
      bump();
    });

    s.on("leave", ({ id }) => {
      const gone = state.people.get(id);
      leftAt.set(id, Date.now());
      if (gone?.roomId && gone.roomId === state.me?.roomId) leaveSound();
      state.people.delete(id);
      state.emotes.delete(id);
      live.delete(id);
      state.hearing.delete(id);
      bump();
    });

    s.on("moves", (batch) => {
      let roomsChanged = false;
      for (const [id, x, y, roomId] of batch) {
        if (id === state.me?.id) {
          serverMe.x = x; serverMe.y = y; serverMe.at = Date.now();
          if (state.me.roomId !== roomId) {
            state.me.roomId = roomId;
            roomsChanged = true;
          }
          continue; // my own position is local
        }
        const pos = live.get(id);
        if (pos) {
          pos.tx = x;
          pos.ty = y;
        }
        const p = state.people.get(id);
        if (p && p.roomId !== roomId) {
          // Only rooms make these sounds: the open floor and the kitchen would never be quiet.
          const mine = state.me?.roomId;
          if (mine && roomId === mine) arriveSound();
          else if (mine && p.roomId === mine) leaveSound();
          p.roomId = roomId;
          roomsChanged = true;
        }
      }
      if (roomsChanged) bump();
    });

    s.on("person", (patch) => {
      if (patch.id === state.me?.id) {
        // Passed a reward: fireworks and the unlock card (not on the first count, not going down).
        const before = state.me.points;
        if (typeof before === "number" && typeof patch.points === "number") {
          const got = newlyUnlocked(before, patch.points);
          if (got.length) {
            state.unlocked = { items: got, at: Date.now() };
            unlockSound();
            const id = state.me.id;
            requestAnimationFrame(() => playScreenFx(got.some((r) => r.kind === "epic") ? "nova" : "fireworks", id));
          }
        }
        Object.assign(state.me, patch);
      }
      else {
        const p = state.people.get(patch.id);
        if (p) Object.assign(p, patch);
      }
      bump();
    });

    s.on("room", ({ roomId, ...r }) => {
      if (state.rooms[roomId] && state.rooms[roomId].closed !== r.closed && nearDoor(roomId)) doorSound(r.closed);
      state.rooms = { ...state.rooms, [roomId]: r };
      bump();
    });

    s.on("knock", ({ roomId, from }) => {
      const t = toast(`${from.name} is knocking${roomName(roomId) ? ` on ${roomName(roomId)}` : ""}`, {
        action: {
          label: "Let in",
          run: () => {
            s.emit("admit", { roomId, personId: from.id });
            dismiss(t);
          },
        },
      });
      ding();
    });

    s.on("admitted", ({ roomId }) => toast(`You've been let in${roomName(roomId) ? ` to ${roomName(roomId)}` : ""}`));
    s.on("emote", ({ id, name }) => {
      if (!name) state.emotes.delete(id);
      else {
        const at = Date.now();
        state.emotes.set(id, { name, at });
        // Nobody stops it: it ends by itself.
        setTimeout(() => { if (state.emotes.get(id)?.at === at) { state.emotes.delete(id); bump(); } }, emoteMs(name));
        // An epic one lights up the screen of whoever's near: you, someone you can hear, or your room.
        const fx = emoteDef(name)?.fx;
        const meId = state.me?.id;
        const near = id === meId || (state.hearing.get(id) ?? 0) > 0 || (state.people.get(id)?.roomId != null && state.people.get(id)?.roomId === state.me?.roomId);
        // After this render, so a new avatar is on the page to aim at.
        if (fx && near) requestAnimationFrame(() => playScreenFx(fx, id));
      }
      bump();
    });
    // High-fives: a hand up for someone, then the slap when they answer.
    s.on("highfive", ({ a, b, done }) => {
      if (!done) {
        state.handUp.set(a, { to: b, at: Date.now() });
        setTimeout(() => { if (Date.now() - (state.handUp.get(a)?.at ?? 0) >= 5900) { state.handUp.delete(a); bump(); } }, 6000);
        if (b === state.me?.id) toast(`✋ ${personName(a).split(" ")[0]} wants a high five! Press Y.`);
      } else {
        state.handUp.delete(a);
        state.handUp.delete(b);
        const at = Date.now();
        state.fives.set(a, at);
        state.fives.set(b, at);
        setTimeout(() => { state.fives.delete(a); state.fives.delete(b); bump(); }, 1300);
        const meId = state.me?.id;
        if (a === meId || b === meId || (state.hearing.get(a) ?? 0) > 0) highFiveSound();
      }
      bump();
    });
    s.on("pat", ({ to }) => {
      state.pats.set(to, Date.now());
      setTimeout(() => { state.pats.delete(to); bump(); }, 1600);
      bump();
    });
    s.on("win", ({ name, text, img }) => {
      state.win = { name, text, img, at: Date.now() };
      winBell();
      showWin();
      setTimeout(() => { if (state.win && Date.now() - state.win.at >= 7900) { state.win = null; bump(); } }, 8000);
      bump();
    });
    s.on("celebrate", ({ id }) => {
      const meId = state.me?.id;
      if (id === meId || (state.hearing.get(id) ?? 0) > 0 || (state.people.get(id)?.roomId != null && state.people.get(id)?.roomId === state.me?.roomId)) requestAnimationFrame(() => playScreenFx("fireworks", id));
    });
    // A bonus (first time in): wait for the welcome screen to close, then the big card and fireworks.
    s.on("bonus", (b) => {
      // Wait until onboarding has loaded and had a moment to open the welcome screen, then until that closes
      // (on a slow link the card could beat the welcome screen and sit on top of it).
      let settledAt = 0;
      const show = (tries = 0) => {
        if (tries < 600) {
          if (!onboard.loaded && tries < 20) return void setTimeout(() => show(tries + 1), 500); // ~10 s, then go on without it
          if (!settledAt) settledAt = tries;
          if (tries - settledAt < 3 || document.querySelector(".modal.welcome")) return void setTimeout(() => show(tries + 1), 500);
        }
        state.unlocked = { items: newlyUnlocked(Math.max(0, (state.me?.points ?? b.points) - b.points), state.me?.points ?? b.points), at: Date.now(), bonus: b };
        unlockSound();
        const id = state.me?.id;
        if (id) requestAnimationFrame(() => playScreenFx("fireworks", id));
        bump();
      };
      setTimeout(() => show(), 800);
    });
    s.on("egg", ({ id }) => {
      (state.myEggs ??= new Set()).add(id);
      bump();
    });
    s.on("react", ({ id, emoji }) => {
      state.reactions.set(id, { emoji, at: Date.now() });
      bump();
      setTimeout(bump, 3100);
    });
    s.on("nudge", ({ from }) => {
      toast(`👋 ${from.name} nudged you`);
      ding();
      if (document.hidden && "Notification" in window && Notification.permission === "granted") {
        new Notification("Office Spaces", { body: `${from.name} nudged you` });
      }
    });
    s.on("followRequest", ({ from }) => {
      const t = toast(`${from.name} wants you to follow them`, {
        action: {
          label: "Follow",
          run: () => {
            s.emit("follow", { to: from.id });
            dismiss(t);
          },
        },
      });
      ding();
    });
    s.on("place", ({ x, y }) => {
      serverMe.x = x; serverMe.y = y; serverMe.at = Date.now();
      const me = state.me && live.get(state.me.id);
      if (me) {
        // Bounced off a closed door (the client thought it could pass): say so instead of a silent hop.
        const heading = state.floor ? roomAt(state.floor, { x: me.tx, y: me.ty }) : null;
        if (heading && state.rooms[heading.id]?.closed && (roomAt(state.floor!, { x, y })?.id ?? null) !== heading.id) {
          toast(`The door to ${roomName(heading.id)} is closed — knock to be let in.`, { ttl: 5000 });
        } else stuckBounce(); // put back for no visible reason: if it keeps happening, they're stuck
        const far = Math.hypot(me.x - x, me.y - y) > 200;
        me.x = me.tx = x;
        me.y = me.ty = y;
        // A teleport ("Go to"): stop any walk in progress and bring the view back to you,
        // or you land somewhere off-screen and it looks like you froze.
        window.dispatchEvent(new CustomEvent("es:placed", { detail: { far } }));
      }
    });
    s.on("bring", ({ x, y, text }) => {
      if (state.me?.following) s.emit("follow", { to: null }); // following someone would walk you straight back
      toast(text, { ttl: 8000 });
      window.dispatchEvent(new CustomEvent("es:bring", { detail: { x, y } }));
    });
    s.on("toast", ({ text }) => toast(text));
    s.on("welcome", ({ id, name, title }) => {
      const quiet = arrivalToast.get(id);
      if (quiet) dismiss(quiet); // their first time: the welcome says it better
      const t = toast(`👋 ${name}${title ? `, ${title},` : ""} just walked into the office for the first time.`, {
        ttl: 45000,
        // Brings them over to you (the server says so to both of you).
        // You stay put (and your view comes back to you) so you see them arrive.
        action: { label: "Say hi", run: () => { s.emit("sayHi", { to: id }); window.dispatchEvent(new CustomEvent("es:placed", { detail: { far: true } })); dismiss(t); } },
      });
    });
    s.on("recordingNote", ({ title, url }) => toast(`Meeting notes are ready: ${title}`, url ? { action: { label: "Open", run: () => window.open(url, "_blank") } } : {}));
    s.on("kicked", ({ reason }) => onKicked(reason));
    s.on("meetingStarted", ({ roomId, meetUrl, byName, kind, label, auto }) => {
      const ghl = kind === "ghl";
      // You closed the door and that started the meeting: you go straight in.
      if (auto) return void joinMeet(meetUrl, roomId, { embed: true, label: label ?? "Meeting" });
      const where = roomName(roomId);
      const t = toast(`${byName.split(" ")[0]} started a ${ghl ? "" : "recorded "}meeting${where ? ` in ${where}` : ""}`, {
        ttl: 60000,
        action: { label: ghl ? "Join" : "Join Meet", run: () => { void joinMeet(meetUrl, roomId, ghl ? { embed: true, label: label ?? "Meeting" } : {}); dismiss(t); } },
      });
      ding();
    });
    s.on("floor", async (f) => {
      state.floor = f;
      // Someone else changed the office mid hand-edit: those edits were against the old plan.
      if (hand.on && !hand.applying) {
        stopHand();
        toast("Another admin just changed the office, so your hand edits were set aside — start again from the new layout.", { ttl: 10000 });
      }
      state.previewFloor = null;
      const r = await fetch("/api/desks");
      if (r.ok) state.desks = new Map((await r.json()).map((d: any) => [d.desk_id, { name: d.name, title: d.title }]));
      bump();
      toast("The office was just redesigned.");
    });
    s.on("disconnect", (why) => {
      if (why !== "io client disconnect") toast("Reconnecting…", { ttl: 3000 });
    });
  });
}

export { ding };
