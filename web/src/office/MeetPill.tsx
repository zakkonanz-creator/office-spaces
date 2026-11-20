// While you're in a recorded Meet, this stays on screen wherever you are, so
// "I'm back" is never hidden behind a room you've left or a closed panel.

import { useOffice } from "./store";
import { inMeet, leaveMeet, meetFrame } from "./meet";
import "../meet.css";

export function MeetPill() {
  useOffice(); // re-render when the meeting state changes (meet.ts bumps)
  if (!inMeet() || meetFrame()) return null; // the in-office panel has its own Leave
  return (
    <div className="meet-pill" role="status">
      <span className="meet-dot" aria-hidden />
      <span>In a meeting · the office is muted for you</span>
      <button className="primary small" onClick={() => void leaveMeet()}>I'm back</button>
    </div>
  );
}
