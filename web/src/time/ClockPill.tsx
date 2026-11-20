// The office toolbar's clock: shows whether you're clocked in. Clicking it opens
// a small menu — clock in, start or end a break, clock out — so a stray click
// never clocks anyone out; clocking out asks once more. Everything else lives on /time.

import { useEffect, useRef, useState } from "react";
import { api, hm, post } from "./api";
import { toast } from "../office/store";
import "./time.css";

interface Me { clockedIn: boolean; onBreak: boolean; since: string | null; todayMinutes: number; isManager?: boolean; isPayrollAdmin?: boolean }
interface Waiting { leaveCount: number; swapCount: number; timesheetCount: number }
type Kind = "in" | "out" | "break_start" | "break_end";

export function ClockPill() {
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const [offerAway, setOfferAway] = useState(false);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [, tick] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const load = () => api<Me>("/api/time/me").then(setMe).catch(() => setMe(null));
  const close = () => { setOpen(false); setConfirmOut(false); };
  useEffect(() => {
    load();
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    const r = setInterval(load, 5 * 60_000);
    // Coming back to the office tab: you may have clocked out on /time meanwhile.
    const onShow = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onShow);
    return () => { clearInterval(t); clearInterval(r); document.removeEventListener("visibilitychange", onShow); };
  }, []);
  // A click anywhere else, or Escape, closes the menu.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", esc); };
  }, [open]);
  if (!me) return null; // backend not there yet, or no access: stay out of the way
  const running = me.clockedIn && me.since ? (Date.now() - new Date(me.since).getTime()) / 60000 : 0;
  const act = async (kind: Kind) => {
    setBusy(true);
    try {
      const r = await post<{ suggestAway?: boolean }>("/api/time/clock", { kind });
      // Clocking in flips Away → Available on the server; clocking out only offers Away.
      setOfferAway(Boolean(r.suggestAway));
      if (r.suggestAway) setTimeout(() => setOfferAway(false), 12_000);
      close();
      await load();
    } catch (e) {
      alertless((e as Error).message);
      await load(); // act on the server's state next time, not a pill that may be minutes old
    } finally {
      setBusy(false);
    }
  };
  // Managers and payroll admins: how much is waiting on them, fetched only when the menu opens.
  const loadWaiting = () => api<Waiting>("/api/time/dashboard")
    .then((d) => setWaiting(d.leaveCount + d.swapCount + d.timesheetCount))
    .catch(() => setWaiting(null));
  const openMenu = () => { if (open) close(); else { setOpen(true); void load(); if (me.isManager) void loadWaiting(); } };
  return (
    <div className="clock-wrap" ref={box} data-tour="clock">
      {open ? (
        <div className="clock-menu" role="menu">
          {!me.clockedIn ? (
            <button className="primary" disabled={busy} onClick={() => act("in")}>Clock in</button>
          ) : confirmOut ? (
            <>
              <p>Clock out for today{me.todayMinutes ? ` (${hm(me.todayMinutes)} so far)` : ""}?</p>
              <div className="row">
                <button onClick={() => setConfirmOut(false)}>Cancel</button>
                <button className="danger" disabled={busy} onClick={() => act("out")}>Clock out</button>
              </div>
            </>
          ) : (
            <>
              {me.onBreak
                ? <button className="primary" disabled={busy} onClick={() => act("break_end")}>End break</button>
                : <button disabled={busy} onClick={() => act("break_start")}>Start a break</button>}
              <button onClick={() => setConfirmOut(true)}>Clock out…</button>
            </>
          )}
          <a href="/time" target="_blank" rel="noopener">Timesheet, leave and shifts</a>
          {me.isManager ? (
            <a className="clock-menu-approve" href="/time/team" target="_blank" rel="noopener">
              Approve leave &amp; timesheets{waiting ? <span className="clock-menu-count">{waiting}</span> : null}
            </a>
          ) : null}
          {me.isPayrollAdmin ? <a href="/payroll" target="_blank" rel="noopener">Access</a> : null}
        </div>
      ) : null}
      <div className={`clock-pill${me.clockedIn ? (me.onBreak ? " break" : " in") : ""}`}>
        <button className="clock-pill-main" onClick={openMenu} disabled={busy} aria-expanded={open} title="Clock in, take a break or clock out">
          <span className="clock-dot" />
          <span>{me.clockedIn ? (me.onBreak ? "On break" : `In · ${hm(running)}`) : "Clock in"}</span>
        </button>
        {offerAway ? (
          <button className="clock-pill-link offer-away" onClick={async () => { setOfferAway(false); await post("/api/time/status", { status: "away" }).catch(() => null); }} title="Show as Away in the office">Set Away?</button>
        ) : <a className="clock-pill-link" href="/time" target="_blank" rel="noopener" title="Your timesheet, leave and shifts">Time</a>}
      </div>
    </div>
  );
}

/** No browser dialogs (they block the office): a toast says what went wrong. */
function alertless(msg: string) {
  toast(`Clock didn't change: ${msg}`, { ttl: 8000 });
}
