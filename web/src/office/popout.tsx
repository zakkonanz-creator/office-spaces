// Pop-out: a small always-on-top window that floats over Slack, so the office
// can sit beside your real work. Chrome/Edge's Document Picture-in-Picture puts
// live React UI in it; elsewhere we fall back to video picture-in-picture.

import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { Track } from "livekit-client";
import { Icon } from "../icons";
import { useOffice, personName, roomName } from "./store";
import { videoFor, onMediaChange } from "./media";
import { VideoTile } from "./VideoTile";

declare global {
  interface Window {
    documentPictureInPicture?: { requestWindow(o: { width: number; height: number }): Promise<Window>; window: Window | null };
  }
}

interface Controls {
  onMic: () => void;
  onCam: () => void;
}

export async function openPopout(c: Controls) {
  const dpip = window.documentPictureInPicture;
  if (!dpip) {
    const v = document.querySelector<HTMLVideoElement>(".avatar.heard video, .avatar.me video");
    if (v && document.pictureInPictureEnabled) return void (await v.requestPictureInPicture());
    throw new Error("Pop-out needs Chrome or Edge.");
  }
  if (dpip.window) return dpip.window.focus();
  const win = await dpip.requestWindow({ width: 300, height: 420 });
  // Bring our styles along.
  for (const sheet of [...document.styleSheets]) {
    try {
      const style = win.document.createElement("style");
      style.textContent = [...sheet.cssRules].map((r) => r.cssText).join("\n");
      win.document.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = win.document.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        win.document.head.appendChild(link);
      }
    }
  }
  win.document.body.className = "pip-body";
  const mount = win.document.createElement("div");
  win.document.body.appendChild(mount);
  const root = createRoot(mount);
  root.render(<Mini {...c} />);
  win.addEventListener("pagehide", () => root.unmount());
}

function Mini({ onMic, onCam }: Controls) {
  const s = useOffice();
  const [, tick] = useState(0);
  useEffect(() => onMediaChange(() => tick((x) => x + 1)), []);
  const me = s.me!;
  const near = [...s.people.values()].filter((p) => (s.hearing.get(p.id) ?? 0) > 0);
  return (
    <div className="pip">
      <div className="pip-head">
        <b>{roomName(me.roomId) ?? "Open floor"}</b>
        <span className="muted">{near.length ? `${near.length} nearby` : "Nobody nearby"}</span>
      </div>
      <div className="pip-tiles">
        {[me, ...near].slice(0, 6).map((p) => {
          const cam = p.cam ? videoFor(p.id, Track.Source.Camera) : null;
          return (
            <div key={p.id} className={`pip-tile${s.speaking.has(p.id) ? " speaking" : ""}`}>
              {cam ? <VideoTile pub={cam} mirror={p.id === me.id} /> : p.avatar ? <img src={p.avatar} alt="" referrerPolicy="no-referrer" /> : <span>{p.name[0]}</span>}
              <em>{p.id === me.id ? "You" : personName(p.id).split(" ")[0]}</em>
            </div>
          );
        })}
      </div>
      <div className="pip-bar">
        <button className={me.mic ? "" : "off"} onClick={onMic} aria-label="Microphone"><Icon name={me.mic ? "mic" : "micOff"} /></button>
        <button className={me.cam ? "" : "off"} onClick={onCam} aria-label="Camera"><Icon name={me.cam ? "cam" : "camOff"} /></button>
      </div>
    </div>
  );
}
