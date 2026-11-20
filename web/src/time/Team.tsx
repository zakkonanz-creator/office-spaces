// Managers: approvals (leave, swaps), team timesheets for the week, and the
// schedule. Managers see hours, never pay.

import { Fragment, useEffect, useState } from "react";
import { shiftInZone } from "../../../shared/time";
import { addDays, api, dayLabel, flagLabel, hm, leaveLabel, listOf, NotAvailable, post, shiftSpan, shortTz, teamHue, wallToInstant, timeOf, todayYmd, viewerTz, weekStart, WEEKDAYS } from "./api";
import { evLabel, Msg, StatusPill, Unavailable, useLoad } from "./TimeApp";
import { LeaveCalendar, PublishBar, Today } from "./TeamExtras";
import { DayView, Locations, OffRow, Overview, People, type Coverage } from "./TeamViews";
import { announceTab, useTabRequests } from "./TimeTour";

// The tabs: what's waiting on me,
// approvals, timesheets, the schedule (day / week / month), who's on now, people, locations.
type Tab = "overview" | "approvals" | "timesheets" | "projects" | "schedule" | "today" | "people" | "locations";
const TAB_LABEL: Record<Tab, string> = { overview: "Overview", approvals: "Approvals", timesheets: "Timesheets", projects: "Project time", schedule: "Schedule", today: "Who's on now", people: "People", locations: "Locations" };

export function Team({ teams }: { teams: string[] }) {
  const [tab, setTab] = useState<Tab>("overview");
  useTabRequests(setTab);
  useEffect(() => { announceTab(tab); }, [tab]);
  return (
    <>
      <div className="seg">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)} data-tour={`tab-${t}`}>{TAB_LABEL[t]}</button>
        ))}
        {teams.length ? <span className="muted teams">{teams.includes("*") ? "You see every team" : `Your teams: ${teams.join(", ")}`}</span> : null}
      </div>
      {tab === "overview" ? <Overview go={setTab} /> : tab === "today" ? <Today teams={teams} /> : tab === "approvals" ? <Approvals /> : tab === "timesheets" ? <Timesheets /> : tab === "projects" ? <ProjectTime /> : tab === "schedule" ? <Schedule teams={teams} /> : tab === "people" ? <People teams={teams} /> : <Locations teams={teams} />}
    </>
  );
}

interface LeaveReq { id: number; user_id: number; name?: string; type_name?: string; balance?: number; code: string; start_date: string; end_date: string; days: number; status?: string; note?: string | null }
interface SwapReq { id: number; shift_id: number; from_user: number; to_user: number; from_name?: string; to_name?: string; date?: string; start_local?: string; end_local?: string; status?: string; note?: string | null }

