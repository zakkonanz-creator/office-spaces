// Hours from clock events, for timesheets, the team view and payroll.

import { one, q } from "../db";
import { addDays, approvedInRange, expectedMinutesOn, isRegularHours, isTz, isWorkDays, pickTz, MON_FRI, minutesByDay, pairEvents, weekStart, zonedTime, type ClockEvent, type Flag, type RegularDay } from "../../shared/time";

/**
 * Their timezone for time and pay: the one on their pay profile when it's set
 * (deliberate, and the same whichever device they're on), else `device` (the
 * browser in front of us, when the caller has it), else what a browser last
 * reported (users.tz), else UTC. A laptop set to the wrong zone, or a trip
 * abroad, must not move which day their hours fall on.
 */
export async function tzOf(userId: number, device?: string | null): Promise<string> {
  const r = await one<{ tz: string | null; profile_tz: string | null }>(
    `SELECT u.tz, (SELECT p.timezone FROM pay_profiles p WHERE p.user_id = u.id OR p.email = lower(u.email) ORDER BY p.effective_from DESC, p.id DESC LIMIT 1) AS profile_tz
       FROM users u WHERE u.id = $1`,
    [userId],
  ).catch(() => one<{ tz: string | null; profile_tz: string | null }>(`SELECT tz, NULL AS profile_tz FROM users WHERE id = $1`, [userId]));
  return pickTz(r?.profile_tz, device, r?.tz);
}

/**
 * The viewer's own zone, for what "this week" means on their screen: the
 * browser they're looking through (the x-timezone header every time page
 * sends), else their own tzOf. Monday morning in Manila is still Sunday in UTC.
 */
export async function viewerTz(userId: number, header: unknown): Promise<string> {
  return isTz(header) ? header : tzOf(userId);
}

/**
 * Live (non-voided) clock events for a person between two instants, padded on
 * both sides by a maximum shift so a shift crossing the window's edge (a
 * Sunday-night shift into Monday) still pairs instead of looking unclosed.
 * Callers keep only the days and flags inside their own window.
 */
export async function eventsBetween(userId: number, from: number, to: number) {
  const rows = await q<{ id: number; kind: ClockEvent["kind"]; at: Date | string; source: string; reason: string | null; created_by: number | null }>(
    `SELECT id, kind, at, source, reason, created_by FROM clock_events
      WHERE user_id = $1 AND voided_by IS NULL AND at >= $2 AND at < $3 ORDER BY at, id`,
    [userId, new Date(from - 17 * 3600_000).toISOString(), new Date(to + 17 * 3600_000).toISOString()],
  );
  return rows.map((r) => ({ ...r, at: new Date(r.at).getTime() }));
}

export interface DaySummary { date: string; minutes: number; events: { id: number; kind: string; at: string; source: string; reason: string | null }[] }

/** One person's week: minutes per local day, the events behind them, and anything a manager must fix. */
export async function weekSummary(userId: number, week: string, now = Date.now()) {
  const tz = await tzOf(userId);
  const start = weekStart(week);
  const from = zonedTime(start, "00:00", tz);
  const to = zonedTime(addDays(start, 7), "00:00", tz);
  const events = await eventsBetween(userId, from, to);
  const { sessions, flags } = pairEvents(events, now, tz);
  const byDay = minutesByDay(sessions, tz);
  const days: DaySummary[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const dayFrom = zonedTime(date, "00:00", tz), dayTo = zonedTime(addDays(date, 1), "00:00", tz);
    days.push({
      date,
      minutes: byDay[date] ?? 0,
      events: events.filter((e) => e.at >= dayFrom && e.at < dayTo).map((e) => ({ id: e.id, kind: e.kind, at: new Date(e.at).toISOString(), source: e.source, reason: e.reason })),
    });
  }
  const inWeek = (f: Flag) => f.at >= from && f.at < to;
  const total = days.reduce((s, d) => s + d.minutes, 0);
  const approval = await one<{ approved_by: number | null; approved_at: Date | null; minutes_worked: number }>(
    `SELECT approved_by, approved_at, minutes_worked FROM timesheet_weeks WHERE user_id = $1 AND week_start = $2`,
    [userId, start],
  );
  return {
    weekStart: start,
    timezone: tz,
    days,
    total,
    flags: flags.filter(inWeek),
    approved: Boolean(approval?.approved_at),
    approvedAt: approval?.approved_at ?? null,
    approvedMinutes: approval?.approved_at ? approval.minutes_worked : null,
  };
}

