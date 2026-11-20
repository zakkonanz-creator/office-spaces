// Camera auto-pause. A camera nobody is in front of still streams to everyone
// near your desk, and that video is most of the hosting bill. So the camera
// pauses when you go Away or Focusing, or when this tab has sat in the
// background for 10 minutes — and comes back by itself once you're Available
// and looking at the office again. Only a camera *we* paused comes back: turn
// it off yourself and it stays off.
//
// The background rule stands down while the pop-out is open (that's the office
// floating over Slack, still in use) and while you're in a room with someone
// you can hear — a meeting in another window is still a meeting.
//
// Focusing also mutes the mic (the owner, 2026-11-05): heads-down means nobody walking
// past hears you either. Same deal: it comes back when you're Available, unless
// you turned it on (or off) yourself in the meantime.
//
// Focusing and Away also silence the office for you (pilot feedback): you
// stop hearing the floor, and Away mutes your mic too so nobody hears a desk
// you've left. Turn your mic on yourself and the office sound comes back —
// someone walked up and you're talking to them.

import { useEffect } from "react";
import { state, useOffice, toast } from "./store";
import { sock } from "./net";
import * as media from "./media";

const HIDDEN_MS = 10 * 60e3;
let paused: null | "status" | "hidden" = null;
let micMuted = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Call when the person flips the camera themselves: their choice wins. */
export function clearCameraPause() {
  paused = null;
}
/** Call when the person flips the mic themselves: their choice wins. */
export function clearMicPause() {
  micMuted = false;
}

async function pause(reason: "status" | "hidden") {
  if (paused || !state.me?.cam) return;
  paused = reason;
  await media.setCam(false).catch(() => {});
  sock().emit("media", { cam: false });
  toast(
    reason === "status"
      ? "Camera paused while you're away — it comes back when you're Available."
      : "Camera paused — this tab was in the background for 10 minutes. It comes back when you return.",
    { action: { label: "Turn it on", run: () => void resume(true) } },
  );
}

/**
 * Coming back (a reload, a new tab) while Focusing or Away: don't start the mic or
 * camera at all, but remember them so going Available turns them on (the owner, 2026-11-09).
 * Returns what to actually connect with.
 */
export function holdForStatus(want: { mic: boolean; cam: boolean }): { mic: boolean; cam: boolean } {
  const status = state.me?.status;
  if (status !== "focusing" && status !== "away") return want;
  if (want.mic) micMuted = true;
  if (want.cam) paused = "status";
  if (want.mic || want.cam) toast(`Mic and camera stay off while you're ${status === "focusing" ? "Focusing" : "Away"}. They come on when you're Available.`);
  return { mic: false, cam: false };
}

/** Focusing or Away: mic muted, camera off and the office silent, in one go and one message. */
async function focus(status: "focusing" | "away") {
  const me = state.me;
  if (!me || me.inMeeting) return; // a meeting window manages its own devices (meet.ts)
  const mic = me.mic && !micMuted, cam = me.cam && !paused;
  if (mic) {
    micMuted = true;
    await media.setMic(false).catch(() => {});
  }
  if (cam) {
    paused = "status";
    await media.setCam(false).catch(() => {});
  }
  if (mic || cam) sock().emit("media", { ...(mic ? { mic: false } : {}), ...(cam ? { cam: false } : {}) });
  const what = [mic && "mic muted", cam && "camera off", "office sound off"].filter(Boolean).join(", ");
  const label = status === "focusing" ? "Focusing" : "Away";
  toast(`${what[0].toUpperCase()}${what.slice(1)} while you're ${label}. Turn your mic on to hear people again; Available brings it all back.`);
}

async function unmute() {
  if (!micMuted || state.me?.inMeeting || state.me?.status !== "available") return;
  micMuted = false;
  try {
    await media.setMic(true);
    sock().emit("media", { mic: true });
  } catch {
    toast("Your mic didn't come back on — turn it on from the toolbar.", { ttl: 10000 });
  }
}

async function resume(force = false) {
  if (!paused) return;
  // Not while a Meet tab has the camera — meet.ts puts it back after the call.
  if (state.me?.inMeeting) return;
  if (!force && (document.hidden || state.me?.status !== "available")) return;
  paused = null;
  try {
    await media.setCam(true);
    sock().emit("media", { cam: true });
  } catch {
    toast("Your camera didn't come back on — it may be in use by another app. Turn it on from the toolbar.", { ttl: 10000 });
  }
}

function inUse() {
  if (window.documentPictureInPicture?.window || document.pictureInPictureElement) return true;
  const me = state.me;
  if (!me?.roomId) return false;
  for (const [id, vol] of state.hearing) {
    if (vol > 0 && state.people.get(id)?.roomId === me.roomId) return true;
  }
  return false;
}

function arm() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(function check() {
    if (!document.hidden) return;
    if (inUse()) timer = setTimeout(check, 60e3);
    else void pause("hidden");
  }, HIDDEN_MS);
}

export function useCameraAutoPause() {
  const s = useOffice();
  const status = s.me?.status;
  const mic = Boolean(s.me?.mic);

  // Heads-down = you don't hear the floor, until you unmute to talk to someone.
  useEffect(() => {
    media.setStatusAudio(!((status === "focusing" || status === "away") && !mic));
  }, [status, mic]);

  useEffect(() => {
    if (status === "focusing" || status === "away") void focus(status);
    else if (status === "available") void unmute().then(() => resume());
  }, [status]);

  useEffect(() => {
    const onVis = () => {
      if (document.hidden) return arm();
      if (timer) clearTimeout(timer);
      void resume();
    };
    document.addEventListener("visibilitychange", onVis);
    if (document.hidden) arm();
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (timer) clearTimeout(timer);
    };
  }, []);
}
