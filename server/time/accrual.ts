// Leave accrual: a yearly entitlement is earned the way the team's Deputy policies
// earn it (read from Deputy's leave settings, 2026-10-16), so the two-month
// parallel run reconciles balance for balance:
//
//   monthly — Standard PTO: a twelfth of the year is released every month on the
//             person's hire-date day (the 31st falls back to the month's last day),
//             in advance, from their hire date on. Everything rolls over. Each month
//             releases what the year has reached by then less what it had reached the
//             month before, both to the cent of a day, so 12 releases are the year
//             exactly (10 a year: 0.83, 0.84, 0.83 … = 10, never 12 × 0.83 = 9.96).
//   yearly  — National Holiday PTO: the whole year is released on Jan 1 and the
//             balance resets to it (last year's leftover, or overdraw, is gone), less
//             any leave in the new year already approved (and so already taken
//             from the old balance): approving January in December must not
//             hand those days back on Jan 1.
//             Someone who joins mid-year gets the rest of the year, prorated by day.
//
// Releases happen on dates in Deputy's business timezone. Each release is written
// to leave_accruals once (keyed by its date), so a restart or a second server never
// pays it twice. And at most one per period (a month for monthly, a year for yearly):
// a corrected hire date moves the release day, and must not pay a month again. A person's releases start after the Deputy snapshot their balance
// came from: Deputy already paid everything up to the moment it was exported. For
// someone with no Deputy snapshot, releases start with the month accrual was
// switched on.

import { one, q } from "../db";
import { addDays, localDate, workingDays } from "../../shared/time";
import { workDaysOf } from "./hours";

/** Deputy's business timezone: its releases happen just after midnight here. */
const BUSINESS_TZ = "America/Los_Angeles";

export type AccrualKind = "monthly" | "yearly";

export async function migrateAccrual() {
  for (const sql of [
    // `month` is the release date (it held the first of the month before releases followed Deputy's dates).
    `CREATE TABLE IF NOT EXISTS leave_accruals (
      user_id INTEGER NOT NULL REFERENCES users(id),
      code TEXT NOT NULL REFERENCES leave_types(code),
      month DATE NOT NULL,
      days NUMERIC NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, code, month)
    )`,
    `ALTER TABLE leave_accruals ADD COLUMN IF NOT EXISTS reset BOOLEAN NOT NULL DEFAULT FALSE`,
    `CREATE TABLE IF NOT EXISTS leave_accrual_start (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), month DATE NOT NULL)`,
    // The first month that accrues is the one accrual was switched on in.
    `INSERT INTO leave_accrual_start (month) VALUES (date_trunc('month', now())::date) ON CONFLICT (id) DO NOTHING`,
    `ALTER TABLE leave_types ADD COLUMN IF NOT EXISTS accrual TEXT CHECK (accrual IN ('monthly', 'yearly'))`,
    `UPDATE leave_types SET accrual = 'yearly' WHERE code = 'holiday' AND accrual IS NULL`,
    `UPDATE leave_types SET accrual = 'monthly' WHERE has_balance AND accrual IS NULL`,
  ]) await q(sql);
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");

export interface Release { date: string; days: number; reset: boolean }

/**
 * Every release for one person and leave type dated after `after` and on or before
 * `today`, oldest first. `startDate` is their hire date (null: the 1st of each month,
 * and no proration).
 */
export function releasesFor(kind: AccrualKind, daysPerYear: number, startDate: string | null, after: string, today: string): Release[] {
  const out: Release[] = [];
  if (daysPerYear <= 0 || today <= after) return out;
  const from = startDate && startDate > after ? addDays(startDate, -1) : after;
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = today.split("-").map(Number);
  if (kind === "monthly") {
    const day = startDate ? Number(startDate.slice(8, 10)) : 1;
    for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, m = 1) : m++) {
      const date = `${y}-${pad(m)}-${pad(Math.min(day, daysIn(y, m)))}`;
      if (date > from && date <= today) out.push({ date, days: monthlyRelease(daysPerYear, m), reset: false });
    }
  } else {
    // The year they joined in: the rest of it, from the hire date.
    if (startDate && startDate > from && startDate <= today && startDate.slice(5) !== "01-01") {
      const y = Number(startDate.slice(0, 4));
      const len = (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / 86400_000;
      const left = (Date.UTC(y + 1, 0, 1) - Date.parse(`${startDate}T00:00:00Z`)) / 86400_000;
      out.push({ date: startDate, days: Math.round(daysPerYear * (left / len) * 100) / 100, reset: false });
    }
    for (let y = fy + 1; y <= ty; y++) {
      const date = `${y}-01-01`;
      if (date > from && date <= today) out.push({ date, days: daysPerYear, reset: true });
    }
  }
  return out;
}

