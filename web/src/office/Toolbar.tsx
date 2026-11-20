import { useEffect, useState } from "react";
import type { Status } from "../../../shared/protocol";
import { Icon } from "../icons";
import { useOffice, toast } from "./store";
import { sock } from "./net";
import * as media from "./media";
import { ClockPill } from "../time/ClockPill";
import { MyStreak } from "./Streak";
import { EMOTES, LEVELS, MAX_LEVEL, levelOf, unlocked } from "../../../shared/emotes";
import { fmtPoints } from "../../../shared/points";

const EMOJI = ["👋", "👍", "😂", "❤️", "🎉", "👏", "🙌", "🤔", "☕", "🔥", "✅", "👀"];

export const STATUS_LABEL: Record<Status, string> = { available: "Available", away: "Away", focusing: "Focusing" };

interface Props {
  onMic: () => void;
  onCam: () => void;
  onShare: () => void;
  onStatus: (s: Status, text?: string) => void;
  onGallery: () => void;
  onPopout: () => void;
  emojiOpen: boolean;
  setEmojiOpen: (v: boolean) => void;
  panelOpen: boolean;
  onPanel: () => void;
}

// Phones (the owner, 2026-11-09): no screen sharing in mobile browsers, and a pop-out that
// "floats over Slack" is a desktop idea, so those two buttons only show where they work.
const canShare = () => typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";
const isTouch = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export function Toolbar(p: Props) {
  const s = useOffice();
  const me = s.me!;
  const [menu, setMenu] = useState<null | "status" | "cam" | "mic">(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => !(e.target as HTMLElement).closest(".tool-menu, .tool") && setMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);
  // The React/emote menu closes when you click anywhere else (not just the React button again).
  useEffect(() => {
    if (!p.emojiOpen) return;
    const close = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".emoji-menu, .react-btn")) p.setEmojiOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [p.emojiOpen]);

  return (
    <div className="toolbar-wrap">
      <button className={`tool panel-toggle${p.panelOpen ? " on" : ""}`} onClick={p.onPanel} title="People (C)" data-tour="people">
        <Icon name="people" />
        <span>People</span>
      </button>
      {me.guestRoom ? null : <ClockPill />}
      {me.guestRoom ? null : <MyStreak me={me} />}
      <div className="toolbar">
        <div className="tool-split">
          <button className={`tool${me.cam ? "" : " off"}`} onClick={p.onCam} title="Camera (1)">
            <Icon name={me.cam ? "cam" : "camOff"} />
            <span>Camera</span>
          </button>
          <button className="tool caret" onClick={() => setMenu(menu === "cam" ? null : "cam")} aria-label="Camera settings"><Icon name="chevron" size={14} /></button>
        </div>
        <div className="tool-split">
          <button className={`tool${me.mic ? "" : " off"}`} onClick={p.onMic} title="Microphone (2)">
            <Icon name={me.mic ? "mic" : "micOff"} />
            <span>Mic</span>
          </button>
          <button className="tool caret" onClick={() => setMenu(menu === "mic" ? null : "mic")} aria-label="Microphone settings"><Icon name="chevron" size={14} /></button>
        </div>
        <button data-tour="status" className={`tool status-btn status-${me.status}`} onClick={() => setMenu(menu === "status" ? null : "status")} title="Status (3/4/5)">
          <span className="status-dot" />
          <span>{STATUS_LABEL[me.status]}</span>
        </button>
        {canShare() || me.sharing ? (
          <button className={`tool${me.sharing ? " live" : ""}`} onClick={p.onShare} title="Present your screen">
            <Icon name="screen" />
            <span>{me.sharing ? "Stop" : "Present"}</span>
          </button>
        ) : null}
        <button className={`tool react-btn${p.emojiOpen ? " on" : ""}`} onClick={() => p.setEmojiOpen(!p.emojiOpen)} title="React (:) · Emote (E)">
          <Icon name="smile" />
          <span>React</span>
        </button>
        <button className="tool" onClick={p.onGallery} title="Gallery (G)">
          <Icon name="gallery" />
          <span>Gallery</span>
        </button>
        {isTouch() ? null : (
          <button className="tool" onClick={p.onPopout} title="Pop out a mini window that floats over Slack">
            <Icon name="popout" />
            <span>Pop-out</span>
          </button>
        )}

        {menu === "status" ? <StatusMenu onPick={(st, text) => { p.onStatus(st, text); }} close={() => setMenu(null)} /> : null}
        {menu === "cam" ? <DeviceMenu kind="videoinput" close={() => setMenu(null)} /> : null}
        {menu === "mic" ? <DeviceMenu kind="audioinput" close={() => setMenu(null)} /> : null}
        {p.emojiOpen ? (
          <div className="tool-menu emoji-menu">
            {EMOJI.map((e) => (
              <button key={e} onClick={() => { sock().emit("react", { emoji: e }); p.setEmojiOpen(false); }}>{e}</button>
            ))}
            <EmoteGrid points={me.points ?? 0} guest={Boolean(me.guestRoom)} close={() => p.setEmojiOpen(false)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StatusMenu({ onPick, close }: { onPick: (s: Status, text?: string) => void; close: () => void }) {
  const s = useOffice();
  const me = s.me!;
  const [text, setText] = useState(me.statusText);
  const since = new Date(me.statusSince).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div className="tool-menu status-menu">
      <p className="menu-title">Set your availability</p>
      <div className="seg">
        {(["available", "away", "focusing"] as Status[]).map((st) => (
          <button key={st} className={`status-${st}${me.status === st ? " on" : ""}`} onClick={() => onPick(st)}>
            <span className="status-dot" />
            {STATUS_LABEL[st]}
          </button>
        ))}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); onPick(me.status, text); close(); }}>
        <input value={text} maxLength={80} placeholder="What's your status? e.g. Please Slack if urgent" onChange={(e) => setText(e.target.value)} />
      </form>
      <p className="hint">{STATUS_LABEL[me.status]} since {since}{me.autoAway ? " · set automatically while you were idle" : ""}</p>
    </div>
  );
}

