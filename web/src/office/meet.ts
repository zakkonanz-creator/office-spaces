// Hand-off to a Fathom-recorded Google Meet. Fathom only joins Meet/Zoom/Teams,
// so a recorded room meeting happens in a Meet tab; while you're in it the
// office goes quiet for you (mic, camera and room audio off, so nothing
// echoes) and your avatar shows you're in the meeting.
//
// We can't watch the Meet tab: Meet sends Cross-Origin-Opener-Policy, which
// severs our handle to it the moment it loads (the handle reads `closed`
// immediately). So leaving is explicit — an "I'm back" button (always on
// screen while you're in one) — and returning to this tab after a while asks
// whether you're done. Walking out of the room also ends it.

import { state, bump, toast, dismiss } from "./store";
import { sock } from "./net";
import * as media from "./media";

let active: { roomId: string | null; since: number; restore: { mic: boolean; cam: boolean } } | null = null;
let askedId = 0;
/** A GHL Meeting Room shown inside the office (MeetFrame), instead of a tab. */
let frame: { url: string; label: string } | null = null;

export const inMeet = () => active !== null;
export const meetFrame = () => frame;

/**
 * Open the Meet and quiet the office. `roomId` is the room the meeting belongs
 * to (walking out of it ends the meeting state); it defaults to where you are.
 * Must run inside a click: after an `await`, browsers may block the new tab,
 * and then we offer a button that opens it on a fresh click.
 */
export async function joinMeet(url: string, roomId: string | null = state.me?.roomId ?? null, opts: { embed?: boolean; label?: string } = {}) {
  if (active) return;
  if (opts.embed) {
    // GHL lets its meeting page sit in a frame, so the meeting opens inside the office:
    // no tab to lose, and closing the panel is "I'm back".
    frame = { url, label: opts.label ?? "Meeting" };
    await quiet(roomId);
    toast("You're in the meeting. The office is muted for you; press “Leave meeting” when you're done.", { ttl: 8000 });
    return;
  }
  // Not "noopener" in the features: with it, window.open always returns null and
  // a blocked popup looks the same as an opened one. Cut the link by hand instead.
  const w = window.open(url, "_blank");
  if (!w) {
    toast("Your browser blocked the Meet tab.", { ttl: 30000, action: { label: "Open Meet", run: () => void joinMeet(url, roomId) } });
    return;
  }
  try {
    w.opener = null;
  } catch {
    /* already cross-origin */
  }
  await quiet(roomId);
  toast("You're in the Meet — the office is muted for you. Press “I'm back” when you're done.", { ttl: 8000 });
}

/** The office goes quiet for you while you're in a meeting, so nothing echoes. */
async function quiet(roomId: string | null) {
  const me = state.me!;
  active = { roomId, since: Date.now(), restore: { mic: me.mic, cam: me.cam } };
  // Turning devices off can't really fail; if media is down there's nothing to turn off.
  if (me.mic) await media.setMic(false).catch(() => {});
  if (me.cam) await media.setCam(false).catch(() => {});
  media.setOfficeAudio(false);
  sock().emit("media", { mic: false, cam: false, inMeeting: true });
  bump();
}

/** Move an in-office meeting to its own tab (if GHL ever refuses the frame, or for more room). */
export function popOutMeet() {
  if (!frame) return;
  const w = window.open(frame.url, "_blank");
  if (!w) return toast("Your browser blocked the new tab.", { ttl: 8000 });
  try {
    w.opener = null;
  } catch {
    /* already cross-origin */
  }
  frame = null;
  toast("The meeting is in its own tab now. Press “I'm back” when you're done.", { ttl: 8000 });
  bump();
}

export async function leaveMeet() {
  if (!active) return;
  const r = active.restore;
  active = null;
  frame = null;
  if (askedId) dismiss(askedId);
  askedId = 0;
  media.setOfficeAudio(true);
  // Back on only what actually restarts (the Meet tab may still hold the camera).
  const mic = r.mic ? await media.setMic(true).then(() => true, () => false) : false;
  const cam = r.cam ? await media.setCam(true).then(() => true, () => false) : false;
  if ((r.mic && !mic) || (r.cam && !cam)) toast(`Your ${r.mic && !mic ? "microphone" : "camera"} didn't come back — it may still be in use by the Meet tab. Turn it on from the toolbar.`, { ttl: 10000 });
  sock().emit("media", { mic, cam, inMeeting: false });
  toast("Welcome back to the office.");
  bump();
}

/** After a reconnect the server has forgotten you're in a meeting: say so again. */
export function reassertMeet() {
  if (active) sock().emit("media", { mic: false, cam: false, inMeeting: true });
}

// Coming back to this tab after a minute or more: offer to end the meeting state.
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !active || frame || askedId || Date.now() - active.since < 60_000) return;
  const id = toast("Back from the meeting?", {
    ttl: 30000,
    action: { label: "I'm back", run: () => void leaveMeet() },
  });
  askedId = id;
  // Only clear our own prompt: a newer one may have replaced it meanwhile.
  setTimeout(() => {
    if (askedId === id) askedId = 0;
  }, 30000);
});

/** Walking out of the room you joined the meeting from ends it. */
export function roomChanged(roomId: string | null) {
  if (active && active.roomId && roomId !== active.roomId) void leaveMeet();
}
