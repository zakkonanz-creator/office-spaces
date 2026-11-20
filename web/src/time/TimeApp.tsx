// Time & Payroll: the shell (/time, /time/team, /payroll) and the member page.
// Phone-friendly, and independent of the office: no sockets, no audio/video.

import { useEffect, useState, type ReactNode } from "react";
import { access, addDays, api, dayLabel, flagLabel, hm, leaveLabel, NotAvailable, post, shiftSpan, timeOf, todayYmd, weekStart, type Access, type ShiftLike } from "./api";
import { Team } from "./Team";
import { Payroll } from "./Payroll";
import { TimeTour, markTimeStep } from "./TimeTour";
import { outgoingSwapText, swapForShift, swapOpen } from "../../../shared/swaps";
import { backToOffice } from "../officeTab";
import "./time.css";

export function TimeApp({ name }: { name: string }) {
  const path = location.pathname;
  const [acc, setAcc] = useState<Access | null>(null);
  useEffect(() => { access().then(setAcc); }, []);
  const section = path.startsWith("/payroll") ? "payroll" : path.startsWith("/time/team") ? "team" : "me";
  const manager = Boolean(acc?.managerTeams.length) || Boolean(acc?.payrollAdmin);
  const [officeHint, setOfficeHint] = useState(false);
  const toOffice = (e: React.MouseEvent) => { e.preventDefault(); void backToOffice(() => setOfficeHint(true)); };
  return (
    <div className="admin time">
      <header className="admin-head time-head">
        <div className="time-topbar">
          <a href="/" onClick={toOffice} className="time-brand" aria-label="Proximity Office"><span className="time-mark" aria-hidden>E</span><b>Acme</b><span className="muted">Time</span></a>
          <a href="/" onClick={toOffice} className="back">Back to the office →</a>
        </div>
        {officeHint ? <p className="flash">Your office is already open in another tab. Switch to that tab; you're still in the office there.</p> : null}
        <h1>{section === "payroll" ? "Access" : section === "team" ? "Team time" : "Time"}</h1>
        <nav className="tabs">
          <a className={`tab-link${section === "me" ? " on" : ""}`} href="/time">My time</a>
          {manager ? <a className={`tab-link${section === "team" ? " on" : ""}`} href="/time/team">Team</a> : null}
          {acc?.payrollAdmin ? <a className={`tab-link${section === "payroll" ? " on" : ""}`} href="/payroll">Access</a> : null}
        </nav>
      </header>
      <main className="admin-body">
        {!acc ? null : section === "payroll" ? (acc.payrollAdmin ? <TimeTour track="payroll" /> : null) : section === "team" ? (manager ? <TimeTour track="manager" /> : null) : <TimeTour track="time" />}
        {!acc ? <p className="muted">Loading…</p> : section === "payroll" ? (
          acc.payrollAdmin ? <Payroll /> : <Denied what="Access is for time admins." />
        ) : section === "team" ? (
          manager ? <Team teams={acc.managerTeams} /> : <Denied what="Team time is for managers." />
        ) : (
          <MyTime name={name} />
        )}
      </main>
    </div>
  );
}

export function Denied({ what }: { what: string }) {
  return <div className="panel"><b>{what}</b><span className="muted">Ask an admin if you should have access.</span></div>;
}

export function Unavailable() {
  return <div className="panel"><b>Not available yet</b><span className="muted">Time tracking is not switched on yet.</span></div>;
}

/** Loads `url`; renders the "not available yet" panel if the backend isn't there. */
export function useLoad<T>(url: string | null): [T | null, () => void, string] {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!url) return;
    let live = true;
    api<T>(url).then((d) => { if (live) { setData(d); setErr(""); } }).catch((e) => live && setErr(e instanceof NotAvailable ? "unavailable" : (e as Error).message));
    return () => { live = false; };
  }, [url, n]);
  return [data, () => setN((x) => x + 1), err];
}

export function Msg({ text }: { text: string }) {
  return text ? <p className={`time-msg${/^(saved|done|sent|approved|clocked|requested|claimed|closed|imported|added|removed)/i.test(text) ? " ok" : ""}`}>{text}</p> : null;
}

// ── Member ─────────────────────────────────────────────────────────────────

