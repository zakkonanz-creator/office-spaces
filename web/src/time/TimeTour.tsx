// Tours for Time tracking: one per screen, for whoever
// can open it. My time (everyone), Team (managers), Access (time admins).
// The same walkthrough as the admin tour: each step opens the right tab, rings
// the section it's about, and a card beside it has Back / Next. They chain: the
// office welcome rolls into My time, then Team, Payroll and Admin by access
// (tourChain.ts). Opens by itself the first time; "Take the tour" brings it back.

import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "../icons";
import { useOnboard, markStep, dismissTrack, loadOnboarding, type Track } from "../onboard";
import { Ring } from "../admin/AdminTour";
import { nextTour } from "../tourChain";

type TimeTrack = Extract<Track, "time" | "manager" | "payroll">;
interface Stop {
  id: string;
  title: string;
  body: ReactNode;
  careful?: ReactNode;
  /** Team/Payroll: the tab this stop is about; opening it ticks the stop. */
  tab?: string;
  /** My time: the section "Show me" scrolls to. */
  target?: string;
  /** Ticks only by doing it (clocking in), never by Next. */
  byDoing?: boolean;
  rules?: string[];
}

const TOURS: Record<TimeTrack, { title: string; intro: string; stops: Stop[] }> = {
  time: {
    title: "Your time, in one place",
    intro: "Clocking in, breaks, your week, leave and shifts. It works on your phone too, even when the office's audio and video don't.",
    stops: [
      { id: "clock", title: "Clock in and out", target: "clock", byDoing: true,
        body: <><p>Being in the office never clocks you in. You clock in here, from the clock in the office's bottom bar, or from this page on your phone. Breaks start and end from the same button.</p><p>If your team tracks projects, <b>Working on</b> times them as you go.</p></>,
        careful: <>Forgot to clock out? It's flagged for your manager to sort out with you. It's never guessed.</> },
      { id: "week", title: "My week", target: "week",
        body: <p>Your hours by day, and whether your manager has approved the week. A missed clock-out shows on your clock card: tell your manager so they can fix it.</p> },
      { id: "leave", title: "Leave", target: "leave",
        body: <p>Your balances and a request form. Your manager approves it and you hear back on Slack. On a day of approved leave, the office shows you as Away, "On leave".</p> },
      { id: "shifts", title: "Shifts", target: "shifts",
        body: <p>Your upcoming shifts, plus open shifts on your team you can take. Need to swap one? Ask a teammate here. Once they accept, your manager approves it.</p> },
      { id: "unavailable", title: "When I can't work", target: "unavailable",
        body: <p>Tell your manager the times you can't work, so the schedule is built around them.</p> },
    ],
  },
  manager: {
    title: "Running your team's time",
    intro: "Your team in one place: approvals, timesheets and the schedule. You see hours, never pay.",
    stops: [
      { id: "overview", title: "Overview", tab: "overview", body: <p>What's waiting on you: leave requests and timesheets to approve. Start here each day.</p> },
      { id: "approvals", title: "Approvals", tab: "approvals",
        body: <p>Leave requests, and shift swaps once the teammate has accepted. Approving vacation takes it off the person's balance, and they hear back on Slack.</p>,
        careful: <>Leave beyond someone's balance needs <b>Approve over balance</b>. Check with them first.</> },
      { id: "timesheets", title: "Timesheets", tab: "timesheets",
        body: <p>Approve each person's week. You can add or void an entry, with a reason.</p>,
        careful: <>Flagged weeks (a missed clock-out, a clock-out pressed the next morning) need <b>approve anyway</b>. Read the flag first.</> },
      { id: "schedule", title: "Schedule", tab: "schedule", body: <p>Seven days at a time, including overnight shifts, because the office runs 24/7. New shifts are drafts: publish the week and your team sees them, including open shifts anyone can take.</p> },
      { id: "people", title: "People", tab: "people", body: <p>Each person's working days, regular week and leave entitlements. Working days matter: leave and part months count against them. <b>Import from Deputy</b> brings across what Deputy already has.</p> },
      { id: "rules", title: "Ground rules", rules: [
        "I see hours, never pay.",
        "Every entry I add or void needs a reason, and it's logged with my name.",
        "I read a flagged week before I approve it anyway.",
        "Being in the office isn't attendance. Only clocking in counts.",
      ], body: null },
    ],
  },
  payroll: {
    title: "Access",
    intro: "Who can run time tracking for everyone, and who manages which team.",
    stops: [
      { id: "access", title: "Access", tab: "access", body: <p>Time admins see everything. A manager sees schedules, timesheets and leave for their own team. Only time admins can grant either.</p> },
    ],
  },
};

/** Team and Payroll keep their own tab state: they announce tab changes, and the tour asks them to switch. */
export const announceTab = (tab: string) => window.dispatchEvent(new CustomEvent("es:time-tab", { detail: tab }));
export function useTabRequests(setTab: (t: any) => void) {
  useEffect(() => {
    const go = (e: Event) => setTab((e as CustomEvent).detail);
    window.addEventListener("es:time-goto", go);
    return () => window.removeEventListener("es:time-goto", go);
  }, []);
}

export function TimeTour({ track }: { track: TimeTrack }) {
  const o = useOnboard();
  const t = o[track];
  const tour = TOURS[track];
  const forced = new URLSearchParams(location.search).get("tour") === "1";
  const [open, setOpen] = useState<boolean | null>(null);
  const [i, setI] = useState(0);
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState(false);
  const [after, setAfter] = useState<{ label: string; href: string } | null | undefined>(undefined);
  /** Whether the tour may change tabs. These are everyday pages: a tour that opened by itself never
   *  moves someone off the tab they came for until they press Next or Back. Asked for (?tour=1), it drives. */
  const [driving, setDriving] = useState(forced);

  useEffect(() => { void loadOnboarding(); }, []);
  // Opening a tab (from the page's own tabs, not just the tour) ticks that tab's stop.
  useEffect(() => {
    const on = (e: Event) => {
      const st = tour.stops.find((s) => s.tab === (e as CustomEvent).detail);
      if (st && open) markStep(track, st.id);
    };
    window.addEventListener("es:time-tab", on);
    return () => window.removeEventListener("es:time-tab", on);
  }, [open]);
  useEffect(() => {
    if (!t || open !== null) return;
    // Opening by itself starts at the first stop, which is each page's default tab.
    setOpen(forced || (t.autoOpen && !t.finished));
  }, [Boolean(t)]);

  const step = tour.stops[i];
  // Each step opens its tab. Reading a step is the stop, except clocking in, which ticks when you do it.
  useEffect(() => {
    if (!open || done) return;
    if (step.tab && driving) window.dispatchEvent(new CustomEvent("es:time-goto", { detail: step.tab }));
    if (!step.byDoing && !step.rules) markStep(track, step.id);
  }, [i, open, done]);
  useEffect(() => { if (done && after === undefined) void nextTour(track).then(setAfter); }, [done]);

  const close = () => {
    setOpen(false);
    if (t && !t.finished) dismissTrack(track);
    history.replaceState(null, "", location.pathname);
  };
  const next = () => { setDriving(true); if (i < tour.stops.length - 1) setI(i + 1); else setDone(true); };
  const back = () => { setDriving(true); setI(Math.max(0, i - 1)); };

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight" && !step.rules) next();
      else if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  if (!t) return null;
  if (!open) return <button className="small ghost time-tour-reopen" onClick={() => { setI(0); setDone(false); setDriving(true); setOpen(true); }}><Icon name="help" size={16} /> Take the tour</button>;

  if (done) {
    return (
      <div className="tour-card" role="dialog" aria-label={`${tour.title} tour`}>
        <h3>{track === "time" ? "That's your time covered." : track === "manager" ? "That's your team covered." : "That's payroll covered."}</h3>
        {track === "time" && !t.done.clock ? <p className="hint">The first stop ticks itself when you clock in for your shift.</p> : null}
        {after === undefined ? <p className="hint">…</p> : after ? (
          <div className="tour-next-tour">
            <span className="eyebrow">Next tour</span>
            <b>{after.label}</b>
            <a className="button primary small" href={after.href}>Start it →</a>
          </div>
        ) : <p className="hint">That's the last of your tours.</p>}
        <div className="tour-actions"><button className="small ghost" onClick={() => setDone(false)}>← Back</button><button className="small" onClick={close}>{after ? "Later" : "Done"}</button></div>
      </div>
    );
  }

  const target = step.target ? `[data-tour="${step.target}"]` : step.tab ? `[data-tour="tab-${step.tab}"]` : null;
  return (
    <>
      {target ? <Ring selector={target} key={`${track}-${i}`} /> : null}
      <div className="tour-card" role="dialog" aria-label={`${tour.title} tour`}>
        <div className="tour-top">
          <span className="eyebrow">{tour.title} · {i + 1} of {tour.stops.length}</span>
          <button className="ghost small" onClick={close} title="Close (Esc). 'Take the tour' brings it back." aria-label="Close the tour"><Icon name="close" size={14} /></button>
        </div>
        {i === 0 ? <p className="tour-hello">{tour.intro}</p> : null}
        <h3>{step.title}</h3>
        {step.rules ? (
          <>
            <p className="hint">Tick each one once you've read it.</p>
            <ul className="admin-rules">
              {step.rules.map((r) => (
                <li key={r}><label className="check">
                  <input type="checkbox" checked={Boolean(ticks[r])} onChange={(e) => setTicks({ ...ticks, [r]: e.target.checked })} />{r}
                </label></li>
              ))}
            </ul>
          </>
        ) : (
          <div className="tour-body">
            {step.body}
            {step.careful ? <p className="admin-careful"><b>Careful:</b> {step.careful}</p> : null}
            {step.byDoing && !t.done[step.id] ? <p className="hint">This one ticks when you actually clock in.</p> : null}
          </div>
        )}
        <div className="tour-progress" aria-hidden>{tour.stops.map((_, k) => <span key={k} className={k === i ? "on" : k < i ? "past" : ""} />)}</div>
        <div className="tour-actions">
          <button className="small ghost" onClick={back} disabled={i === 0}>← Back</button>
          {step.rules ? (
            <button className="small primary" disabled={!step.rules.every((r) => ticks[r])} onClick={() => { markStep(track, step.id); setDone(true); }}>Finish</button>
          ) : (
            <button className="small primary" onClick={next}>{i === tour.stops.length - 1 ? "Finish" : "Next →"}</button>
          )}
        </div>
      </div>
    </>
  );
}

export { markStep as markTimeStep };