/** timesheet_weeks.minutes_by_day as stored (JSONB can come back as text): { date: minutes }, or null. */
const byDayOf = (raw: unknown): Record<string, number> | null => {
  let v = raw;
  if (typeof v === "string") try { v = JSON.parse(v); } catch { return null; }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : null;
};

/**
 * Minutes between two dates (inclusive, the person's local dates) in weeks a
 * manager approved, as approved — what payroll may pay hours on. `drift` lists
 * approved weeks whose clock events now add up differently (an edit next to the
 * week, a timezone change): pay doesn't move, but the run says so.
 */
export async function approvedHours(userId: number, fromDate: string, toDate: string) {
  // ::text: a DATE parsed into a JS Date shifts by the server's own timezone.
  const rows = await q<{ week_start: string; minutes_worked: number; minutes_by_day: unknown }>(
    `SELECT week_start::text AS week_start, minutes_worked, minutes_by_day FROM timesheet_weeks
      WHERE user_id = $1 AND approved_at IS NOT NULL AND week_start >= $2 AND week_start <= $3 ORDER BY week_start`,
    [userId, weekStart(fromDate), toDate],
  );
  if (!rows.length) return { minutes: 0, drift: [], legacy: [] };
  const tz = await tzOf(userId);
  // Live minutes over the whole weeks, to compare each with what was approved.
  const first = rows[0].week_start, last = addDays(rows[rows.length - 1].week_start, 7);
  const from = zonedTime(first, "00:00", tz), to = zonedTime(last, "00:00", tz);
  const live = minutesByDay(pairEvents(await eventsBetween(userId, from, to), Date.now(), tz).sessions, tz);
  return approvedInRange(rows.map((r) => ({ weekStart: r.week_start, minutes: Number(r.minutes_worked), byDay: byDayOf(r.minutes_by_day) })), live, fromDate, toDate);
}

/** Just the approved minutes (the hours export). */
export async function approvedMinutes(userId: number, fromDate: string, toDate: string): Promise<number> {
  return (await approvedHours(userId, fromDate, toDate)).minutes;
}

/** Someone's working-day pattern (0 = Sunday … 6), Monday–Friday if not set. */
export async function workDaysOf(userId: number): Promise<number[]> {
  const r = await one<{ work_days: number[] | null }>(`SELECT work_days FROM time_members WHERE user_id = $1`, [userId]);
  return isWorkDays(r?.work_days) ? r!.work_days! : MON_FRI;
}

/** Someone's regular week (Deputy's "regular work schedule"), or null if not set. */
export async function regularHoursOf(userId: number): Promise<RegularDay[] | null> {
  const r = await one<{ regular_hours: unknown }>(`SELECT regular_hours FROM time_members WHERE user_id = $1`, [userId]);
  return isRegularHours(r?.regular_hours) && (r!.regular_hours as RegularDay[]).length ? (r!.regular_hours as RegularDay[]) : null;
}

/**
 * Minutes someone is expected to work on each date: their regular hours (or an
 * 8-hour day on their working days), and nothing on a day of approved leave.
 */
export async function expectedByDay(userId: number, dates: string[]): Promise<Record<string, number>> {
  if (!dates.length) return {};
  const [regular, workDays] = await Promise.all([regularHoursOf(userId), workDaysOf(userId)]);
  const sorted = [...dates].sort();
  const leave = await q<{ start_date: string; end_date: string }>(
    `SELECT start_date::text AS start_date, end_date::text AS end_date FROM leave_requests
      WHERE user_id = $1 AND status = 'approved' AND start_date <= $3 AND end_date >= $2`,
    [userId, sorted[0], sorted[sorted.length - 1]],
  );
  const out: Record<string, number> = {};
  for (const d of dates) out[d] = leave.some((l) => l.start_date <= d && l.end_date >= d) ? 0 : expectedMinutesOn(d, regular, workDays);
  return out;
}
