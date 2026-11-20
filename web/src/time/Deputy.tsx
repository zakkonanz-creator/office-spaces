// The Deputy-style screens:
//   Overview   — what's waiting on me: leave requests and timesheets to approve
//   People     — start date, regular week (hours + break), leave entitlements
//   Locations  — departments (e.g. WhiteLabel Services: support, onboarding, calls, live chat)
//   Day view   — who's due in on one day, who's off and why
// Managers see hours, never pay.

import { useState } from "react";
import { dayLabel, hm, leaveLabel, post, shortTz, todayYmd, WEEKDAYS } from "./api";
import { Msg, Unavailable, useLoad } from "./TimeApp";

// ── Overview ────────────────────────────────────────────────────────────────

interface Dash {
  leave: { id: number; user_id: number; name: string; code: string; type_name: string; start_date: string; end_date: string; days: number; note: string | null }[];
  leaveCount: number; swapCount: number;
  timesheets: { userId: number; name: string; team: string | null; weekStart: string; minutes: number; expected: number; flags: number }[];
  timesheetCount: number; week: string | null;
}

export function Overview({ go }: { go: (tab: "approvals" | "timesheets") => void }) {
  const [d, reload, err] = useLoad<Dash>("/api/time/dashboard");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false); // one decision in flight at a time, like the Approvals tab
  if (err === "unavailable") return <Unavailable />;
  if (err) return <p className="error">{err}</p>;
  if (!d) return <p className="muted">Loading…</p>;
  const once = async (fn: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); setMsg(done); reload(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const decide = (id: number, approve: boolean, force = false) => once(() => post(`/api/time/leave/${id}/decide`, { approve, force }), approve ? "Approved." : "Declined.");
  const approveSheet = (userId: number) => once(() => post("/api/time/timesheets/approve", { user_id: userId, week_start: d.week }), "Approved.");
  const nothing = !d.leaveCount && !d.timesheetCount && !d.swapCount;
  return (
    <div className="stack overview">
      <div className="action-cards">
        <button className={`action-card${d.leaveCount ? " due" : ""}`} onClick={() => go("approvals")}>
          <b>{d.leaveCount}</b><span>Leave request{d.leaveCount === 1 ? "" : "s"} to decide</span>
        </button>
        <button className={`action-card${d.timesheetCount ? " due" : ""}`} onClick={() => go("timesheets")}>
          <b>{d.timesheetCount}</b><span>Timesheet{d.timesheetCount === 1 ? "" : "s"} to approve{d.week ? ` · week of ${dayLabel(d.week)}` : ""}</span>
        </button>
        <button className={`action-card${d.swapCount ? " due" : ""}`} onClick={() => go("approvals")}>
          <b>{d.swapCount}</b><span>Shift swap{d.swapCount === 1 ? "" : "s"} to approve</span>
        </button>
      </div>
      <Msg text={msg} />
      {nothing ? <p className="empty">Nothing is waiting on you. 🎉</p> : null}
      {d.leave.length ? (
        <section className="panel">
          <h3>Leave requests</h3>
          <ul className="list">
            {d.leave.slice(0, 6).map((l) => (
              <li key={l.id}>
                <b>{l.name}</b>
                <span className={`tag leave-tag leave-${l.code}`}>{l.type_name}</span>
                <span className="muted">{dayLabel(l.start_date)}{l.end_date !== l.start_date ? ` – ${dayLabel(l.end_date)}` : ""} · {l.days} day{l.days === 1 ? "" : "s"}</span>
                {l.note ? <span className="muted small-text">“{l.note}”</span> : null}
                <span className="spacer" />
                <button className="small" disabled={busy} onClick={() => decide(l.id, false)}>Decline</button>
                <button className="small primary" disabled={busy} onClick={() => decide(l.id, true)}>Approve</button>
              </li>
            ))}
          </ul>
          {d.leave.length > 6 ? <button className="small ghost" onClick={() => go("approvals")}>See all {d.leave.length}</button> : null}
        </section>
      ) : null}
      {d.timesheets.length ? (
        <section className="panel">
          <h3>Timesheets to approve <span className="muted small-text">week of {d.week ? dayLabel(d.week) : ""}</span></h3>
          <table className="grid compact sheet">
            <thead><tr><th>Person</th><th className="num">Logged</th><th className="num">Expected</th><th className="num">Difference</th><th /></tr></thead>
            <tbody>
              {d.timesheets.slice(0, 12).map((t) => {
                const diff = t.minutes - t.expected;
                return (
                  <tr key={t.userId}>
                    <td><div className="who"><b>{t.name}</b>{t.flags ? <span className="pill no">{t.flags} flag{t.flags > 1 ? "s" : ""}</span> : null}</div><span className="muted small-text">{t.team}</span></td>
                    <td className="num">{hm(t.minutes)}</td>
                    <td className="num muted">{hm(t.expected)}</td>
                    <td className={`num ${diff < -30 ? "short" : diff > 30 ? "over" : ""}`}>{diff === 0 ? "—" : `${diff > 0 ? "+" : "−"}${hm(Math.abs(diff))}`}</td>
                    <td className="actions">{t.flags ? <button className="small" onClick={() => go("timesheets")}>Review</button> : <button className="small primary" disabled={busy} onClick={() => approveSheet(t.userId)}>Approve</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {d.timesheets.length > 12 ? <button className="small ghost" onClick={() => go("timesheets")}>See all {d.timesheets.length}</button> : null}
        </section>
      ) : null}
    </div>
  );
}

// ── People ──────────────────────────────────────────────────────────────────

export interface RegularDay { dow: number; start: string; end: string; break_start?: string | null; break_end?: string | null; break_minutes?: number | null }
interface Person {
  id: number; name: string; email: string; team: string | null; timezone: string | null; startDate: string | null;
  workDays: number[]; regularHours: RegularDay[]; entitlements: Record<string, number>; balances: Record<string, number>;
}
interface Location { name: string; description: string | null; people: number; managers: string[] }

/** Monday-first over the server's 0 = Sunday … 6 = Saturday. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const dayName = (d: number) => WEEKDAYS[(d + 6) % 7];
const LEAVE_CODES = ["vacation", "holiday", "sick", "personal", "unpaid"];

/** "Mon–Fri 09:00–17:00 · break 13:00–13:30" — the same hours on consecutive days collapse. */
export function weekSummary(days: RegularDay[], workDays: number[]): string {
  if (!days.length) return workDays.length ? `${DAY_ORDER.filter((d) => workDays.includes(d)).map(dayName).join(", ")} · hours not set` : "Not set";
  const key = (r: RegularDay) => `${r.start}–${r.end}${r.break_start ? ` · break ${r.break_start}–${r.break_end}` : r.break_minutes ? ` · ${hm(r.break_minutes)} break` : ""}`;
  const groups: { days: number[]; text: string }[] = [];
  for (const d of DAY_ORDER) {
    const r = days.find((x) => x.dow === d);
    if (!r) continue;
    const last = groups[groups.length - 1];
    const prev = last && last.days[last.days.length - 1];
    if (last && last.text === key(r) && DAY_ORDER.indexOf(prev) === DAY_ORDER.indexOf(d) - 1) last.days.push(d);
    else groups.push({ days: [d], text: key(r) });
  }
  return groups.map((g) => `${g.days.length > 2 ? `${dayName(g.days[0])}–${dayName(g.days[g.days.length - 1])}` : g.days.map(dayName).join(", ")} ${g.text}`).join("; ");
}

export function People({ teams }: { teams: string[] }) {
  const [rows, reload, err] = useLoad<Person[]>("/api/time/people");
  const [locs] = useLoad<Location[]>("/api/time/locations");
  const [open, setOpen] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [loc, setLoc] = useState("");
  if (err === "unavailable") return <Unavailable />;
  if (err) return <p className="error">{err}</p>;
  if (!rows) return <p className="muted">Loading…</p>;
  const all = teams.includes("*");
  const list = rows.filter((r) => (all && !loc ? true : loc ? r.team === loc : true) && `${r.name} ${r.team ?? ""} ${r.email}`.toLowerCase().includes(q.toLowerCase()));
  // An all-teams view lists every account; lead with the people who are on the time system.
  list.sort((a, b) => Number(!a.team) - Number(!b.team) || a.name.localeCompare(b.name));
  return (
    <div className="stack">
      <div className="admin-toolbar">
        <label className="search"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find someone" /></label>
        {(locs ?? []).length > 1 ? (
          <select value={loc} onChange={(e) => setLoc(e.target.value)} aria-label="Location">
            <option value="">All locations</option>
            {(locs ?? []).map((l) => <option key={l.name}>{l.name}</option>)}
          </select>
        ) : null}
        <span className="spacer" />
        <span className="muted small-text">{list.length} {list.length === 1 ? "person" : "people"}</span>
      </div>
      <div className="scroll-x">
        <table className="grid compact people-table">
          <thead><tr><th>Person</th><th>Location</th><th>Started</th><th>Regular week</th><th>Leave per year</th><th /></tr></thead>
          <tbody>
            {list.map((r) => (
              <PersonRow key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} locations={locs ?? []} canMove={all} onSaved={reload} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">Regular hours are in each person's own timezone. They set what a timesheet is checked against, and which days count for leave and part-month pay.</p>
      {all ? <DeputyImport onDone={reload} /> : null}
    </div>
  );
}

function PersonRow({ r, open, onToggle, locations, canMove, onSaved }: { r: Person; open: boolean; onToggle: () => void; locations: Location[]; canMove: boolean; onSaved: () => void }) {
  const ent = LEAVE_CODES.filter((c) => r.entitlements[c] != null).map((c) => `${leaveLabel(c)} ${r.entitlements[c]}`).join(" · ");
  return (
    <>
      <tr className={open ? "focus" : ""}>
        <td><button className="link" onClick={onToggle}>{r.name}</button><span className="muted small-text block">{r.timezone ? shortTz(r.timezone) : "timezone not known yet"}</span></td>
        <td>{r.team ?? <span className="muted">—</span>}</td>
        <td className="nowrap">{r.startDate ? dayLabel(r.startDate) : <span className="muted">—</span>}</td>
        <td className="small-text">{weekSummary(r.regularHours, r.workDays)}</td>
        <td className="small-text">{ent || <span className="muted">—</span>}</td>
        <td className="actions"><button className="small" onClick={onToggle}>{open ? "Close" : "Edit"}</button></td>
      </tr>
      {open ? <tr className="editor-row"><td colSpan={6}><PersonEditor r={r} locations={locations} canMove={canMove} onSaved={onSaved} /></td></tr> : null}
    </>
  );
}

function PersonEditor({ r, locations, canMove, onSaved }: { r: Person; locations: Location[]; canMove: boolean; onSaved: () => void }) {
  const [team, setTeam] = useState(r.team ?? "");
  const [start, setStart] = useState(r.startDate ?? "");
  const [week, setWeek] = useState<Record<number, RegularDay | null>>(() =>
    Object.fromEntries(DAY_ORDER.map((d) => [d, r.regularHours.find((x) => x.dow === d) ?? null])));
  const [ent, setEnt] = useState<Record<string, string>>(() => Object.fromEntries(LEAVE_CODES.map((c) => [c, r.entitlements[c] != null ? String(r.entitlements[c]) : ""])));
  const [msg, setMsg] = useState("");
  const setDay = (d: number, patch: Partial<RegularDay> | null) =>
    setWeek((w) => ({ ...w, [d]: patch === null ? null : { ...(w[d] ?? { dow: d, start: "09:00", end: "17:00", break_start: "13:00", break_end: "13:30" }), ...patch } }));
  const copyMonday = () => setWeek((w) => {
    const mon = w[1];
    if (!mon) return w;
    return Object.fromEntries(DAY_ORDER.map((d) => [d, w[d] ? { ...mon, dow: d } : null]));
  });
  const save = async () => {
    const days = DAY_ORDER.map((d) => week[d]).filter((x): x is RegularDay => Boolean(x))
      .map((x) => ({ dow: x.dow, start: x.start, end: x.end, break_start: x.break_start || null, break_end: x.break_end || null, break_minutes: x.break_start || x.break_end || !x.break_minutes ? null : x.break_minutes }));
    const entitlements: Record<string, number> = {};
    for (const c of LEAVE_CODES) if (ent[c].trim() !== "") entitlements[c] = Number(ent[c]);
    try {
      await post(`/api/time/people/${r.id}`, { team, start_date: start || null, regular_hours: days, entitlements }, "PUT");
      setMsg(`Saved ${r.name.split(" ")[0]}'s profile.`);
      onSaved();
    } catch (e) { setMsg((e as Error).message); }
  };
  const total = DAY_ORDER.reduce((sum, d) => {
    const x = week[d];
    if (!x) return sum;
    const span = (a: string, b: string) => { const v = (+b.slice(0, 2) * 60 + +b.slice(3)) - (+a.slice(0, 2) * 60 + +a.slice(3)); return v > 0 ? v : v + 1440; };
    return sum + span(x.start, x.end) - (x.break_start && x.break_end ? span(x.break_start, x.break_end) : x.break_minutes ?? 0);
  }, 0);
  return (
    <div className="person-editor">
      <div className="form-grid">
        <label>Location
          <select value={team} onChange={(e) => setTeam(e.target.value)} disabled={!canMove}>
            {!team ? <option value="">Choose…</option> : null}
            {locations.map((l) => <option key={l.name}>{l.name}</option>)}
          </select>
        </label>
        <label>Joined the business<input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label>Timezone<input value={r.timezone ?? ""} disabled placeholder="From their browser" title="Their pay profile's timezone if it has one (set under Payroll), else the one their browser reports" /></label>
      </div>
      <h4 className="sub">Regular week <span className="muted small-text">· their time ({r.timezone ? shortTz(r.timezone) : "not known yet"}) · {hm(total)} a week</span></h4>
      <table className="grid compact regular-week">
        <thead><tr><th>Day</th><th>Works</th><th>Start</th><th>End</th><th>Break from</th><th>Break to</th><th>Or a break of (min)</th></tr></thead>
        <tbody>
          {DAY_ORDER.map((d) => {
            const x = week[d];
            return (
              <tr key={d} className={x ? "" : "off"}>
                <td><b>{dayName(d)}</b></td>
                <td><input type="checkbox" checked={Boolean(x)} onChange={(e) => setDay(d, e.target.checked ? {} : null)} aria-label={`Works ${dayName(d)}`} /></td>
                {(["start", "end", "break_start", "break_end"] as const).map((k) => (
                  <td key={k}><input type="time" value={(x?.[k] as string) ?? ""} disabled={!x} onChange={(e) => setDay(d, { [k]: e.target.value || null })} aria-label={`${dayName(d)} ${k.replace("_", " ")}`} /></td>
                ))}
                <td><input className="num-input" inputMode="numeric" value={x?.break_minutes ?? ""} disabled={!x || Boolean(x.break_start || x.break_end)} placeholder="—"
                  onChange={(e) => setDay(d, { break_minutes: /^\d+$/.test(e.target.value) ? Number(e.target.value) : null })} aria-label={`${dayName(d)} break length in minutes`} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button className="small ghost" onClick={copyMonday} disabled={!week[1]}>Copy Monday's hours to their other working days</button>
      <h4 className="sub">Leave entitlement <span className="muted small-text">· days per year, earned as in Deputy: Vacation adds a twelfth every month on their start-date day; National holiday adds the year on Jan 1 and doesn't carry over. 0 = not on that policy.</span></h4>
      <div className="form-grid">
        {LEAVE_CODES.map((c) => (
          <label key={c}>{leaveLabel(c)}
            <input inputMode="decimal" value={ent[c]} onChange={(e) => setEnt({ ...ent, [c]: e.target.value })} placeholder="—" />
            {r.balances[c] != null ? <span className="muted small-text">{r.balances[c]} in the balance now</span> : null}
          </label>
        ))}
      </div>
      <div className="row-between">
        <Msg text={msg} />
        <button className="primary" onClick={save}>Save profile</button>
      </div>
    </div>
  );
}

// ── Import from Deputy ──────────────────────────────────────────────────────

interface DeputyRow {
  deputyId: number; name: string; email: string; location: string | null; startDate: string | null;
  userId: number | null; matchedBy: "email" | "name" | null; status: "ready" | "waits-for-sign-in" | "skipped";
  timezone: string | null; regular: RegularDay[] | null; regularNote: string | null;
  balances: { code: string; days: number }[]; shifts: number; leave: number; changes: string[]; notes: string[]; problems: string[];
}
interface DeputyResult {
  preview: boolean; exportedAt: string; rows: DeputyRow[]; locations: string[]; skippedLeaveTypes: string[];
  summary: { people: number; ready: number; waiting: number; skipped: number; shifts: number; openShifts: number; leave: number };
  staged?: number; applied?: number;
}
interface PolicyResult {
  preview: boolean; readAt: string; set?: number; notInSpace?: string[];
  rows: { name: string; email: string; userId: number | null; before: Record<string, number>; after: Record<string, number> }[];
}
const POLICY_CODES = ["vacation", "holiday"];
const isPolicyFile = (text: string) => { try { return JSON.parse(text)?.source === "deputy-leave-policy"; } catch { return false; } };

/** Everyone in Deputy → People, Locations, Schedule and leave. Preview first; nothing is saved until Import. */
function DeputyImport({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState("");
  const [res, setRes] = useState<DeputyResult | null>(null);
  const [pol, setPol] = useState<PolicyResult | null>(null);
  const [msg, setMsg] = useState("");
  const [status, reloadStatus] = useLoad<{ waiting: { email: string; name: string; why: string }[] }>(open ? "/api/time/deputy/status" : null);
  const notInSpace = (status?.waiting ?? []).filter((w) => w.why === "not signed in yet");
  const addPeople = async () => {
    setMsg("");
    try {
      const j = await post<{ added: number; left: { name: string; why: string }[]; waitingForTimezone: string[] }>("/api/time/deputy/add-people", {});
      setMsg(`Added ${j.added} people to Space.${j.left.length ? ` Left out: ${j.left.map((l) => `${l.name} (${l.why})`).join(", ")}.` : ""}${j.waitingForTimezone.length ? ` ${j.waitingForTimezone.length} regular weeks go in on each person's first visit, once Space knows their timezone.` : ""}`);
      reloadStatus(); onDone();
    } catch (e) { setMsg((e as Error).message); }
  };
  const run = async (commit: boolean) => {
    setMsg("");
    if (isPolicyFile(file)) return runPolicy(commit);
    try {
      const r = await fetch(`/api/time/deputy/import?commit=${commit ? 1 : 0}`, { method: "POST", headers: { "content-type": "application/json" }, body: file });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setRes(j);
      if (commit) { setMsg(`Imported ${j.staged} people from Deputy: ${j.summary.ready} applied now, ${j.summary.waiting} on their first sign-in.`); reloadStatus(); onDone(); }
    } catch (e) { setMsg((e as Error).message); }
  };
  const runPolicy = async (commit: boolean) => {
    try {
      const r = await fetch(`/api/time/deputy/leave-policy?commit=${commit ? 1 : 0}`, { method: "POST", headers: { "content-type": "application/json" }, body: file });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setPol(j);
      if (commit) { setMsg(`Leave entitlements set from Deputy (${j.set} changed).${j.notInSpace.length ? ` Not in Space: ${j.notInSpace.join(", ")}.` : ""}`); onDone(); }
    } catch (e) { setMsg((e as Error).message); }
  };
  const ent = (m: Record<string, number>) => POLICY_CODES.map((c) => `${leaveLabel(c)} ${m[c] ?? "—"}`).join(" · ");
  if (!open) return <button className="small ghost" onClick={() => setOpen(true)}>Import from Deputy…</button>;
  return (
    <section className="panel">
      <h3>Import from Deputy</h3>
      <span className="muted">Choose the Deputy export (<code>deputy-export.json</code>). It brings in each person's location, start date, regular week, leave balances, upcoming shifts and leave. Or choose the leave-policy file (<code>deputy-leave-policy.json</code>) to set everyone's leave entitlements. You'll see everyone before anything is saved.</span>
      <input type="file" accept=".json,application/json" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setFile(await f.text()); setRes(null); setPol(null); setMsg(""); } }} />
      <div className="admin-toolbar">
        <button disabled={!file} onClick={() => run(false)}>Preview</button>
        {pol ? <button className="primary" disabled={!pol.preview} onClick={() => run(true)}>Set entitlements for {pol.rows.filter((r) => r.userId).length} people</button>
          : <button className="primary" disabled={!res?.preview || !(res.summary.ready + res.summary.waiting)} onClick={() => run(true)}>Import {res?.preview ? res.summary.ready + res.summary.waiting : ""} people</button>}
        <button className="small ghost" onClick={() => setOpen(false)}>Close</button>
        <Msg text={msg} />
      </div>
      {notInSpace.length ? (
        <div className="admin-toolbar">
          <span>{notInSpace.length} {notInSpace.length === 1 ? "person" : "people"} from Deputy {notInSpace.length === 1 ? "isn't" : "aren't"} in Space yet. Their data waits for their first sign-in, or add them now (desk, Slack photo, location, balances, schedule and leave; regular week on their first visit).</span>
          <button className="primary" onClick={addPeople}>Add them to Space now</button>
        </div>
      ) : null}
      {pol ? (
        <div className="scroll-x">
          <p>Deputy's leave policies as of {pol.readAt} · days per year · 0 = not on that policy</p>
          <table className="grid compact">
            <thead><tr><th>Person</th><th>Space</th><th>Now</th><th>From Deputy</th></tr></thead>
            <tbody>
              {pol.rows.map((r) => (
                <tr key={r.email} className={r.userId ? "" : "removed"}>
                  <td>{r.name}<span className="muted small-text block">{r.email}</span></td>
                  <td className="small-text">{r.userId ? "yes" : <span className="muted">not in Space</span>}</td>
                  <td className="small-text muted">{ent(r.before)}</td>
                  <td className="small-text">{ent(r.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {res ? (
        <>
          <p>
            Deputy as of {res.exportedAt.slice(0, 16).replace("T", " ")} UTC · {res.summary.people} people · <b>{res.summary.ready}</b> in Space now · {res.summary.waiting} applied when they first sign in · {res.summary.skipped} skipped
            {" "}· {res.summary.shifts} upcoming shifts ({res.summary.openShifts} open) · {res.summary.leave} leave requests · locations: {res.locations.join(", ")}
          </p>
          {res.skippedLeaveTypes.length ? <p className="muted small-text">Not brought over (no matching leave type here): {res.skippedLeaveTypes.join(", ")}</p> : null}
          <div className="scroll-x">
            <table className="grid compact">
              <thead><tr><th>Person</th><th>Space</th><th>Location</th><th>Started</th><th>Regular week (their time)</th><th>Balances</th><th>Shifts</th><th>Leave</th><th>Notes</th></tr></thead>
              <tbody>
                {res.rows.map((r) => (
                  <tr key={r.deputyId} className={r.status === "skipped" ? "removed" : ""}>
                    <td>{r.name}<span className="muted small-text block">{r.email}</span></td>
                    <td className="small-text">{r.status === "ready" ? `yes (by ${r.matchedBy})` : r.status === "waits-for-sign-in" ? <span className="muted">first sign-in</span> : <span className="error">skipped</span>}</td>
                    <td>{r.location ?? <span className="muted">—</span>}</td>
                    <td className="nowrap">{r.startDate ? dayLabel(r.startDate) : "—"}</td>
                    <td className="small-text">{r.regular ? `${weekSummary(r.regular, [])}${r.timezone ? ` (${shortTz(r.timezone)})` : ""}` : <span className="muted">{r.regularNote}</span>}</td>
                    <td className="small-text">{r.balances.map((b) => `${leaveLabel(b.code)} ${b.days}d`).join(" · ") || "—"}</td>
                    <td className="num">{r.shifts || ""}</td>
                    <td className="num">{r.leave || ""}</td>
                    <td className="small-text muted">{[...r.problems, ...r.changes, ...r.notes].join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

// ── Locations ───────────────────────────────────────────────────────────────

export function Locations({ teams }: { teams: string[] }) {
  const [rows, reload, err] = useLoad<Location[]>("/api/time/locations");
  const [msg, setMsg] = useState("");
  const [add, setAdd] = useState({ name: "", description: "" });
  const [edit, setEdit] = useState<{ from: string; name: string; description: string } | null>(null);
  if (err === "unavailable") return <Unavailable />;
  if (err) return <p className="error">{err}</p>;
  if (!rows) return <p className="muted">Loading…</p>;
  const all = teams.includes("*");
  const act = async (fn: () => Promise<unknown>, done: string) => { try { await fn(); setMsg(done); reload(); } catch (e) { setMsg((e as Error).message); } };
  return (
    <div className="stack">
      <p className="hint">Locations are the team's departments — for example WhiteLabel Services covers support, onboarding, calls and live chat. Everyone, every shift and every manager belongs to one.</p>
      <Msg text={msg} />
      <div className="loc-grid">
        {rows.map((l) => (
          <div key={l.name} className="loc-card">
            {edit?.from === l.name ? (
              <div className="stack">
                <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} aria-label="Location name" />
                <textarea rows={2} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} aria-label="What it covers" placeholder="What it covers" />
                <div className="qa-btns">
                  <button className="small" onClick={() => setEdit(null)}>Cancel</button>
                  <button className="small primary" onClick={() => act(async () => { await post(`/api/time/locations/${encodeURIComponent(l.name)}`, { name: edit.name, description: edit.description }, "PUT"); setEdit(null); }, "Saved.")}>Save</button>
                </div>
              </div>
            ) : (
              <>
                <div className="row-between"><b>{l.name}</b>{all ? <button className="small ghost" onClick={() => setEdit({ from: l.name, name: l.name, description: l.description ?? "" })}>Edit</button> : null}</div>
                <span className="muted small-text">{l.description || "No description yet"}</span>
                <span className="small-text"><b>{l.people}</b> {l.people === 1 ? "person" : "people"}{l.managers.length ? ` · managed by ${l.managers.join(", ")}` : " · no manager yet"}</span>
                {all && !l.people ? <button className="small ghost danger-text" onClick={() => act(() => post(`/api/time/locations/${encodeURIComponent(l.name)}`, undefined, "DELETE"), "Removed.")}>Remove</button> : null}
              </>
            )}
          </div>
        ))}
        {!rows.length ? <p className="empty">No locations yet.</p> : null}
      </div>
      {all ? (
        <section className="panel">
          <h3>Add a location</h3>
          <div className="tpl-form">
            <input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} placeholder="Name, e.g. WhiteLabel Services" aria-label="New location name" />
            <input value={add.description} onChange={(e) => setAdd({ ...add, description: e.target.value })} placeholder="What it covers" aria-label="New location description" style={{ flex: 1 }} />
            <button className="primary" disabled={!add.name.trim()} onClick={() => act(async () => { await post("/api/time/locations", add); setAdd({ name: "", description: "" }); }, "Added.")}>Add location</button>
          </div>
        </section>
      ) : <p className="hint">Only payroll admins and all-team managers can add or rename locations.</p>}
    </div>
  );
}

// ── Coverage (shared by the week and day views) ─────────────────────────────

export interface Coverage {
  days: { date: string; scheduled: number; available: number; offCount: number; pendingCount: number; off: { userId: number; name: string; code: string; type: string; status: string }[] }[];
  people: { userId: number; name: string; team: string | null; timezone: string; byDay: Record<string, { expected: number; hours: { start: string; end: string; break_start: string | null; break_end: string | null } | null; shifts: { start: string; end: string }[]; leave: { code: string; name: string; status: string } | null }> }[];
}

/** One day: who's due in, when (their time), and who's off and why. */
export function DayView({ date, team }: { date: string; team: string }) {
  const [c, , err] = useLoad<Coverage>(`/api/time/coverage?from=${date}&to=${date}${team && team !== "*" ? `&team=${encodeURIComponent(team)}` : ""}`);
  if (err === "unavailable") return <Unavailable />;
  if (err) return <p className="error">{err}</p>;
  if (!c) return <p className="muted">Loading…</p>;
  const day = c.days[0];
  const rows = c.people.map((p) => ({ p, x: p.byDay[date] })).filter(({ x }) => x.expected > 0 || x.shifts.length || x.leave);
  const off = rows.filter(({ x }) => x.leave);
  const due = rows.filter(({ x }) => !x.leave);
  const byType = Object.entries(off.reduce<Record<string, number>>((acc, { x }) => ({ ...acc, [x.leave!.name]: (acc[x.leave!.name] ?? 0) + 1 }), {}));
  return (
    <div className="stack">
      <div className={`coverage-banner${day.scheduled && day.offCount / day.scheduled >= 0.3 ? " thin" : ""}`}>
        <b>{day.available}</b> of <b>{day.scheduled}</b> due in on {dayLabel(date)}{date === todayYmd() ? " (today)" : ""}
        {day.offCount ? <span> · <b>{day.offCount}</b> off: {byType.map(([t, n]) => `${n} ${t.toLowerCase()}`).join(", ")}</span> : <span className="muted"> · nobody off</span>}
        {day.pendingCount ? <span className="muted"> · {day.pendingCount} pending request{day.pendingCount > 1 ? "s" : ""}</span> : null}
      </div>
      <div className="scroll-x">
        <table className="grid compact day-table">
          <thead><tr><th>Person</th><th>Location</th><th>Hours <span className="muted">(their time)</span></th><th>Break</th><th>Status</th></tr></thead>
          <tbody>
            {[...due, ...off].map(({ p, x }) => (
              <tr key={p.userId} className={x.leave ? "is-off" : ""}>
                <td><b>{p.name}</b><span className="muted small-text block">{shortTz(p.timezone)}</span></td>
                <td className="muted">{p.team}</td>
                <td className="nowrap">{x.shifts.length ? x.shifts.map((s) => `${s.start}–${s.end}`).join(", ") : x.hours ? `${x.hours.start}–${x.hours.end}` : x.expected ? "8h (hours not set)" : "—"}</td>
                <td className="nowrap muted">{x.hours?.break_start ? `${x.hours.break_start}–${x.hours.break_end}` : "—"}</td>
                <td>{x.leave ? <span className={`tag leave-tag leave-${x.leave.code}`}>{x.leave.name}{x.leave.status === "pending" ? " (pending)" : ""}</span> : <span className="now-chip in"><i />Due in</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? <p className="empty">Nobody is due in on {dayLabel(date)}.</p> : null}
      </div>
    </div>
  );
}

/** The "who's off" row under the week's day headers. */
export function OffRow({ cov, days, colSpanBefore = 1 }: { cov: Coverage | null; days: string[]; colSpanBefore?: number }) {
  return (
    <tr className="off-row">
      <td className="who-col" colSpan={colSpanBefore}><b>Off</b><span className="muted small-text">and why</span></td>
      {days.map((d) => {
        const day = cov?.days.find((x) => x.date === d);
        const off = day?.off ?? [];
        const thin = day && day.scheduled && day.offCount / day.scheduled >= 0.3;
        return (
          <td key={d} className={`off-cell${thin ? " thin" : ""}`} title={off.map((o) => `${o.name} — ${o.type}${o.status === "pending" ? " (pending)" : ""}`).join("\n") || undefined}>
            {day ? (
              off.length ? (
                <>
                  <span className="off-count">{day.offCount}{day.pendingCount ? <small> +{day.pendingCount}?</small> : null} off</span>
                  {off.slice(0, 3).map((o) => <span key={o.userId} className={`off-name leave-${o.code}${o.status === "pending" ? " pending" : ""}`} title={`${o.name} — ${o.type}`}>{o.name} · {o.type}</span>)}
                  {off.length > 3 ? <span className="muted small-text">+{off.length - 3} more</span> : null}
                </>
              ) : <span className="muted small-text">{day.scheduled ? `all ${day.scheduled} in` : ""}</span>
            ) : null}
          </td>
        );
      })}
      <td />
    </tr>
  );
}
