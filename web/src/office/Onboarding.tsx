// Getting started in the office: a welcome on your first visit, then a checklist
// that ticks itself as you actually do each thing (walk, go to your desk, set a
// status, talk, close a door, find someone, clock in). "Show me" points at the
// control. Admins who were just promoted get a short hand-off to the admin tour.

import { useEffect, useRef, useState } from "react";
import { seatOf } from "../../../shared/floor";
import { Icon } from "../icons";
import { onboard, useOnboard, markStep, dismissTrack, loadOnboarding } from "../onboard";
import { useOffice, state, live, roomName } from "./store";
import { sock } from "./net";
import { nextTour } from "../tourChain";

interface Ctx { desk: string | null; alone: boolean; touch: boolean }
interface Step {
  id: string;
  title: string;
  how: (ctx: Ctx) => string;
  /** What "Show me" points at: a [data-tour] name, or nothing (a centred tip). */
  target?: string;
  tip: (ctx: Ctx) => string;
}

/** Phones and tablets: no keyboard, and a plain tap walks (World.tsx), so the copy says tap, not keys. */
const isTouch = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

const STEPS: Step[] = [
  {
    id: "move",
    title: "Walk around",
    how: ({ touch }) => touch
      ? "Tap anywhere on the floor to walk there. Drag to look around."
      : "Use the arrow keys or WASD, or double-click anywhere on the floor to walk there. Drag to look around.",
    tip: ({ touch }) => (touch ? "Tap anywhere on the floor to walk there." : "Double-click anywhere on the floor to walk there."),
  },
  {
    id: "desk",
    title: "Go to your desk",
    how: ({ desk, touch }) => desk
      ? `Your desk is in ${desk}. ${touch ? "Tap the house button" : "Press H, or the house button,"} to walk back to it from anywhere.`
      : `You don't have a desk yet. ${touch ? "Tap" : "Click"} any desk without a name on it and choose Make this my desk.`,
    target: "home",
    tip: ({ desk, touch }) => (desk ? (touch ? "Tap here to go to your desk." : "Press H, or click here, to go to your desk.") : `${touch ? "Tap" : "Click"} a free desk on the floor, then Make this my desk.`),
  },
  {
    id: "status",
    title: "Say if you can be interrupted",
    how: ({ touch }) => `Available means come over. Focusing means Slack first. Away means you're not at your desk. ${touch ? "Tap your status" : "Press 3 for Available, 4 for Away, 5 for Focusing, or click your status"} and add a note like "On a call till 2".`,
    target: "status",
    tip: ({ touch }) => (touch ? "Tap here. You can add a note too." : "Click here, or press 3 / 4 / 5. You can add a note too."),
  },
  {
    id: "talk",
    title: "Say hi to someone",
    how: ({ alone }) => alone
      ? "Nobody else is in right now. This ticks itself the next time you walk up to a teammate."
      : "Walk up to a teammate until you can hear them. A ring lights up around whoever's talking. Walk away and the sound fades out, just like a real office.",
    target: "people",
    tip: ({ touch }) => `Everyone who's in is listed here. ${touch ? "Tap" : "Click"} a name, then Go to.`,
  },
  {
    id: "door",
    title: "Have a private conversation",
    how: ({ touch }) => touch
      ? "Walk into a room and tap Close door in the bar at the top. Nobody outside can hear you; they knock and you let them in. Tap Open door to open it."
      : "Walk into a room and press O (or Close door in the bar at the top). Nobody outside can hear you; they knock and you let them in. Press O again to open it.",
    target: "map",
    tip: ({ touch }) => (touch ? "The map shows every room. Walk into one, then tap Close door." : "The map shows every room. Walk into one, then press O."),
  },
  {
    id: "find",
    title: "Find a teammate",
    how: ({ touch }) => touch
      ? "Open People, tap a name, then Go to, and you're standing next to them. Their card shows their local time and a Slack button."
      : "Press F, type a name and press Enter, and you're standing next to them (or outside their door, if it's closed). Click anyone to see their local time or message them on Slack.",
    target: "people",
    tip: ({ touch }) => (touch ? "Tap a name here, then Go to." : "Press F anywhere, or click a name here."),
  },
  {
    id: "clock",
    title: "Clock in for your shift",
    how: () => "Being in the office never clocks you in. Use the clock in the bottom bar, or /time on your phone when you're away from your desk. Time (the clock's Time link) has a short tour of leave, shifts and your week.",
    target: "clock",
    tip: () => "Clock in and out here, and start or end breaks.",
  },
];

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };
const readSession = (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const writeSession = (k: string) => { try { sessionStorage.setItem(k, "1"); } catch { /* private window */ } };

/** Help → "Open the checklist" and similar: ask the office to show a track. */
export const openGettingStarted = () => window.dispatchEvent(new CustomEvent("es:getting-started"));

export function GettingStarted() {
  const s = useOffice();
  const o = useOnboard();
  const me = s.me!;
  const [welcome, setWelcome] = useState(false);
  const [open, setOpen] = useState(false);
  const [adminPrompt, setAdminPrompt] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  /** "Show me around" opens the list with the first tip up; "on my own" keeps it small. */
  const [guided, setGuided] = useState(false);

  useEffect(() => {
    void loadOnboarding();
    const show = () => { setOpen(true); setCelebrate(false); };
    window.addEventListener("es:getting-started", show);
    return () => window.removeEventListener("es:getting-started", show);
  }, []);

  // First load: welcome a new teammate once; otherwise offer a new admin their tour.
  const decided = useRef(false);
  useEffect(() => {
    if (!o.loaded || decided.current) return;
    decided.current = true;
    const m = o.member;
    // ?welcome=1: preview the first-visit welcome (for QA), whoever you are.
    if (new URLSearchParams(location.search).get("welcome") === "1") return setWelcome(true);
    if (m?.autoOpen && !m.finished) {
      if (read(`es.welcomed.${me.id}`)) setOpen(true);
      else setWelcome(true);
    } else if (o.admin?.autoOpen && !o.admin.finished && !readSession("es.adminPrompt")) {
      setAdminPrompt(true);
    }
  }, [o.loaded]);

  // Promoted while in the office: the server pushes the new role; offer the tour right then.
  const lastRole = useRef(me.role);
  useEffect(() => {
    if (lastRole.current !== "admin" && me.role === "admin") void loadOnboarding().then(() => setAdminPrompt(true));
    if (me.role !== "admin") onboard.admin = null;
    lastRole.current = me.role;
  }, [me.role]);

  // Steps tick themselves from what you actually do, while the checklist is theirs to do.
  const start = useRef<{ x: number; y: number } | null>(null);
  const firstDesk = useRef(me.deskId);
  useEffect(() => {
    onboard.checklistOpen = open;
    if (!o.member || o.member.finished || me.guestRoom || !open) return;
    const t = setInterval(() => {
      const m = state.me;
      const pos = m && live.get(m.id);
      if (!m || !pos || !state.floor) return;
      start.current ??= { x: pos.x, y: pos.y };
      const done = onboard.member?.done ?? {};
      if (!done.move && Math.hypot(pos.x - start.current.x, pos.y - start.current.y) > 60) markStep("member", "move");
      const desk = state.floor.desks.find((d) => d.id === m.deskId);
      // You arrive at your desk, so being there only counts after you've walked away and come back.
      if (!done.desk && desk && ((done.move && Math.hypot(pos.x - seatOf(desk).x, pos.y - seatOf(desk).y) < 40) || m.deskId !== firstDesk.current)) markStep("member", "desk");
      if (!done.talk && [...state.hearing.values()].some((v) => v > 0.05)) markStep("member", "talk");
      if (!done.door && m.roomId && state.rooms[m.roomId]?.closed) markStep("member", "door");
      if (!done.clock && m.clock) markStep("member", "clock");
    }, 500);
    return () => clearInterval(t);
  }, [o.member?.finished, Boolean(o.member), open]);

  // Finishing is a moment: a 🎉 over your head that everyone nearby sees.
  const wasFinished = useRef<boolean | null>(null);
  useEffect(() => {
    if (!o.member) return;
    if (wasFinished.current === false && o.member.finished && onboard.checklistOpen) {
      setCelebrate(true);
      setOpen(true);
      sock().emit("react", { emoji: "🎉" });
    }
    wasFinished.current = o.member.finished;
  }, [o.member?.finished]);

  const deskRoom = (() => {
    const d = s.floor?.desks.find((x) => x.id === me.deskId);
    return d ? roomName(d.roomId) ?? "your team's room" : null;
  })();

  return (
    <>
      {welcome ? (
        <Welcome
          name={me.name}
          desk={deskRoom}
          onStart={() => { write(`es.welcomed.${me.id}`, "1"); setWelcome(false); setGuided(true); setOpen(true); }}
          onSkip={() => { write(`es.welcomed.${me.id}`, "1"); setWelcome(false); setGuided(false); setOpen(true); }}
        />
      ) : null}
      {open && o.member && !welcome ? (
        <Checklist desk={deskRoom} celebrate={celebrate} guided={guided} onClose={() => { setOpen(false); if (!o.member!.finished) dismissTrack("member"); }} />
      ) : null}
      {adminPrompt && o.admin ? (
        <AdminPrompt grantedBy={o.admin.grantedBy ?? null} onClose={() => { writeSession("es.adminPrompt"); setAdminPrompt(false); }} />
      ) : null}
    </>
  );
}

// ── The welcome ────────────────────────────────────────────────────────────

function Welcome({ name, desk, onStart, onSkip }: { name: string; desk: string | null; onStart: () => void; onSkip: () => void }) {
  const first = name.split(" ")[0];
  return (
    <div className="modal-scrim onboard-scrim">
      <div className="modal welcome" role="dialog" aria-labelledby="welcome-title">
        <p className="eyebrow">Welcome to Acme</p>
        <h2 id="welcome-title">Hi {first}, this is the office.</h2>
        <p className="welcome-lede">It works like a real floor. Everyone you'd find at the office is here, and you talk by walking over to them.</p>
        <ul className="welcome-ideas">
          <li>
            <span className="welcome-icon"><Icon name="people" /></span>
            <span><b>Walk up to talk.</b> Voices get louder as you get closer. No meeting links, no calendar invites.</span>
          </li>
          <li>
            <span className="welcome-icon"><Icon name="door" /></span>
            <span><b>Close a door for privacy.</b> A closed room is soundproof. People knock, and you let them in.</span>
          </li>
          <li>
            <span className="welcome-icon status-available"><span className="status-dot" /></span>
            <span><b>Your status sets expectations.</b> Available means come over. Focusing means Slack first.</span>
          </li>
        </ul>
        <p className="welcome-desk">
          {desk ? <>Your desk is in <b>{desk}</b>. Press <kbd>H</kbd> any time to walk back to it.</> : <>You don't have a desk yet. The checklist shows you how to pick one.</>}
          {" "}Messages stay in Slack; this is where you talk.
        </p>
        <div className="row welcome-actions">
          <button className="primary big" autoFocus onClick={onStart}>Show me around · 2 min</button>
          <button className="ghost" onClick={onSkip}>I'll explore on my own</button>
        </div>
        <p className="hint">Either way, a checklist stays in the corner and ticks itself off as you go.</p>
      </div>
    </div>
  );
}

// ── The checklist ──────────────────────────────────────────────────────────

function Checklist({ desk, celebrate, guided, onClose }: { desk: string | null; celebrate: boolean; guided: boolean; onClose: () => void }) {
  const s = useOffice();
  const o = useOnboard();
  const m = o.member!;
  const next = STEPS.find((st) => !m.done[st.id]);
  const [collapsed, setCollapsed] = useState(!guided);
  const [spot, setSpot] = useState<Step | null>(guided && next ? next : null);
  const [openId, setOpenId] = useState<string | null>(null);
  const shown = openId ?? next?.id ?? null;
  const count = STEPS.filter((st) => m.done[st.id]).length;
  const alone = s.people.size === 0;
  const ctx = { desk, alone, touch: isTouch() };

  if (m.finished && celebrate) {
    return (
      <section className="onboard-card done" aria-label="Getting started">
        <p className="onboard-party" aria-hidden>🎉</p>
        <h3>You're all set.</h3>
        <p className="hint">That's the whole office. Three things worth remembering:</p>
        {ctx.touch ? (
          <ul className="onboard-recap">
            <li>The house button takes you home to your desk.</li>
            <li>People lists everyone who's in; tap a name to go to them.</li>
            <li>On a computer, Pop-out keeps the office in a mini window over Slack.</li>
          </ul>
        ) : (
          <ul className="onboard-recap">
            <li><kbd>H</kbd> takes you home to your desk.</li>
            <li><kbd>F</kbd> finds anyone; <kbd>?</kbd> lists every shortcut.</li>
            <li>Pop-out keeps the office in a mini window over Slack.</li>
          </ul>
        )}
        <p className="hint">Something not working? Help (in the side panel) checks your camera, mic and connection.</p>
        <NextTour onClose={onClose} />
      </section>
    );
  }

  return (
    <>
      <section className={`onboard-card${collapsed ? " collapsed" : ""}`} aria-label="Getting started">
        <header className="onboard-head">
          <button className="onboard-title" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>
            <span>Getting started</span>
            <span className="onboard-count">{count} of {STEPS.length}</span>
            <Icon name="chevron" size={14} className={collapsed ? "" : "flip"} />
          </button>
          <button className="ghost small" onClick={onClose} title="Hide. You can open it again from Help." aria-label="Hide the checklist"><Icon name="close" size={14} /></button>
        </header>
        <div className="onboard-bar" aria-hidden><span style={{ width: `${(count / STEPS.length) * 100}%` }} /></div>
        {collapsed ? null : (
          <ol className="onboard-steps">
            {STEPS.map((st) => {
              const done = Boolean(m.done[st.id]);
              const isOpen = shown === st.id;
              return (
                <li key={st.id} className={`${done ? "done" : ""}${isOpen ? " open" : ""}`}>
                  <button className="onboard-step" onClick={() => setOpenId(isOpen ? "" : st.id)} aria-expanded={isOpen}>
                    <span className="onboard-tick" aria-hidden>{done ? "✓" : ""}</span>
                    <span>{st.title}</span>
                  </button>
                  {isOpen ? (
                    <div className="onboard-how">
                      <p>{st.how(ctx)}</p>
                      {!done ? (
                        <div className="row">
                          <button className="small primary" onClick={() => setSpot(st)}>Show me</button>
                          {st.id === "clock" ? <a className="button small" href="/time?tour=1" {...(isTouch() ? {} : { target: "_blank", rel: "noreferrer" })}>Take the Time tour</a> : null}
                          <button className="small ghost" onClick={() => markStep("member", st.id)}>{st.id === "talk" && alone ? "Skip for now" : "Skip"}</button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>
      {spot ? <Spotlight target={spot.target} text={spot.tip(ctx)} onDone={() => setSpot(null)} /> : null}
    </>
  );
}

/** The office is the first tour: when it's done, hand over to the next one this person can open (My time for everyone). */
function NextTour({ onClose }: { onClose: () => void }) {
  const [after, setAfter] = useState<{ label: string; href: string } | null | undefined>(undefined);
  useEffect(() => { void nextTour("office").then(setAfter); }, []);
  return (
    <>
      {after ? (
        <div className="tour-next-tour" style={{ textAlign: "left" }}>
          <span className="eyebrow">{isTouch() ? "Next tour" : "Next tour · opens in a new tab, so you stay in the office"}</span>
          <b>{after.label}</b>
          {/* A phone pauses a background tab (and its mic), so there the tour opens in this one. */}
          <a className="button primary small" href={after.href} {...(isTouch() ? {} : { target: "_blank", rel: "noreferrer" })} onClick={onClose}>Start it →</a>
        </div>
      ) : null}
      <button className={after ? "ghost" : "primary"} onClick={onClose}>{after ? "Later" : "Done"}</button>
    </>
  );
}

/** A pulsing ring on the control (or a centred tip when there isn't one), gone after a few seconds or a click. */
export function Spotlight({ target, text, onDone }: { target?: string; text: string; onDone: () => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    let raf = 0;
    const track = () => {
      const el = target ? document.querySelector(`[data-tour="${target}"]`) : null;
      const r = el?.getBoundingClientRect();
      // Hidden (the clock pill on a phone) or scrolled out of view: no ring, the centred tip instead.
      const visible = r && r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
      setRect(visible ? r! : null);
      raf = requestAnimationFrame(track);
    };
    track();
    const t = setTimeout(onDone, 7000);
    const away = () => onDone();
    setTimeout(() => window.addEventListener("pointerdown", away), 0);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); window.removeEventListener("pointerdown", away); };
  }, [target]);
  if (!rect) return <div className="spot-tip centred" role="status">{text}</div>;
  const pad = 6;
  const below = rect.top < 160;
  const left = Math.min(window.innerWidth - 276, Math.max(12, rect.left + rect.width / 2 - 130));
  return (
    <>
      <div className="spot-ring" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} aria-hidden />
      <div className="spot-tip" role="status" style={below ? { left, top: rect.bottom + 14 } : { left, top: rect.top - 14, transform: "translateY(-100%)" }}>{text}</div>
    </>
  );
}

// ── Just made an admin ─────────────────────────────────────────────────────

function AdminPrompt({ grantedBy, onClose }: { grantedBy: string | null; onClose: () => void }) {
  return (
    <div className="modal-scrim onboard-scrim" onClick={onClose}>
      <div className="modal welcome" role="dialog" aria-labelledby="admin-title" onClick={(e) => e.stopPropagation()}>
        <p className="eyebrow">New role</p>
        <h2 id="admin-title">{grantedBy ? `${grantedBy.split(" ")[0]} made you an admin.` : "You're an admin now."}</h2>
        <p className="welcome-lede">You can now change the office for everyone. Here's what that covers:</p>
        <ul className="welcome-ideas compact">
          <li><span className="welcome-icon"><Icon name="people" /></span><span><b>Members:</b> roles and desks, removing people, and setting up a new hire's access before their first day.</span></li>
          <li><span className="welcome-icon"><Icon name="link" /></span><span><b>Guest links:</b> let someone outside Acme into one room.</span></li>
          <li><span className="welcome-icon"><Icon name="chart" /></span><span><b>Analytics:</b> who was Available, Focusing or Away, by day or week.</span></li>
          <li><span className="welcome-icon"><Icon name="settings" /></span><span><b>Office Designer:</b> redesign the floor in plain English, with a private preview first.</span></li>
        </ul>
        <p className="welcome-desk">The tour takes about 3 minutes and walks through each one, plus the few things that can't be undone.</p>
        <div className="row welcome-actions">
          <a className="button primary big" href="/admin/members?tour=1" target="_blank" rel="noopener">Take the admin tour</a>
          <button className="ghost" onClick={onClose}>Later</button>
        </div>
        <p className="hint">You can start it any time from Help.</p>
      </div>
    </div>
  );
}
