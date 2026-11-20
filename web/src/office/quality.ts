// Lighter video when your computer or connection is struggling. Audio always
// comes first, so only video gives way: other people's cameras arrive at the small layer (180p,
// 15 fps) and yours is sent small. LiveKit already drops layers when bandwidth is short; this adds
// the cases it doesn't act on — a busy computer (the browser says it's limiting the camera for
// CPU, or the office itself is drawing slowly) and a connection LiveKit rates poor for a while.
//
// Automatic by default: on after a sustained problem, back to normal after 90 s of good
// conditions, a toast each way. Help → Video quality can make it always lighter (old laptops).

import { ConnectionQuality, ParticipantEvent, RoomEvent, Track, VideoQuality, type LocalVideoTrack, type RemoteTrackPublication, type Room } from "livekit-client";
import { bump, toast } from "./store";

export type QualityMode = "auto" | "lighter";
const KEY = "es.quality";
const POOR_MS = 10_000; // a poor connection this long → lighter
const SLOW_MS = 5_000; // the office drawing this slowly this long → lighter
const SLOW_FRAME_MS = 50; // under ~20 frames a second
const CPU_MS = 60_000; // a CPU warning counts for this long
const RECOVER_MS = 90_000; // good this long → back to normal

export const quality = {
  mode: ((): QualityMode => { try { return localStorage.getItem(KEY) === "lighter" ? "lighter" : "auto"; } catch { return "auto"; } })(),
  /** Automatic mode switched on (mode "lighter" is always on). */
  auto: false,
  /** Why automatic mode switched on, for Help. */
  why: null as null | "connection" | "computer",
};
export const isLighter = () => quality.mode === "lighter" || quality.auto;

let room: Room | null = null;
let poorSince = 0, slowSince = 0, cpuAt = 0, goodSince = 0;
let frameAvg = 16;

export function setQualityMode(m: QualityMode) {
  quality.mode = m;
  try { localStorage.setItem(KEY, m); } catch { /* private window: this visit only */ }
  applyAll();
  bump();
}

/** The office's frame loop reports each visible frame's length. */
export function noteFrame(ms: number) {
  frameAvg = frameAvg * 0.9 + Math.min(ms, 1000) * 0.1;
  const now = performance.now();
  if (frameAvg > SLOW_FRAME_MS) { if (!slowSince) slowSince = now; }
  else slowSince = 0;
}

/** One remote camera: the small layer when lighter, else whatever its tile size needs. */
export function applyTo(pub: RemoteTrackPublication) {
  if (pub.source !== Track.Source.Camera || !pub.isDesired) return;
  const lighter = isLighter();
  pub.setVideoQuality(lighter ? VideoQuality.LOW : VideoQuality.HIGH);
  pub.setVideoFPS(lighter ? 15 : 30);
}

function applyAll() {
  if (!room) return;
  for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) applyTo(pub);
  const cam = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined;
  cam?.setPublishingQuality(isLighter() ? VideoQuality.LOW : VideoQuality.HIGH);
}

export function watchQuality(r: Room) {
  room = r;
  r.on(RoomEvent.ConnectionQualityChanged, (q, p) => {
    if (p !== r.localParticipant) return;
    const bad = q === ConnectionQuality.Poor || q === ConnectionQuality.Lost;
    if (bad) { if (!poorSince) poorSince = performance.now(); }
    else poorSince = 0;
  });
  r.localParticipant.on(ParticipantEvent.LocalTrackCpuConstrained, () => { cpuAt = performance.now(); });
  // A camera turned on (or back on) while lighter starts out lighter too.
  r.on(RoomEvent.LocalTrackPublished, () => applyAll());
}

/** Every 2 s: switch automatic mode on or off. */
export function evaluate(now = performance.now()) {
  const poor = poorSince > 0 && now - poorSince >= POOR_MS;
  const slow = !document.hidden && slowSince > 0 && now - slowSince >= SLOW_MS;
  const cpu = cpuAt > 0 && now - cpuAt < CPU_MS;
  const bad = poor || slow || cpu;
  if (bad) goodSince = 0;
  else if (!goodSince) goodSince = now;
  if (!quality.auto && bad) {
    quality.auto = true;
    quality.why = poor ? "connection" : "computer";
    applyAll();
    if (quality.mode === "auto") {
      toast(poor
        ? "Your connection is struggling, so video is lighter for now (smaller, smoother). Audio comes first. It goes back up by itself."
        : "Your computer is working hard, so video is lighter for now (smaller, smoother). Audio comes first. It goes back up by itself.", { ttl: 9000 });
    }
    bump();
  } else if (quality.auto && !bad && goodSince && now - goodSince >= RECOVER_MS) {
    quality.auto = false;
    quality.why = null;
    applyAll();
    if (quality.mode === "auto") toast("Video quality is back to normal.", { ttl: 4000 });
    bump();
  }
}
setInterval(() => evaluate(), 2000);

/** Tests: pretend a signal fired (no way to make a real browser's CPU or network bad on cue). */
export const qualityTest = {
  cpu: () => { cpuAt = performance.now(); evaluate(); },
  recover: () => { cpuAt = 0; poorSince = 0; slowSince = 0; frameAvg = 16; goodSince = performance.now() - RECOVER_MS; evaluate(); },
};