interface Shift { id: number; user_id: number | null; team: string; date: string; start_local: string; end_local: string; timezone: string; note?: string | null; open?: boolean }
interface MeT {
  clockedIn: boolean; onBreak: boolean; since: string | null; todayMinutes: number; weekMinutes: number;
  flags: (string | { code?: string; message?: string })[];
  upcomingShifts: Shift[];
  leaveBalances: { code: string; name?: string; paid?: boolean; has_balance?: boolean; days: number; per_month?: number | null; per_year?: number | null }[];
  leaveRequests: { id: number; code: string; start_date: string; end_date: string; days: number; status: string; note?: string | null }[];
  team: string | null;
}

function MyTime({ name }: { name: string }) {
  const [me, reload, err] = useLoad<MeT>("/api/time/me");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [offerAway, setOfferAway] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  // The clock ticks every second while you're clocked in; otherwise a slow refresh is enough.
  const [now, setNow] = useState(Date.now());
  const running = Boolean(me?.clockedIn);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), running ? 1000 : 30_000); return () => clearInterval(t); }, [running]);
  useEffect(() => { if (running) markTimeStep("time", "clock"); }, [running]); // the tour's first stop is done by doing it
  if (err === "unavailable") return <Unavailable />;
  if (err) return <p className="error">{err}</p>;
  if (!me) return <p className="muted">Loading…</p>;
  const clock = async (kind: string) => {
    setBusy(true);
    setConfirmOut(false);
    try {
      const r = await post<{ statusChanged?: string | null; suggestAway?: boolean }>("/api/time/clock", { kind });
      setMsg(kind === "in" ? (r.statusChanged === "available" ? "Clocked in — you're showing as Available in the office." : "Clocked in.") : kind === "out" ? "Clocked out." : kind === "break_start" ? "Done — break started." : "Done — back from break.");
      setOfferAway(Boolean(r.suggestAway));
      reload();
    } catch (e) {
      setMsg((e as Error).message);
      reload(); // e.g. "already clocked in" from the phone: show the server's state, not this page's
    } finally {
      setBusy(false);
    }
  };
  const state = me.clockedIn ? (me.onBreak ? "break" : "in") : "out";
  const secs = me.clockedIn && me.since ? Math.max(0, Math.floor((now - new Date(me.since).getTime()) / 1000)) : 0;
  return (
    <div className="time-grid">
      <section className={`panel clock-card is-${state}`} data-tour="clock">
        <div className="clock-head">
          <span className="eyebrow">{name.split(" ")[0]}, {me.clockedIn ? (me.onBreak ? "you're on a break" : "you're clocked in") : "you're clocked out"}</span>
          <span className={`clock-chip ${state}`}><i />{state === "in" ? "On the clock" : state === "break" ? "On a break" : "Off the clock"}</span>
        </div>
        {me.clockedIn ? (
          <div className="clock-face">
            <b className="clock-timer">{stopwatch(secs)}</b>
            <span className="muted">{me.onBreak ? "On a break · " : ""}since {me.since ? timeOf(me.since) : "—"}</span>
          </div>
        ) : (
          <div className="clock-face">
            <b className="clock-timer idle">Not working</b>
            <span className="muted">Clock in when you start. It's never automatic.</span>
          </div>
        )}
        <div className="clock-actions">
          {me.clockedIn && confirmOut ? (
            <>
              <button className="primary big" disabled={busy} onClick={() => clock("out")}>Yes, clock out</button>
              <button className="big" onClick={() => setConfirmOut(false)}>Cancel</button>
            </>
          ) : me.clockedIn ? (
            <>
              <button className="primary big" disabled={busy} onClick={() => setConfirmOut(true)}>Clock out…</button>
              <button className="big" disabled={busy} onClick={() => clock(me.onBreak ? "break_end" : "break_start")}>{me.onBreak ? "End break" : "Start break"}</button>
            </>
          ) : (
            <button className="primary big" disabled={busy} onClick={() => clock("in")}>Clock in</button>
          )}
        </div>
        <div className="time-totals">
          <div><span className="muted">Today</span><b>{hm(me.todayMinutes)}</b></div>
          <div><span className="muted">This week</span><b>{hm(me.weekMinutes)}</b></div>
        </div>
        {offerAway ? (
          <div className="offer">
            <span>Show as Away in the office?</span>
            <button className="small" onClick={() => setOfferAway(false)}>No</button>
            <button className="small primary" onClick={async () => { await post("/api/time/status", { status: "away" }).catch(() => null); setOfferAway(false); setMsg("Done — you're Away in the office."); }}>Set Away</button>
          </div>
        ) : null}
        {me.flags.length ? <ul className="flags">{me.flags.map((f, i) => <li key={i}>{flagLabel(f)} — tell your manager so they can fix it.</li>)}</ul> : null}
        <Msg text={msg} />
      </section>

      <ProjectTimer state={state} />

      <Week />

      <Leave me={me} onChange={reload} />

      <Shifts shifts={me.upcomingShifts} onChange={reload} />

      <Availability />
    </div>
  );
}

