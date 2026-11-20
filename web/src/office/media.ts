// Proximity audio/video on LiveKit. Everyone on the floor is in one LiveKit
// room, but nobody subscribes to anyone automatically: four times a second we
// work out who you can hear (shared/floor.ts volumeBetween) and subscribe to
// exactly those people, at that volume. Far-away people cost nothing.

import {
  Room, RoomEvent, Track, LocalVideoTrack, VideoPresets, ScreenSharePresets, AudioPresets, DisconnectReason, createLocalTracks,
  type RemoteParticipant, type RemoteTrackPublication, type LocalTrackPublication,
} from "livekit-client";
import { BackgroundProcessor, supportsBackgroundProcessors } from "@livekit/track-processors";
import { volumeBetween } from "../../../shared/floor";
import { publishOnceReconnected } from "../../../shared/publishRetry";
import { state, live, bump, toast } from "./store";
import { quietWhile } from "./sounds";
import { applyTo, watchQuality } from "./quality";

export type Background = "none" | "blur" | "strong";

let room: Room | null = null;
let closedRoom: (id: string) => boolean = () => false;
const lastHeard = new Map<string, number>();
let allowedKey: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export const onMediaChange = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** LiveKit identities are opaque; the office's people list maps them back. */
function personForLk(lk: string): string | null {
  if (state.me?.lk === lk) return state.me.id;
  for (const p of state.people.values()) if (p.lk === lk) return p.id;
  return null;
}
const lkFor = (personId: string) => (state.me?.id === personId ? state.me.lk : state.people.get(personId)?.lk);

export const prefs = {
  get mic() { return read("es.mic", "") },
  get cam() { return read("es.cam", "") },
  get speaker() { return read("es.speaker", "") },
  get background() { return (read("es.bg", "none") as Background) },
};
function read(k: string, d: string) {
  try { return localStorage.getItem(k) ?? d; } catch { return d; }
}
export function savePref(k: "mic" | "cam" | "speaker" | "bg", v: string) {
  try { localStorage.setItem(`es.${k}`, v); } catch { /* private window */ }
}

let tick: ReturnType<typeof setInterval> | null = null;
let leaving = false;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let lastOpts: { mic: boolean; cam: boolean; isClosed: (id: string) => boolean } | null = null;

/**
 * Join the media room. Never leaves you half-connected: subscriptions start as
 * soon as the room is joined, and a mic or camera that fails (held by Zoom,
 * permission denied) is reported back as off instead of stopping everything.
 */
export async function connect(opts: { mic: boolean; cam: boolean; isClosed: (id: string) => boolean }): Promise<{ mic: boolean; cam: boolean }> {
  closedRoom = opts.isClosed;
  lastOpts = opts;
  leaving = false;
  const res = await fetch("/api/livekit-token", { method: "POST" });
  if (!res.ok) throw new Error("Couldn't get a media token");
  const { token, url } = await res.json();
  const r = new Room({
    // iOS only: it changes the audio path (and its echo cancelling) everywhere else, where .volume works.
    webAudioMix: isIOS(),
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: { resolution: VideoPresets.h360.resolution },
    publishDefaults: {
      simulcast: true,
      videoSimulcastLayers: [VideoPresets.h180],
      // Voice, not music: half the bitrate for the same clarity.
      audioPreset: AudioPresets.speech,
      // No redundant audio: RED re-sends every packet in the next one to cover UDP loss, but media
      // here runs over TCP (Railway has no UDP), which already retransmits. It only doubled the
      // audio bill — measured with the 60-person load test (loadtest/), where audio was most of it.
      red: false,
      // Screen shares: ~1.2 Mbps instead of the 2.5 Mbps default, plus a small layer
      // for people only seeing it in the mini window.
      screenShareEncoding: { maxBitrate: 1_200_000, maxFramerate: 15 },
      screenShareSimulcastLayers: [ScreenSharePresets.h360fps3],
    },
  });
  room = r;
  watchQuality(r);
  r
    .on(RoomEvent.TrackSubscribed, (track, pub, p) => {
      applyTo(pub); // lighter video, if this computer or connection needs it
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        el.dataset.person = personForLk(p.identity) ?? "";
        document.getElementById("audio-sink")?.appendChild(el);
        applyVolume(p);
      }
      emit();
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el) => el.remove());
      emit();
    })
    .on(RoomEvent.TrackPublished, () => emit())
    .on(RoomEvent.TrackUnpublished, () => emit())
    .on(RoomEvent.LocalTrackPublished, () => emit())
    .on(RoomEvent.LocalTrackUnpublished, () => emit())
    .on(RoomEvent.TrackMuted, () => emit())
    .on(RoomEvent.TrackUnmuted, () => emit())
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      // Only people you can actually hear: LiveKit reports speakers room-wide, and
      // a speaking ring must not give away who's talking behind a closed door.
      const next = new Set(speakers.map((s) => personForLk(s.identity))
        .filter((x): x is string => Boolean(x) && (x === state.me?.id || (state.hearing.get(x!) ?? 0) > 0)));
      if (next.size === state.speaking.size && [...next].every((x) => state.speaking.has(x))) return;
      state.speaking = next;
      bump();
    })
    .on(RoomEvent.Reconnecting, () => toast("Audio/video dropped — reconnecting…", { ttl: 6000 }))
    .on(RoomEvent.Reconnected, () => { toast("Audio/video back.", { ttl: 3000 }); allowedKey = null; })
    .on(RoomEvent.Disconnected, (reason) => {
      emit();
      if (leaving || r !== room || reason === DisconnectReason.DUPLICATE_IDENTITY || reason === DisconnectReason.PARTICIPANT_REMOVED) return;
      scheduleReconnect();
    });

  await r.connect(url, token, { autoSubscribe: false });
  retry = 0;
  r.localParticipant.setTrackSubscriptionPermissions(false, []);
  allowedKey = "";
  if (tick) clearInterval(tick);
  tick = setInterval(updateSubscriptions, 250);
  if (prefs.speaker) await r.switchActiveDevice("audiooutput", prefs.speaker).catch(() => {});
  await r.startAudio().catch(() => {}); // a click-to-play prompt handles blocked autoplay
  const mic = opts.mic ? await setMic(true).then(() => true, (e) => { deviceFailed("microphone", e); return false; }) : false;
  const cam = opts.cam ? await setCam(true).then(() => true, (e) => { deviceFailed("camera", e); return false; }) : false;
  return { mic, cam };
}

