// Import people, schedules and leave from Deputy (optional migration for teams
// moving off Deputy; nothing else depends on it).
//
// The file is a JSON export (DeputyExport below) read from a logged-in Deputy tab:
// everyone active, their location, start date, regular week (Deputy's "regular
// working hours"), leave balances, the upcoming roster and upcoming leave.
//
// Preview first; nothing is written until commit=1. Each person is kept in
// deputy_import by email and applied to their office account — now if they've
// signed in, otherwise the moment they first do. Deputy's times are wall-clock
// times in Deputy's business timezone; a regular week is turned into the
// person's own timezone, so it waits until the office knows that timezone.
// Re-importing a newer file updates everything the office hasn't decided itself.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { one, q } from "../db";
import { managedTeams } from "../payroll/grants";
import { addDays, isDate, isRegularHours, isTime, isTz, localDate, MON_FRI, weekStart, workingDays, zonedTime, type RegularDay } from "../../shared/time";
import { audit } from "./db";
import { bringForward } from "./accrual";

// ── The export file ─────────────────────────────────────────────────────────

export interface DeputyExport {
  source: "deputy";
  version: 1;
  exportedAt: string;
  /** Deputy's business timezone: every time in the file is wall-clock time here. */
  timezone: string;
  locations: { name: string; areas: string[] }[];
  leaveRules: { id: number; name: string; paid: boolean }[];
  people: DeputyPerson[];
  shifts: DeputyShift[];
  leave: DeputyLeave[];
}
export interface DeputyPerson {
  deputyId: number; name: string; email: string; location: string | null; startDate: string | null;
  /** Deputy day 1 = Monday … 7 = Sunday. Null when Deputy has no regular hours for them. */
  regular: { day: number; start: string; end: string; breakStart: string | null; breakEnd: string | null; breakMinutes: number; area: string | null }[] | null;
  balances: { ruleId: number; hours: number }[];
}
export interface DeputyShift { id: number; emp: number | null; date: string; start: string; end: string; breakMinutes: number; area: string | null; location: string | null; published: boolean }
export interface DeputyLeave { id: number; emp: number; ruleId: number | null; start: string; end: string; days: number; hours: number; status: "approved" | "pending" }

/** Deputy shows balances in hours; the office keeps days. Deputy's own standard day is 8h ("1 standard day is 8h 0m"). */
const HOURS_PER_DAY = 8;

/** Deputy leave rule → office leave type. Anything not here is reported and skipped. */
export function leaveCodeFor(ruleName: string): string | null {
  const n = ruleName.toLowerCase();
  if (n === "standard pto") return "vacation";
  if (n.startsWith("national holiday")) return "holiday";
  if (n.startsWith("sick")) return "sick";
  if (n.startsWith("unpaid")) return "unpaid";
  return null;
}

/** Deputy's leave policies per person: days per year by office leave type, 0 when they aren't on it. */
export interface LeavePolicyFile {
  source: "deputy-leave-policy"; version: 1; readAt: string;
  people: { email: string; name: string; entitlements: Record<string, number> }[];
}

export function parseLeavePolicy(body: unknown): LeavePolicyFile {
  const x = (typeof body === "string" ? JSON.parse(body) : body) as LeavePolicyFile;
  if (!x || typeof x !== "object" || x.source !== "deputy-leave-policy" || x.version !== 1) throw new Error("that isn't a Deputy leave-policy file (expected source \"deputy-leave-policy\", version 1)");
  if (!Array.isArray(x.people) || !x.people.length) throw new Error("the file has no people");
  for (const p of x.people) {
    if (typeof p.email !== "string" || !p.email.includes("@")) throw new Error(`a person has no email (${p.name ?? "?"})`);
    for (const [code, days] of Object.entries(p.entitlements ?? {})) {
      if (!["vacation", "holiday"].includes(code)) throw new Error(`${p.name}: unknown leave type ${code}`);
      if (typeof days !== "number" || days < 0 || days > 60) throw new Error(`${p.name}: ${code} must be 0–60 days a year`);
    }
  }
  return x;
}