export interface TakenLeave { start_date: string; end_date: string; days: number }

/**
 * Days of already-approved leave that fall from `from` to `to` (a reset's year), by
 * their working days: a request over New Year counts only its days in the new year.
 */
export function takenBetween(from: string, to: string, requests: TakenLeave[], workDays?: number[]): number {
  let n = 0;
  for (const r of requests) {
    if (r.end_date < from || r.start_date > to) continue;
    if (r.start_date >= from && r.end_date <= to) { n += Number(r.days); continue; }
    const all = workingDays(r.start_date, r.end_date, workDays);
    const inside = workingDays(r.start_date > from ? r.start_date : from, r.end_date < to ? r.end_date : to, workDays);
    if (all) n += (Number(r.days) * inside) / all;
  }
  return Math.round(n * 100) / 100;
}

/** Hundredths of a day the year has released by the end of month `m` (1–12). */
const reachedBy = (daysPerYear: number, m: number) => Math.round((daysPerYear * 100 * m) / 12);

/** What month `m` (1–12) of the calendar year releases: cumulative to date, less the month before. Any 12 in a row sum to the year. */
export const monthlyRelease = (daysPerYear: number, m: number) => (reachedBy(daysPerYear, m) - reachedBy(daysPerYear, m - 1)) / 100;

/** The period a release pays for: one per month (monthly) or per year (yearly). */
export const periodOf = (kind: AccrualKind, date: string) => (kind === "monthly" ? date.slice(0, 7) : date.slice(0, 4));

/** Releases whose period hasn't been paid yet (`posted`: dates already in the ledger). */
export function unpaidReleases(kind: AccrualKind, releases: Release[], posted: string[]): Release[] {
  const paid = new Set(posted.map((d) => periodOf(kind, d)));
  return releases.filter((r) => {
    const p = periodOf(kind, r.date);
    if (paid.has(p)) return false;
    paid.add(p);
    return true;
  });
}

/** What "+n" a balance shows: per month for monthly types, per year for yearly ones. */
export function accrualNote(kind: AccrualKind | null, daysPerYear: number | null): { per_month: number | null; per_year: number | null } {
  if (!kind || !daysPerYear || daysPerYear <= 0) return { per_month: null, per_year: null };
  return kind === "monthly" ? { per_month: Math.round((daysPerYear / 12) * 100) / 100, per_year: null } : { per_month: null, per_year: daysPerYear };
}

/**
 * A Deputy balance as of its export, brought forward by the releases Space has
 * already posted since (applying a snapshot late mustn't wipe them). A reset since
 * the export makes the snapshot irrelevant: only what came after it counts.
 */
export async function bringForward(userId: number, code: string, snapshotDays: number, exportedAt: string | null): Promise<number> {
  if (!exportedAt) return snapshotDays;
  const after = localDate(Date.parse(exportedAt), BUSINESS_TZ);
  const rows = await q<{ days: number; reset: boolean }>(
    `SELECT days::float AS days, reset FROM leave_accruals WHERE user_id = $1 AND code = $2 AND month > $3 ORDER BY month`, [userId, code, after]);
  let days = snapshotDays;
  for (const r of rows) days = r.reset ? r.days : days + r.days;
  return Math.round(days * 100) / 100;
}