function Approvals() {
  const [data, reload, err] = useLoad<{ leave: LeaveReq[]; swaps: SwapReq[]; upcoming?: LeaveReq[] }>("/api/time/approvals");
  const [revoking, setRevoking] = useState<number | null>(null);
  const [why, setWhy] = useState("");
  const [forceUrl, setForceUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  // One decision at a time: a second click while the first is in flight would be a second request.
  const [busy, setBusy] = useState(false);
  if (err === "unavailable") return <Unavailable />;
  if (err) return <p className="error">{err}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const decide = async (url: string, approve: boolean, force = false) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await post<{ warning?: string }>(url, { approve, note: null, force });
      setMsg(r?.warning ?? (approve ? "Approved." : "Done — declined."));
      setForceUrl(null);
      reload();
    } catch (e) {
      setMsg((e as Error).message);
      if (approve && /balance|force/i.test((e as Error).message)) setForceUrl(url);
    } finally {
      setBusy(false);
    }
  };
  // The server only sends leave that is waiting (no status field) and swaps already accepted.
  const pendingLeave = data.leave.filter((r) => (r.status ?? "pending") === "pending");
  const pendingSwaps = data.swaps.filter((r) => (r.status ?? "accepted") === "accepted");
  return (
    <div className="stack">
      <Msg text={msg} />
      <section className="panel">
        <div className="row-between"><h3>Leave requests</h3>{pendingLeave.length ? <span className="count">{pendingLeave.length} waiting</span> : null}</div>
        {data.leave.length ? (
          <ul className="req-list">
            {data.leave.map((r) => {
              const url = `/api/time/leave/${r.id}/decide`;
              return (
                <li key={r.id} className="req">
                  <span className="avatar-i" aria-hidden>{initials(r.name ?? "?")}</span>
                  <span className="req-body">
                    <b>{r.name ?? `#${r.user_id}`}</b>
                    <span className="req-meta">
                      <span className={`tag leave-${r.code}`}>{r.type_name ?? leaveLabel(r.code)}</span>
                      <span>{r.start_date === r.end_date ? dayLabel(r.start_date) : `${dayLabel(r.start_date)} – ${dayLabel(r.end_date)}`}</span>
                      <span className="muted">{r.days} {Number(r.days) === 1 ? "day" : "days"}{r.code === "unpaid" ? " · taken off pay" : r.balance != null ? ` · ${r.balance}d left` : ""}</span>
                    </span>
                    {r.note ? <span className="req-note">“{r.note}”</span> : null}
                  </span>
                  <span className="req-actions">
                    {(r.status ?? "pending") === "pending" ? (
                      <>
                        {forceUrl === url ? <button className="small" disabled={busy} onClick={() => decide(url, true, true)}>Approve over balance</button> : null}
                        <button className="small" disabled={busy} onClick={() => decide(url, false)}>Decline</button>
                        <button className="small primary" disabled={busy} onClick={() => decide(url, true)}>Approve</button>
                      </>
                    ) : <StatusPill s={r.status} />}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : <p className="empty">Nothing waiting. New leave requests from your teams land here.</p>}
      </section>
      <section className="panel">
        <div className="row-between"><h3>Upcoming leave</h3>{data.upcoming?.length ? <span className="muted small-text">{data.upcoming.length} approved</span> : null}</div>
        {data.upcoming?.length ? (
          <ul className="req-list">
            {data.upcoming.map((r) => (
              <li key={r.id} className="req">
                <span className="avatar-i" aria-hidden>{initials(r.name ?? "?")}</span>
                <span className="req-body">
                  <b>{r.name ?? `#${r.user_id}`}</b>
                  <span className="req-meta">
                    <span className={`tag leave-${r.code}`}>{r.type_name ?? leaveLabel(r.code)}</span>
                    <span>{r.start_date === r.end_date ? dayLabel(r.start_date) : `${dayLabel(r.start_date)} – ${dayLabel(r.end_date)}`}</span>
                    <span className="muted">{r.days} {Number(r.days) === 1 ? "day" : "days"}</span>
                  </span>
                  {revoking === r.id ? (
                    <span className="revoke">
                      <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why? (kept in the audit log and sent to them)" autoFocus />
                      <button className="small" onClick={() => { setRevoking(null); setWhy(""); }}>Keep it</button>
                      <button className="small danger" disabled={!why.trim() || busy} onClick={async () => {
                        if (busy) return;
                        setBusy(true);
                        try { await post(`/api/time/leave/${r.id}/revoke`, { note: why.trim() }); setMsg("Done — leave revoked and the balance restored."); setRevoking(null); setWhy(""); reload(); }
                        catch (e) { setMsg((e as Error).message); }
                        finally { setBusy(false); }
                      }}>Revoke leave</button>
                    </span>
                  ) : null}
                </span>
                <span className="req-actions">{revoking === r.id ? null : <button className="small ghost danger" onClick={() => { setRevoking(r.id); setWhy(""); }}>Revoke</button>}</span>
              </li>
            ))}
          </ul>
        ) : <p className="empty">No approved leave coming up.</p>}
      </section>
      <section className="panel">
        <div className="row-between"><h3>Shift swaps</h3>{pendingSwaps.length ? <span className="count">{pendingSwaps.length} waiting</span> : null}</div>
        {data.swaps.length ? (
          <ul className="req-list">
            {data.swaps.map((sw) => (
              <li key={sw.id} className="req">
                <span className="avatar-i" aria-hidden>{initials(sw.from_name ?? "?")}</span>
                <span className="req-body">
                  <b>{sw.from_name ?? `#${sw.from_user}`} → {sw.to_name ?? `#${sw.to_user}`}</b>
                  <span className="req-meta"><span>{sw.date ? `${dayLabel(sw.date)} · ${sw.start_local}–${sw.end_local}` : `Shift #${sw.shift_id}`}</span></span>
                  {sw.note ? <span className="req-note">“{sw.note}”</span> : null}
                </span>
                <span className="req-actions">
                  {(sw.status ?? "accepted") === "accepted" ? (
                    <>
                      <button className="small" disabled={busy} onClick={() => decide(`/api/time/swaps/${sw.id}/decide`, false)}>Decline</button>
                      <button className="small primary" disabled={busy} onClick={() => decide(`/api/time/swaps/${sw.id}/decide`, true)}>Approve</button>
                    </>
                  ) : <StatusPill s={sw.status} />}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="empty">Nothing waiting. A swap shows up once the other person has accepted it.</p>}
      </section>
    </div>
  );
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

interface TeamRow { userId: number; name: string; team: string | null; timezone?: string; days: { date: string; minutes: number; expected?: number }[]; total: number; expectedTotal?: number; approved: boolean; flags: any[] }
interface TeamWeek { weekStart: string; teams: string[]; people: TeamRow[] }

interface RangeRow { userId: number; name: string; team: string | null; timezone: string; worked: number; expected: number; daysWorked: number; flags: number; weeksApproved: number; weeks: number }

/** Week by week (to approve), or any range — a month, a pay period — to review. */
function Timesheets() {
  const [mode, setMode] = useState<"week" | "range">("week");
  const [from, setFrom] = useState(() => `${todayYmd().slice(0, 8)}01`);
  const [to, setTo] = useState(() => todayYmd());
  return (
    <div className="stack">
      <div className="admin-toolbar">
        <div className="seg small">
          <button className={mode === "week" ? "on" : ""} onClick={() => setMode("week")}>Week</button>
          <button className={mode === "range" ? "on" : ""} onClick={() => setMode("range")}>Month or dates</button>
        </div>
        {mode === "range" ? (
          <>
            <button className="small" onClick={() => { const t = todayYmd(); setFrom(`${t.slice(0, 8)}01`); setTo(t); }}>This month</button>
            <button className="small" onClick={() => { const end = addDays(`${todayYmd().slice(0, 8)}01`, -1); setFrom(`${end.slice(0, 8)}01`); setTo(end); }}>Last month</button>
            <label className="inline">From <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
            <label className="inline">To <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
          </>
        ) : null}
      </div>
      {mode === "week" ? <WeekSheets /> : <RangeSheets from={from} to={to} />}
    </div>
  );
}

interface ProjectReport { total: number; projects: { client: string; project: string; minutes: number; people: string[] }[]; people: { name: string; minutes: number; clients: string[] }[] }

/** Done-for-you time by client and project, and by person — from the "Working on" timers. */
function ProjectTime() {
  const [from, setFrom] = useState(() => `${todayYmd().slice(0, 8)}01`);
  const [to, setTo] = useState(() => todayYmd());
  const [data, , err] = useLoad<ProjectReport>(`/api/time/projects/report?from=${from}&to=${to}`);
  if (err === "unavailable") return <Unavailable />;
  return (
    <div className="stack">
      <div className="admin-toolbar">
        <button className="small" onClick={() => { const t = todayYmd(); setFrom(`${t.slice(0, 8)}01`); setTo(t); }}>This month</button>
        <button className="small" onClick={() => { const end = addDays(`${todayYmd().slice(0, 8)}01`, -1); setFrom(`${end.slice(0, 8)}01`); setTo(end); }}>Last month</button>
        <label className="inline">From <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label className="inline">To <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
        {data ? <span className="muted">{hm(data.total)} tracked</span> : null}
        <span className="spacer" />
        <a className="button small" href={`/api/time/projects/export?from=${from}&to=${to}`} download>Export entries (CSV)</a>
      </div>
      {err ? <p className="error">{err}</p> : !data ? <p className="muted">Loading…</p> : !data.projects.length ? (
        <p className="empty">No project time in these dates yet. People track it under My time → Working on, while clocked in.</p>
      ) : (
        <div className="split-2">
          <table className="grid compact">
            <thead><tr><th>Client</th><th>Project</th><th className="num">Time</th><th>Who</th></tr></thead>
            <tbody>{data.projects.map((p) => (
              <tr key={`${p.client}|${p.project}`}><td><b>{p.client}</b></td><td>{p.project || <span className="dash">—</span>}</td><td className="num">{hm(p.minutes)}</td><td className="muted small-text">{p.people.join(", ")}</td></tr>
            ))}</tbody>
          </table>
          <table className="grid compact">
            <thead><tr><th>Person</th><th className="num">Time</th><th>Clients</th></tr></thead>
            <tbody>{data.people.map((p) => (
              <tr key={p.name}><td><b>{p.name}</b></td><td className="num">{hm(p.minutes)}</td><td className="muted small-text">{p.clients.join(", ")}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RangeSheets({ from, to }: { from: string; to: string }) {
  const [data, , err] = useLoad<{ people: RangeRow[] }>(`/api/time/team/range?from=${from}&to=${to}`);
  if (err === "unavailable") return <Unavailable />;
  const rows = data?.people ?? null;
  const total = rows?.reduce((n, r) => n + r.worked, 0) ?? 0;
  return (
    <>
      <div className="admin-toolbar">
        <b>{dayLabel(from)} – {dayLabel(to)}</b>
        {rows ? <span className="muted">{hm(total)} worked across {rows.filter((r) => r.worked).length} people</span> : null}
        <span className="spacer" />
        <a className="button small" href={`/api/time/export/timesheets?from=${from}&to=${to}`} download>Export (CSV)</a>
      </div>
      {err ? <p className="error">{err}</p> : !rows ? <p className="muted">Loading…</p> : (
        <div className="scroll-x">
          <table className="grid compact">
            <thead><tr><th>Person</th><th className="num">Days worked</th><th className="num">Worked</th><th className="num">Expected</th><th className="num">Difference</th><th className="num">Weeks approved</th><th className="num">Flags</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const diff = r.worked - r.expected;
                return (
                  <tr key={r.userId}>
                    <td><div className="who"><b>{r.name}</b></div><span className="muted small-text">{[r.team, r.timezone ? shortTz(r.timezone) : null].filter(Boolean).join(" · ")}</span></td>
                    <td className="num">{r.daysWorked}</td>
                    <td className="num"><b>{hm(r.worked)}</b></td>
                    <td className="num">{r.expected ? hm(r.expected) : <span className="dash">—</span>}</td>
                    <td className={`num${r.expected && diff < -30 ? " short" : ""}`}>{r.expected ? `${diff < 0 ? "−" : "+"}${hm(Math.abs(diff))}` : <span className="dash">—</span>}</td>
                    <td className="num">{r.weeksApproved}/{r.weeks}</td>
                    <td className="num">{r.flags ? <span className="pill no">{r.flags}</span> : <span className="dash">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length ? <p className="muted">No one on your teams.</p> : null}
        </div>
      )}
    </>
  );
}

function WeekSheets() {
  const [week, setWeek] = useState(addDays(weekStart(), -7));
  const [data, reload, err] = useLoad<TeamWeek>(`/api/time/team?week=${week}`);
  const rows = data?.people ?? null;
  const [forceFor, setForceFor] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  // An approval in flight: the buttons wait for its answer instead of sending it twice.
  const [busy, setBusy] = useState(false);
  if (err === "unavailable") return <Unavailable />;
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const approve = async (user_id: number, force = false) => {
    if (busy) return;
    setBusy(true);
    try {
      await post("/api/time/timesheets/approve", { user_id, week_start: week, force });
      setMsg("Approved."); setForceFor(null); reload();
    } catch (e) {
      const m = (e as Error).message;
      setMsg(m);
      // Flagged clock problems block approval; the manager can fix them, or approve anyway on purpose.
      if (/flagged/.test(m)) setForceFor(user_id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <div className="admin-toolbar">
        <button className="small" onClick={() => setWeek(addDays(week, -7))}>‹ Previous</button>
        <b>Week of {dayLabel(week)}</b>
        <button className="small" onClick={() => setWeek(addDays(week, 7))} disabled={week >= weekStart()}>Next ›</button>
        <Msg text={msg} />
        <span className="spacer" />
        <a className="button small" href={`/api/time/export/timesheets?from=${week}&to=${addDays(week, 6)}`} download>Export week (CSV)</a>
        <a className="button small" href={`/api/time/export/timesheets?from=${week.slice(0, 8)}01&to=${monthEnd(week)}`} download>Export month</a>
      </div>
      {err ? <p className="error">{err}</p> : !rows ? <p className="muted">Loading…</p> : (
        <div className="scroll-x">
          <table className="grid compact sheet">
            <thead><tr><th>Person</th>{days.map((d) => <th key={d} className={`num${d === todayYmd() ? " today" : ""}`}>{dayHead(d)}</th>)}<th className="num">Logged</th><th className="num">Expected</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.userId}>
                  <tr className={open === r.userId ? "focus" : ""}>
                    <td>
                      <div className="who">
                        <button className="link" onClick={() => setOpen(open === r.userId ? null : r.userId)}>{r.name}</button>
                        {r.flags?.length ? <span className="pill no" title={r.flags.map(flagLabel).join(", ")}>{r.flags.length} flag{r.flags.length > 1 ? "s" : ""}</span> : null}
                      </div>
                      <span className="muted small-text">{r.team}{r.timezone ? ` · ${shortTz(r.timezone)}` : ""}</span>
                    </td>
                    {days.map((d) => {
                      const x = r.days.find((y) => y.date === d);
                      const m = x?.minutes, e = x?.expected ?? 0;
                      // Under what they were due by more than half an hour: worth a look before approving.
                      const short = e > 0 && (m ?? 0) < e - 30;
                      return (
                        <td key={d} className={`num hours${m ? "" : " none"}${short ? " short" : ""}${d === todayYmd() ? " today" : ""}`} title={e ? `Expected ${fmtDay(e)}` : "Not a working day"}>
                          {fmtDay(m)}{e ? <span className="exp">/{fmtDay(e)}</span> : null}
                        </td>
                      );
                    })}
                    <td className="num"><b>{hm(r.total)}</b></td>
                    <td className={`num${r.expectedTotal && r.total < r.expectedTotal - 30 ? " short" : ""}`}>{r.expectedTotal ? hm(r.expectedTotal) : <span className="dash">—</span>}</td>
                    <td className="actions">{r.approved ? <span className="pill ok">Approved</span> : <>
                      <button className="small primary" disabled={busy} onClick={() => approve(r.userId)}>Approve</button>
                      {forceFor === r.userId ? <button className="small" disabled={busy} title="Kept in the audit log as approved with flags" onClick={() => approve(r.userId, true)}>Approve anyway</button> : null}
                    </>}</td>
                  </tr>
                  {open === r.userId ? <tr><td colSpan={11}><Fix userId={r.userId} week={week} onChange={reload} /></td></tr> : null}
                </Fragment>
              ))}
            </tbody>
          </table>
          {!rows.length ? <p className="muted">No one on your teams has time this week.</p> : null}
        </div>
      )}
    </div>
  );
}

/** Last day of the month holding `day`. */
const monthEnd = (day: string) => { const [y, m] = day.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const fmtDay = (m?: number) => (m ? `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, "0")}` : "—");
/** "Mon 5". */
const dayHead = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return `${new Date(y, m - 1, dd).toLocaleDateString(undefined, { weekday: "short" })} ${dd}`; };

/** One person's week, event by event: add a missed clock-out, void a wrong entry. Every edit needs a reason. */
function Fix({ userId, week, onChange }: { userId: number; week: string; onChange: () => void }) {
  const [ts, reload, err] = useLoad<{ timezone?: string; days: { date: string; minutes: number; events: { id: number; kind: string; at: string; voided?: boolean; reason?: string | null }[] }[] }>(`/api/time/timesheet?week=${week}&user=${userId}`);
  const [kind, setKind] = useState("out");
  const [at, setAt] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  if (err) return <p className="muted">{err === "unavailable" ? "Not available yet." : err}</p>;
  if (!ts) return <p className="muted">Loading…</p>;
  const act = async (fn: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); setMsg(done); reload(); onChange(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  // The time typed is the employee's own clock time, not the manager's.
  const tz = ts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const instant = (local: string) => wallToInstant(local.slice(0, 10), local.slice(11, 16), tz).toISOString();
  return (
    <div className="fix">
      <div className="fix-days">
        {ts.days.filter((d) => d.events.length).map((d) => (
          <div key={d.date}>
            <b>{dayLabel(d.date)}</b>
            {d.events.map((e) => (
              <span key={e.id} className={`ev ev-${e.kind}${e.voided ? " voided" : ""}`}>
                {evLabel(e.kind)} {timeOf(e.at)}
                {!e.voided ? <button className="x" title="Void this entry" onClick={() => {
                  if (!reason.trim()) return setMsg("Write a reason first (it's kept in the audit log).");
                  act(() => post(`/api/time/events/${e.id}/void`, { reason }), "Done — entry voided.");
                }}>×</button> : null}
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className="form-grid">
        <label>Add<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="in">Clock in</option><option value="out">Clock out</option><option value="break_start">Break start</option><option value="break_end">Break end</option></select></label>
        <label>At <span className="muted small-text">(their time, {shortTz(tz)})</span><input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></label>
        <label className="wide">Reason (required)<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. forgot to clock out, confirmed on Slack" /></label>
      </div>
      <button className="small" disabled={!at || !reason.trim() || busy} onClick={() => act(() => post("/api/time/events", { user_id: userId, kind, at: instant(at), reason }), "Added.")}>Add entry</button>
      <Msg text={msg} />
    </div>
  );
}

interface Shift { id: number; user_id: number | null; user_name?: string | null; team: string; date: string; start_local: string; end_local: string; timezone: string; note?: string | null; published?: boolean }
interface Unavail { kind: "weekly" | "date"; dow?: number | null; date?: string | null; start_local?: string | null; end_local?: string | null; label: string }
interface Template { id: number; team: string; name: string; start_local: string; end_local: string; days_of_week: number[] | string }

function Schedule({ teams }: { teams: string[] }) {
  // The schedule: one day, the week, or the month (who's off, and why).
  const [view, setView] = useState<"day" | "week" | "month">("week");
  const [day, setDay] = useState(todayYmd());
  const [week, setWeek] = useState(weekStart());
  const [members] = useLoad<MemberRow[]>("/api/time/members");
  const all = teams.includes("*");
  // An all-teams manager (or payroll admin) picks from every team that has people, or sees them all.
  const teamList = all ? [...new Set((members ?? []).map((m) => m.team).filter((t): t is string => Boolean(t)))].sort() : teams;
  const [picked, setTeam] = useState("");
  const team = picked || teamList[0] || "";
  const shown = team === "*" ? teamList : team ? [team] : [];
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [err, setErr] = useState("");
  const [n, setN] = useState(0);
  const reload = () => setN((x) => x + 1);
  useEffect(() => {
    if (!shown.length) { setShifts([]); return; }
    let live = true;
    // One day either side: in the viewer's timezone a shift can land on a neighbouring day.
    Promise.all(shown.map((t) => api(`/api/time/shifts?from=${addDays(week, -1)}&to=${addDays(week, 7)}&team=${encodeURIComponent(t)}`)))
      .then((r) => { if (live) { setShifts(r.flatMap((x) => listOf<Shift>(x, "shifts"))); setErr(""); } })
      .catch((e) => live && setErr(e instanceof NotAvailable ? "unavailable" : (e as Error).message));
    return () => { live = false; };
  }, [week, shown.join("|"), n]);
  const [templates, reloadT] = useLoad<Template[]>("/api/time/templates");
  const [cov] = useLoad<Coverage>(`/api/time/coverage?from=${week}&to=${addDays(week, 6)}${team && team !== "*" ? `&team=${encodeURIComponent(team)}` : ""}`);
  const leaveOn = (uid: number, d: string) => cov?.people.find((p) => p.userId === uid)?.byDay[d]?.leave ?? null;
  const [avail] = useLoad<{ user_id: number; items: Unavail[] }[]>("/api/time/availability/team");
  /** What someone said about this (their local) day, for greying the cell. Times are in their timezone. */
  const unavailOn = (uid: number, d: string) => {
    const items = avail?.find((a) => a.user_id === uid)?.items ?? [];
    const [yy, mm, ddd] = d.split("-").map(Number);
    const dw = new Date(Date.UTC(yy, mm - 1, ddd)).getUTCDay();
    return items.filter((u) => (u.kind === "date" ? u.date === d : u.dow === dw));
  };
  const [conflict, setConflict] = useState<{ uid: number; shift: ShiftPost; message: string } | null>(null);
  const people = (members ?? []).map((m) => ({ user_id: m.id, name: m.name, team: m.team, tz: m.tz }));
  const [adding, setAdding] = useState<{ team: string; uid: number; date: string } | null>(null);
  const [tpl, setTpl] = useState({ name: "", start: "09:00", end: "17:00" });
  const [msg, setMsg] = useState("");
  if (err === "unavailable") return <Unavailable />;
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try { await fn(); setMsg(done); reload(); reloadT(); } catch (e) { setMsg((e as Error).message); }
  };
  const spans = new Map((shifts ?? []).map((s) => [s.id, shiftSpan(s)]));
  const rowsFor = (t: string) => [0, ...new Set([...people.filter((p) => p.team === t).map((p) => p.user_id), ...(shifts ?? []).filter((s) => s.team === t && s.user_id).map((s) => s.user_id!)])];
  const nameOf = (id: number) => people.find((p) => p.user_id === id)?.name ?? shifts?.find((s) => s.user_id === id)?.user_name ?? `#${id}`;
  const tzOfUser = (id: number) => people.find((p) => p.user_id === id)?.tz ?? null;
  const cell = (t: string, uid: number, d: string) => (shifts ?? []).filter((s) => s.team === t && (s.user_id ?? 0) === uid && spans.get(s.id)!.localDay === d);
  const hoursOf = (t: string, uid: number) => days.reduce((sum, d) => sum + cell(t, uid, d).reduce((m, s) => { const sp = spans.get(s.id)!; return m + (sp.end.getTime() - sp.start.getTime()) / 3_600_000; }, 0), 0);
  const [y, m, dd] = week.split("-").map(Number);
  const range = `${new Date(y, m - 1, dd).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${dayLabel(addDays(week, 6)).split(", ").pop()}`;
  const viewToggle = (
    <div className="seg-mini" role="tablist" aria-label="Schedule view">
      {(["day", "week", "month"] as const).map((v) => <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
    </div>
  );
  if (view === "month") return <div className="stack"><div className="admin-toolbar">{viewToggle}</div><LeaveCalendar teams={teams} /></div>;
  if (view === "day") {
    return (
      <div className="stack">
        <div className="admin-toolbar">
          {viewToggle}
          <div className="week-nav boxed">
            <button className="small ghost" onClick={() => setDay(addDays(day, -1))} aria-label="Previous day">‹</button>
            <b>{dayLabel(day)}</b>
            <button className="small ghost" onClick={() => setDay(addDays(day, 1))} aria-label="Next day">›</button>
          </div>
          <button className="small" onClick={() => setDay(todayYmd())} disabled={day === todayYmd()}>Today</button>
          {teamList.length > 1 || all ? (
            <select value={team} onChange={(e) => setTeam(e.target.value)}>
              {all && teamList.length > 1 ? <option value="*">All teams</option> : null}
              {teamList.map((t) => <option key={t}>{t}</option>)}
            </select>
          ) : null}
        </div>
        <DayView date={day} team={team} />
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="admin-toolbar">
        {viewToggle}
        <div className="week-nav boxed">
          <button className="small ghost" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">‹</button>
          <b>{range}</b>
          <button className="small ghost" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week">›</button>
        </div>
        <button className="small" onClick={() => setWeek(weekStart())} disabled={week === weekStart()}>This week</button>
        {teamList.length > 1 || all ? (
          <select value={team} onChange={(e) => setTeam(e.target.value)}>
            {all && teamList.length > 1 ? <option value="*">All teams</option> : null}
            {teamList.map((t) => <option key={t}>{t}</option>)}
          </select>
        ) : null}
        <span className="spacer" />
        <span className="muted small-text">Times in your timezone ({shortTz(viewerTz)}). Click an empty slot to add a shift. Dashed = draft.</span>
      </div>
      <Msg text={msg} />
      {conflict ? (
        <div className="conflict">
          <span><b>{nameOf(conflict.uid)}</b>: {conflict.message}</span>
          <button className="small" onClick={() => setConflict(null)}>Cancel</button>
          <button className="small primary" onClick={() => act(async () => {
            await post("/api/time/shifts", { ...conflict.shift, force: true });
            setConflict(null); setAdding(null);
          }, "Added — assigned anyway.")}>Assign anyway</button>
        </div>
      ) : null}
      {team && team !== "*" ? <PublishBar team={team} week={week} n={n} onPublished={reload} /> : shown.length > 1 ? <p className="hint">Pick one team to publish its week. Drafts (dashed) aren't visible to your team until you publish.</p> : null}
      {!teamList.length ? <p className="empty">No one is in a location yet. Put people in one under People.</p>
        : err ? <p className="error">{err}</p> : !shifts ? <p className="muted">Loading…</p> : (
        <div className="scroll-x">
          <table className="roster">
            <thead>
              <tr>
                <th className="who-col">Person</th>
                {days.map((d) => <th key={d} className={d === todayYmd() ? "today" : ""}>{dayHead(d)}</th>)}
                <th className="hrs">Hours</th>
              </tr>
              <OffRow cov={cov} days={days} />
            </thead>
            <tbody>
              {shown.map((t) => (
                <Fragment key={t}>
                  {shown.length > 1 ? <tr className="team-row"><td colSpan={9}><span className="swatch" style={{ ["--h" as any]: teamHue(t) }} />{t}</td></tr> : null}
                  {rowsFor(t).map((uid) => (
                    <tr key={`${t}-${uid}`} className={uid === 0 ? "open-row" : ""}>
                      <td className="who-col">
                        {uid === 0 ? <><b>Open shifts</b><span className="muted small-text">anyone on {t} can take these</span></> : <><b>{nameOf(uid)}</b>{tzOfUser(uid) ? <span className="muted small-text">{shortTz(tzOfUser(uid)!)}</span> : null}</>}
                      </td>
                      {days.map((d) => {
                        const here = cell(t, uid, d);
                        const isAdding = adding && adding.team === t && adding.uid === uid && adding.date === d;
                        const off = uid ? unavailOn(uid, d) : [];
                        const offAllDay = off.some((u) => u.kind === "date" || !u.start_local);
                        return (
                          <td key={d} className={`slot${d === todayYmd() ? " today" : ""}${off.length ? (offAllDay ? " unavail" : " unavail part") : ""}`} title={off.map((u) => u.label).join("\n") || undefined} onClick={(e) => { if (e.target === e.currentTarget && !isAdding) setAdding({ team: t, uid, date: d }); }}>
                            {uid && leaveOn(uid, d) ? <span className={`leave-badge leave-${leaveOn(uid, d)!.code}${leaveOn(uid, d)!.status === "pending" ? " pending" : ""}`}>{leaveOn(uid, d)!.name}{leaveOn(uid, d)!.status === "pending" ? "?" : ""}</span> : null}
                            {off.length ? <span className="unavail-note">{offAllDay ? "Unavailable" : off.map((u) => `${u.start_local}–${u.end_local}`).join(", ")}</span> : null}
                            {here.map((s) => {
                              const sp = spans.get(s.id)!;
                              return (
                                <div key={s.id} className={`blk${s.user_id ? "" : " open"}${s.published === false ? " draft" : ""}`} style={{ ["--h" as any]: teamHue(s.team) }} title={`${s.published === false ? "Draft — not published yet. " : ""}Their time: ${sp.theirs}${s.note ? ` · ${s.note}` : ""}`}>
                                  <span className="blk-time">{sp.label.replace(" (+1)", "")}{sp.label.includes("+1") ? <span className="plus1">+1</span> : null}</span>
                                  {!sp.sameTz ? <span className="blk-tz">{sp.theirs}</span> : null}
                                  {s.note ? <span className="blk-tz">{s.note}</span> : null}
                                  <button className="x" title="Remove shift" onClick={() => act(() => post(`/api/time/shifts/${s.id}`, undefined, "DELETE"), "Removed.")}>×</button>
                                </div>
                              );
                            })}
                            {isAdding ? (
                              <QuickAdd
                                templates={(templates ?? []).filter((x) => x.team === t)}
                                theirTz={uid ? tzOfUser(uid) : null}
                                onCancel={() => setAdding(null)}
                                onAdd={async (start, end, tz) => {
                                  // Saved on the person's own clock (open shifts: on yours), at the instant you picked.
                                  const target = (uid && tzOfUser(uid)) || viewerTz;
                                  const at = shiftInZone(d, start, end, tz, target);
                                  const shift: ShiftPost = { team: t, ...at, timezone: target, user_id: uid || null };
                                  try {
                                    await post("/api/time/shifts", shift);
                                    setAdding(null); setMsg("Added — publish the week when you're ready."); reload();
                                  } catch (e) {
                                    const m = (e as Error).message;
                                    // They said they can't work then, or they're on leave: ask before assigning.
                                    if (/assign anyway/.test(m)) setConflict({ uid, shift, message: m.replace(/ — assign anyway\?$/, "") });
                                    else setMsg(m);
                                  }
                                }}
                              />
                            ) : <button className="slot-add" aria-label={`Add a shift on ${dayLabel(d)}`} onClick={() => setAdding({ team: t, uid, date: d })}>+</button>}
                          </td>
                        );
                      })}
                      <td className="hrs">{uid === 0 ? "" : hoursOf(t, uid) ? `${Math.round(hoursOf(t, uid) * 10) / 10}h` : "—"}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="panel templates">
        <h3>Shift templates{team && team !== "*" ? ` · ${team}` : ""}</h3>
        {templates?.filter((x) => team === "*" || x.team === team).length ? (
          <div className="chips">{templates.filter((x) => team === "*" || x.team === team).map((x) => <span key={x.id} className="tpl">{x.name} <span className="muted">{x.start_local}–{x.end_local}</span></span>)}</div>
        ) : <p className="empty">No templates yet. Save the shifts you use most; they show up when you add a shift.</p>}
        {team && team !== "*" ? (
          <div className="tpl-form">
            <input value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} placeholder="Name, e.g. Night" aria-label="Template name" />
            <input type="time" value={tpl.start} onChange={(e) => setTpl({ ...tpl, start: e.target.value })} aria-label="Start" />
            <input type="time" value={tpl.end} onChange={(e) => setTpl({ ...tpl, end: e.target.value })} aria-label="End" />
            <button disabled={!tpl.name.trim()} onClick={() => act(() => post("/api/time/templates", { team, name: tpl.name, start_local: tpl.start, end_local: tpl.end, days_of_week: [1, 2, 3, 4, 5] }), "Saved.")}>Save template</button>
          </div>
        ) : null}
        <p className="hint">Template times are on the person's own clock: picking one in a slot uses their time (the slot says so). An end before the start runs past midnight: 22:00–06:00 is an overnight shift.</p>
      </section>
    </div>
  );
}

interface ShiftPost { team: string; date: string; start_local: string; end_local: string; timezone: string; user_id: number | null }

/**
 * The little form that opens in an empty schedule slot. Times you type are on your
 * clock, like the grid, so the shift lands in the slot you clicked. A template is on
 * the person's own clock, so picking one switches to their time; the label says which.
 */
function QuickAdd({ templates, theirTz, onAdd, onCancel }: { templates: Template[]; theirTz: string | null; onAdd: (start: string, end: string, tz: string) => void; onCancel: () => void }) {
  const theirs = theirTz && theirTz !== viewerTz ? theirTz : null;
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("17:00");
  const [tz, setTz] = useState(viewerTz);
  return (
    <div className="quick-add" onClick={(e) => e.stopPropagation()}>
      {templates.length ? <div className="qa-tpls">{templates.map((x) => <button key={x.id} className="small ghost" onClick={() => { setStart(x.start_local); setEnd(x.end_local); setTz(theirs ?? viewerTz); }}>{x.name}</button>)}</div> : null}
      <div className="qa-times">
        <input type="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start" />
        <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="End" />
      </div>
      <span className="muted small-text qa-tz">
        Times in {tz === viewerTz ? `your time (${shortTz(viewerTz)})` : `their time (${shortTz(tz)})`}
        {theirs ? <> · <button className="link" onClick={() => setTz(tz === viewerTz ? theirs : viewerTz)}>use {tz === viewerTz ? "theirs" : "mine"}</button></> : null}
      </span>
      <div className="qa-btns">
        <button className="small ghost" onClick={onCancel}>Cancel</button>
        <button className="small primary" onClick={() => onAdd(start, end, tz)}>Add</button>
      </div>
    </div>
  );
}

interface MemberRow { id: number; name: string; team: string | null; tz: string | null; work_days: number[] | null }