/** No camera/mic at all: a page that isn't https (phones testing a local build) never offers them. */
export const noDevices = () => typeof window !== "undefined" && (!window.isSecureContext || !navigator.mediaDevices);
/** Where to allow the camera/mic, in words that match the device (phones have no address-bar toggle). */
export function allowWhere(): string {
  if (isIOS()) return "on iPhone, tap aA in the address bar → Website Settings → allow it";
  if (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)) return "tap the icon left of the address → Permissions → allow it";
  return "allow it in the address bar";
}
let toldNoDevices = false;
function deviceFailed(what: "microphone" | "camera", e: unknown) {
  if (noDevices()) {
    if (!toldNoDevices) toast("This address isn't secure (https), so there's no camera or microphone here. Everything else works.", { ttl: 8000 });
    toldNoDevices = true;
    return;
  }
  const name = (e as Error)?.name ?? "";
  const why = name === "NotAllowedError" ? `${allowWhere()}, then reload` : name === "NotReadableError" ? `it's in use by another app (Zoom, Teams…)` : (e as Error)?.message ?? "unknown error";
  toast(`Your ${what} didn't start — ${why}. You're in with it off.`, { ttl: 12000 });
}

/** The media server went away (redeploy, long network drop): try again, backing off up to a minute. */
function scheduleReconnect() {
  if (retryTimer || !lastOpts) return;
  const wait = Math.min(60_000, 2000 * 2 ** retry) * (0.75 + Math.random() / 2);
  retry++;
  toast("Audio/video disconnected — reconnecting…", { ttl: Math.min(wait, 10000) });
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    if (leaving || !lastOpts) return;
    const me = state.me;
    try {
      const got = await connect({ ...lastOpts, mic: Boolean(me?.mic), cam: Boolean(me?.cam) });
      onReconnected?.(got);
      toast("Audio/video back.", { ttl: 3000 });
    } catch {
      scheduleReconnect();
    }
  }, wait);
}
let onReconnected: ((got: { mic: boolean; cam: boolean }) => void) | null = null;
/** The office tells the server what actually came back after a reconnect. */
export const setOnReconnected = (f: (got: { mic: boolean; cam: boolean }) => void) => { onReconnected = f; };

export const getRoom = () => room;

// ── Who to listen to ───────────────────────────────────────────────────────