/** Post every release that's due and not posted yet. Safe to run any time. Returns rows written. */
export async function accrueLeave(today = localDate(Date.now(), BUSINESS_TZ)): Promise<number> {
  const start = (await one<{ month: string }>(`SELECT month::text AS month FROM leave_accrual_start`))?.month;
  if (!start) return 0;
  const rows = await q<{ user_id: number; code: string; kind: AccrualKind; days_per_year: number; start_date: string | null; exported_at: string | null }>(
    `SELECT e.user_id, e.code, t.accrual AS kind, e.days_per_year::float AS days_per_year, m.start_date::text AS start_date, d.exported_at::text AS exported_at
       FROM leave_entitlements e JOIN leave_types t ON t.code = e.code AND t.has_balance AND t.accrual IS NOT NULL
       JOIN users u ON u.id = e.user_id AND NOT u.removed
       LEFT JOIN time_members m ON m.user_id = e.user_id
       LEFT JOIN deputy_import d ON d.user_id = e.user_id
      WHERE e.days_per_year > 0`,
  );
  let n = 0;
  for (const r of rows) {
    const after = r.exported_at ? localDate(Date.parse(r.exported_at), BUSINESS_TZ) : addDays(start, -1);
    const due = releasesFor(r.kind, r.days_per_year, r.start_date, after, today);
    if (!due.length) continue;
    const posted = (await q<{ month: string }>(`SELECT month::text AS month FROM leave_accruals WHERE user_id = $1 AND code = $2 AND month >= $3`,
      [r.user_id, r.code, `${due[0].date.slice(0, 4)}-01-01`])).map((x) => x.month);
    for (const rel0 of unpaidReleases(r.kind, due, posted)) {
      // A reset starts the year less what's already approved in it: that came off last year's balance.
      let rel = rel0, taken = 0;
      if (rel0.reset) {
        const year = rel0.date.slice(0, 4);
        const leave = await q<TakenLeave>(
          `SELECT start_date::text AS start_date, end_date::text AS end_date, days::float AS days FROM leave_requests
            WHERE user_id = $1 AND code = $2 AND status = 'approved' AND end_date >= $3 AND start_date <= $4`,
          [r.user_id, r.code, rel0.date, `${year}-12-31`]);
        taken = leave.length ? takenBetween(rel0.date, `${year}-12-31`, leave, await workDaysOf(r.user_id)) : 0;
        rel = { ...rel0, days: Math.round((rel0.days - taken) * 100) / 100 };
      }
      // The ledger row and the balance move together, or not at all.
      const done = await q(
        `WITH ins AS (
           INSERT INTO leave_accruals (user_id, code, month, days, reset) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING RETURNING user_id
         )
         INSERT INTO leave_balances (user_id, code, days) SELECT $1, $2, $4 FROM ins
         ON CONFLICT (user_id, code) DO UPDATE SET days = CASE WHEN $5 THEN EXCLUDED.days ELSE leave_balances.days + EXCLUDED.days END
         RETURNING user_id`,
        [r.user_id, r.code, rel.date, rel.days, rel.reset],
      );
      if (done.length) {
        n++;
        await q(`INSERT INTO time_audit (actor, action, entity, entity_id, before, after, reason) VALUES (NULL, 'accrue', 'leave_balance', $1, NULL, $2, $3)`,
          [`${r.user_id}:${r.code}`, JSON.stringify({ on: rel.date, days: rel.days, reset: rel.reset, ...(taken ? { released: rel0.days, already_approved: taken } : {}) }),
            rel.reset ? (taken ? `yearly release (balance reset to ${rel0.days}, less ${taken} day(s) already approved this year)` : "yearly release (balance reset)") : r.kind === "monthly" ? "monthly release" : "yearly release (joined this year)"]);
      }
    }
  }
  return n;
}
