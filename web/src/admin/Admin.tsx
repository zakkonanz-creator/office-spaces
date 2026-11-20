// Admin: members & roles, guest links, the analytics timesheet, settings.

import { useEffect, useMemo, useState } from "react";
import { Icon } from "../icons";
import { loadOnboarding } from "../onboard";
import { AdminTour } from "./AdminTour";
import { BACKLOG, CHANGELOG, type BacklogStatus } from "./changelog";
import { GivePoints } from "../office/GivePoints";
import { access } from "../time/api";

type Tab = "members" | "points" | "reports" | "guests" | "analytics" | "settings";

export function Admin() {
  const initial = (location.pathname.split("/")[2] as Tab) || "analytics";
  const [tab, setTab] = useState<Tab>(["members", "points", "reports", "guests", "analytics", "settings"].includes(initial) ? initial : "analytics");
  const go = (t: Tab) => {
    history.replaceState(null, "", `/admin/${t}${location.search}`);
    setTab(t);
  };
  useEffect(() => { void loadOnboarding(); }, []);
  return (
    <div className="admin">
      <header className="admin-head">
        <a href="/" className="back" onClick={backToOffice}>← Back to the office</a>
        <div className="admin-title">
          <h1>Office Spaces · Admin</h1>
          {/* A full load with ?tour=1: the tour reopens even if it was hidden or finished. */}
          <a className="button small" href={`/admin/${tab}?tour=1`} title="What each admin page is for, and what can't be undone">Take the admin tour</a>
        </div>
        <nav className="tabs">
          {(["analytics", "members", "points", "reports", "guests", "settings"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => go(t)}>
              {t === "guests" ? "Guest links" : t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      </header>
      <main className="admin-body">
        <AdminTour tab={tab} go={go} />
        {tab === "members" ? <Members /> : null}
        {tab === "points" ? <AdminPoints /> : null}
        {tab === "reports" ? <Reports /> : null}
        {tab === "guests" ? <Guests /> : null}
        {tab === "analytics" ? <Analytics /> : null}
        {tab === "settings" ? <Settings /> : null}
      </main>
    </div>
  );
}

const api = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j;
};

// ── Members ────────────────────────────────────────────────────────────────

interface Member { id: number; email: string; name: string; title: string | null; role: string; desk_id: string | null; removed: boolean; last_seen: string | null; slack_id: string | null; calendar: boolean; first_office_at: string | null; started_on: string | null; started_guessed: boolean; gettingStarted: { done: number; of: number; finished: boolean; hidden: boolean } }

function Members() {
  const [data, setData] = useState<{ users: Member[]; desks: { id: string; room: string; owner: string | null }[] } | null>(null);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const load = () => api("/api/admin/members").then(setData);
  useEffect(() => {
    load();
  }, []);
  const patch = async (id: number, body: object) => {
    try {
      await api(`/api/admin/members/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      setMsg("Saved.");
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  if (!data) return <p className="muted">Loading…</p>;
  const taken = new Map(data.users.filter((u) => u.desk_id).map((u) => [u.desk_id!, u.name]));
  // Desk ids are opaque (designer and import ids are random): label them "Sales · desk 3".
  const deskNo = new Map<string, number>();
  const perRoom = new Map<string, number>();
  for (const d of data.desks) {
    perRoom.set(d.room, (perRoom.get(d.room) ?? 0) + 1);
    deskNo.set(d.id, perRoom.get(d.room)!);
  }
  const rows = data.users.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase()));
  const focus = Number(location.hash.slice(1));
  return (
    <section>
      <Preassign />
      <div className="admin-toolbar">
        <label className="search"><Icon name="search" size={16} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search members" /></label>
        <span className="muted">{data.users.filter((u) => !u.removed).length} members · anyone on an allowed domain joins as a Member the first time they sign in, unless their access was set up above</span>
        {msg ? <span className="flash">{msg}</span> : null}
      </div>
      <table className="grid" data-tour="members-table">
        <thead>
          <tr><th>Name</th><th>Role</th><th>Desk</th><th title="First day at Acme: unlocks emotes and sets the pin on their avatar. From Slack's account-created date; anyone not found there counts from the day they first signed in here.">Started</th><th>Slack</th><th>Calendar</th><th title="The first-day checklist in the office" data-tour="getting-started">Getting started</th><th>Last seen</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id} className={`${u.removed ? "removed" : ""}${u.id === focus ? " focus" : ""}`}>
              <td>
                <b className="editable-name" title="Click to change the name everyone sees">
                  <input
                    key={u.name}
                    defaultValue={u.name}
                    maxLength={60}
                    disabled={u.removed}
                    aria-label={`Name for ${u.email}`}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { (e.target as HTMLInputElement).value = u.name; (e.target as HTMLInputElement).blur(); } }}
                    onBlur={(e) => { const v = e.target.value.trim(); if (!v) e.target.value = u.name; else if (v !== u.name) void patch(u.id, { name: v }); }}
                  />
                </b>
                <div className="muted small-text">{u.email}{u.title ? ` · ${u.title}` : ""}</div>
              </td>
              <td>
                <select value={u.role} disabled={u.removed} onChange={(e) => patch(u.id, { role: e.target.value })}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </td>
              <td>
                <select value={u.desk_id ?? ""} disabled={u.removed} onChange={(e) => patch(u.id, { desk_id: e.target.value || null })}>
                  <option value="">No desk</option>
                  {data.desks.map((d) => (
                    <option key={d.id} value={d.id} disabled={taken.has(d.id) && taken.get(d.id) !== u.name}>
                      {d.room} · desk {deskNo.get(d.id)}{taken.has(d.id) && taken.get(d.id) !== u.name ? ` (${taken.get(d.id)})` : d.owner ? ` (saved for ${d.owner})` : ""}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input type="date" className={`started${u.started_guessed ? " guessed" : ""}`} defaultValue={u.started_on ?? ""} key={u.started_on ?? ""} disabled={u.removed} max={new Date().toISOString().slice(0, 10)}
                  title={u.started_guessed ? "No start date set: this is the day they first signed in to the office. Set their real first day." : "First day at Acme"}
                  onBlur={(e) => { const v = e.target.value; if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v !== u.started_on) patch(u.id, { started_on: v }); }} />
              </td>
              <td>{u.slack_id ? "✓" : <span className="muted">—</span>}</td>
              <td>{u.calendar ? "Linked" : <span className="muted">—</span>}</td>
              <td>
                <GettingStartedCell u={u} />
                {!u.removed ? (
                  <button className="small ghost replay" title="Show them the first-day welcome and checklist the next time they open the office" onClick={() => patch(u.id, { replayOnboarding: true })}>Replay</button>
                ) : null}
              </td>
              <td className="muted">{u.last_seen ? new Date(u.last_seen).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</td>
              <td>
                {u.removed ? (
                  <button className="small" onClick={() => patch(u.id, { removed: false })}>Restore</button>
                ) : (
                  <button className="small danger" onClick={() => confirmRemove(u) && patch(u.id, { removed: true })}>Remove</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Done, a/b for someone part-way, or "Not in yet" for someone who hasn't walked in. */
function GettingStartedCell({ u }: { u: Member }) {
  const g = u.gettingStarted;
  if (g.finished) return <span className="pill ok">Done</span>;
  if (!u.first_office_at) return <span className="muted">Not in yet</span>;
  const days = (Date.now() - new Date(u.first_office_at).getTime()) / 864e5;
  // The checklist only opens by itself in someone's first 14 days; people already here when it shipped never saw it.
  if ((days > 14 || g.hidden) && !g.done) return <span className="muted" title="Joined before the checklist, or never opened it">—</span>;
  // Someone a few days in who hasn't got far may need a hand; everyone else is just "a/b".
  const stuck = days >= 3 && g.done < g.of - 2;
  return <span className={stuck ? "pill wait" : "muted"} title={stuck ? `First came in ${Math.floor(days)} days ago` : undefined}>{g.done}/{g.of}{stuck ? " · may need a hand" : ""}</span>;
}

// ── Access set up before a first sign-in ───────────────────────────────────

interface Pre { email: string; role: "admin" | "member"; manager_team: string | null; payroll_admin: boolean; team: string | null; created_by_name: string | null; created_at: string; claimed_at: string | null }

const accessLabel = (p: Pick<Pre, "role" | "manager_team" | "payroll_admin">) =>
  [p.role === "admin" ? "Admin" : "Member", p.manager_team ? `Manager · ${p.manager_team === "*" ? "all teams" : p.manager_team}` : "", p.payroll_admin ? "Payroll admin" : ""].filter(Boolean).join(" + ");

function Preassign() {
  const [data, setData] = useState<{ rows: Pre[]; teams: string[]; canGrantPay: boolean; domains: string[] } | null>(null);
  const blank = { email: "", role: "member", managerTeam: "", payrollAdmin: false, team: "" };
  const [f, setF] = useState(blank);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showApplied, setShowApplied] = useState(false);
  const load = () => api("/api/admin/preassigned").then(setData).catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  useEffect(() => { load(); }, []);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api("/api/admin/preassigned", { method: "POST", body: JSON.stringify(f) });
      setMsg({ ok: true, text: `Saved. ${f.email.trim()} gets this the first time they sign in.` });
      setF(blank);
      load();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  };
  const drop = async (email: string) => {
    try {
      await api(`/api/admin/preassigned/${encodeURIComponent(email)}`, { method: "DELETE" });
      load();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  };
  if (!data) return null;
  const waiting = data.rows.filter((r) => !r.claimed_at);
  const applied = data.rows.filter((r) => r.claimed_at);
  const pay = data.canGrantPay;
  return (
    <section className="two-col preassign">
      <form className="panel" onSubmit={save} data-tour="preassign">
        <h3>Set up access before they sign in</h3>
        <p className="hint">Add someone's work email and what they should get. It's applied the moment they first sign in with Google — no waiting for them to show up first.</p>
        <label className="field">Email
          <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder={`name@${data.domains[0] ?? "example.com"}`} required />
        </label>
        <label className="field">Office role
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="member">Member</option>
            <option value="admin">Admin — this page, the Designer, guest links</option>
          </select>
        </label>
        <label className="field">Manager of{pay ? "" : " (payroll admins only)"}
          <select value={f.managerTeam} disabled={!pay} onChange={(e) => setF({ ...f, managerTeam: e.target.value })}>
            <option value="">Not a manager</option>
            <option value="*">All teams</option>
            {data.teams.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="field">Works in team
          <select value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })}>
            <option value="">Not set</option>
            {data.teams.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={f.payrollAdmin} disabled={!pay} onChange={(e) => setF({ ...f, payrollAdmin: e.target.checked })} /> Payroll admin — sees and runs pay{pay ? "" : " (payroll admins only)"}</label>
        <button className="primary">Save</button>
        {msg ? <p className={msg.ok ? "flash" : "error-text"}>{msg.text}</p> : null}
      </form>
      <div className="panel">
        <div className="row" style={{ marginTop: 0, justifyContent: "space-between" }}>
          <h3>Waiting for first sign-in</h3>
          {applied.length ? <button className="small ghost" onClick={() => setShowApplied(!showApplied)}>{showApplied ? "Hide" : "Show"} {applied.length} applied</button> : null}
        </div>
        {!waiting.length && !showApplied ? <p className="muted">Nobody waiting.</p> : (
          <table className="grid">
            <thead><tr><th>Email</th><th>Access</th><th>Team</th><th /></tr></thead>
            <tbody>
              {[...waiting, ...(showApplied ? applied : [])].map((r) => (
                <tr key={r.email} className={r.claimed_at ? "removed" : ""}>
                  <td><b>{r.email}</b><div className="muted small-text">{r.claimed_at ? `applied ${new Date(r.claimed_at).toLocaleDateString()}` : `added by ${r.created_by_name ?? "an admin"}`}</div></td>
                  <td>{accessLabel(r)}</td>
                  <td>{r.team ?? <span className="muted">—</span>}</td>
                  <td>{r.claimed_at ? null : <button className="small danger" disabled={!pay && (r.payroll_admin || !!r.manager_team)} onClick={() => drop(r.email)}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function confirmRemove(u: Member) {
  return window.confirm(`Remove ${u.name}? They're signed out now and can't sign back in until restored. Their analytics history is kept.`);
}

// ── Guest links ────────────────────────────────────────────────────────────

interface Invite { id: number; label: string; room: string; room_id: string; link: string; expires_at: string | null; can_present: boolean; revoked: boolean; created_at: string; created_by_name: string | null }

function Guests() {
  const [rows, setRows] = useState<Invite[] | null>(null);
  const [rooms, setRooms] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({ label: "", roomId: "conference", hours: "24", canPresent: false });
  const [made, setMade] = useState<Invite | null>(null);
  const load = () => api("/api/admin/invites").then(setRows);
  useEffect(() => {
    load();
    fetch("/api/floor").then((r) => r.json()).then((f) => setRooms(f.rooms.filter((r: any) => r.kind !== "common").map((r: any) => ({ id: r.id, name: r.name }))));
  }, []);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const inv = await api("/api/admin/invites", { method: "POST", body: JSON.stringify({ ...form, hours: form.hours === "never" ? null : Number(form.hours) }) });
    setMade(inv);
    navigator.clipboard?.writeText(inv.link).catch(() => {});
    load();
  };
  const live = (i: Invite) => !i.revoked && (!i.expires_at || new Date(i.expires_at) > new Date());
  const [showOld, setShowOld] = useState(false);
  const shown = (rows ?? []).filter((i) => showOld || live(i));
  const oldCount = (rows ?? []).filter((i) => !live(i)).length;
  return (
    <section className="two-col">
      <form className="panel" onSubmit={create} data-tour="guest-new">
        <h3>New guest link</h3>
        <p className="hint">Guests skip Google sign-in, type a name, and can only be in the one room you pick.</p>
        <label className="field">Who's it for
          <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. Acme demo — Jane" required />
        </label>
        <label className="field">Room
          <select value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })}>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name || `Unnamed room (${r.id})`}</option>)}
          </select>
        </label>
        <label className="field">Expires
          <select value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })}>
            <option value="2">In 2 hours</option>
            <option value="24">In 24 hours</option>
            <option value="168">In 7 days</option>
            <option value="720">In 30 days</option>
            <option value="never">Never (permanent link)</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={form.canPresent} onChange={(e) => setForm({ ...form, canPresent: e.target.checked })} /> Allow them to share their screen</label>
        <button className="primary">Create link</button>
        {made ? (
          <div className="made">
            <p>Copied to your clipboard:</p>
            <code>{made.link}</code>
          </div>
        ) : null}
      </form>
      <div className="panel" data-tour="guest-links">
        <div className="row" style={{ marginTop: 0, justifyContent: "space-between" }}>
          <h3>Links</h3>
          {oldCount ? <button className="small ghost" onClick={() => setShowOld(!showOld)}>{showOld ? "Hide" : "Show"} {oldCount} expired or revoked</button> : null}
        </div>
        {!rows ? <p className="muted">Loading…</p> : !shown.length ? <p className="muted">No active links.</p> : (
          <table className="grid">
            <thead><tr><th>For</th><th>Room</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {shown.map((i) => (
                <tr key={i.id} className={live(i) ? "" : "removed"}>
                  <td><b>{i.label}</b><div className="muted small-text">by {i.created_by_name ?? "—"}{i.can_present ? " · can present" : ""}</div></td>
                  <td>{i.room}</td>
                  <td className="muted">{i.revoked ? "Revoked" : i.expires_at ? new Date(i.expires_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Never"}</td>
                  <td>
                    {live(i) ? (
                      <div className="actions">
                        <button className="small" onClick={() => navigator.clipboard?.writeText(i.link)}><Icon name="copy" size={14} /> Copy</button>
                        <button className="small danger" onClick={async () => { await api(`/api/admin/invites/${i.id}`, { method: "DELETE" }); load(); }}>Revoke</button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

// ── Analytics ──────────────────────────────────────────────────────────────

interface Seg { status: string; start: number; end: number }
interface Row { id: number; name: string; email: string; role: string; segments: Seg[]; totals: { available: number; focusing: number; away: number } }

const TZS = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "Europe/London", "Africa/Lagos", "Asia/Karachi", "Asia/Manila", "UTC"];

/** Midnight of a calendar date in a timezone, as a UTC instant. */
function zonedMidnight(date: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess - (asIfUtc - guess));
}

function Analytics() {
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [tz, setTz] = useState(localTz);
  const [mode, setMode] = useState<"day" | "week">("day");
  const [date, setDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: localTz }).format(new Date()));
  const [rows, setRows] = useState<Row[] | null>(null);
  const [filter, setFilter] = useState<Set<string>>(new Set(["available", "away", "focusing"]));
  const [q, setQ] = useState("");

  const win = useMemo(() => {
    let from = zonedMidnight(date, tz);
    if (mode === "week") {
      const dow = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
      const monday = new Date(`${date}T12:00:00Z`);
      monday.setUTCDate(monday.getUTCDate() - ((dow + 6) % 7));
      from = zonedMidnight(monday.toISOString().slice(0, 10), tz);
    }
    const end = new Date(from);
    end.setUTCDate(end.getUTCDate() + (mode === "week" ? 7 : 1));
    // Re-anchor to the zone's midnight in case DST moved inside the window.
    const to = zonedMidnight(new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(+end + 6 * 3600e3)), tz);
    return { from, to };
  }, [date, mode, tz]);

  useEffect(() => {
    setRows(null);
    api(`/api/admin/analytics?from=${win.from.toISOString()}&to=${win.to.toISOString()}`).then(setRows).catch(() => setRows([]));
  }, [win]);

  const shift = (n: number) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n * (mode === "week" ? 7 : 1));
    setDate(d.toISOString().slice(0, 10));
  };

  const visible = (rows ?? []).filter((r) => `${r.name} ${r.email}`.toLowerCase().includes(q.toLowerCase()));
  const span = +win.to - +win.from;
  const sum = (k: keyof Row["totals"]) => visible.reduce((a, r) => a + r.totals[k], 0);
  const total = sum("available") + sum("away") + sum("focusing");
  const people = visible.filter((r) => r.totals.available + r.totals.away + r.totals.focusing > 0).length || 1;
  const days = mode === "week" ? 7 : 1;
  const hours = mode === "day" ? Array.from({ length: 24 }, (_, i) => i) : Array.from({ length: 7 }, (_, i) => i);

  return (
    <section>
      <div className="admin-toolbar" data-tour="analytics-controls">
        <div className="seg">
          <button className={mode === "day" ? "on" : ""} onClick={() => setMode("day")}>Day</button>
          <button className={mode === "week" ? "on" : ""} onClick={() => setMode("week")}>Week</button>
        </div>
        <button className="small" onClick={() => setDate(new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()))}>Today</button>
        <button className="small" onClick={() => shift(-1)} aria-label="Previous">←</button>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <button className="small" onClick={() => shift(1)} aria-label="Next">→</button>
        <select value={tz} onChange={(e) => setTz(e.target.value)}>
          {[...new Set([localTz, ...TZS])].map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
        </select>
        <div className="seg">
          {(["available", "away", "focusing"] as const).map((k) => (
            <button key={k} className={`status-${k}${filter.has(k) ? " on" : ""}`} onClick={() => { const n = new Set(filter); n.has(k) ? n.delete(k) : n.add(k); setFilter(n); }}>
              <span className="status-dot" />{k[0].toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
        <a className="button small" href={`/api/admin/analytics.csv?from=${win.from.toISOString()}&to=${win.to.toISOString()}&tz=${encodeURIComponent(tz)}`}>Download CSV</a>
      </div>

      <div className="summary">
        <div className="sum-card">
          <span className="muted">{mode === "day" ? new Date(`${date}T12:00:00Z`).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }) : `Week of ${win.from.toLocaleDateString([], { month: "short", day: "numeric", timeZone: tz })}`}</span>
          <b>{visible.length} people in the office</b>
        </div>
        <div className="sum-card">
          <span className="muted">Average per person{days > 1 ? " per day" : ""}</span>
          <b>{fmt(total / people / days)}</b>
          <Bars a={sum("available")} f={sum("focusing")} w={sum("away")} />
        </div>
        <div className="sum-card">
          <span className="muted">Total</span>
          <b>{fmt(total)}</b>
          <span className="muted small-text">{fmt(sum("available"))} available · {fmt(sum("focusing"))} focusing · {fmt(sum("away"))} away</span>
        </div>
      </div>

      <div className="timeline" data-tour="analytics-timeline">
        <div className="tl-head">
          <label className="search"><Icon name="search" size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" /></label>
          <div className="tl-axis">
            {hours.map((h) => (
              <span key={h} style={{ left: `${(h / hours.length) * 100}%` }}>
                {mode === "day" ? (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`) : new Date(+win.from + h * 864e5 + 12 * 3600e3).toLocaleDateString([], { weekday: "short", timeZone: tz })}
              </span>
            ))}
          </div>
          <span className="tl-total">Total</span>
        </div>
        {!rows ? <p className="muted pad">Loading…</p> : !visible.length ? <p className="muted pad">Nobody was in the office in this window.</p> : null}
        {visible.map((r) => {
          const t = r.totals.available + r.totals.focusing + r.totals.away;
          return (
            <div key={r.id} className="tl-row">
              <div className="tl-who"><b>{r.name}</b><span className="muted small-text">{r.email}</span></div>
              <div className="tl-track">
                {r.segments.filter((s) => filter.has(s.status)).map((s, i) => (
                  <span
                    key={i}
                    className={`tl-seg status-${s.status}`}
                    style={{ left: `${((s.start - +win.from) / span) * 100}%`, width: `${Math.max(0.15, ((s.end - s.start) / span) * 100)}%` }}
                    title={`${s.status} ${new Date(s.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: tz })}–${new Date(s.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: tz })}`}
                  />
                ))}
              </div>
              <div className="tl-total">
                <b>{fmt(t)}</b>
                <span className="tl-split small-text">
                  <span title="Available"><i className="status-dot status-available" />{fmt(r.totals.available)}</span>
                  <span title="Focusing"><i className="status-dot status-focusing" />{fmt(r.totals.focusing)}</span>
                  <span title="Away"><i className="status-dot status-away" />{fmt(r.totals.away)}</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <p className="hint">Time counts only while someone has the office open. Available, Focusing and Away come from the status they set (or auto-away, for people who turned it on).</p>
    </section>
  );
}

function Bars({ a, f, w }: { a: number; f: number; w: number }) {
  const t = a + f + w || 1;
  return (
    <div className="bars" aria-label="Status mix">
      <span className="status-available" style={{ width: `${(a / t) * 100}%` }} />
      <span className="status-focusing" style={{ width: `${(f / t) * 100}%` }} />
      <span className="status-away" style={{ width: `${(w / t) * 100}%` }} />
    </div>
  );
}

const fmt = (ms: number) => {
  const m = Math.round(ms / 60000);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

// ── Settings ───────────────────────────────────────────────────────────────

function Settings() {
  const [s, setS] = useState<any>(null);
  const link = new URLSearchParams(location.search).get("link");
  const [msg, setMsg] = useState(link === "drive" ? "Drive linked." : link === "payroll-only" ? "Drive wasn't linked: only a payroll admin can link it." : "");
  // Linking Drive is payroll admins only (it writes the backup, which holds pay data).
  const [payrollAdmin, setPayrollAdmin] = useState(false);
  useEffect(() => {
    api("/api/admin/settings").then(setS);
    access().then((a) => setPayrollAdmin(a.payrollAdmin));
  }, []);
  if (!s) return <p className="muted">Loading…</p>;
  return (
    <section className="settings">
      {msg ? <p className="flash">{msg}</p> : null}
      <p className="hint settings-jump">Jump to <a href="#changelog">Changelog</a> · <a href="#backlog">Backlog</a></p>
      <div className="panel" data-tour="settings-audio">
        <h3>Audio range</h3>
        <p className="hint">How far your voice carries on the open floor. Inside a room everyone hears everyone.</p>
        <div className="seg">
          {["small", "normal", "large"].map((r) => (
            <button key={r} className={s.audioRange === r ? "on" : ""} onClick={async () => { const j = await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ audioRange: r }) }); setS({ ...s, audioRange: r }); setMsg(j.note); }}>
              {r[0].toUpperCase() + r.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="panel" data-tour="settings-transcription">
        <h3>Room transcription</h3>
        <p className="hint">Any teammate in a room can press <b>Transcribe</b>. Each teammate's own mic is sent in short clips; guests' mics are never recorded. Our own Whisper service on Railway turns them into text, the audio is deleted, and Claude writes the notes for the people who were in the room. Admins don't see other rooms' transcripts.</p>
        <p>{s.transcriberConfigured ? "Transcriber connected." : <span className="bad-line">TRANSCRIBER_URL / TRANSCRIBER_KEY not set: the Transcribe button says it isn't set up.</span>}</p>
        <p>This month: <b>{s.transcription.hours.toFixed(1)}</b> of {s.transcription.cap} hours of audio sent.</p>
        <form className="row" onSubmit={async (e) => {
          e.preventDefault();
          const h = Number(new FormData(e.currentTarget).get("hours"));
          try {
            await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ transcribeMonthlyHours: h }) });
            setS({ ...s, transcription: { ...s.transcription, cap: h } });
            setMsg(`Monthly limit set to ${h} hours.`);
          } catch (err) { setMsg((err as Error).message); }
        }}>
          <label className="field" style={{ margin: 0 }}>Monthly limit (hours of audio) <input name="hours" type="number" min={0} max={2000} defaultValue={s.transcription.cap} style={{ width: 90 }} /></label>
          <button className="small">Save</button>
        </form>
        <p className="hint">When it's reached, running transcriptions stop and nobody can start a new one until next month (UTC) or until the limit is raised.</p>
      </div>
      <div className="panel" data-tour="settings-meetings">
        <h3>Shared meeting rooms</h3>
        <p className="hint"><b>Start meeting</b> in a room opens a GHL Meeting Room inside the office and asks everyone in the room to join. People who saved their own room use it; everyone else gets the first free room below. Make these rooms in GHL just for the office and don't share their links elsewhere: the office can only tell a room is busy when the office started the meeting in it.</p>
        <form onSubmit={async (e) => {
          e.preventDefault();
          try {
            const j = await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ ghlRooms: String(new FormData(e.currentTarget).get("rooms") ?? "") }) });
            setS({ ...s, ghlRooms: j.ghlRooms });
            setMsg(`${j.ghlRooms.length} shared meeting room${j.ghlRooms.length === 1 ? "" : "s"} saved.`);
          } catch (err) { setMsg((err as Error).message); }
        }}>
          <p className="hint"><b>Only rooms nobody owns</b> (spare GHL users made for the office). Never put someone's personal room here: the office hands these out to anyone.</p>
          <textarea name="rooms" rows={4} style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
            defaultValue={(s.ghlRooms ?? []).map((r: { label: string; url: string }) => `${r.label} | ${r.url}`).join("\n")}
            placeholder={"Team room 1 | https://crm.example.com/meet/team-1?pwd=…\nTeam room 2 | https://crm.example.com/meet/team-2?pwd=…"} />
          <p className="hint">One per line: <code>Name | link</code> (the name is optional).</p>
          <button className="small">Save</button>
        </form>
      </div>
      <div className="panel" data-tour="settings-own-rooms">
        <h3>Each person's own meeting room</h3>
        <p className="hint">Not shared: these are people's personal GHL rooms. One per line: <code>email | link</code>. Start meeting opens that person's own room (a link they save themselves with <b>My room</b> wins). Works before they've signed in to the office.</p>
        <form onSubmit={async (e) => {
          e.preventDefault();
          try {
            const j = await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ ghlRoomLinks: String(new FormData(e.currentTarget).get("links") ?? "") }) });
            setS({ ...s, ghlRoomLinks: j.ghlRoomLinks });
            setMsg(`${Object.keys(j.ghlRoomLinks).length} people's meeting rooms saved.`);
          } catch (err) { setMsg((err as Error).message); }
        }}>
          <textarea name="links" rows={5} style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
            defaultValue={Object.entries(s.ghlRoomLinks ?? {}).map(([e, u]) => `${e} | ${u}`).join("\n")}
            placeholder={"jay@example.com | https://crm.example.com/meet/jay-weiss-…?pwd=…"} />
          <button className="small">Save</button>
        </form>
      </div>
      <div className="panel" data-tour="settings-door-meetings">
        <h3>Closing a door starts a meeting</h3>
        <p className="hint">The person who closes it goes straight into the meeting; everyone else in the room is asked to join.</p>
        <div className="seg">
          {([["off", "Off"], ["meeting", "Meeting rooms"], ["all", "Every room with a door"]] as const).map(([v, label]) => (
            <button key={v} className={(s.autoMeetOnClose ?? "meeting") === v ? "on" : ""} onClick={async () => {
              await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ autoMeetOnClose: v }) });
              setS({ ...s, autoMeetOnClose: v });
            }}>{label}</button>
          ))}
        </div>
      </div>
      <div className="panel">
        <h3>Fathom</h3>
        <p className="hint">Rooms now use <b>Transcribe</b> (above); the room bar no longer starts Fathom meetings. This only matters for summaries of older "Record with Fathom" meetings: each person who ran them adds a webhook in Fathom (Settings → API Access → Add Webhook) pointing here, and its <code>whsec_…</code> secret goes in <code>FATHOM_WEBHOOK_SECRETS</code>.</p>
        <code className="block">{s.webhookUrl}</code>
        <p>{s.fathomWebhooks ? `${s.fathomWebhooks} webhook secret${s.fathomWebhooks > 1 ? "s" : ""} configured.` : <span className="muted">No webhook secrets configured (fine if nobody used Record with Fathom).</span>}</p>
      </div>
      <div className="panel">
        <h3>Google Drive</h3>
        <p className="hint">Fathom summaries from room meetings are filed in a dated folder under <i>Office Spaces Recordings</i>, next to the other call recordings. The same account writes the nightly database backup.</p>
        <p>Folder: {s.driveFolderConfigured ? "configured" : <span className="bad-line">DRIVE_RECORDINGS_FOLDER_ID is not set</span>}</p>
        <p>Writing as: {s.driveAccount ?? <span className="bad-line">nobody linked yet</span>}</p>
        {payrollAdmin
          ? <a className="button" href="/auth/drive">{s.driveAccount ? "Re-link Drive" : "Link Drive"}</a>
          : <p className="hint">A payroll admin has to {s.driveAccount ? "re-link" : "link"} Drive. The backup it writes holds pay data, so only they can choose the account.</p>}
      </div>
      <div className="panel">
        <h3>Slack</h3>
        <p>{s.slackConfigured ? "Connected — profile photos, “Message on Slack”, and Fathom DMs are on." : <span className="bad-line">SLACK_BOT_TOKEN not set — no Slack photos, links or DMs.</span>}</p>
      </div>
      <ChangelogPanels />
    </section>
  );
}