interface ProjectsMe {
  running: { id: number; client: string; project: string; note: string | null; startedAt: string } | null;
  today: { id: number; client: string; project: string; note: string | null; startedAt: string; endedAt: string | null; minutes: number }[];
  todayMinutes: number;
  recent: { client: string; project: string }[];
  clients: string[];
}

/** What you're working on: pick a client (and project), start, stop. Lives inside your clocked-in time. */
function ProjectTimer({ state }: { state: "in" | "break" | "out" }) {
  // The clock changing (a break, clocking out) stops the timer on the server: reload with it.
  const [data, reload] = useLoad<ProjectsMe>(`/api/time/projects/me?s=${state}`);
  const [client, setClient] = useState("");
  const [project, setProject] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const running = data?.running ?? null;
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), running ? 1000 : 60_000); return () => clearInterval(t); }, [running]);
  if (!data) return null;
  const call = async (fn: () => Promise<unknown>, done = "") => {
    if (busy) return;
    setBusy(true);
    try { await fn(); setMsg(done); reload(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const start = (c: string, p: string) => call(() => post("/api/time/projects/start", { client: c, project: p }), "");
  const secs = running ? Math.max(0, Math.floor((now - new Date(running.startedAt).getTime()) / 1000)) : 0;
  return (
    <section className="panel project-timer">
      <div className="row-between"><h3>Working on</h3>{data.todayMinutes ? <span className="muted small-text">{hm(data.todayMinutes)} on projects today</span> : null}</div>
      {running ? (
        <div className="project-running">
          <div>
            <b>{running.client}</b>{running.project ? <span className="muted"> · {running.project}</span> : null}
            <div className="clock-timer small">{stopwatch(secs)}</div>
          </div>
          <button className="primary" disabled={busy} onClick={() => call(() => post("/api/time/projects/stop", {}), "Stopped.")}>Stop</button>
        </div>
      ) : state !== "in" ? (
        <p className="empty">{state === "break" ? "On a break — end it to track project time." : "Clock in, then pick what you're working on."}</p>
      ) : (
        <>
          <div className="form-2">
            <label>Client<input list="project-clients" value={client} maxLength={80} onChange={(e) => setClient(e.target.value)} placeholder="e.g. Certainty Engine" /></label>
            <label>Project<input value={project} maxLength={80} onChange={(e) => setProject(e.target.value)} placeholder="Optional, e.g. Website build" /></label>
          </div>
          <datalist id="project-clients">{data.clients.map((c) => <option key={c} value={c} />)}</datalist>
          <button className="primary" disabled={!client.trim() || busy} onClick={() => start(client, project)}>Start timer</button>
          {data.recent.length ? (
            <div className="chips">{data.recent.slice(0, 6).map((r) => (
              <button key={`${r.client}|${r.project}`} className="chip" disabled={busy} onClick={() => start(r.client, r.project)} title="Start a timer on this">▶ {r.client}{r.project ? ` · ${r.project}` : ""}</button>
            ))}</div>
          ) : null}
        </>
      )}
      <Msg text={msg} />
      {data.today.filter((e) => e.endedAt).length ? (
        <table className="grid compact">
          <tbody>
            {data.today.filter((e) => e.endedAt).map((e) => (
              <tr key={e.id}>
                <td>{e.client}{e.project ? <span className="muted"> · {e.project}</span> : null}</td>
                <td className="nowrap muted">{timeOf(e.startedAt)}–{timeOf(e.endedAt!)}</td>
                <td className="num">{hm(e.minutes)}</td>
                <td className="actions">{removing === e.id
                  ? <><button className="small danger" disabled={busy} onClick={() => { setRemoving(null); call(() => post(`/api/time/projects/${e.id}`, undefined, "DELETE"), "Removed."); }}>Remove it</button> <button className="small ghost" onClick={() => setRemoving(null)}>Keep</button></>
                  : <button className="small ghost danger" disabled={busy} onClick={() => setRemoving(e.id)}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="hint">Separate from clocking in: this says which client the time went to, so we can see what done-for-you work really takes.</p>
    </section>
  );
}

/** 3725 → "1:02:05". */
const stopwatch = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

function ShiftCard({ s, action, children }: { s: Shift; action?: ReactNode; children?: ReactNode }) {
  const sp = shiftSpan(s);
  const [y, m, d] = sp.localDay.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return (
    <li className="shift-card">
      <span className="date-badge"><small>{date.toLocaleDateString(undefined, { weekday: "short" })}</small><b>{d}</b></span>
      <span className="shift-card-body">
        <b>{sp.label}{sp.label.includes("+1") ? <span className="tag night">overnight</span> : null}</b>
        <span className="muted small-text">{s.team}{!sp.sameTz ? ` · ${sp.theirs}` : ""}{s.note ? ` · ${s.note}` : ""}</span>
      </span>
      {action}
      {children ? <div className="shift-card-extra">{children}</div> : null}
    </li>
  );
}

interface SwapRow { id: number; shift_id: number; status: string; note: string | null; updated_at: string; date: string; start_local: string; end_local: string; timezone: string; team: string; from_name?: string; to_name?: string }

/** "Tue 21 Oct 09:00–17:00" in the viewer's own time. */
const shiftShort = (s: ShiftLike) => {
  const sp = shiftSpan(s);
  return `${sp.start.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${sp.label}`;
};

/** Upcoming shifts, with swaps: ask a teammate to take one, and answer when they ask you. */
function Shifts({ shifts, onChange }: { shifts: Shift[]; onChange: () => void }) {
  const [swaps, reload] = useLoad<{ incoming: SwapRow[]; outgoing: SwapRow[] }>("/api/time/swaps/mine");
  const [asking, setAsking] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const outgoing = swaps?.outgoing ?? [];
  const act = async (url: string, done: string) => {
    if (busy) return;
    setBusy(true);
    try { await post(url); setMsg(done); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); reload(); }
  };
  // Swaps a manager approved: the shift isn't mine any more, so it has no card to sit on.
  const handedOver = outgoing.filter((w) => w.status === "approved" && !shifts.some((s) => s.id === w.shift_id));
  return (
    <section className="panel" data-tour="shifts">
      <h3>Upcoming shifts</h3>
      {swaps?.incoming.length ? (
        <ul className="swap-asks">
          {swaps.incoming.map((w) => (
            <li key={w.id} className="offer">
              <span><b>{w.from_name}</b> asked you to take {shiftShort(w)}{w.note ? <span className="muted"> · “{w.note}”</span> : null}</span>
              <button className="small" disabled={busy} onClick={() => act(`/api/time/swaps/${w.id}/decline`, "Done — declined. They'll hear on Slack.")}>Decline</button>
              <button className="small primary" disabled={busy} onClick={() => act(`/api/time/swaps/${w.id}/accept`, "Done — accepted. It goes to your manager to approve.")}>Accept</button>
            </li>
          ))}
        </ul>
      ) : null}
      {shifts.length ? (
        <ul className="shift-cards">{shifts.map((s) => {
          const w = swapForShift(outgoing, s.id);
          const open = Boolean(w && swapOpen(w.status));
          return (
            <ShiftCard key={s.id} s={s} action={swaps && !open && asking !== s.id ? <button className="small" onClick={() => { setAsking(s.id); setMsg(""); }}>Swap…</button> : null}>
              {w ? (
                <div className="swap-status">
                  <span className={`pill ${w.status === "approved" ? "ok" : open ? "wait" : "no"}`}>{outgoingSwapText(w.status, w.to_name ?? "")}</span>
                  {open ? <button className="small ghost danger" disabled={busy} onClick={() => act(`/api/time/swaps/${w.id}/cancel`, "Done — swap cancelled. The shift is still yours.")}>Cancel swap</button> : null}
                </div>
              ) : null}
              {asking === s.id ? <SwapForm shiftId={s.id} onClose={() => setAsking(null)} onSent={(name) => { setAsking(null); setMsg(`Sent — ${name} will get a Slack message.`); reload(); }} /> : null}
            </ShiftCard>
          );
        })}</ul>
      ) : <p className="empty">No shifts scheduled. Your manager's schedule shows up here, in your own timezone.</p>}
      {handedOver.length ? (
        <ul className="swap-done">{handedOver.map((w) => <li key={w.id} className="muted small-text">{shiftShort(w)}: {outgoingSwapText(w.status, w.to_name ?? "")}</li>)}</ul>
      ) : null}
      <Msg text={msg} />
      <OpenShifts onChange={onChange} />
    </section>
  );
}

/** Pick a teammate, add a note, send. The teammate accepts, then a manager approves. */
function SwapForm({ shiftId, onClose, onSent }: { shiftId: number; onClose: () => void; onSent: (name: string) => void }) {
  const [mates, , err] = useLoad<{ id: number; name: string }[]>("/api/time/teammates");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (busy || !to) return;
    setBusy(true);
    try {
      await post("/api/time/swaps", { shift_id: shiftId, to_user: Number(to), note: note.trim() || null });
      onSent(mates?.find((m) => String(m.id) === to)?.name.split(" ")[0] ?? "they");
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  if (err) return <p className="error">{err === "unavailable" ? "Swaps aren't available yet." : err}</p>;
  if (!mates) return <p className="muted">Loading…</p>;
  if (!mates.length) return <div className="swap-form"><p className="empty">Nobody else is on your team yet, so there's no one to swap with.</p><button className="small ghost" onClick={onClose}>Close</button></div>;
  return (
    <div className="swap-form">
      <label>Ask<select value={to} onChange={(e) => setTo(e.target.value)}><option value="">Pick a teammate…</option>{mates.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <label>Note<input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Optional, e.g. doctor's appointment" /></label>
      <div className="swap-form-actions">
        <button className="small ghost" onClick={onClose}>Cancel</button>
        <button className="small primary" disabled={!to || busy} onClick={send}>{busy ? "Sending…" : "Send"}</button>
      </div>
      <p className="hint">They accept it, then your manager approves. Until then the shift is still yours.</p>
      <Msg text={msg} />
    </div>
  );
}

function Week() {
  const [week, setWeek] = useState(weekStart());
  const [ts, , err] = useLoad<{ days: { date: string; minutes: number; events: { id: number; kind: string; at: string; voided?: boolean }[] }[]; total: number; approved: boolean; flags: any[] }>(`/api/time/timesheet?week=${week}`);
  return (
    <section className="panel" data-tour="week">
      <div className="row-between">
        <h3>My week</h3>
        <div className="week-nav">
          <button className="small ghost" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">‹</button>
          <span>{dayLabel(week)}</span>
          <button className="small ghost" onClick={() => setWeek(addDays(week, 7))} disabled={week >= weekStart()} aria-label="Next week">›</button>
        </div>
      </div>
      {err ? <p className="muted">{err === "unavailable" ? "Not available yet." : err}</p> : !ts ? <p className="muted">Loading…</p> : (
        <>
          <div className="week-bars">
            {ts.days.map((d) => {
              const scale = Math.max(480, ...ts.days.map((x) => x.minutes));
              const live = d.events.filter((e) => !e.voided);
              return (
                <div key={d.date} className={`wb-row${d.date === todayYmd() ? " today" : ""}`} title={live.map((e) => `${evLabel(e.kind)} ${timeOf(e.at)}`).join(" · ")}>
                  <span className="wb-day">{dayLabel(d.date)}</span>
                  <span className="wb-track"><span className="wb-fill" style={{ width: `${Math.min(100, (d.minutes / scale) * 100)}%` }} /></span>
                  <span className="wb-val">{d.minutes ? hm(d.minutes) : "—"}</span>
                </div>
              );
            })}
          </div>
          <div className="row-between week-foot">
            <span className={`pill ${ts.approved ? "ok" : "wait"}`}>{ts.approved ? "Approved" : "Not approved yet"}</span>
            <span className="week-total"><span className="muted">Total</span> <b>{hm(ts.total)}</b></span>
          </div>
        </>
      )}
    </section>
  );
}

export const evLabel = (k: string) => ({ in: "In", out: "Out", break_start: "Break", break_end: "Back" } as Record<string, string>)[k] ?? k;

function OpenShifts({ onChange }: { onChange: () => void }) {
  const from = weekStart();
  const [shifts, reload, err] = useLoad<Shift[]>(`/api/time/shifts?from=${from}&to=${addDays(from, 27)}&open=1`);
  const [msg, setMsg] = useState("");
  if (err || !shifts) return null;
  const open = shifts.filter((s) => s.open || s.user_id === null);
  if (!open.length) return null;
  return (
    <>
      <h4 className="sub">Open shifts you can take</h4>
      <ul className="shift-cards">
        {open.map((s) => (
          <ShiftCard key={s.id} s={s} action={<button className="small" onClick={async () => {
            try { await post(`/api/time/shifts/${s.id}/claim`); setMsg("Claimed — it's yours."); reload(); onChange(); } catch (e) { setMsg((e as Error).message); }
          }}>Take it</button>} />
        ))}
      </ul>
      <Msg text={msg} />
    </>
  );
}

function Leave({ me, onChange }: { me: MeT; onChange: () => void }) {
  // Vacation first: the types come back sorted by code, which would put "National holiday" on top.
  const [code, setCode] = useState(me.leaveBalances.some((b) => b.code === "vacation") || !me.leaveBalances.length ? "vacation" : me.leaveBalances[0].code);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");
  const [half, setHalf] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const oneDay = Boolean(start) && (!end || end === start);
  // The server's leave types (they come back with the balances); a guess list only if it sent none.
  const codes = me.leaveBalances.length ? me.leaveBalances.map((b) => b.code) : ["vacation", "sick", "personal", "unpaid"];
  const nameOf = (c: string) => me.leaveBalances.find((b) => b.code === c)?.name ?? leaveLabel(c);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await post("/api/time/leave", { code, start_date: start, end_date: end || start, note: note || null, ...(half && oneDay ? { half_day: true } : {}) });
      setMsg("Requested — your manager will get it.");
      setStart(""); setEnd(""); setNote(""); setHalf(false);
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel" data-tour="leave">
      <h3>Leave</h3>
      {me.leaveBalances.length ? (
        <div className="balances">{me.leaveBalances.filter((b) => b.has_balance !== false).map((b) => <div key={b.code}><span className="muted">{b.name ?? leaveLabel(b.code)}</span><b>{b.days} {b.days === 1 ? "day" : "days"}</b>{b.per_month ? <span className="muted small-text" title="Added every month on the day of the month you started">+{b.per_month} a month</span> : b.per_year ? <span className="muted small-text" title="The year's days arrive on Jan 1, less any of next year's leave already approved; what's left from last year doesn't carry over">{b.per_year} a year, on Jan 1</span> : null}</div>)}</div>
      ) : null}
      <div className="form-2">
        <label className="wide">Type<select value={code} onChange={(e) => setCode(e.target.value)}>{codes.map((c) => <option key={c} value={c}>{nameOf(c)}</option>)}</select></label>
        <label>From<input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label>To<input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></label>
        <label className="wide">Note<input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></label>
        {oneDay ? <label className="check wide"><input type="checkbox" checked={half} onChange={(e) => setHalf(e.target.checked)} /> Half day (counts as 0.5)</label> : null}
      </div>
      {me.leaveBalances.find((b) => b.code === code)?.paid === false || code === "unpaid" ? <p className="hint">Unpaid leave is taken off that month's pay.</p> : null}
      <p className="hint">Only your working days count, so a day you don't normally work isn't charged.</p>
      <button className="primary" disabled={!start || busy} onClick={submit}>{busy ? "Requesting…" : "Request leave"}</button>
      <Msg text={msg} />
      {me.leaveRequests.length ? (
        <table className="grid compact leave-list">
          <tbody>
            {me.leaveRequests.map((r) => (
              <tr key={r.id}>
                <td>{nameOf(r.code)}</td>
                <td className="nowrap range">{r.start_date === r.end_date ? dayLabel(r.start_date) : `${dayLabel(r.start_date)} – ${dayLabel(r.end_date)}`}</td>
                <td className="num">{r.days}d</td>
                <td><StatusPill s={r.status} /></td>
                <td className="actions">{r.status === "pending" ? <button className="small ghost danger" onClick={async () => {
                  try { await post(`/api/time/leave/${r.id}`, undefined, "DELETE"); setMsg("Removed the request."); onChange(); } catch (e) { setMsg((e as Error).message); }
                }}>Cancel</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

interface AvailItem { id: number; kind: "weekly" | "date"; dow: number | null; date: string | null; start_local: string | null; end_local: string | null; note: string | null }
const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** When you can't work, so managers don't schedule you then. In your own timezone. */
function Availability() {
  const [data, reload, err] = useLoad<{ timezone: string; items: AvailItem[] }>("/api/time/availability");
  const [kind, setKind] = useState<"weekly" | "date">("weekly");
  const [dow, setDow] = useState(6);
  const [allDay, setAllDay] = useState(true);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("17:00");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  if (err) return null;
  const add = async () => {
    try {
      await post("/api/time/availability", kind === "weekly"
        ? { kind, dow, start_local: allDay ? null : start, end_local: allDay ? null : end, note: note || null }
        : { kind, date, note: note || null });
      setMsg("Saved — managers will see it on the schedule."); setNote(""); setDate(""); reload();
    } catch (e) { setMsg((e as Error).message); }
  };
  const line = (a: AvailItem) => a.kind === "date"
    ? dayLabel(a.date!)
    : `Every ${DOW_NAMES[a.dow ?? 0]}${a.start_local ? `, ${a.start_local}–${a.end_local}${a.end_local! <= a.start_local ? " (+1)" : ""}` : ", all day"}`;
  return (
    <section className="panel availability" data-tour="unavailable">
      <div className="row-between"><h3>When I can't work</h3>{data ? <span className="muted small-text">Your time · {data.timezone}</span> : null}</div>
      {data?.items.length ? (
        <ul className="avail-list">
          {data.items.map((a) => (
            <li key={a.id}>
              <span className={`tag ${a.kind === "date" ? "leave-unpaid" : ""}`}>{a.kind === "date" ? "One day" : "Weekly"}</span>
              <span>{line(a)}</span>
              {a.note ? <span className="muted">· {a.note}</span> : null}
              <button className="small ghost danger" onClick={async () => { try { await post(`/api/time/availability/${a.id}`, undefined, "DELETE"); reload(); } catch (e) { setMsg((e as Error).message); } }}>Remove</button>
            </li>
          ))}
        </ul>
      ) : <p className="empty">Nothing set. If there are times you can never work (classes, a second job), add them so you aren't scheduled then.</p>}
      <div className="avail-form">
        <select value={kind} onChange={(e) => setKind(e.target.value as "weekly" | "date")} aria-label="Repeat">
          <option value="weekly">Every week</option>
          <option value="date">One date</option>
        </select>
        {kind === "weekly" ? (
          <>
            <select value={dow} onChange={(e) => setDow(Number(e.target.value))} aria-label="Day">{DOW_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
            <label className="check"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day</label>
            {!allDay ? <><input type="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label="From" /><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="To" /></> : null}
          </>
        ) : <input type="date" value={date} min={todayYmd()} onChange={(e) => setDate(e.target.value)} aria-label="Date" />}
        <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Why (optional)" aria-label="Note" />
        <button className="small primary" disabled={kind === "date" && !date} onClick={add}>Add</button>
      </div>
      <Msg text={msg} />
      <p className="hint">This doesn't ask for time off — use Leave for that. It tells your manager when not to put you on a shift.</p>
    </section>
  );
}

export function StatusPill({ s: raw }: { s?: string | null }): ReactNode {
  const s = raw || "pending";
  const cls = s === "approved" || s === "accepted" ? "ok" : s === "rejected" || s === "denied" || s === "declined" || s === "cancelled" ? "no" : "wait";
  return <span className={`pill ${cls}`}>{s[0].toUpperCase() + s.slice(1)}</span>;
}