/** Throws with a readable message when the file isn't a Deputy export this code understands. */
export function parseExport(body: unknown): DeputyExport {
  const x = (typeof body === "string" ? JSON.parse(body) : body) as DeputyExport;
  if (!x || typeof x !== "object" || x.source !== "deputy" || x.version !== 1) throw new Error("that isn't a Deputy export (expected source \"deputy\", version 1)");
  if (!isTz(x.timezone)) throw new Error("the export has no valid Deputy timezone");
  for (const k of ["locations", "leaveRules", "people", "shifts", "leave"] as const) if (!Array.isArray(x[k])) throw new Error(`the export has no ${k} list`);
  if (x.people.length > 2000 || x.shifts.length > 20000) throw new Error("that export is far bigger than the team's Deputy — refusing it");
  // Check every row before anything is written: a bad one halfway through would leave a partial import.
  const badShift = x.shifts.find((s) => !Number.isInteger(s.id) || !isDate(s.date) || !isTime(s.start) || !isTime(s.end) || s.start === s.end);
  if (badShift) throw new Error(`shift ${badShift.id} has a bad date or time (${badShift.date} ${badShift.start}–${badShift.end}); times must be HH:MM`);
  const badLeave = x.leave.find((l) => !Number.isInteger(l.id) || !isDate(l.start) || !isDate(l.end) || l.end < l.start || !["approved", "pending"].includes(l.status));
  if (badLeave) throw new Error(`leave request ${badLeave.id} has bad dates or status`);
  const badPerson = x.people.find((p) => (p.startDate != null && !isDate(p.startDate)) || (p.regular != null && !Array.isArray(p.regular)));
  if (badPerson) throw new Error(`${badPerson.name}'s start date or regular week isn't valid`);
  return x;
}

/**
 * A Deputy regular week (in Deputy's timezone) as regular hours in the
 * person's own timezone. Converted at the offsets of `refDate`'s week, so a
 * timezone pair with different daylight-saving dates drifts by an hour across
 * the change — the preview says so.
 */
export function toRegularHours(days: NonNullable<DeputyPerson["regular"]>, fromTz: string, toTz: string, refDate: string): { hours: RegularDay[]; notes: string[] } {
  const notes: string[] = [];
  const monday = weekStart(refDate);
  const at = (date: string, t: string) => zonedTime(date, t, fromTz);
  const hhmm = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: toTz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
  const byDow = new Map<number, RegularDay>();
  // Group by Deputy day: a split day is one stretch (below).
  const merged = new Map<number, typeof days>();
  for (const d of days) merged.set(d.day, [...(merged.get(d.day) ?? []), d]);
  for (const [day, list] of merged) {
    if (day < 1 || day > 7) { notes.push(`skipped an unknown Deputy day ${day}`); continue; }
    const date = addDays(monday, day - 1);
    const first = list[0];
    const last = list[list.length - 1];
    if (!isTime(first.start) || !isTime(last.end)) { notes.push(`skipped a ${dayWord(day)} with odd times`); continue; }
    // Shifts on one day (Deputy lists them in order) are one stretch: 17:00–20:00 + 21:00–02:00
    // is 17:00–02:00 with the hour between as the break.
    const s = at(date, first.start);
    let e = at(date, last.end);
    if (e <= s) e = at(addDays(date, 1), last.end); // runs past midnight
    const dow = new Date(Date.parse(localDate(s, toTz) + "T00:00:00Z")).getUTCDay();
    const r: RegularDay = { dow, start: hhmm(s), end: hhmm(e) };
    const inner = list.reduce((sum, x) => sum + (x.breakMinutes || 0), 0);
    const gaps = list.slice(1).reduce((sum, x, i) => sum + clockGap(list[i].end, x.start), 0);
    const breakMinutes = inner + gaps;
    if (list.length === 2 && !inner && gaps > 0) {
      r.break_start = hhmm(at(date, list[0].end) < s ? at(addDays(date, 1), list[0].end) : at(date, list[0].end));
      r.break_end = hhmm(at(date, list[1].start) < s ? at(addDays(date, 1), list[1].start) : at(date, list[1].start));
    } else if (list.length === 1 && first.breakStart && first.breakEnd && isTime(first.breakStart) && isTime(first.breakEnd)) {
      let bs = at(date, first.breakStart);
      if (bs < s) bs = at(addDays(date, 1), first.breakStart);
      let be = at(date, first.breakEnd);
      if (be <= bs) be = at(addDays(date, 1), first.breakEnd);
      r.break_start = hhmm(bs);
      r.break_end = hhmm(be);
    } else if (breakMinutes > 0) {
      r.break_minutes = breakMinutes;
    }
    if (byDow.has(dow)) { notes.push(`${dayWord(day)} lands on a day that's already set in their timezone — skipped`); continue; }
    byDow.set(dow, r);
  }
  const hours = [...byDow.values()].sort((a, b) => a.dow - b.dow);
  if (!isRegularHours(hours)) return { hours: [], notes: [...notes, "Deputy's hours didn't make a valid week — left empty"] };
  return { hours, notes };
}
/** Minutes from a to b on a clock (b at or before a runs past midnight). */
const clockGap = (a: string, b: string) => { const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); const d = m(b) - m(a); return d >= 0 ? d : d + 1440; };
const dayWord = (deputyDay: number) => ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][deputyDay] ?? `day ${deputyDay}`;

