// "You're joining Acme": camera preview, devices, then in. The usual
// pre-join shape so nobody has to learn a new door.

import { useEffect, useRef, useState } from "react";
import type { LocalTrack } from "livekit-client";
import { Icon } from "../icons";
import { allowWhere, listDevices, noDevices, previewTracks, prefs, savePref } from "./media";

export interface JoinChoice {
  mic: boolean;
  cam: boolean;
}

/** What went wrong with the camera/mic, and where to allow it on this device. */
function allowHow(what: string): string {
  if (noDevices()) return `This address isn't secure (https), so the browser can't offer your ${what}. You can still join without them.`;
  return `Your ${what} is blocked. To use it, ${allowWhere()}, then reload.`;
}

export function PreJoin({ name, onJoin }: { name: string; onJoin: (c: JoinChoice) => void }) {
  const [mic, setMic] = useState(read("es.join.mic", "1") === "1");
  const [cam, setCam] = useState(read("es.join.cam", "1") === "1");
  const [devices, setDevices] = useState<{ mics: MediaDeviceInfo[]; cams: MediaDeviceInfo[]; speakers: MediaDeviceInfo[] }>({ mics: [], cams: [], speakers: [] });
  const [micId, setMicId] = useState(prefs.mic);
  const [camId, setCamId] = useState(prefs.cam);
  const [speakerId, setSpeakerId] = useState(prefs.speaker);
  const [error, setError] = useState("");
  const [level, setLevel] = useState(0);
  const [skip, setSkip] = useState(read("es.skipJoin", "0") === "1");
  const video = useRef<HTMLVideoElement>(null);
  const tracks = useRef<LocalTrack[]>([]);

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let ctx: AudioContext | null = null;
    (async () => {
      tracks.current.forEach((t) => t.stop());
      tracks.current = [];
      try {
        // A blocked mic shouldn't also hide the camera preview: fall back to video only.
        const t = await previewTracks(cam).catch((e) => (cam ? previewTracks(cam, false).then((v) => { setError(allowHow("microphone")); return v; }) : Promise.reject(e)));
        if (cancelled) return t.forEach((x) => x.stop());
        tracks.current = t;
        const v = t.find((x) => x.kind === "video");
        if (v && video.current) v.attach(video.current);
        const a = t.find((x) => x.kind === "audio");
        if (a?.mediaStreamTrack) {
          ctx = new AudioContext();
          void ctx.resume().catch(() => {}); // iOS starts it suspended: the level bar would sit at zero
          const src = ctx.createMediaStreamSource(new MediaStream([a.mediaStreamTrack]));
          const an = ctx.createAnalyser();
          an.fftSize = 256;
          src.connect(an);
          const buf = new Uint8Array(an.frequencyBinCount);
          const tick = () => {
            an.getByteTimeDomainData(buf);
            let peak = 0;
            for (const b of buf) peak = Math.max(peak, Math.abs(b - 128));
            setLevel(peak / 128);
            raf = requestAnimationFrame(tick);
          };
          tick();
        }
        if (t.some((x) => x.kind === "audio")) setError("");
        const [mics, cams, speakers] = await Promise.all([listDevices("audioinput"), listDevices("videoinput"), listDevices("audiooutput")]);
        if (!cancelled) setDevices({ mics, cams, speakers });
      } catch (e) {
        setError(allowHow(cam ? "camera and microphone" : "microphone"));
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ctx?.close().catch(() => {});
    };
  }, [cam, micId, camId]);

  useEffect(() => () => tracks.current.forEach((t) => t.stop()), []);

  const join = () => {
    tracks.current.forEach((t) => t.stop());
    write("es.join.mic", mic ? "1" : "0");
    write("es.join.cam", cam ? "1" : "0");
    write("es.skipJoin", skip ? "1" : "0");
    onJoin({ mic, cam });
  };

  return (
    <div className="prejoin">
      <div className="prejoin-card">
        <p className="eyebrow">You're joining</p>
        <h1>Acme</h1>
        <div className="prejoin-body">
          <div className={`prejoin-preview${cam ? "" : " off"}`}>
            {cam ? <video ref={video} autoPlay playsInline muted /> : <div className="prejoin-initials">{name.split(" ").map((w) => w[0]).slice(0, 2).join("")}</div>}
            <span className="prejoin-name">{name}</span>
            <div className="prejoin-toggles">
              <button className={`round${mic ? "" : " off"}`} onClick={() => setMic(!mic)} aria-label={mic ? "Mute" : "Unmute"}>
                <Icon name={mic ? "mic" : "micOff"} />
              </button>
              <button className={`round${cam ? "" : " off"}`} onClick={() => setCam(!cam)} aria-label={cam ? "Camera off" : "Camera on"}>
                <Icon name={cam ? "cam" : "camOff"} />
              </button>
            </div>
          </div>
          <div className="prejoin-fields">
            {devices.cams.length ? <label>
              Camera
              <select value={camId} onChange={(e) => { setCamId(e.target.value); savePref("cam", e.target.value); }} disabled={!cam}>
                {devices.cams.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "Camera"}</option>)}
              </select>
            </label> : null}
            {devices.mics.length ? <label>
              Microphone
              <select value={micId} onChange={(e) => { setMicId(e.target.value); savePref("mic", e.target.value); }}>
                {devices.mics.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "Microphone"}</option>)}
              </select>
              <span className="level"><span style={{ width: `${Math.min(100, level * 220)}%` }} /></span>
            </label> : null}
            {devices.speakers.length ? (
              <label>
                Speakers
                <select value={speakerId} onChange={(e) => { setSpeakerId(e.target.value); savePref("speaker", e.target.value); }}>
                  {devices.speakers.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "Speakers"}</option>)}
                </select>
              </label>
            ) : null}
            {error ? <p className="error">{error}</p> : null}
            <button className="primary big" onClick={join}>Join the office</button>
            <label className="check">
              <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
              Skip this page next time
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

export const skipJoin = () => read("es.skipJoin", "0") === "1";
export const lastJoin = (): JoinChoice => ({ mic: read("es.join.mic", "1") === "1", cam: read("es.join.cam", "1") === "1" });

function read(k: string, d: string) {
  try { return localStorage.getItem(k) ?? d; } catch { return d; }
}
function write(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* private window */ }
}
