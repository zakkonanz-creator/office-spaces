// The office screen: the floor, the bottom bar, the side panel, and every
// overlay. Keyboard shortcuts follow common virtual-office conventions.

import { useCallback, useEffect, useState } from "react";
import { RoomEvent, Track } from "livekit-client";
import { seatOf, type Obj } from "../../../shared/floor";
import type { Status } from "../../../shared/protocol";
import { Icon } from "../icons";
import { state, useOffice, bump, toast, dismiss, roomName, live } from "./store";
import { inMeet } from "./meet";
import { connectSocket, sock } from "./net";
import { WinBanner, useMyEggs } from "./Points";
import { UnlockCard } from "./Rewards";
import * as media from "./media";
import { World, walkTo, jumpTo, recenter, zoomBy, closedDoorNearby, camera } from "./World";
import { PreJoin, skipJoin, lastJoin, type JoinChoice } from "./PreJoin";
import { answerOfficePings } from "../officeTab";
import { Toolbar } from "./Toolbar";
import { SidePanel, type Tab } from "./SidePanel";
import { ProfileCard } from "./ProfileCard";
import { RoomBar } from "./RoomBar";
import { MeetPill } from "./MeetPill";
import { MeetFrame } from "./MeetFrame";
import { Minimap } from "./Minimap";
import { FindPeople } from "./FindPeople";
import { Stage } from "./Stage";
import { ObjectPopover, CHESS_URL } from "./ObjectPopover";
import { Shortcuts } from "./Shortcuts";
import { useIdleAway } from "./idle";
import { hand } from "./handEdit";
import { useCameraAutoPause, clearCameraPause, clearMicPause, holdForStatus } from "./camPause";
import { openPopout } from "./popout";
import { GettingStarted } from "./Onboarding";
import { soundLog } from "./sounds";
import { quality, qualityTest } from "./quality";
import { useTranscribeCapture } from "./transcribe";
import { markStep } from "../onboard";
import { Report } from "./Report";

type Overlay =
  | null
  | { kind: "person"; id: string; at: { x: number; y: number } }
  | { kind: "object"; obj: Obj; at: { x: number; y: number } }
  | { kind: "desk"; deskId: string; at: { x: number; y: number } };

let joinStarted = false;