/**
 * Days of leave in a Deputy request. Deputy fills these in once a request is
 * decided; a pending one has none yet, so count their working days (by their
 * Deputy week, else Monday–Friday) the way the office does for a new request.
 */
export function leaveDays(l: DeputyLeave, p: DeputyPerson): number {
  if (l.days > 0) return l.days;
  if (l.hours > 0) return Math.round((l.hours / HOURS_PER_DAY) * 100) / 100;
  if (l.status !== "pending") return 0; // decided with nothing taken: nothing to bring over
  if (!isDate(l.start) || !isDate(l.end)) return 0;
  const workDays = p.regular?.length ? [...new Set(p.regular.map((d) => d.day % 7))] : MON_FRI;
  return workingDays(l.start, l.end, workDays);
}

// ── Tables ──────────────────────────────────────────────────────────────────

export async function migrateDeputy() {
  for (const sql of [
    // One row per Deputy person, by email: what to apply, and whether it has been.
    `CREATE TABLE IF NOT EXISTS deputy_import (
      email TEXT PRIMARY KEY,
      deputy_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      payload JSONB NOT NULL,
      exported_at TIMESTAMPTZ,
      imported_by INTEGER,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      user_id INTEGER REFERENCES users(id),
      applied_at TIMESTAMPTZ,
      hours_applied_at TIMESTAMPTZ
    )`,
    // Rows that came from Deputy carry its id, so a re-import updates instead of duplicating.
    `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS external_id TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS shifts_external_id ON shifts (external_id) WHERE external_id IS NOT NULL`,
    // When Deputy last wrote the shift. A claim or swap in the office after that (updated_at later) wins over a re-import.
    `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS deputy_synced_at TIMESTAMPTZ`,
    `ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS external_id TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS leave_requests_external_id ON leave_requests (external_id) WHERE external_id IS NOT NULL`,
    // Deputy's "National Holiday PTO": paid, with its own balance (most of the team has one).
    `INSERT INTO leave_types (code, name, paid, has_balance) VALUES ('holiday', 'National holiday', TRUE, TRUE) ON CONFLICT (code) DO NOTHING`,
  ]) await q(sql);
}

// ── Preview ─────────────────────────────────────────────────────────────────

export interface PreviewRow {
  deputyId: number; name: string; email: string; location: string | null; startDate: string | null;
  userId: number | null; matchedBy: "email" | "name" | null;
  /** In the office now, or applied on their first sign-in. */
  status: "ready" | "waits-for-sign-in" | "skipped";
  timezone: string | null;
  regular: RegularDay[] | null; regularNote: string | null;
  balances: { code: string; days: number }[];
  shifts: number; leave: number;
  changes: string[]; notes: string[]; problems: string[];
}

const normName = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

/** Their timezone if the office knows it (their pay profile's, else what their browser reported) — never a guess. Same order as tzOf. */
async function knownTz(userId: number): Promise<string | null> {
  const r = await one<{ tz: string | null; profile_tz: string | null }>(
    `SELECT u.tz, (SELECT p.timezone FROM pay_profiles p WHERE p.user_id = u.id OR p.email = lower(u.email) ORDER BY p.effective_from DESC, p.id DESC LIMIT 1) AS profile_tz
       FROM users u WHERE u.id = $1`, [userId],
  ).catch(() => one<{ tz: string | null; profile_tz: string | null }>(`SELECT tz, NULL AS profile_tz FROM users WHERE id = $1`, [userId]));
  return isTz(r?.profile_tz) ? r!.profile_tz : isTz(r?.tz) ? r!.tz : null;
}

