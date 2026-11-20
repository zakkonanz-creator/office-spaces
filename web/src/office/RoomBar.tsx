// The strip at the top of the floor when you're in a room: the room's name,
// its door, and "Transcribe". Outside a closed door it offers a knock.
//
// Out of the way: it rests as a small pill (the room, who's here, and anything
// live like a meeting or transcription); the buttons open on hover, focus or a tap, and for a few
// seconds after you walk into a room. When an avatar or the jumbotron is under it, it fades to
// see-through and lets clicks through to the floor, until the pointer comes back to it.

import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { useOffice, roomName, toast } from "./store";
import { sock } from "./net";
import { joinMeet, inMeet } from "./meet";
import { GhlLinkForm } from "./GhlLinkForm";

const ARRIVE_MS = 6000;
/** Tests (and anyone who wants it) can keep the bar open: localStorage "es.roombar" = "open". */
const pinnedOpen = () => { try { return localStorage.getItem("es.roombar") === "open"; } catch { return false; } };

/** See-through while an avatar or the jumbotron sits under the bar and the pointer isn't on it. */
function useSeeThrough(ref: React.RefObject<HTMLDivElement | null>) {
  const [faded, setFaded] = useState(false);
  const [near, setNear] = useState(false);
  useEffect(() => {
    let mx = -1, my = -1;
    // Touch screens have no hover to bring it back, so it never goes see-through there.
    const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    if (coarse) return;
    const onMove = (e: PointerEvent) => { mx = e.clientX; my = e.clientY; };
    addEventListener("pointermove", onMove, { passive: true });
    addEventListener("pointerdown", onMove, { passive: true, capture: true });
    const hit = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const t = setInterval(() => {
      const el = ref.current;
      if (!el) return;
      const bar = el.getBoundingClientRect();
      const pad = 6; // the pointer counts as "on it" a little outside, so it doesn't flicker at the edge
      const pointerOn = mx >= bar.left - pad && mx <= bar.right + pad && my >= bar.top - pad && my <= bar.bottom + pad;
      let under = false;
      if (!pointerOn) {
        for (const a of document.querySelectorAll<HTMLElement>(".world .avatar .bubble, .world .avatar .fig, .obj-jumbotron")) {
          if (hit(bar, a.getBoundingClientRect())) { under = true; break; }
        }
      }
      setFaded((f) => (f === under ? f : under));
      setNear((n) => (n === pointerOn ? n : pointerOn)); // see-through lets clicks pass, so watch the pointer ourselves
    }, 250);
    return () => { clearInterval(t); removeEventListener("pointermove", onMove); removeEventListener("pointerdown", onMove, { capture: true }); };
  }, []);
  return { faded, near };
}