const STATUS: Record<BacklogStatus, string> = { next: "Next up", waiting: "Waiting on someone", idea: "Idea", parked: "Parked" };

/** What shipped (newest first) and what's next (admin/changelog.ts). */
function ChangelogPanels() {
  const [allReleases, setAllReleases] = useState(false);
  const shown = allReleases ? CHANGELOG : CHANGELOG.slice(0, 3);
  const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return (
    <>
      <div className="panel changelog" id="changelog">
        <h3>Changelog</h3>
        <p className="hint">What's shipped in Office Spaces, newest first.</p>
        {shown.map((r) => (
          <div key={r.date} className="release">
            <div className="release-head"><b>{r.title}</b><span className="muted">{fmt(r.date)}</span></div>
            <ul>{r.items.map((it, i) => <li key={i}>{it}</li>)}</ul>
          </div>
        ))}
        {CHANGELOG.length > 3 ? <button className="small" onClick={() => setAllReleases(!allReleases)}>{allReleases ? "Show less" : `Show all ${CHANGELOG.length} releases (since ${fmt(CHANGELOG[CHANGELOG.length - 1].date)})`}</button> : null}
      </div>
      <div className="panel backlog" id="backlog">
        <h3>Backlog</h3>
        <p className="hint">Asked for, proposed, or waiting on someone. Parked items are decided against for now.</p>
        {(["next", "waiting", "idea", "parked"] as BacklogStatus[]).map((st) => {
          const items = BACKLOG.filter((b) => b.status === st);
          if (!items.length) return null;
          return (
            <div key={st} className="backlog-group">
              <h4><span className={`bl-pill bl-${st}`}>{STATUS[st]}</span> <span className="muted">{items.length}</span></h4>
              <ul>
                {items.map((b) => (
                  <li key={b.title}><b>{b.title}</b>{b.from ? <span className="muted"> · {b.from}</span> : null}<div className="hint">{b.why}</div></li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * Admin opens in its own tab from the office (so you don't leave it). Going "back" closes this tab
 * rather than loading a second office, which would sign the first one out ("opened in another tab").
 * A browser only lets a page close a tab it opened, or one with no history; otherwise go to the office.
 */
function backToOffice(e: React.MouseEvent) {
  e.preventDefault();
  window.close();
  setTimeout(() => { if (!window.closed) location.href = "/"; }, 150);
}

// ── Points: award them for work (shared/points.ts) ─────────────────────────

interface LedgerRow { id: number; kind: string; points: number; reason: string; created_at: string; user_name: string; by_name: string | null }
// ── Reports (bugs + ideas from the office's Report button; server/feedback.ts) ──

interface ReportRow { id: number; kind: "bug" | "idea"; title: string; details: string; context: { path?: string; room?: string; userAgent?: string; viewport?: string; errors?: string[] }; status: string; fix_branch: string | null; fix_pr_url: string | null; agent_note: string | null; created_at: string; by: string | null }
const REPORT_STATUS: Record<string, string> = { new: "New", filed: "Filed", fixing: "Agent fixing", fix_ready: "Fix ready (PR)", no_fix: "Agent couldn't fix", done: "Done", wont_do: "Won't do" };

function Reports() {
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [msg, setMsg] = useState("");
  const load = () => api("/api/admin/feedback").then(setRows).catch((e) => setMsg((e as Error).message));
  useEffect(() => { load(); }, []);
  const mark = async (id: number, status: string) => {
    try { await api(`/api/admin/feedback/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }); load(); } catch (e) { setMsg((e as Error).message); }
  };
  if (!rows) return <p className="muted">Loading…</p>;
  return (
    <section>
      <h2>Bugs and ideas</h2>
      <p className="muted">From the bug button in the office. If you connect a bot (FEEDBACK_AGENT_KEY), it can file these elsewhere and update their status here.</p>
      {msg ? <p className="muted">{msg}</p> : null}
      {rows.length === 0 ? <p className="muted">No reports yet.</p> : (
        <table className="grid">
          <thead><tr><th>When</th><th>From</th><th>What</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                <td>{r.by ?? "?"}</td>
                <td>
                  <details>
                    <summary>{r.kind === "bug" ? "🐞" : "💡"} {r.title}</summary>
                    {r.details ? <p style={{ whiteSpace: "pre-wrap" }}>{r.details}</p> : null}
                    <p className="muted small-text">{[r.context.room, r.context.path, r.context.viewport].filter(Boolean).join(" · ")}</p>
                    {r.context.errors?.length ? <pre className="small-text">{r.context.errors.join("\n")}</pre> : null}
                    {r.agent_note ? <p className="small-text"><b>Agent:</b> {r.agent_note}</p> : null}
                  </details>
                </td>
                <td>{r.fix_pr_url ? <a href={r.fix_pr_url} target="_blank" rel="noreferrer">{REPORT_STATUS[r.status] ?? r.status}</a> : REPORT_STATUS[r.status] ?? r.status}</td>
                <td>
                  {r.status === "done" || r.status === "wont_do" ? <button className="small" onClick={() => mark(r.id, "new")} title="Reopen. The agent picks it up again on its next run.">Reopen</button> : (
                    <>
                      <button className="small" onClick={() => mark(r.id, "done")}>Done</button>{" "}
                      <button className="small ghost" onClick={() => mark(r.id, "wont_do")}>Won't do</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function AdminPoints() {
  const [data, setData] = useState<{ recent: LedgerRow[]; everyone: { id: number; name: string; points: number }[] } | null>(null);
  const [canGive, setCanGive] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () => api("/api/admin/points").then(setData);
  useEffect(() => { load(); fetch("/api/points").then((r) => r.json()).then((j) => setCanGive(Boolean(j.canGive))).catch(() => {}); }, []);
  if (!data) return <p className="muted">Loading…</p>;
  const remove = async (id: number) => {
    try { await api(`/api/admin/points/${id}`, { method: "DELETE" }); load(); } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <section>
      <h2>Award points</h2>
      {canGive ? (
        <>
          <p className="muted">For anything work-related: a closed deal, a great save for a customer, a process fixed. They see it straight away, with your reason, and it's posted in #wins (untick to keep it quiet). You can't give points to yourself.</p>
          <GivePoints onDone={load} />
        </>
      ) : <p className="muted">Only the people your admins chose can give points.</p>}
      {msg ? <p className="muted">{msg}</p> : null}
      <h3>Recent points</h3>
      <table className="grid">
        <thead><tr><th>When</th><th>Who</th><th>Points</th><th>For</th><th /></tr></thead>
        <tbody>
          {data.recent.map((r) => (
            <tr key={r.id}>
              <td className="muted">{new Date(r.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
              <td>{r.user_name}</td>
              <td>{r.points > 0 ? `+${r.points}` : r.points}</td>
              <td>{r.reason}{r.by_name ? <span className="muted"> · from {r.by_name}</span> : null}</td>
              <td>{canGive && (r.kind === "grant" || r.kind === "win") ? <button className="small ghost" onClick={() => remove(r.id)}>Remove</button> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Everyone</h3>
      <table className="grid">
        <thead><tr><th>#</th><th>Name</th><th>Points</th></tr></thead>
        <tbody>{data.everyone.map((u, i) => <tr key={u.id}><td className="muted">{i + 1}</td><td>{u.name}</td><td>{u.points.toLocaleString("en-US")}</td></tr>)}</tbody>
      </table>
    </section>
  );
}
