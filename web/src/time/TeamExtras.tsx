// Managers: who's on today, the leave calendar, and the schedule's publish bar.

import { useState } from "react";
import { dayLabel, leaveLabel, post, shiftSpan, shortTz, todayYmd, viewerTz, WEEKDAYS } from "./api";
import { Msg, Unavailable, useLoad } from "./TimeApp";

// ── Who's on today ──────────────────────────────────────────────────────────

interface TodayShift { id: number; date: string; start_local: string; end_local: string; timezone: string; team: string; status: "upcoming" | "now" | "done" }
interface TodayRow {
  userId: number; name: string; team: string | null; timezone: string; localTime: string;
  clock: "in" | "break" | "out"; onLeave: { code: string; name: string } | null; shifts: TodayShift[];
  late: { minutes: number; shiftId: number } | null;
}
interface TodayData { now: string; counts: { working: number; late: number; scheduled: number; onLeave: number }; people: TodayRow[] }

export function Today({ teams }: { teams: string[] }) {
  const [team, setTeam] = useState("");
  const [showAll, setShowAll] = useState(false);
  const all = teams.includes("*");
  const [data, reload, err] = useLoad<TodayData>(`/api/time/today${team ? `?team=${encodeURIComponent(team)}` : ""}`);
  if (err === "unavailable") return <Unavailable />;
  if (err) return <p className="error">{err}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const teamNames = [...new Set(data.people.map((p) => p.team).filter((t): t is string => Boolean(t)))].sort();
  const state = (r: TodayRow) =>
    r.late ? { cls: "late", text: `Late · ${r.late.minutes}m` }
      : r.clock === "in" ? { cls: "in", text: "Working" }
      : r.clock === "break" ? { cls: "break", text: "On a break" }
      : r.onLeave ? { cls: "leave", text: `On leave · ${r.onLeave.name}` }
      : r.shifts.some((s) => s.status === "upcoming") ? { cls: "later", text: "Starts later" }
      : r.shifts.length ? { cls: "done", text: "Shift over" }
      : { cls: "off", text: "Off today" };
  // Who matters today: anyone working, late, scheduled or on leave, plus everyone on a team.
  // An all-teams view would otherwise list every account in the company.
  const active = (r: TodayRow) => r.clock !== "out" || r.late || r.shifts.length > 0 || r.onLeave;
  const shown = showAll ? data.people : data.people.filter((r) => active(r) || (r.team && !all) || (r.team && team));
  const hidden = data.people.length - shown.length;
  return (
    <div className="stack">
      <div className="admin-toolbar">
        <div className="today-counts">
          <span><b>{data.counts.working}</b> working</span>
          <span className={data.counts.late ? "warn" : ""}><b>{data.counts.late}</b> late</span>
          <span><b>{data.counts.scheduled}</b> scheduled today</span>
          <span><b>{data.counts.onLeave}</b> on leave</span>
        </div>
        <span className="spacer" />
        {(all || teams.length > 1) && teamNames.length > 1 ? (
          <select value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Team">
            <option value="">All my teams</option>
            {teamNames.map((t) => <option key={t}>{t}</option>)}
          </select>
        ) : null}
        <button className="small" onClick={reload}>Refresh</button>
      </div>
      {shown.length ? (
        <div className="scroll-x">
          <table className="grid compact today-table">
            <thead><tr><th>Person</th><th>Now</th><th>Today's shift <span className="muted">({shortTz(viewerTz)})</span></th><th>Their time</th></tr></thead>
            <tbody>
              {shown.map((r) => {
                const st = state(r);
                return (
                  <tr key={r.userId} className={r.late ? "is-late" : ""}>
                    <td><b>{r.name}</b><span className="muted small-text block">{r.team ?? "No team"}</span></td>
                    <td><span className={`now-chip ${st.cls}`}><i />{st.text}</span></td>
                    <td className="nowrap">{r.shifts.length ? r.shifts.map((s) => {
                      const sp = shiftSpan(s);
                      return <span key={s.id} className={`today-shift ${s.status}`}>{sp.label}</span>;
                    }) : <span className="dash">—</span>}</td>
                    <td className="muted nowrap">{r.localTime} · {shortTz(r.timezone)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="empty">{data.people.length ? "Nobody is working, scheduled or on leave today." : "No one on your teams yet."}</p>}
      {hidden > 0 ? <button className="small ghost" onClick={() => setShowAll(true)}>Show {hidden} more {hidden === 1 ? "person" : "people"} with nothing on today</button>
        : showAll && data.people.length > 8 ? <button className="small ghost" onClick={() => setShowAll(false)}>Only show who's on today</button> : null}
      <p className="hint">Late means a published shift started more than 10 minutes ago and they haven't clocked in. People get a Slack reminder about 30 minutes before each shift.</p>
    </div>
  );
}

// ── Leave calendar ──────────────────────────────────────────────────────────

interface CalLeave { id: number; user_id: number; code: string; type_name: string; start_date: string; end_date: string; days: number; status: "approved" | "pending" }
interface CalData { month: string; days: string[]; people: { userId: number; name: string; team: string | null; workDays: number[] }[]; leave: CalLeave[] }

const monthOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const shiftMonth = (m: string, n: number) => { const [y, mo] = m.split("-").map(Number); return monthOf(new Date(y, mo - 1 + n, 1)); };
const dow = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); };

export function LeaveCalendar({ teams }: { teams: string[] }) {
  const [month, setMonth] = useState(monthOf());
  const [team, setTeam] = useState("");
  const [data, , err] = useLoad<CalData>(`/api/time/leave-calendar?month=${month}${team ? `&team=${encodeURIComponent(team)}` : ""}`);
  if (err === "unavailable") return <Unavailable />;
  const [y, m] = month.split("-").map(Number);
  const title = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const teamNames = data ? [...new Set(data.people.map((p) => p.team).filter((t): t is string => Boolean(t)))].sort() : [];
  // People with no team and no leave this month are just noise in an all-teams view.
  const people = (data?.people ?? []).filter((p) => p.team || data!.leave.some((l) => l.user_id === p.userId));
  const onDay = (uid: number, d: string) => data?.leave.find((l) => l.user_id === uid && l.start_date <= d && l.end_date >= d) ?? null;
  // Coverage: of the people who normally work that day, how many are off.
  const coverage = (d: string) => {
    const due = people.filter((p) => p.workDays.includes(dow(d)));
    const off = due.filter((p) => onDay(p.userId, d)).length;
    return { due: due.length, off };
  };
  return (
    <div className="stack">
      <div className="admin-toolbar">
        <div className="week-nav boxed">
          <button className="small ghost" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button>
          <b>{title}</b>
          <button className="small ghost" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">›</button>
        </div>
        <button className="small" onClick={() => setMonth(monthOf())} disabled={month === monthOf()}>This month</button>
        {(teams.includes("*") || teams.length > 1) && teamNames.length > 1 ? (
          <select value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Team">
            <option value="">All my teams</option>
            {teamNames.map((t) => <option key={t}>{t}</option>)}
          </select>
        ) : null}
        <span className="spacer" />
        <span className="legend"><i className="cal-cell on approved" /> Approved <i className="cal-cell on pending" /> Pending <i className="cal-cell rest" /> Not a working day</span>
      </div>
      {err ? <p className="error">{err}</p> : !data ? <p className="muted">Loading…</p> : (
        <div className="scroll-x">
          <table className="leave-cal">
            <thead>
              <tr>
                <th className="who-col">Person</th>
                {data.days.map((d) => <th key={d} className={`${d === todayYmd() ? "today " : ""}${[0, 6].includes(dow(d)) ? "wkend" : ""}`}><small>{WEEKDAYS[(dow(d) + 6) % 7][0]}</small>{Number(d.slice(8))}</th>)}
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.userId}>
                  <td className="who-col"><b>{p.name}</b><span className="muted small-text">{p.team}</span></td>
                  {data.days.map((d) => {
                    const l = onDay(p.userId, d);
                    const working = p.workDays.includes(dow(d));
                    return (
                      <td key={d} className={`${d === todayYmd() ? "today " : ""}`}>
                        <span
                          className={`cal-cell${l ? ` on ${l.status} leave-${l.code}` : ""}${!working ? " rest" : ""}`}
                          title={l ? `${l.type_name}${l.status === "pending" ? " (pending)" : ""} · ${dayLabel(l.start_date)}${l.end_date !== l.start_date ? ` – ${dayLabel(l.end_date)}` : ""}` : working ? "" : "Not a working day"}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="who-col"><b>Off</b><span className="muted small-text">of those due to work</span></td>
                {data.days.map((d) => {
                  const c = coverage(d);
                  const share = c.due ? c.off / c.due : 0;
                  return <td key={d} className={`cov${share >= 0.3 ? " thin" : c.off ? " some" : ""}`} title={`${c.off} of ${c.due} off`}>{c.off || ""}</td>;
                })}
              </tr>
            </tfoot>
          </table>
          {!people.length ? <p className="muted">No one on your teams yet.</p> : null}
        </div>
      )}
      <p className="hint">Red in the bottom row means 30% or more of the people due to work that day are off — check coverage before approving more. Leave types: {["vacation", "sick", "personal", "unpaid"].map(leaveLabel).join(", ")}.</p>
    </div>
  );
}

// ── Schedule: publish bar ───────────────────────────────────────────────────

interface PublishState { lastPublishedAt: string | null; pending: { added: number; removed: number; changed: number }; upToDate: boolean }

export function PublishBar({ team, week, onPublished, n }: { team: string; week: string; onPublished: () => void; n: number }) {
  const [st, reload] = useLoad<PublishState>(team && team !== "*" ? `/api/time/publish?team=${encodeURIComponent(team)}&week=${week}&n=${n}` : null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  if (!team || team === "*") return <p className="hint">Pick one team to publish its week.</p>;
  if (!st) return null;
  const changes = st.pending.added + st.pending.removed + st.pending.changed;
  const publish = async () => {
    setBusy(true);
    try {
      const r = await post<{ published: number; notified: number[]; first?: boolean; unchanged?: boolean }>("/api/time/publish", { team, week_start: week });
      setMsg(r.unchanged ? "Done — nothing changed since the last publish." : `Published — ${r.notified.length} ${r.notified.length === 1 ? "person" : "people"} told on Slack.`);
      reload();
      onPublished();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const summary = !st.lastPublishedAt
    ? "Not published yet — your team can't see this week."
    : st.upToDate
      ? `Published ${new Date(st.lastPublishedAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })} · up to date`
      : `${changes} change${changes === 1 ? "" : "s"} not published (${[st.pending.added && `${st.pending.added} added`, st.pending.removed && `${st.pending.removed} removed`, st.pending.changed && `${st.pending.changed} changed`].filter(Boolean).join(", ")})`;
  return (
    <div className={`publish-bar${st.upToDate ? " clean" : ""}`}>
      <span className="publish-dot" aria-hidden />
      <span>{summary}</span>
      <span className="spacer" />
      <Msg text={msg} />
      <button className={`small${st.upToDate ? "" : " primary"}`} disabled={busy || st.upToDate} onClick={publish}>{st.lastPublishedAt ? "Publish changes" : "Publish week"}</button>
    </div>
  );
}
