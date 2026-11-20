// The admin tour: a step-by-step walkthrough of the admin pages. Each step opens
// the right page, scrolls to the control it's about and rings it, with a small
// card beside it: Back / Next (or the arrow keys). It covers what each page is
// for and the few things that reach everyone or can't be taken back, and ends
// with five ground rules to tick. Opens by itself for someone just made an admin;
// "Take the admin tour" in the header (or ?tour=1) starts it from the top. It's
// the last tour in the chain (tourChain.ts), so it ends here.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../icons";
import { useOnboard, markStep, dismissTrack } from "../onboard";

export type AdminTab = "members" | "points" | "reports" | "guests" | "analytics" | "settings";

interface Step {
  /** The progress stop this step belongs to; a stop is done once its last step has been shown. */
  stop: "members" | "guests" | "analytics" | "settings" | "designer" | "rules";
  tab?: AdminTab;
  /** CSS selector for the control this step is about. */
  target?: string;
  title: string;
  body?: ReactNode;
  careful?: ReactNode;
}

const STEPS: Step[] = [
  { stop: "members", tab: "members", target: '[data-tour="members-table"]', title: "Everyone in Space",
    body: <p>Change anyone's role or desk here. Whoever you make an admin gets this tour, and a note on Slack if they're on the team's Slack.</p> },
  { stop: "members", tab: "members", target: '[data-tour="preassign"]', title: "Set up a new hire before day one",
    body: <p>Add their work email, role and team (a payroll admin can add manager or payroll access too). It's applied the moment they first sign in, and the getting-started checklist opens for them by itself.</p> },
  { stop: "members", tab: "members", target: '[data-tour="getting-started"]', title: "Who's still settling in",
    body: <p>Each person's first-day checklist. Anyone a few days in who's stuck is flagged, so go over and help.</p> },
  { stop: "members", tab: "members", target: '[data-tour="members-table"] button.danger', title: "Removing someone",
    careful: <><b>Remove</b> signs them out everywhere, straight away, and frees their desk. Restore brings them back, but not their desk.</> },
  { stop: "guests", tab: "guests", target: '[data-tour="guest-new"]', title: "Letting someone in from outside",
    body: <p>A customer, a candidate or a contractor joins without an account and can't leave the one room you pick. Choose the shortest expiry that works. Screen sharing stays off unless you turn it on.</p> },
  { stop: "guests", tab: "guests", target: '[data-tour="guest-links"]', title: "Links you've made",
    careful: <>A permanent link works for anyone it's forwarded to until you revoke it. Revoking removes anyone using it straight away.</> },
  { stop: "analytics", tab: "analytics", target: '[data-tour="analytics-controls"]', title: "Pick the day or week",
    body: <p>Any day or week, in your timezone or the team's main ones. <b>Download CSV</b> gives you the same data.</p> },
  { stop: "analytics", tab: "analytics", target: '[data-tour="analytics-timeline"]', title: "Available, Focusing, Away",
    body: <p>It shows time in the office, not the work itself. Use it to spot a pattern, then talk to the person before you decide what it means.</p>,
    careful: <>This is data about people. Share it with their manager, not in a public channel.</> },
  { stop: "settings", tab: "settings", target: '[data-tour="settings-audio"]', title: "How far voices carry",
    body: <p>The audio range on the open floor, for everyone, from the next time they join.</p>,
    careful: <>Everything on this page applies to the whole office.</> },
  { stop: "settings", tab: "settings", target: '[data-tour="settings-transcription"]', title: "Room transcription",
    body: <p>Hours of audio sent this month and the monthly limit. Room notes go only to the people who were in the room; in Space, admins don't see other rooms' notes.</p> },
  { stop: "designer", title: "Office Designer",
    body: <>
      <p>It lives in the office: open the side panel and choose <b>Design</b>. Describe a change in plain English ("add two desks to Sales") or edit by hand.</p>
      <p>Only you see the preview. <b>Apply for everyone</b> changes the floor for the whole company, and <b>History</b> brings back any earlier version.</p>
      <p><a href="/?panel=designer" target="_blank" rel="noreferrer">Open the Designer in a new tab</a></p>
    </> },
  { stop: "rules", title: "Ground rules" },
];

const RULES = [
  "What I change here reaches everyone, straight away.",
  "Remove and revoke are immediate. The person is signed out on the spot.",
  "Payroll and manager access are separate. Only a payroll admin can grant them, in Payroll → Access or when setting up a new hire.",
  "I can't demote or remove myself. Another admin has to.",
  "When I'm not sure, I preview first or ask in Slack.",
];

export function AdminTour({ tab, go }: { tab: AdminTab; go: (t: AdminTab) => void }) {
  const o = useOnboard();
  const a = o.admin;
  const forced = new URLSearchParams(location.search).get("tour") === "1";
  const [open, setOpen] = useState<boolean | null>(null);
  const [i, setI] = useState(0);
  const [ticked, setTicked] = useState<boolean[]>(RULES.map(() => false));
  const [done, setDone] = useState(false);

  // Start: from the top when asked for, otherwise where they left off.
  useEffect(() => {
    if (!a || open !== null) return;
    const want = forced || (a.autoOpen && !a.finished);
    setOpen(want);
    if (want && !forced) {
      const first = STEPS.findIndex((s) => !a.done[s.stop]);
      setI(first < 0 ? 0 : first);
    }
  }, [Boolean(a)]);

  const step = STEPS[i];

  // Each step opens its page; a stop is done once its last step has been shown.
  useEffect(() => {
    if (!open || done) return;
    if (step.tab && step.tab !== tab) go(step.tab);
    if (STEPS[i + 1]?.stop !== step.stop && step.stop !== "rules") markStep("admin", step.stop);
  }, [i, open, done]);

  const close = () => {
    setOpen(false);
    if (a && !a.finished) dismissTrack("admin");
    history.replaceState(null, "", location.pathname);
  };
  const next = () => setI((n) => Math.min(STEPS.length - 1, n + 1));
  const back = () => setI((n) => Math.max(0, n - 1));

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight" && step.stop !== "rules") next();
      else if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  if (!a || !open) return null;

  if (done) {
    return (
      <div className="tour-card" role="dialog" aria-label="Admin tour">
        <h3>You're set up as an admin.</h3>
        <p className="hint">That's the last of your tours. Run this one again any time with <b>Take the admin tour</b> at the top of this page.</p>
        <div className="tour-actions"><span /><button className="primary small" onClick={close}>Done</button></div>
      </div>
    );
  }

  return (
    <>
      {step.target ? <Ring selector={step.target} key={i} /> : null}
      <div className="tour-card" role="dialog" aria-label="Admin tour">
        <div className="tour-top">
          <span className="eyebrow">Admin tour · {i + 1} of {STEPS.length}</span>
          <button className="ghost small" onClick={close} title="Close (Esc). 'Take the admin tour' restarts it." aria-label="Close the tour"><Icon name="close" size={14} /></button>
        </div>
        {i === 0 && a.grantedBy ? <p className="tour-hello">{a.grantedBy.split(" ")[0]} made you an admin. Here's what that covers.</p> : null}
        <h3>{step.title}</h3>
        {step.stop === "rules" ? (
          <>
            <p className="hint">Tick each one once you've read it.</p>
            <ul className="admin-rules">
              {RULES.map((r, k) => (
                <li key={r}><label className="check">
                  <input type="checkbox" checked={ticked[k]} onChange={(e) => setTicked(ticked.map((t, j) => (j === k ? e.target.checked : t)))} />{r}
                </label></li>
              ))}
            </ul>
          </>
        ) : (
          <div className="tour-body">
            {step.body}
            {step.careful ? <p className="admin-careful"><b>Careful:</b> {step.careful}</p> : null}
          </div>
        )}
        <div className="tour-progress" aria-hidden>{STEPS.map((_, k) => <span key={k} className={k === i ? "on" : k < i ? "past" : ""} />)}</div>
        <div className="tour-actions">
          <button className="small ghost" onClick={back} disabled={i === 0}>← Back</button>
          {step.stop === "rules" ? (
            <button className="small primary" disabled={!ticked.every(Boolean)} onClick={() => { markStep("admin", "rules"); setDone(true); }}>Finish</button>
          ) : (
            <button className="small primary" onClick={next}>Next →</button>
          )}
        </div>
      </div>
    </>
  );
}

/** Scrolls the control into view and rings it, following it as the page moves. Shared by the Time tours. */
export function Ring({ selector }: { selector: string }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const scrolled = useRef(false);
  useLayoutEffect(() => {
    let raf = 0;
    const started = performance.now();
    const tick = () => {
      const el = document.querySelector(selector);
      if (el) {
        if (!scrolled.current) {
          scrolled.current = true;
          // Into the upper part of the screen: the card sits at the bottom.
          const r = el.getBoundingClientRect();
          window.scrollTo({ top: Math.max(0, window.scrollY + r.top - 100), behavior: "smooth" });
        }
        setRect(el.getBoundingClientRect());
      } else if (performance.now() - started > 3000) {
        setRect(null); // nothing to point at (no members yet, say): the card explains on its own
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [selector]);
  if (!rect) return null;
  const pad = 6;
  return <div className="tour-ring" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: Math.min(rect.height, window.innerHeight * 0.55) + pad * 2 }} aria-hidden />;
}