function DeviceMenu({ kind, close }: { kind: "audioinput" | "videoinput"; close: () => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [bg, setBg] = useState(media.prefs.background);
  const current = kind === "audioinput" ? media.prefs.mic : media.prefs.cam;
  useEffect(() => {
    media.listDevices(kind).then(setDevices);
    if (kind === "audioinput") media.listDevices("audiooutput").then(setSpeakers);
  }, [kind]);
  return (
    <div className="tool-menu device-menu">
      <p className="menu-title">{kind === "audioinput" ? "Microphone" : "Camera"}</p>
      {devices.map((d) => (
        <button key={d.deviceId} className={d.deviceId === current ? "on" : ""} onClick={() => { media.switchDevice(kind, d.deviceId); close(); }}>
          {d.label || (kind === "audioinput" ? "Microphone" : "Camera")}
        </button>
      ))}
      {kind === "audioinput" && speakers.length ? (
        <>
          <p className="menu-title">Speakers</p>
          {speakers.map((d) => (
            <button key={d.deviceId} className={d.deviceId === media.prefs.speaker ? "on" : ""} onClick={() => { media.switchDevice("audiooutput", d.deviceId); close(); }}>
              {d.label || "Speakers"}
            </button>
          ))}
        </>
      ) : null}
      {kind === "videoinput" ? (
        <>
          <p className="menu-title">Background</p>
          {media.backgroundSupported() ? (
            <div className="seg">
              {(["none", "blur", "strong"] as const).map((b) => (
                <button key={b} className={bg === b ? "on" : ""} onClick={() => { setBg(b); media.setBackground(b).catch(() => toast("This browser can't blur the background.")); }}>
                  {b === "none" ? "None" : b === "blur" ? "Blur" : "Heavy blur"}
                </button>
              ))}
            </div>
          ) : (
            <p className="hint">Background blur needs Chrome, Edge or a recent Safari.</p>
          )}
        </>
      ) : null}
    </div>
  );
}

/** The emotes: day-one ones, then the ones points unlock (locked ones say how many points). */
function EmoteGrid({ points, guest, close }: { points: number; guest?: boolean; close: () => void }) {
  const [lol, setLol] = useState(false);
  const btn = (e: (typeof EMOTES)[number]) => {
    const open = unlocked(e.id, points);
    const need = e.points;
    const hint = "blurb" in e ? `${e.label}: ${e.blurb}` : e.label;
    return (
      <button key={e.id} className={`emote-btn${"epic" in e ? " epic" : ""}${open ? "" : " locked"}`} disabled={!open}
        onClick={() => { sock().emit("emote", { name: e.id }); close(); }}
        title={open ? hint : `${hint}. Level ${LEVELS.indexOf(need) + 1}: unlocks at ${fmtPoints(need)} points (you have ${fmtPoints(points)}). Time in the office, high-fives, streaks and easter eggs get you there.`}>
        <span className="emote-icon">{open ? e.icon : "🔒"}</span>
        <span className="emote-label">{e.label}</span>
        {open ? null : <span className="emote-lock">Lv {LEVELS.indexOf(need) + 1} · {fmtPoints(need)}</span>}
      </button>
    );
  };
  // Guests get the day-one emotes and nothing about levels or points (those are for the team).
  if (guest) return (
    <>
      <div className="emote-head">Emotes</div>
      <div className="emote-grid">{EMOTES.filter((e) => e.points === 0).map(btn)}</div>
    </>
  );
  return (
    <>
      <div className="emote-head">Emotes <span className="muted">· Level {levelOf(points)} of {MAX_LEVEL}</span></div>
      <div className="emote-grid">{EMOTES.filter((e) => !("epic" in e)).map(btn)}</div>
      <div className="emote-head epic-head">Epic <span className="muted">· Levels 11–{MAX_LEVEL}</span></div>
      <div className="emote-grid">{EMOTES.filter((e) => "epic" in e).map(btn)}</div>
      <button className="p2w-btn" onClick={() => setLol(true)} title="Skip the grind">💳 Pay to win</button>
      {lol ? (
        <div className="p2w-pop" role="dialog" onClick={() => setLol(false)}>
          <b>lol</b>
          <span>Points come from showing up, high-fives and wins. No credit cards accepted.</span>
        </div>
      ) : null}
    </>
  );
}
