import { useEffect, useRef } from "react";
import type { LocalTrackPublication, RemoteTrackPublication } from "livekit-client";

/** Attaches a LiveKit video track to a <video> for as long as it's mounted. */
export function VideoTile({ pub, mirror, contain }: { pub: LocalTrackPublication | RemoteTrackPublication; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    const track = pub.track;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [pub, pub.track]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      style={{ transform: mirror ? "scaleX(-1)" : undefined, objectFit: contain ? "contain" : "cover" }}
    />
  );
}
