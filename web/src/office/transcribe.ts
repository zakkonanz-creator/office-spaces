// Your part of "Transcribe this room": while you're a teammate in a room that's
// being transcribed, your browser records your own mic (nobody else's) in ~30 s
// clips and uploads the ones with speech in them. Leaving the room, muting in a
// Meet tab or the room stopping ends it. Guests never record.

import { useEffect, useRef } from "react";
import { Track } from "livekit-client";
import { getRoom } from "./media";
import { useOffice, toast } from "./store";
import { inMeet } from "./meet";

const CLIP_MS = 30_000;
/** Less speech than this in a clip: it isn't sent (and doesn't count against the monthly hours). */
const MIN_VOICED_MS = 600;
const LEVEL = 0.02; // RMS above room noise on a normal mic

const mimeType = () =>
  ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "";

class Capture {
  private stopped = false;
  private rec: MediaRecorder | null = null;
  private timer = 0;
  private ctx: AudioContext | null = null;

  constructor(private transcriptId: number) {
    void this.next();
  }

  private micTrack(): MediaStreamTrack | null {
    const t = getRoom()?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
    return t && t.readyState === "live" ? t : null;
  }

  /** One clip: record, measure how much of it was speech, upload if it's worth it, go again. */
  private async next() {
    if (this.stopped) return;
    const track = this.micTrack(); // fetched each clip: switching mics mid-meeting just works
    if (!track) {
      this.timer = window.setTimeout(() => void this.next(), 3000); // mic off or not started yet
      return;
    }
    const stream = new MediaStream([track]);
    const mime = mimeType();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 24_000 });
    } catch {
      toast("This browser can't record audio, so your voice isn't in this room's transcript.");
      return;
    }
    this.rec = rec;
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);

    // Speech detection: sample the level ten times a second.
    if (!this.ctx) {
      this.ctx = new AudioContext();
      // iOS keeps an AudioContext made without a tap suspended (the meter then reads silence): resume on the next one.
      const wake = () => void this.ctx?.resume().catch(() => {});
      window.addEventListener("pointerdown", wake, { once: true });
    }
    void this.ctx.resume().catch(() => {});
    const src = this.ctx.createMediaStreamSource(stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let samples = 0;
    let voiced = 0;
    let unmuted = track.enabled;
    const meter = window.setInterval(() => {
      if (track.enabled) unmuted = true;
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      samples++;
      if (track.enabled && Math.sqrt(sum / buf.length) > LEVEL) voiced++;
    }, 100);

    const started = performance.now();
    rec.onstop = () => {
      clearInterval(meter);
      src.disconnect();
      const dur = performance.now() - started;
      // A background tab throttles the meter, and a suspended audio context reads silence: when it
      // couldn't listen properly, send the clip anyway (marked unsure, so it doesn't keep the meeting
      // alive) and let the transcriber's own silence filter decide. Muted the whole time: nothing to send.
      const unsure = samples < (dur / 100) * 0.5 || this.ctx?.state !== "running";
      if (unmuted && (unsure || voiced * 100 >= MIN_VOICED_MS) && parts.length) void this.upload(new Blob(parts, { type: rec.mimeType || mime }), dur, unsure && voiced * 100 < MIN_VOICED_MS);
      if (!this.stopped) void this.next();
    };
    rec.start();
    this.timer = window.setTimeout(() => rec.state === "recording" && rec.stop(), CLIP_MS);
  }

  private async upload(blob: Blob, dur: number, unsure: boolean) {
    const type = (blob.type || "audio/webm").split(";")[0];
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`/api/transcripts/${this.transcriptId}/chunks?dur=${Math.round(dur)}${unsure ? "&unsure=1" : ""}`, { method: "POST", headers: { "content-type": type }, body: blob }).catch(() => null);
      if (r && r.status < 500) return; // done, or refused for good (stopped, left, over a limit): nothing to retry
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
    }
  }

  /** Stops after the current clip is sent: the last words before leaving still count. */
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.rec?.state === "recording") this.rec.stop();
    void this.ctx?.close().catch(() => {});
  }
}

export function useTranscribeCapture() {
  const s = useOffice();
  const me = s.me;
  const t = me?.roomId ? s.rooms[me.roomId]?.transcribing ?? null : null;
  const want = t && me && !me.guestRoom && !me.inMeeting && !inMeet() ? t.id : null;
  const cur = useRef<{ id: number; cap: Capture } | null>(null);
  const seen = useRef<number | null>(null);

  useEffect(() => {
    if (cur.current?.id === want) return;
    cur.current?.cap.stop();
    cur.current = want ? { id: want, cap: new Capture(want) } : null;
  }, [want]);

  // Walking into a room that's already being transcribed: say so, every time.
  useEffect(() => {
    if (!t || !me || seen.current === t.id) return;
    seen.current = t.id;
    if (t.by === me.id) return;
    toast(me.guestRoom
      ? "Acme is taking notes in this room. Guests' mics aren't recorded."
      : `${t.byName.split(" ")[0]} is transcribing this room. Your mic is part of it while you're here; leave the room to stop.`, { ttl: 9000 });
  }, [t?.id]);

  useEffect(() => () => cur.current?.cap.stop(), []);
}