export function Office({ me }: { me: { name: string } }) {
  const [phase, setPhase] = useState<"prejoin" | "joining" | "in" | "kicked" | "error">(skipJoin() ? "joining" : "prejoin");
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<JoinChoice>(lastJoin());
  // Other tabs (Time & Payroll) ask whether the office is open, so "Back to the office" returns here.
  useEffect(() => (phase === "in" ? answerOfficePings() : undefined), [phase]);

  const join = async (c: JoinChoice) => {
    if (joinStarted) return; // React StrictMode runs effects twice in dev
    joinStarted = true;
    setChoice(c);
    setPhase("joining");
    try {
      const [floor, desks] = await Promise.all([
        fetch("/api/floor").then((r) => (r.ok ? r.json() : Promise.reject(new Error("Couldn't load the floor — try signing in again.")))),
        fetch("/api/desks").then((r) => (r.ok ? r.json() : [])), // guests don't get the desk directory
      ]);
      state.floor = floor;
      state.desks = new Map(desks.map((d: any) => [d.desk_id, { name: d.name, title: d.title }]));
      await connectSocket((why) => {
        setError(why);
        setPhase("kicked");
        media.disconnect();
      });
      setPhase("in");
      // Tell everyone only what actually started (a camera held by Zoom stays off).
      sock().emit("media", { mic: false, cam: false });
      media.setOnReconnected((got) => {
        sock().emit("media", got);
        media.getRoom()?.on(RoomEvent.AudioPlaybackStatusChanged, () => bump());
      });
      try {
        const got = await media.connect({ ...holdForStatus({ mic: c.mic, cam: c.cam }), isClosed: (id) => Boolean(state.rooms[id]?.closed) });
        sock().emit("media", got);
        const r = media.getRoom();
        r?.on(RoomEvent.AudioPlaybackStatusChanged, () => bump());
      } catch (e) {
        toast(`Audio/video couldn't connect (${(e as Error).message}). You're on the floor without it — reload to retry.`, { ttl: 12000 });
      }
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  };

  useEffect(() => {
    if (phase === "joining" && !state.me) join(choice);
  }, []);

  if (phase === "prejoin") return <PreJoin name={me.name} onJoin={join} />;
  if (phase === "joining") return <div className="center-screen"><div className="spinner" /><p>Opening the office…</p></div>;
  if (phase === "kicked") return <div className="center-screen"><h2>You've left the office</h2><p>{error}</p></div>;
  if (phase === "error") return (
    <div className="center-screen">
      <h2>Couldn't open the office</h2>
      <p>{error}</p>
      <button className="primary" onClick={() => location.reload()}>Try again</button>
    </div>
  );
  return <Floor />;
}

function deviceError(what: string, e: unknown): string {
  const name = (e as Error)?.name ?? "";
  if (media.noDevices()) return "This address isn't secure (https), so there's no camera or microphone here.";
  if (name === "NotAllowedError") return `Your ${what} is blocked — ${media.allowWhere()}, then try again.`;
  if (name === "NotReadableError") return `Your ${what} is in use by another app (Zoom, Teams…). Close it there and try again.`;
  return `Your ${what} didn't start: ${(e as Error)?.message ?? "unknown error"}.`;
}

function Floor() {
  const s = useOffice();
  const me = s.me!;
  useMyEggs();
  const [overlay, setOverlay] = useState<Overlay>(null);
  // ?panel=designer (from the admin tour) or ?panel=help opens that tab; otherwise People on wide screens.
  const [panel, setPanel] = useState<Tab | null>(() => {
    const want = new URLSearchParams(location.search).get("panel");
    if (want === "help" || (want === "designer" && state.me?.role === "admin")) return want;
    return window.innerWidth > 900 ? "people" : null;
  });
  const [showMap, setShowMap] = useState(false);
  const [showFind, setShowFind] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [gallery, setGallery] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [, setTick] = useState(0);
  const room = media.getRoom();

  useEffect(() => media.onMediaChange(() => setTick((t) => t + 1)), []);
  useIdleAway();
  useCameraAutoPause();
  useTranscribeCapture();

  // Stable handlers, so the floor's memoised furniture doesn't redraw on every store change.
  const onPerson = useCallback((id: string, at: { x: number; y: number }) => setOverlay({ kind: "person", id, at }), []);
  const onObject = useCallback((obj: Obj, at: { x: number; y: number }) => {
    // The chess board opens a game straight from the click: no popover to close.
    if (obj.type === "chess") return void window.open(obj.url ?? CHESS_URL, "_blank", "noopener");
    setOverlay({ kind: "object", obj, at });
  }, []);
  const onDesk = useCallback((deskId: string, at: { x: number; y: number }) => setOverlay({ kind: "desk", deskId, at }), []);
  const setStatus = useCallback((status: Status, text?: string) => {
    sock().emit("status", { status, ...(text !== undefined ? { text } : {}) });
    markStep("member", "status");
  }, []);
  const toggleMic = useCallback(async () => {
    const on = !me.mic;
    clearMicPause();
    try {
      await media.setMic(on);
      sock().emit("media", { mic: on });
    } catch (e) {
      toast(deviceError("microphone", e), { ttl: 10000 });
    }
  }, [me.mic]);
  const toggleCam = useCallback(async () => {
    const on = !me.cam;
    clearCameraPause();
    try {
      await media.setCam(on);
      sock().emit("media", { cam: on });
    } catch (e) {
      toast(deviceError("camera", e), { ttl: 10000 });
    }
  }, [me.cam]);
  const toggleShare = useCallback(async () => {
    if (me.guestRoom && !me.sharing) {
      // The server enforces this too; this just explains it.
    }
    const on = await media.setScreenShare(!me.sharing);
    sock().emit("media", { sharing: on });
  }, [me.sharing, me.guestRoom]);
  const toggleDoor = useCallback(() => {
    if (!me.roomId) return toast("Walk into a room to use its door.");
    const r = s.floor!.rooms.find((x) => x.id === me.roomId)!;
    if (!r.closable) return toast(`${r.name || "This room"} doesn't have a door.`);
    sock().emit("door", { roomId: me.roomId, closed: !s.rooms[me.roomId]?.closed });
  }, [me.roomId, s.rooms]);
  const goHome = useCallback(() => {
    const d = s.floor!.desks.find((x) => x.id === me.deskId);
    if (!d) return toast("You don't have a desk yet — click a free desk to claim it.");
    if (!walkTo(seatOf(d))) jumpTo(seatOf(d));
  }, [me.deskId]);

  // Screen share ended from the browser's own "Stop sharing" bar.
  useEffect(() => {
    if (me.sharing && room && !room.localParticipant.isScreenShareEnabled) sock().emit("media", { sharing: false });
  });

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      const act: Record<string, () => void> = {
        "1": toggleCam,
        "2": toggleMic,
        "3": () => setStatus("available"),
        "4": () => setStatus("away"),
        "5": () => setStatus("focusing"),
        ":": () => setEmoji((v) => !v),
        e: () => setEmoji((v) => !v), // the same menu: emotes are under the reactions
        g: () => setGallery((v) => !v),
        m: () => setShowMap((v) => !v),
        o: toggleDoor,
        c: () => setPanel((p) => (p ? null : "people")),
        f: () => setShowFind(true),
        h: goHome,
        y: () => sock().emit("highfive", {}), // high-five whoever's closest
        "?": () => setShowKeys((v) => !v),
        "=": () => zoomBy(1.15),
        "+": () => zoomBy(1.15),
        "-": () => zoomBy(1 / 1.15),
        Escape: () => {
          setOverlay(null);
          setShowMap(false);
          setShowFind(false);
          setShowKeys(false);
          setGallery(false);
          setEmoji(false);
        },
      };
      const fn = act[k] ?? act[k.toLowerCase()];
      if (fn && !(k.length === 1 && /[wasd]/i.test(k))) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCam, toggleMic, toggleDoor, goHome, setStatus]);

  // Walking into a closed door offers a knock. A double-click on a closed room from across the
  // floor keeps the offer up for a few seconds, instead of the proximity sweep hiding it at once.
  const [knockRoom, setKnockRoom] = useState<string | null>(null);
  useEffect(() => {
    let sticky: { room: string; until: number } | null = null;
    const onClosed = (e: Event) => {
      sticky = { room: (e as CustomEvent).detail as string, until: Date.now() + 8000 };
      setKnockRoom(sticky.room);
    };
    window.addEventListener("es:closed-door", onClosed);
    const t = setInterval(() => {
      const near = closedDoorNearby()?.id ?? null;
      if (!near && sticky && Date.now() < sticky.until) return;
      sticky = null;
      setKnockRoom(near);
    }, 400);
    return () => {
      window.removeEventListener("es:closed-door", onClosed);
      clearInterval(t);
    };
  }, []);

  const audioBlocked = room && !room.canPlaybackAudio;
  const shares = media.screenShares();

  return (
    <div className={`office${panel ? " with-panel" : ""}`}>
      <div id="audio-sink" hidden />
      <SidePanel tab={panel} onTab={setPanel} onPerson={(id, at) => setOverlay({ kind: "person", id, at })} />
      <main className="stage-area">
        <World onPerson={onPerson} onObject={onObject} onDesk={onDesk} />
        <RoomBar knockRoom={knockRoom} />
        <MeetPill />
        <MeetFrame />
        <div className="rail">
          <button onClick={() => setShowMap((v) => !v)} title="Map (M)" data-tour="map"><Icon name="map" /></button>
          <button onClick={goHome} title="Go to my desk (H)" data-tour="home"><Icon name="home" /></button>
          <button onClick={recenter} title="Recenter"><Icon name="target" /></button>
          <button onClick={() => zoomBy(1.15)} title="Zoom in (+)"><Icon name="plus" /></button>
          <button onClick={() => zoomBy(1 / 1.15)} title="Zoom out (−)"><Icon name="minus" /></button>
          {me.guestRoom ? null : <button onClick={() => setShowReport(true)} title="Report a bug or suggest an idea" data-tour="report"><Icon name="bug" /></button>}
        </div>
        {shares.length && !gallery ? <Stage shares={shares} compact onExpand={() => setGallery(true)} /> : null}
        {gallery ? <Stage shares={shares} onClose={() => setGallery(false)} /> : null}
        {showMap ? <Minimap onClose={() => setShowMap(false)} /> : null}
        {showFind ? <FindPeople onClose={() => setShowFind(false)} /> : null}
        {showKeys ? <Shortcuts onClose={() => setShowKeys(false)} /> : null}
        {showReport ? <Report onClose={() => setShowReport(false)} /> : null}
        {audioBlocked ? (
          <button className="audio-unlock" onClick={() => room!.startAudio().then(bump)}>Click to turn on sound</button>
        ) : null}
        <Toolbar
          onMic={toggleMic}
          onCam={toggleCam}
          onShare={toggleShare}
          onStatus={setStatus}
          onGallery={() => setGallery((v) => !v)}
          onPopout={() => openPopout({ onMic: toggleMic, onCam: toggleCam }).catch((e) => toast(e.message))}
          emojiOpen={emoji}
          setEmojiOpen={setEmoji}
          panelOpen={Boolean(panel)}
          onPanel={() => setPanel((p) => (p ? null : "people"))}
        />
        <Toasts />
        <WinBanner />
        <UnlockCard />
        {me.guestRoom ? null : <GettingStarted />}
        {s.music ? (
          <iframe className="music-player" src={`https://www.youtube-nocookie.com/embed/${s.music}?autoplay=1`} allow="autoplay; encrypted-media" title="Music" />
        ) : null}
        {overlay?.kind === "person" ? <ProfileCard id={overlay.id} at={overlay.at} onClose={() => setOverlay(null)} /> : null}
        {overlay?.kind === "object" ? <ObjectPopover obj={overlay.obj} at={overlay.at} onClose={() => setOverlay(null)} /> : null}
        {overlay?.kind === "desk" ? <DeskPopover deskId={overlay.deskId} at={overlay.at} onClose={() => setOverlay(null)} /> : null}
      </main>
    </div>
  );
}

