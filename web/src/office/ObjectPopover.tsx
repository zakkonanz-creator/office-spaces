import { useEffect, useState } from "react";
import type { Obj } from "../../../shared/floor";
import { Popover } from "./Office";
import { useOffice, bump } from "./store";
import { JumbotronFull } from "./Jumbotron";

/** Where the chess board takes you (Office.tsx opens it on click): a new game on chess.com, or the board's own url. */
export const CHESS_URL = "https://www.chess.com/play/online";

/** What happens when you click a link, the music flag, the timer, a sign or a note. */
export function ObjectPopover({ obj, at, onClose }: { obj: Obj; at: { x: number; y: number }; onClose: () => void }) {
  if (obj.type === "link") return <LinkPop obj={obj} at={at} onClose={onClose} />;
  if (obj.type === "music") return <MusicPop obj={obj} at={at} onClose={onClose} />;
  if (obj.type === "timer") return <TimerPop at={at} onClose={onClose} />;
  if (obj.type === "jumbotron") return <JumbotronFull onClose={onClose} />;
  return (
    <Popover at={at} onClose={onClose}>
      <p className="sign-text">{obj.text}</p>
    </Popover>
  );
}

function LinkPop({ obj, at, onClose }: { obj: Obj; at: { x: number; y: number }; onClose: () => void }) {
  const s = useOffice();
  useEffect(() => {
    if (obj.url) {
      window.open(obj.url, "_blank", "noopener");
      onClose();
    }
  }, []);
  if (obj.url) return null;
  return (
    <Popover at={at} onClose={onClose}>
      <h3>{obj.label}</h3>
      <p className="muted">This link hasn't been set yet.</p>
      {s.me?.role === "admin" ? (
        <p className="hint">Set it from the side panel → Design, e.g. “Set the {obj.label} link to https://…”. Links can only point to a URL you type.</p>
      ) : (
        <p className="hint">Ask an admin to add it.</p>
      )}
    </Popover>
  );
}

function MusicPop({ obj, at, onClose }: { obj: Obj; at: { x: number; y: number }; onClose: () => void }) {
  const s = useOffice();
  const on = s.music === obj.youtube;
  return (
    <Popover at={at} onClose={onClose}>
      <h3>Music</h3>
      <p className="muted">Plays only for you, in this tab. It keeps playing when you walk away.</p>
      <div className="row">
        <button className="primary" onClick={() => { s.music = on ? null : obj.youtube ?? null; bump(); }}>{on ? "Stop" : "Play"}</button>
      </div>
    </Popover>
  );
}

let timerEnd = 0;
let timerTotal = 5 * 60e3;
function TimerPop({ at, onClose }: { at: { x: number; y: number }; onClose: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, []);
  const left = timerEnd ? Math.max(0, timerEnd - Date.now()) : timerTotal;
  const mm = String(Math.floor(left / 60000)).padStart(2, "0");
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
  return (
    <Popover at={at} onClose={onClose}>
      <h3>Timer</h3>
      <div className="timer-face">{mm}:{ss}</div>
      <div className="row">
        {[5, 10, 25].map((m) => (
          <button key={m} className="small" onClick={() => { timerTotal = m * 60e3; timerEnd = 0; tick((x) => x + 1); }}>{m} min</button>
        ))}
      </div>
      <div className="row">
        <button className="primary" onClick={() => { timerEnd = timerEnd ? 0 : Date.now() + left; tick((x) => x + 1); }}>{timerEnd ? "Pause" : "Start"}</button>
        <button onClick={() => { timerEnd = 0; tick((x) => x + 1); }}>Reset</button>
      </div>
    </Popover>
  );
}
