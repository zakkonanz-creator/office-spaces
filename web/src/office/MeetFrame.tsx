// A GHL Meeting Room inside the office. The page is GHL's own; we only give it
// the camera and mic and a frame. Closing the panel ends the meeting state.

import { useOffice } from "./store";
import { leaveMeet, meetFrame, popOutMeet } from "./meet";
import "../meet.css";

export function MeetFrame() {
  useOffice();
  const f = meetFrame();
  if (!f) return null;
  return (
    <section className="meet-frame" aria-label="Meeting">
      <header>
        <span className="meet-dot" aria-hidden />
        <b>{f.label}</b>
        <span className="muted">· the office is muted for you</span>
        <span className="grow" />
        <button className="small" onClick={popOutMeet} title="Open the meeting in its own tab">Pop out</button>
        <button className="primary small" onClick={() => void leaveMeet()}>Leave meeting</button>
      </header>
      <iframe src={f.url} title={f.label} allow="camera; microphone; display-capture; autoplay; fullscreen; clipboard-write" />
    </section>
  );
}