function Toasts() {
  const s = useOffice();
  return (
    <>
    {s.updateReady ? (
      <div className="update-banner" role="alert">
        <span><b>The office was just updated.</b> Refresh to get the latest{inMeet() ? " (when your meeting's done)" : ""}.</span>
        <button className="primary small" onClick={() => location.reload()}>Refresh</button>
        <button className="ghost small" onClick={() => { s.updateReady = false; bump(); }} aria-label="Later">Later</button>
      </div>
    ) : null}
    <div className="toasts" role="status">
      {s.toasts.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.text}</span>
          {t.action ? <button className="primary small" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button> : null}
          <button className="ghost small" onClick={() => dismiss(t.id)} aria-label="Dismiss"><Icon name="close" size={14} /></button>
        </div>
      ))}
    </div>
    </>
  );
}

function DeskPopover({ deskId, at, onClose }: { deskId: string; at: { x: number; y: number }; onClose: () => void }) {
  const s = useOffice();
  const desk = (s.previewFloor ?? s.floor!).desks.find((d) => d.id === deskId);
  const preview = Boolean(s.previewFloor) && !s.floor!.desks.some((d) => d.id === deskId);
  useEffect(() => {
    if (!desk) onClose(); // the desk went away (redesign, revert, preview ended)
  }, [desk]);
  if (!desk) return null;
  const who = s.desks.get(deskId);
  const mine = s.me!.deskId === deskId;
  const claim = async () => {
    const r = await fetch(`/api/desks/${deskId}/claim`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast(j.error ?? "Couldn't claim that desk");
    // A new Map, not an edit in place: the floor redraws its nameplates only when the directory changes.
    const desks = new Map([...s.desks].filter(([, v]) => v.name !== s.me!.name));
    desks.set(deskId, { name: s.me!.name, title: s.me!.title });
    s.desks = desks;
    s.me!.deskId = deskId;
    bump();
    toast("That's your desk now. H brings you back here.");
    onClose();
  };
  const seat = seatOf(desk);
  return (
    <Popover at={at} onClose={onClose}>
      <h3>{who ? who.name : desk.owner ? `${desk.owner}'s desk` : "Free desk"}</h3>
      <p className="muted">{who?.title ?? desk.title ?? roomName(desk.roomId)}</p>
      <div className="row">
        <button onClick={() => { walkTo(seat) || jumpTo(seat); onClose(); }}>Go here</button>
        {!who && !mine && !desk.owner && !s.me!.guestRoom && !preview ? <button className="primary" onClick={claim}>Make this my desk</button> : null}
      </div>
      {preview ? <p className="hint">This desk is only in your Designer preview.</p> : null}
      {!who && desk.owner ? <p className="hint">Saved for {desk.owner} from the roster. They're seated here when they sign in; an admin can reassign it.</p> : null}
    </Popover>
  );
}

export function Popover({ at, onClose, children, wide }: { at: { x: number; y: number }; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".popover")) onClose();
    };
    setTimeout(() => window.addEventListener("pointerdown", away), 0);
    return () => window.removeEventListener("pointerdown", away);
  }, [onClose]);
  const w = wide ? 360 : 300;
  const left = Math.min(window.innerWidth - w - 12, Math.max(12, at.x + 12));
  const top = Math.min(window.innerHeight - 340, Math.max(12, at.y - 20));
  return (
    <div className="popover" style={{ left, top, width: w }}>
      {children}
    </div>
  );
}

// Console / end-to-end test handle.
Object.assign(window as any, { __es: { state, live, camera, room: media.getRoom, officeAudio: media.officeAudioOn, jump: jumpTo, walk: walkTo, sock, hand, sounds: soundLog, quality, qualityTest, toast } });
