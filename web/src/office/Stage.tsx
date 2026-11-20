// Gallery (G) and screen shares. A share from someone you can hear appears as
// a small "X is presenting" window you can expand; Gallery shows everyone you
// can hear as tiles, with any shares on top.

import { useEffect, useState } from "react";
import { Track, type LocalTrackPublication, type RemoteTrackPublication } from "livekit-client";
import { Icon } from "../icons";
import { useOffice, personName } from "./store";
import { videoFor, onMediaChange } from "./media";
import { VideoTile } from "./VideoTile";

type Share = { id: string; pub: LocalTrackPublication | RemoteTrackPublication };

export function Stage({ shares, compact, onExpand, onClose }: { shares: Share[]; compact?: boolean; onExpand?: () => void; onClose?: () => void }) {
  const s = useOffice();
  const [, tick] = useState(0);
  useEffect(() => onMediaChange(() => tick((x) => x + 1)), []);

  if (compact) {
    const first = shares[0];
    return (
      <div className="share-mini" onClick={onExpand} title="Expand">
        <VideoTile pub={first.pub} contain />
        <span className="share-label">{first.id === s.me?.id ? "You are presenting" : `${personName(first.id)} is presenting`}{shares.length > 1 ? ` +${shares.length - 1}` : ""}</span>
      </div>
    );
  }

  const heard = [s.me!, ...[...s.people.values()].filter((p) => (s.hearing.get(p.id) ?? 0) > 0)];
  return (
    <div className="gallery">
      <header className="gallery-head">
        <h3>{shares.length ? "Presenting" : "Gallery"} · {heard.length} {heard.length === 1 ? "person" : "people"} you can hear</h3>
        <button className="ghost" onClick={onClose} aria-label="Close gallery"><Icon name="close" /></button>
      </header>
      {shares.length ? (
        <div className="shares">
          {shares.map((sh) => (
            <figure key={sh.id} className="share">
              <VideoTile pub={sh.pub} contain />
              <figcaption>{sh.id === s.me?.id ? "Your screen" : `${personName(sh.id)}'s screen`}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}
      <div className={`tiles n${Math.min(heard.length, 9)}`}>
        {heard.map((p) => {
          const cam = p.cam ? videoFor(p.id, Track.Source.Camera) : null;
          return (
            <figure key={p.id} className={`tile${s.speaking.has(p.id) ? " speaking" : ""}`}>
              {cam ? <VideoTile pub={cam} mirror={p.id === s.me?.id} /> : (
                <div className="tile-photo">{p.avatar ? <img src={p.avatar} alt="" referrerPolicy="no-referrer" /> : <span>{p.name[0]}</span>}</div>
              )}
              <figcaption>
                {p.id === s.me?.id ? "You" : p.name}
                {!p.mic ? <Icon name="micOff" size={14} /> : null}
              </figcaption>
            </figure>
          );
        })}
      </div>
      {heard.length === 1 && !shares.length ? <p className="hint center">Nobody's in earshot. Walk up to someone, or into a room.</p> : null}
    </div>
  );
}