export async function previewDeputy(x: DeputyExport, today: string): Promise<{ rows: PreviewRow[]; openShifts: number; skippedLeaveTypes: string[]; locations: string[] }> {
  const users = await q<{ id: number; email: string; name: string; removed: boolean }>(`SELECT id, email, name, removed FROM users`);
  const rules = new Map(x.leaveRules.map((r) => [r.id, r]));
  const skippedLeaveTypes = new Set<string>();
  const seen = new Set<string>();
  const rows: PreviewRow[] = [];
  for (const p of x.people) {
    const problems: string[] = [];
    const notes: string[] = [];
    const changes: string[] = [];
    const email = String(p.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push("no valid email in Deputy");
    if (seen.has(email)) problems.push("email appears twice in the export");
    seen.add(email);
    if (p.startDate && !isDate(p.startDate)) problems.push(`start date "${p.startDate}" isn't a date`);
    let user = users.find((u) => u.email.toLowerCase() === email) ?? null;
    let matchedBy: PreviewRow["matchedBy"] = user ? "email" : null;
    if (!user) {
      const byName = users.filter((u) => normName(u.name) === normName(p.name));
      if (byName.length === 1) { user = byName[0]; matchedBy = "name"; notes.push(`matched by name: the office has them as ${byName[0].email}`); }
    }
    if (user?.removed) { problems.push("their office account is removed"); }
    const balances: PreviewRow["balances"] = [];
    for (const b of p.balances ?? []) {
      const rule = rules.get(b.ruleId);
      const code = rule ? leaveCodeFor(rule.name) : null;
      if (!code) { if (b.hours) skippedLeaveTypes.add(rule?.name ?? `rule ${b.ruleId}`); continue; }
      balances.push({ code, days: Math.round((b.hours / HOURS_PER_DAY) * 100) / 100 });
    }
    const myShifts = x.shifts.filter((s) => s.emp === p.deputyId && s.date >= today);
    const myLeave = x.leave.filter((l) => l.emp === p.deputyId && l.ruleId != null && leaveCodeFor(rules.get(l.ruleId)?.name ?? "") && leaveDays(l, p) > 0);
    for (const l of x.leave.filter((l) => l.emp === p.deputyId && !myLeave.includes(l) && leaveDays(l, p) > 0)) skippedLeaveTypes.add(rules.get(l.ruleId ?? -1)?.name ?? "leave with no type");

    let regular: RegularDay[] | null = null;
    let regularNote: string | null = null;
    let tz: string | null = null;
    if (user) {
      tz = await knownTz(user.id);
      const cur = await one<{ team: string | null; start_date: string | null; regular_hours: unknown }>(`SELECT team, start_date::text AS start_date, regular_hours FROM time_members WHERE user_id = $1`, [user.id]);
      if (cur?.team && p.location && cur.team !== p.location) changes.push(`location ${cur.team} → ${p.location}`);
      if (cur?.start_date && p.startDate && cur.start_date !== p.startDate) changes.push(`start date ${cur.start_date} → ${p.startDate}`);
      if (cur && Array.isArray(cur.regular_hours) && cur.regular_hours.length && p.regular) changes.push("replaces the regular week already set in the office");
    }
    if (p.regular?.length) {
      if (tz) {
        const conv = toRegularHours(p.regular, x.timezone, tz, today);
        regular = conv.hours;
        notes.push(...conv.notes);
      } else {
        regularNote = "regular week waits until the office knows their timezone (their first visit sets it)";
      }
    } else {
      regularNote = "no regular hours in Deputy";
    }
    rows.push({
      deputyId: p.deputyId, name: p.name, email, location: p.location, startDate: p.startDate,
      userId: user?.id ?? null, matchedBy,
      status: problems.length ? "skipped" : user ? "ready" : "waits-for-sign-in",
      timezone: tz, regular, regularNote, balances, shifts: myShifts.length, leave: myLeave.length, changes, notes, problems,
    });
  }
  const locations = [...new Set([...x.people.map((p) => p.location), ...x.shifts.map((s) => s.location)].filter((l): l is string => Boolean(l)))].sort();
  return { rows, openShifts: x.shifts.filter((s) => s.emp == null && s.date >= today).length, skippedLeaveTypes: [...skippedLeaveTypes].sort(), locations };
}

// ── Commit and apply ────────────────────────────────────────────────────────

interface Payload {
  timezone: string; location: string | null; startDate: string | null;
  regular: DeputyPerson["regular"];
  balances: { code: string; days: number }[];
  shifts: (DeputyShift & { timezone: string })[];
  leave: (DeputyLeave & { code: string })[];
}

export async function commitDeputy(x: DeputyExport, actor: number, today: string) {
  const preview = await previewDeputy(x, today);
  const rules = new Map(x.leaveRules.map((r) => [r.id, r]));
  const areas = new Map(x.locations.map((l) => [l.name, l.areas]));
  for (const name of preview.locations) {
    const description = areas.get(name)?.length ? `From Deputy. Areas: ${areas.get(name)!.join(", ")}` : "From Deputy";
    const r = await one(`INSERT INTO locations (name, description) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING name`, [name, description]);
    if (r) await audit(actor, "import", "location", name, null, { name, description, source: "deputy" });
  }
  // Open shifts belong to nobody yet: they go straight in.
  for (const s of x.shifts.filter((s) => s.emp == null && s.date >= today && s.location)) await upsertShift(s, null, x.timezone);
  await pruneShifts(x, today);
  let staged = 0;
  for (const row of preview.rows) {
    if (row.status === "skipped") continue;
    const p = x.people.find((pp) => pp.deputyId === row.deputyId)!;
    const payload: Payload = {
      timezone: x.timezone, location: p.location, startDate: p.startDate, regular: p.regular, balances: row.balances,
      shifts: x.shifts.filter((s) => s.emp === p.deputyId && s.date >= today && s.location).map((s) => ({ ...s, timezone: x.timezone })),
      leave: x.leave.filter((l) => l.emp === p.deputyId).flatMap((l) => {
        const code = l.ruleId != null ? leaveCodeFor(rules.get(l.ruleId)?.name ?? "") : null;
        const days = leaveDays(l, p);
        return code && days > 0 ? [{ ...l, code, days }] : [];
      }),
    };
    // A newer export replaces the old one and is applied again.
    await q(
      `INSERT INTO deputy_import (email, deputy_id, name, payload, exported_at, imported_by, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (email) DO UPDATE SET deputy_id = $2, name = $3, payload = $4, exported_at = $5, imported_by = $6, imported_at = now(),
         user_id = COALESCE($7, deputy_import.user_id), applied_at = NULL, hours_applied_at = NULL`,
      [row.email, row.deputyId, row.name, JSON.stringify(payload), x.exportedAt, actor, row.userId],
    );
    staged++;
  }
  await audit(actor, "import", "deputy", x.exportedAt, null, { people: staged, exportedAt: x.exportedAt });
  const applied = await applyPendingDeputy(actor);
  return { staged, applied };
}

/** A Deputy shift removed since the last import goes from the office too — unless the office has changed it since. */
async function pruneShifts(x: DeputyExport, today: string) {
  const keep = x.shifts.map((s) => `deputy:${s.id}`);
  await q(
    `DELETE FROM shifts WHERE external_id LIKE 'deputy:%' AND date >= $1 AND NOT (external_id = ANY($2::text[]))
       AND NOT EXISTS (SELECT 1 FROM swap_requests r WHERE r.shift_id = shifts.id)
       AND (deputy_synced_at IS NULL OR updated_at <= deputy_synced_at)`,
    [today, keep],
  );
}

async function upsertShift(s: DeputyShift, userId: number | null, tz: string) {
  const note = [s.area, s.breakMinutes ? `${s.breakMinutes} min break` : null].filter(Boolean).join(" · ") || null;
  await q(
    `INSERT INTO shifts (user_id, team, date, start_local, end_local, timezone, note, published_at, external_id, updated_at, deputy_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN now() END, $9, now(), now())
     ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET user_id = $1, team = $2, date = $3, start_local = $4, end_local = $5,
       timezone = $6, note = $7, published_at = CASE WHEN $8 THEN COALESCE(shifts.published_at, now()) END, updated_at = now(), deputy_synced_at = now()
     -- Claimed or swapped in the office since Deputy last wrote it: the office's version stays.
     WHERE shifts.deputy_synced_at IS NULL OR shifts.updated_at <= shifts.deputy_synced_at`,
    [userId, s.location, s.date, s.start, s.end, tz, note, s.published, `deputy:${s.id}`],
  );
}

/** Apply whatever is waiting for people who now have an office account. Safe to call any time. */
export async function applyPendingDeputy(actor: number | null = null, onlyUserId?: number): Promise<number> {
  // Link rows to accounts that have appeared since the import.
  await q(`UPDATE deputy_import d SET user_id = u.id FROM users u WHERE d.user_id IS NULL AND lower(u.email) = d.email`);
  const rows = await q<{ email: string; user_id: number; payload: Payload; applied_at: string | null; hours_applied_at: string | null }>(
    `SELECT email, user_id, payload, applied_at, hours_applied_at FROM deputy_import
      WHERE user_id IS NOT NULL AND (applied_at IS NULL OR hours_applied_at IS NULL) ${onlyUserId ? "AND user_id = $1" : ""}`,
    onlyUserId ? [onlyUserId] : [],
  );
  let n = 0;
  for (const r of rows) {
    // One person's bad data must not block everyone after them on every sweep.
    try {
      if (!r.applied_at) { await applyPerson(r.user_id, r.payload, actor); n++; }
      if (!r.hours_applied_at) await applyHours(r.user_id, r.payload, actor);
      await q(`UPDATE deputy_import SET applied_at = COALESCE(applied_at, now()) WHERE email = $1`, [r.email]);
    } catch (e) {
      console.error(`deputy apply ${r.email}:`, (e as Error).message);
    }
  }
  if (!onlyUserId || n) await recordDeputyPublications();
  return n;
}

/**
 * Shifts published in Deputy are already visible in the office, so record that as the
 * week's publication. Otherwise the schedule says "not published", and the first
 * "Publish week" re-DMs everyone and publishes Deputy's drafts with it. Once a
 * manager has published a week in the office, their publication stands.
 */
export async function recordDeputyPublications(today = localDate(Date.now(), "UTC")) {
  const weeks = await q<{ team: string; date: string }>(
    `SELECT DISTINCT team, date::text AS date FROM shifts
      WHERE external_id LIKE 'deputy:%' AND published_at IS NOT NULL AND date >= $1`,
    [weekStart(today)],
  );
  const seen = new Set<string>();
  for (const w of weeks) {
    const ws = weekStart(w.date);
    if (seen.has(`${w.team}|${ws}`)) continue;
    seen.add(`${w.team}|${ws}`);
    const snap = JSON.stringify(await q(
      `SELECT id, user_id, date::text AS date, start_local, end_local, timezone FROM shifts
        WHERE team = $1 AND date BETWEEN $2 AND $3 AND published_at IS NOT NULL ORDER BY date, start_local, id`,
      [w.team, ws, addDays(ws, 6)],
    ));
    const last = await one<{ published_by: number | null; same: boolean }>(
      `SELECT published_by, snapshot = $3::jsonb AS same FROM shift_publications WHERE team = $1 AND week_start = $2 ORDER BY id DESC LIMIT 1`,
      [w.team, ws, snap]);
    if (last && (last.published_by != null || last.same)) continue;
    await q(`INSERT INTO shift_publications (team, week_start, published_by, snapshot) VALUES ($1, $2, NULL, $3)`, [w.team, ws, snap]);
  }
}

async function applyPerson(userId: number, p: Payload, actor: number | null) {
  const before = await one(`SELECT team, start_date::text AS start_date FROM time_members WHERE user_id = $1`, [userId]);
  if (p.location) {
    await q(`INSERT INTO locations (name, description) VALUES ($1, 'From Deputy') ON CONFLICT (name) DO NOTHING`, [p.location]);
    await q(
      `INSERT INTO time_members (user_id, team, start_date) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET team = $2, start_date = COALESCE($3, time_members.start_date)`,
      [userId, p.location, p.startDate],
    );
  }
  const beforeBal = await q(`SELECT code, days::float AS days FROM leave_balances WHERE user_id = $1`, [userId]);
  // Once a manager has decided leave in the office, the office's balance is the running one: a
  // re-import would wipe that deduction. Until then, Deputy's figure is the truth.
  const spaceDecided = new Set((await q<{ code: string }>(`SELECT DISTINCT code FROM leave_requests WHERE user_id = $1 AND decided_by IS NOT NULL`, [userId])).map((r) => r.code));
  // The balance is Deputy's as of the export; releases the office posted since then are added back.
  const exportedAt = (await one<{ exported_at: string | null }>(`SELECT exported_at::text AS exported_at FROM deputy_import WHERE user_id = $1`, [userId]))?.exported_at ?? null;
  for (const b of p.balances) {
    if (spaceDecided.has(b.code)) continue;
    const days = await bringForward(userId, b.code, b.days, exportedAt);
    await q(`INSERT INTO leave_balances (user_id, code, days) VALUES ($1, $2, $3) ON CONFLICT (user_id, code) DO UPDATE SET days = $3`, [userId, b.code, days]);
  }
  for (const s of p.shifts) await upsertShift(s, userId, s.timezone);
  for (const l of p.leave) {
    const days = l.days;
    // Leave already decided in the office stays as the office decided it.
    await q(
      `INSERT INTO leave_requests (user_id, code, start_date, end_date, days, status, decided_at, note, external_id)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'approved' THEN now() END, 'From Deputy', $7)
       ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET code = $2, start_date = $3, end_date = $4, days = $5, status = $6
       WHERE leave_requests.decided_by IS NULL`,
      [userId, l.code, l.start, l.end, days, l.status, `deputy:${l.id}`],
    );
  }
  await audit(actor ?? userId, "import", "profile", userId,
    { ...(before ?? {}), balances: beforeBal },
    { team: p.location, start_date: p.startDate, balances: p.balances, shifts: p.shifts.length, leave: p.leave.length, source: "deputy" },
    actor ? null : "applied on first sign-in");
}

async function applyHours(userId: number, p: Payload, actor: number | null) {
  if (!p.regular?.length) { await q(`UPDATE deputy_import SET hours_applied_at = now() WHERE user_id = $1`, [userId]); return; }
  const tz = await knownTz(userId);
  if (!tz) return; // waits: their first visit to the office sets their timezone
  if (!(await one(`SELECT 1 FROM time_members WHERE user_id = $1`, [userId]))) return; // needs a location first
  const { hours } = toRegularHours(p.regular, p.timezone, tz, localDate(Date.now(), tz));
  if (hours.length) {
    const before = await one(`SELECT regular_hours, work_days FROM time_members WHERE user_id = $1`, [userId]);
    const workDays = [...new Set(hours.map((h) => h.dow))].sort((a, b) => a - b);
    await q(`UPDATE time_members SET regular_hours = $2, work_days = $3 WHERE user_id = $1`, [userId, JSON.stringify(hours), workDays]);
    await audit(actor ?? userId, "import", "profile", userId, before, { regular_hours: hours, work_days: workDays, timezone: tz, source: "deputy" });
  }
  await q(`UPDATE deputy_import SET hours_applied_at = now() WHERE user_id = $1`, [userId]);
}

// ── Routes ──────────────────────────────────────────────────────────────────

type Member = (req: FastifyRequest, reply: FastifyReply) => { id: number } | null;

export function registerDeputyRoutes(app: FastifyInstance, member: Member) {
  /** Payroll admins and all-team managers: it moves everyone's location, schedule and balances. */
  const allTeams = async (req: FastifyRequest, reply: FastifyReply) => {
    const u = member(req, reply);
    if (!u) return null;
    if (!(await managedTeams(u.id)).includes("*")) { reply.code(403).send({ error: "only payroll admins (or all-team managers) can import from Deputy" }); return null; }
    return u;
  };

  app.post("/api/time/deputy/import", { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const u = await allTeams(req, reply);
    if (!u) return;
    let x: DeputyExport;
    try { x = parseExport(req.body); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    const today = localDate(Date.now(), x.timezone);
    const preview = await previewDeputy(x, today);
    const summary = {
      people: preview.rows.length,
      ready: preview.rows.filter((r) => r.status === "ready").length,
      waiting: preview.rows.filter((r) => r.status === "waits-for-sign-in").length,
      skipped: preview.rows.filter((r) => r.status === "skipped").length,
      shifts: x.shifts.filter((s) => s.date >= today).length,
      openShifts: preview.openShifts,
      leave: preview.rows.reduce((n, r) => n + r.leave, 0),
    };
    if ((req.query as { commit?: string }).commit !== "1") return { preview: true, exportedAt: x.exportedAt, summary, ...preview };
    const done = await commitDeputy(x, u.id, today);
    return { preview: false, exportedAt: x.exportedAt, summary, ...preview, ...done };
  });

  /**
   * Leave entitlements from Deputy's leave policies: who is on Standard PTO and
   * National Holiday PTO, as days per year (0 = not on that policy). The file is
   * read from a logged-in Deputy tab, per person per rule. Preview first, like the import.
   */
  app.post("/api/time/deputy/leave-policy", { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const u = await allTeams(req, reply);
    if (!u) return;
    let x: LeavePolicyFile;
    try { x = parseLeavePolicy(req.body); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    const rows = [];
    for (const p of x.people) {
      const user = await one<{ id: number }>(`SELECT id FROM users WHERE lower(email) = lower($1) AND NOT removed`, [p.email]);
      const before = user ? Object.fromEntries((await q<{ code: string; days: number }>(`SELECT code, days_per_year::float AS days FROM leave_entitlements WHERE user_id = $1`, [user.id])).map((r) => [r.code, r.days])) : {};
      rows.push({ name: p.name, email: p.email, userId: user?.id ?? null, before, after: p.entitlements });
    }
    if ((req.query as { commit?: string }).commit !== "1") return { preview: true, readAt: x.readAt, rows };
    let set = 0;
    for (const r of rows) {
      if (!r.userId) continue;
      for (const [code, days] of Object.entries(r.after)) {
        if (r.before[code] === days) continue;
        await q(`INSERT INTO leave_entitlements (user_id, code, days_per_year) VALUES ($1, $2, $3) ON CONFLICT (user_id, code) DO UPDATE SET days_per_year = $3`, [r.userId, code, days]);
        set++;
      }
      await audit(u.id, "update", "leave_entitlements", r.userId, r.before, r.after, `Deputy leave policy as of ${x.readAt}`);
    }
    return { preview: false, readAt: x.readAt, rows, set, notInSpace: rows.filter((r) => !r.userId).map((r) => r.name) };
  });

  /**
   * Add everyone imported from Deputy who has no office account yet, instead of
   * waiting for their first sign-in. Each goes through the same first-sign-in
   * setup (desk, Slack photo and title, pre-assigned access, their Deputy data).
   * Their regular week still waits for their real timezone (first visit): Slack's
   * is often left on its US default, which would put the hours on the wrong clock.
   * Shared logins ("Admin Account Admin") aren't people: left out.
   */
  app.post("/api/time/deputy/add-people", async (req, reply) => {
    const u = await allTeams(req, reply);
    if (!u) return;
    const { upsertUser, domainAllowed } = await import("../auth");
    const rows = await q<{ email: string; name: string }>(`SELECT email, name FROM deputy_import WHERE user_id IS NULL AND NOT EXISTS (SELECT 1 FROM users x WHERE lower(x.email) = deputy_import.email) ORDER BY name`);
    const added: string[] = [];
    const left: { name: string; email: string; why: string }[] = [];
    for (const r of rows) {
      if (/\badmin\b/i.test(r.name)) { left.push({ ...r, why: "a shared admin login, not a person" }); continue; }
      if (!domainAllowed(r.email)) { left.push({ ...r, why: "email isn't on an allowed domain" }); continue; }
      const user = await upsertUser(r.email, r.name);
      await audit(u.id, "create", "user", user.id, null, { email: r.email, name: r.name, source: "deputy" });
      added.push(r.name);
    }
    await applyPendingDeputy(u.id);
    const noTz = await q<{ name: string }>(`SELECT name FROM deputy_import WHERE user_id IS NOT NULL AND hours_applied_at IS NULL ORDER BY name`);
    return { added: added.length, left, waitingForTimezone: noTz.map((r) => r.name) };
  });

  /** What's still waiting: people who haven't signed in, or whose timezone the office doesn't know yet. */
  app.get("/api/time/deputy/status", async (req, reply) => {
    if (!(await allTeams(req, reply))) return;
    const last = await one<{ exported_at: string | null; imported_at: string }>(`SELECT exported_at, imported_at FROM deputy_import ORDER BY imported_at DESC LIMIT 1`);
    const waiting = await q<{ email: string; name: string; why: string }>(
      `SELECT email, name, CASE WHEN user_id IS NULL THEN 'not signed in yet' ELSE 'timezone not known yet' END AS why
         FROM deputy_import WHERE applied_at IS NULL OR hours_applied_at IS NULL ORDER BY name`,
    );
    return { last, waiting };
  });
}