function updateSubscriptions() {
  if (!room || !state.me) return;
  const meLive = live.get(state.me.id);
  if (!meLive) return;
  const me = { x: meLive.x, y: meLive.y, roomId: state.me.roomId };
  const now = Date.now();
  let changed = false;
  const seen = new Set<string>();
  for (const p of room.remoteParticipants.values()) {
    const pid = personForLk(p.identity);
    if (pid) seen.add(pid);
    const other = pid ? state.people.get(pid) : undefined;
    const pos = pid ? live.get(pid) : undefined;
    // Server-reported positions (tx/ty), not the on-screen eased ones: a hidden
    // tab doesn't animate, and you must still hear someone walk up to your desk
    // while you're working in another window.
    const them = other && pos ? { x: pos.tx, y: pos.ty, roomId: other.roomId } : null;
    const vol = them ? volumeBetween(me, them, closedRoom, state.audioRange) : 0;
    if (vol > 0) lastHeard.set(p.identity, now);
    if (them && vol > 0 && seesVideo(me, them)) lastSeen.set(p.identity, now);
    // Hysteresis: keep a stream for a moment after someone drifts out of range,
    // so walking along the edge of a conversation doesn't flap.
    const keepAudio = vol > 0 || now - (lastHeard.get(p.identity) ?? 0) < 1500;
    const keepVideo = keepAudio && now - (lastSeen.get(p.identity) ?? 0) < 1500;
    for (const pub of p.trackPublications.values()) {
      const keep = pub.source === Track.Source.Camera ? keepVideo : keepAudio;
      if (pub.isSubscribed !== keep) pub.setSubscribed(keep);
    }
    // The UI only needs coarse volume (rings, "can hear" lists): re-render on 10% steps,
    // not on every pixel someone moves.
    const coarse = Math.round(vol * 10) / 10;
    if (pid && (state.hearing.get(pid) ?? 0) !== coarse) {
      state.hearing.set(pid, coarse);
      changed = true;
    }
    applyVolume(p, vol);
  }
  // The other half of privacy: my browser only *lets* people subscribe to me if
  // they can hear me. A tampered client can't listen through a closed door,
  // because the speaker's own browser never grants it. Generous hysteresis so
  // the two sides' slightly different views of positions never cut a word.
  const allowed = [...room.remoteParticipants.keys()].filter((id) => now - (lastHeard.get(id) ?? 0) < 3000).sort();
  const key = allowed.join(",");
  if (key !== allowedKey) {
    allowedKey = key;
    room.localParticipant.setTrackSubscriptionPermissions(false, allowed.map((participantIdentity) => ({ participantIdentity, allowAll: true })));
  }
  for (const id of state.hearing.keys()) {
    if (!seen.has(id)) {
      state.hearing.delete(id);
      changed = true;
    }
  }
  if (changed) bump();
}

/**
 * Cameras reach fewer people than voices. Hearing the whole Tech Support room
 * (27 desks, one open room) is the point; streaming 26 cameras to every desk in
 * it is most of the hosting bill. So: everyone's camera in an office or meeting
 * room, but in a team room, the kitchen or the open floor only the people close
 * enough to be talking to you (median desk spacing is ~104px). Screen shares
 * still follow hearing range — those are put up on purpose.
 */
const VIDEO_RADIUS = 150;
const lastSeen = new Map<string, number>();
function seesVideo(a: { x: number; y: number; roomId: string | null }, b: { x: number; y: number; roomId: string | null }) {
  if (a.roomId && a.roomId === b.roomId) {
    const kind = state.floor?.rooms.find((r) => r.id === a.roomId)?.kind;
    if (kind === "office" || kind === "meeting") return true;
  }
  return Math.hypot(a.x - b.x, a.y - b.y) <= VIDEO_RADIUS;
}

/** Off while you're in a Meet tab, so the room doesn't echo through it. */
let meetingAudio = true;
/** Off while you're Focusing or Away with your mic off (pilot feedback): heads-down means you don't hear the floor either. */
let statusAudio = true;
let officeAudio = true;
quietWhile(() => !officeAudio);
function applyOfficeAudio() {
  const on = meetingAudio && statusAudio;
  if (on === officeAudio) return;
  officeAudio = on;
  if (room) for (const p of room.remoteParticipants.values()) applyVolume(p);
}
export function setOfficeAudio(on: boolean) {
  meetingAudio = on;
  applyOfficeAudio();
}
export function setStatusAudio(on: boolean) {
  statusAudio = on;
  applyOfficeAudio();
}
export const officeAudioOn = () => officeAudio;

function applyVolume(p: RemoteParticipant, vol?: number) {
  const pid = personForLk(p.identity);
  const v = vol ?? (pid ? state.hearing.get(pid) ?? 0 : 0);
  p.setVolume(!officeAudio || (pid && state.locallyMuted.has(pid)) ? 0 : v);
}

export function muteLocally(id: string, muted: boolean) {
  if (muted) state.locallyMuted.add(id);
  else state.locallyMuted.delete(id);
  const lk = lkFor(id);
  const p = lk ? room?.remoteParticipants.get(lk) : undefined;
  if (p) applyVolume(p);
  bump();
}

// ── My devices ─────────────────────────────────────────────────────────────