export function RoomBar({ knockRoom }: { knockRoom: string | null }) {
  const s = useOffice();
  const me = s.me!;
  const [busy, setBusy] = useState(false);
  const [askLink, setAskLink] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const { faded, near } = useSeeThrough(barRef);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [tapped, setTapped] = useState(false);
  // Open for a moment on arrival, so you see what the room offers; then it rests as a pill.
  const [arrived, setArrived] = useState(true);
  useEffect(() => {
    setArrived(true);
    setTapped(false);
    setHover(false);
    setFocus(false);
    const t = setTimeout(() => setArrived(false), ARRIVE_MS);
    return () => clearTimeout(t);
  }, [me.roomId]);

  if (!me.roomId) {
    if (!knockRoom) return null;
    return (
      <div className="roombar">
        <Icon name="door" size={18} />
        <span>{roomName(knockRoom) ? <><b>{roomName(knockRoom)}</b> has its door closed</> : "This door is closed"}</span>
        <button className="primary small" onClick={() => sock().emit("knock", { roomId: knockRoom })}>Knock</button>
      </div>
    );
  }

  const def = s.floor!.rooms.find((r) => r.id === me.roomId)!;
  const st = s.rooms[me.roomId];
  const inside = [me, ...s.people.values()].filter((p) => p.roomId === me.roomId).length;

  const transcribe = async (on: boolean) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/rooms/${me.roomId}/transcribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return toast(j.error ?? "Couldn't change transcription");
      if (on) toast("Transcribing. Everyone in the room sees the badge; the notes go to everyone here when it stops.", { ttl: 8000 });
    } finally {
      setBusy(false);
    }
  };

  // Start meeting: your GHL Meeting Room (or a free shared one) opens inside the office,
  // and everyone else in the room is asked to join.
  const startMeeting = async () => {
    const roomId = me.roomId!;
    setBusy(true);
    try {
      const r = await fetch(`/api/rooms/${roomId}/meeting`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return void joinMeet(j.url, roomId, { embed: true, label: j.label === "your meeting room" ? "Meeting" : j.label });
      if (r.status === 409 && j.url) return void joinMeet(j.url, roomId, { embed: true, label: j.label ?? "Meeting" }); // someone beat us to it: join theirs
      if (j.reason === "no-room" || j.reason === "all-busy") setAskLink(true);
      toast(j.error ?? "Couldn't start the meeting.", { ttl: 8000 });
    } finally {
      setBusy(false);
    }
  };

  // Offices can open into each other, so a closed neighbour can be knocked on from inside a room too.
  const knock = knockRoom && knockRoom !== me.roomId ? (
    <div className="roombar knockbar">
      <Icon name="door" size={18} />
      <span>{roomName(knockRoom) ? <><b>{roomName(knockRoom)}</b> has its door closed</> : "This door is closed"}</span>
      <button className="primary small" onClick={() => sock().emit("knock", { roomId: knockRoom })}>Knock</button>
    </div>
  ) : null;
  const open = hover || near || focus || tapped || arrived || askLink || busy || pinnedOpen();
  return (
    <>
      <div ref={barRef} className={`roombar main-bar${open ? " open" : " pill"}${faded && !open ? " faded" : ""}`}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        onFocus={() => setFocus(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocus(false); }}>
        <RoomNameEdit roomId={def.id} name={def.name} admin={me.role === "admin"} />
        <span className="muted">{inside} here</span>
        {!open ? <button className="ghost small rb-expand" onClick={() => setTapped(true)} aria-label="Room actions" title="Door, meeting, transcribe">⋯</button> : null}
        {open && def.closable && !me.guestRoom ? (
          <button className="small" onClick={() => sock().emit("door", { roomId: me.roomId!, closed: !st?.closed })} title="Open/close the door (O)">
            <Icon name={st?.closed ? "door" : "doorOpen"} size={16} /> {st?.closed ? "Open door" : "Close door"}
          </button>
        ) : null}
        {st?.recording?.kind === "ghl" ? (
          <>
            <span className="rec-badge meeting-badge">● Meeting · {st.recording.byName.split(" ")[0]}</span>
            {!inMeet() && !me.guestRoom ? <button className="primary small" onClick={() => void joinMeet(st.recording!.meetUrl, me.roomId, { embed: true, label: st.recording!.label ?? "Meeting" })}>Join meeting</button> : null}
          </>
        ) : st?.recording ? (
          <>
            <span className="rec-badge">● Meeting · {st.recording.byName.split(" ")[0]}</span>
            {st.recording.meetUrl && !inMeet() ? <button className="primary small" onClick={() => void joinMeet(st.recording!.meetUrl, me.roomId)}>Join Meet</button> : null}
          </>
        ) : open && !me.guestRoom && !inMeet() && !st?.transcribing ? (
          <>
            <button className="small" disabled={busy} onClick={() => void startMeeting()} title="Opens a GHL Meeting Room here in the office and asks everyone in the room to join.">
              <Icon name="cam" size={16} /> Start meeting
            </button>
            <button className="small ghost" onClick={() => setAskLink((v) => !v)} title="Set or change the GHL Meeting Room that Start meeting opens for you">My room</button>
          </>
        ) : null}
        {st?.transcribing ? (
          <span className="rec-badge" title={`Started by ${st.transcribing.byName}. Each teammate's own mic is transcribed; guests' mics aren't recorded.`}>
            ● Transcribing
            {!me.guestRoom ? <button className="small ghost rec-stop" disabled={busy} onClick={() => transcribe(false)}>Stop</button> : null}
          </span>
        ) : open && !me.guestRoom && !inMeet() && !st?.recording ? (
          <button className="small" disabled={busy} onClick={() => transcribe(true)} title="Transcribes this room's conversation. Everyone here sees it's on; the notes go to everyone in the room.">
            <Icon name="record" size={16} /> {busy ? "Starting…" : "Transcribe"}
          </button>
        ) : null}
      </div>
      {askLink ? (
        <div className="roombar knockbar">
          <span>Your GHL Meeting Room link:</span>
          <GhlLinkForm onCancel={() => setAskLink(false)} onSaved={() => setAskLink(false)} />
        </div>
      ) : knock}
    </>
  );
}

/** The room's name in the bar. Admins click it (or "Name this room") to rename; Enter saves, Esc cancels. */
function RoomNameEdit({ roomId, name, admin }: { roomId: string; name: string; admin: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const save = async () => {
    setEditing(false);
    if (draft.trim() === name) return;
    const r = await fetch(`/api/admin/rooms/${roomId}/name`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: draft }) });
    if (!r.ok) toast("Couldn't rename the room.");
  };
  if (editing)
    return (
      <input className="roombar-rename" autoFocus value={draft} maxLength={40} placeholder="Room name"
        onChange={(e) => setDraft(e.target.value)} onBlur={save}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") void save(); if (e.key === "Escape") { setDraft(name); setEditing(false); } }} />
    );
  if (!admin) return name ? <span className="roombar-name">{name}</span> : null;
  return (
    <button className="roombar-name roombar-name-edit" title="Rename this room" onClick={() => { setDraft(name); setEditing(true); }}>
      {name || <span className="muted">Name this room</span>} <span aria-hidden className="muted">✎</span>
    </button>
  );
}
