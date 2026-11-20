// Office streaks, like chess.com's: how many days in a row someone has
// been in the office. Built from status_events (any time in the office counts), in their own
// timezone. A weekend day you come in counts toward the streak; a weekend day you don't never
// breaks it. Today counts the
// moment you arrive; until then yesterday's streak is still alive — it only breaks once a whole
// weekday passes without you.

import { q } from "./db";

export interface Streak { days: number; today: boolean }

const fmt = new Map<string, Intl.DateTimeFormat>();
/** "YYYY-MM-DD" for instant `t` in zone `tz`. */
export function dayIn(t: number, tz: string): string {
  let f = fmt.get(tz);
  if (!f) fmt.set(tz, (f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })));
  return f.format(t);
}
const weekend = (d: string) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); return w === 0 || w === 6; };
const before = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);

/** The streak as of `today`, from the set of local days someone was in. Pure, so it's tested. */
export function streakOf(days: Set<string>, today: string): Streak {
  const inToday = days.has(today);
  let d = inToday ? today : before(today); // not in yet today: the streak still stands on yesterday
  let n = 0;
  for (let guard = 0; guard < 5000; guard++) {
    if (days.has(d)) n++; // any day you were in counts, weekend included
    else if (!weekend(d)) break; // only a missed weekday breaks it
    d = before(d);
  }
  return { days: n, today: inToday };
}

/** Local days with any time in the office, from status stretches (each stretch marks every day it touches). */
export function daysFrom(stretches: { start: number; end: number }[], tz: string): Set<string> {
  const out = new Set<string>();
  for (const s of stretches) {
    // Every 6 hours lands on every calendar day a stretch crosses; the end marks the last one.
    for (let t = s.start; t < s.end; t += 6 * 3600e3) out.add(dayIn(t, tz));
    out.add(dayIn(Math.max(s.start, s.end), tz));
  }
  return out;
}

/** Someone's streak now. `presentNow`: they're in the office this minute (their stretch may not be written yet). */
export async function streakFor(userId: number, tz: string, presentNow: boolean, now = Date.now()): Promise<Streak> {
  const rows = await q<{ s: Date; e: Date | null }>(
    `SELECT started_at AS s, ended_at AS e FROM status_events
      WHERE user_id = $1 AND started_at > now() - interval '400 days'`,
    [userId],
  );
  const days = daysFrom(rows.map((r) => ({ start: new Date(r.s).getTime(), end: r.e ? new Date(r.e).getTime() : now })), tz);
  if (presentNow) days.add(dayIn(now, tz));
  return streakOf(days, dayIn(now, tz));
}

/** Streaks worth a cheer the first time they're reached. */
export const MILESTONES = new Set([5, 10, 20, 30, 50, 75, 100, 150, 200, 250, 365, 500]);