/** Throws when the device can't start; the caller says why and keeps the button honest. */
export async function setMic(on: boolean) {
  if (!room) throw new Error("audio/video isn't connected — reload to retry");
  await publishOnceReconnected(() => room!.localParticipant.setMicrophoneEnabled(on, prefs.mic ? { deviceId: prefs.mic } : undefined), () => room?.state === "connected");
  emit();
}

let processor: ReturnType<typeof BackgroundProcessor> | null = null;

export async function setCam(on: boolean) {
  if (!room) throw new Error("audio/video isn't connected — reload to retry");
  const pub = await room.localParticipant.setCameraEnabled(on, prefs.cam ? { deviceId: prefs.cam } : undefined);
  if (on && pub?.track) await applyBackground(pub.track as LocalVideoTrack, prefs.background);
  emit();
}

export async function setBackground(bg: Background) {
  savePref("bg", bg);
  const t = room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined;
  if (t) await applyBackground(t, bg);
  emit();
}

async function applyBackground(track: LocalVideoTrack, bg: Background) {
  if (!supportsBackgroundProcessors()) return;
  if (bg === "none") {
    if (track.getProcessor()) await track.stopProcessor();
    processor = null;
    return;
  }
  const radius = bg === "strong" ? 24 : 10;
  if (processor && track.getProcessor()) {
    await processor.switchTo({ mode: "background-blur", blurRadius: radius });
  } else {
    processor = BackgroundProcessor({ mode: "background-blur", blurRadius: radius });
    await track.setProcessor(processor);
  }
}

export const backgroundSupported = () => supportsBackgroundProcessors();

export async function setScreenShare(on: boolean): Promise<boolean> {
  if (!room) return false;
  try {
    await publishOnceReconnected(() => room!.localParticipant.setScreenShareEnabled(on, { audio: true, selfBrowserSurface: "exclude" }), () => room?.state === "connected");
    emit();
    return room.localParticipant.isScreenShareEnabled;
  } catch {
    emit();
    return false;
  }
}

export async function switchDevice(kind: "audioinput" | "videoinput" | "audiooutput", id: string) {
  savePref(kind === "audioinput" ? "mic" : kind === "videoinput" ? "cam" : "speaker", id);
  await room?.switchActiveDevice(kind, id).catch(() => {});
  emit();
}

// Safari never lists speakers. Asking anyway makes LiveKit open the mic again for permission, and on
// iOS a second mic capture mutes the one already in the call: so only ask where speakers can be switched.
const canPickSpeakers = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
export const listDevices = (kind: MediaDeviceKind) =>
  kind === "audiooutput" && !canPickSpeakers ? Promise.resolve([] as MediaDeviceInfo[]) : Room.getLocalDevices(kind, true).catch(() => [] as MediaDeviceInfo[]);

/** iPhone/iPad: audio elements ignore .volume there, so distance fade and "Mute for me" need Web Audio. */
export const isIOS = () => typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

// ── Tracks for the UI ──────────────────────────────────────────────────────

type Pub = RemoteTrackPublication | LocalTrackPublication;

export function videoFor(id: string, source: Track.Source = Track.Source.Camera): Pub | null {
  if (!room) return null;
  const lk = lkFor(id);
  const p = state.me?.id === id ? room.localParticipant : lk ? room.remoteParticipants.get(lk) : undefined;
  const pub = p?.getTrackPublication(source);
  if (!pub?.track || pub.isMuted) return null;
  return pub;
}

/** Everyone whose screen share you can currently see. */
export function screenShares(): { id: string; pub: Pub }[] {
  if (!room) return [];
  const out: { id: string; pub: Pub }[] = [];
  const local = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  if (local?.track && state.me) out.push({ id: state.me.id, pub: local });
  for (const p of room.remoteParticipants.values()) {
    const pub = p.getTrackPublication(Track.Source.ScreenShare);
    const pid = personForLk(p.identity);
    if (pid && pub?.track && pub.isSubscribed) out.push({ id: pid, pub });
  }
  return out;
}

export function micLevelOk(): boolean {
  return Boolean(room?.localParticipant.isMicrophoneEnabled);
}

export function disconnect() {
  leaving = true;
  if (tick) clearInterval(tick);
  tick = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  room?.disconnect();
  room = null;
  processor = null;
}

export async function previewTracks(cam: boolean, mic = true) {
  return createLocalTracks({
    audio: mic ? (prefs.mic ? { deviceId: prefs.mic } : true) : false,
    video: cam ? (prefs.cam ? { deviceId: prefs.cam, resolution: VideoPresets.h360.resolution } : { resolution: VideoPresets.h360.resolution }) : false,
  });
}
