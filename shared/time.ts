// Time maths for Time & Payroll, shared by the server and the /time pages.
// Pure functions only: no database, no clock (callers pass `now`).
//
// Clock events are paired by TIME ORDER through a small state machine, never
// by position in a list (the old workforce app paired by position, so one
// missed clock-out shifted every later pair). Anything that doesn't fit the
// machine is flagged for a manager, never guessed: an unclosed shift counts
// for nothing until someone fixes it.

export type ClockKind = "in" | "out" | "break_start" | "break_end";

export interface ClockEvent {
  id: number;
  kind: ClockKind;
  /** Epoch ms. */
  at: number;
}

export interface Interval { start: number; end: number }

export interface Session {
  start: number;
  /** null while still clocked in. */
  end: number | null;
  breaks: Interval[];
  /** Worked time = session minus breaks. Empty if the session can't be trusted. */
  work: Interval[];
  /** An open break (on break right now). */
  breakOpen: number | null;
}

export interface Flag {
  /** "missed-out" | "stray-out" | "stray-break" | "long-shift" */
  code: string;
  at: number;
  message: string;
}

/** A shift still open after this long is a missed clock-out, not a long day. */
export const MAX_SHIFT_MS = 16 * 3600_000;
/**
 * A closed session longer than this is counted but flagged: usually a clock-out
 * pressed the next morning, or a typo in a manager's entry. Approving it needs a look.
 */
export const LONG_SHIFT_MS = 13 * 3600_000;

/**
 * Pair a person's clock events into sessions. `now` decides whether an open
 * session is live (counted to now) or a missed clock-out (counted as nothing, flagged).
 */
export function pairEvents(events: ClockEvent[], now: number, tz = "UTC"): { sessions: Session[]; flags: Flag[]; state: "out" | "in" | "break" } {
  const sorted = [...events].sort((a, b) => a.at - b.at || a.id - b.id);
  const sessions: Session[] = [];
  const flags: Flag[] = [];
  let cur: { start: number; breaks: Interval[]; breakStart: number | null } | null = null;
  const when = (ms: number) => fmtLocal(ms, tz);

  const close = (end: number) => {
    const c = cur!;
    const breaks = [...c.breaks];
    if (c.breakStart !== null) breaks.push({ start: c.breakStart, end }); // clocking out ends the break
    const work = subtract({ start: c.start, end }, breaks);
    sessions.push({ start: c.start, end, breaks, work, breakOpen: null });
    const worked = work.reduce((n, w) => n + (w.end - w.start), 0);
    if (worked > LONG_SHIFT_MS) flags.push({ code: "long-shift", at: c.start, message: `${Math.round(worked / 360_000) / 10}h worked in one go from ${when(c.start)} — check the clock-out` });
    cur = null;
  };

  for (const e of sorted) {
    switch (e.kind) {
      case "in":
        if (cur) {
          // Clocked in again without clocking out: the earlier shift has no end we can trust.
          flags.push({ code: "missed-out", at: cur.start, message: `No clock-out after clocking in at ${when(cur.start)}` });
          sessions.push({ start: cur.start, end: null, breaks: cur.breaks, work: [], breakOpen: null });
        }
        cur = { start: e.at, breaks: [], breakStart: null };
        break;
      case "out":
        if (!cur) flags.push({ code: "stray-out", at: e.at, message: `Clock-out at ${when(e.at)} without a clock-in` });
        else close(e.at);
        break;
      case "break_start":
        if (!cur) flags.push({ code: "stray-break", at: e.at, message: `Break started at ${when(e.at)} while clocked out` });
        else if (cur.breakStart === null) cur.breakStart = e.at;
        break;
      case "break_end":
        if (!cur || cur.breakStart === null) flags.push({ code: "stray-break", at: e.at, message: `Break ended at ${when(e.at)} without starting` });
        else {
          cur.breaks.push({ start: cur.breakStart, end: e.at });
          cur.breakStart = null;
        }
        break;
    }
  }

  let state: "out" | "in" | "break" = "out";
  if (cur) {
    const c = cur as { start: number; breaks: Interval[]; breakStart: number | null };
    if (now - c.start > MAX_SHIFT_MS) {
      flags.push({ code: "missed-out", at: c.start, message: `Still clocked in since ${when(c.start)} — missed clock-out?` });
      sessions.push({ start: c.start, end: null, breaks: c.breaks, work: [], breakOpen: null });
    } else {
      // Live: count up to now, minus breaks so far (an open break counts as break).
      const breaks = c.breakStart !== null ? [...c.breaks, { start: c.breakStart, end: now }] : c.breaks;
      sessions.push({ start: c.start, end: null, breaks: c.breaks, work: subtract({ start: c.start, end: now }, breaks), breakOpen: c.breakStart });
      state = c.breakStart !== null ? "break" : "in";
    }
  }
  return { sessions, flags, state };
}

/** `whole` minus the `holes` that fall inside it. */
export function subtract(whole: Interval, holes: Interval[]): Interval[] {
  let parts: Interval[] = whole.end > whole.start ? [whole] : [];
  for (const h of holes) {
    const next: Interval[] = [];
    for (const p of parts) {
      if (h.end <= p.start || h.start >= p.end) { next.push(p); continue; }
      if (h.start > p.start) next.push({ start: p.start, end: h.start });
      if (h.end < p.end) next.push({ start: h.end, end: p.end });
    }
    parts = next;
  }
  return parts;
}

/** Worked minutes per local date (YYYY-MM-DD in `tz`), splitting work across local midnight. */
export function minutesByDay(sessions: Session[], tz = "UTC"): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sessions) {
    for (const w of s.work) {
      let t = w.start;
      while (t < w.end) {
        const day = localDate(t, tz);
        // Belt and braces: a timezone rule we don't model must never stall the loop.
        const midnight = nextLocalMidnight(t, tz);
        const cut = Math.min(w.end, midnight > t ? midnight : t + 3600_000);
        out[day] = (out[day] ?? 0) + (cut - t) / 60_000;
        t = cut;
      }
    }
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k]);
  return out;
}

// ── Dates ───────────────────────────────────────────────────────────────────

function parts(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** The local calendar date of an instant, YYYY-MM-DD. */
export function localDate(ms: number, tz = "UTC"): string {
  const p = parts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Offset of `tz` from UTC at an instant, in ms (local = utc + offset). */
function offsetAt(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** The instant a local wall-clock time happens in `tz`. */
export function zonedTime(date: string, time: string, tz = "UTC"): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz); // settle across a DST change
  // A wall time that doesn't exist (clocks jump forward at midnight in Santiago,
  // Havana, old São Paulo) lands before it; use the first instant after the gap
  // instead, so "next midnight" is always after "now".
  const p = parts(t, tz);
  const got = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  if (got < guess) t += guess - got;
  return t;
}

/** The next local midnight strictly after `ms`. */
export function nextLocalMidnight(ms: number, tz = "UTC"): number {
  const day = localDate(ms, tz);
  return zonedTime(addDays(day, 1), "00:00", tz);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Monday of the week holding `date`. */
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

/** A week a manager approved: the total they saw, and each day's minutes as they saw them (null: approved before days were kept). */
export interface ApprovedWeek { weekStart: string; minutes: number; byDay: Record<string, number> | null }

/** A week whose clock events now add up to something other than what was approved. */
export interface HoursDrift { weekStart: string; approved: number; live: number }

/**
 * What hourly pay counts between two dates (inclusive): the minutes as approved,
 * never a live recount. An edit just outside the week (a Sunday-night shift
 * running into Monday) or a timezone change mustn't move an approved week's pay.
 * `live` is minutes per day from the clock events today, only used for weeks
 * approved before days were kept (whole week in range: its approved total;
 * a week split by the range: live days, listed in `legacy`), and to report
 * every approved week that no longer matches (`drift`).
 */
export function approvedInRange(weeks: ApprovedWeek[], live: Record<string, number>, from: string, to: string): { minutes: number; drift: HoursDrift[]; legacy: string[] } {
  let minutes = 0;
  const drift: HoursDrift[] = [], legacy: string[] = [];
  for (const w of weeks) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(w.weekStart, i));
    const inRange = days.filter((d) => d >= from && d <= to);
    if (!inRange.length) continue;
    if (w.byDay) minutes += inRange.reduce((s, d) => s + (Number(w.byDay![d]) || 0), 0);
    else if (inRange.length === 7) minutes += w.minutes;
    else { minutes += inRange.reduce((s, d) => s + (live[d] ?? 0), 0); legacy.push(w.weekStart); }
    const now = days.reduce((s, d) => s + (live[d] ?? 0), 0);
    if (now !== w.minutes) drift.push({ weekStart: w.weekStart, approved: w.minutes, live: now });
  }
  return { minutes, drift, legacy };
}

/** The Monday of the week an instant falls in, in `tz` (not UTC: it's Monday in Manila while Sunday in London). */
export const thisWeek = (ms: number, tz: string) => weekStart(localDate(ms, tz));
/** The Monday of the last week that's over in `tz`: the one waiting for sign-off. */
export const lastFullWeek = (ms: number, tz: string) => addDays(thisWeek(ms, tz), -7);

export const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
export const isTime = (s: unknown): s is string => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export const MON_FRI = [1, 2, 3, 4, 5];

/** A valid working-day pattern: distinct days 0 (Sunday) to 6. */
export const isWorkDays = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length > 0 && v.length <= 7 && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) && new Set(v).size === v.length;

/**
 * Days someone normally works from `start` to `end`, inclusive, by their own
 * pattern (Acme is open 24/7: a weekend worker's Saturday is a working day).
 * Public holidays: not yet (a decision for Alex).
 */
export function workingDays(start: string, end: string, workDays: number[] = MON_FRI): number {
  if (end < start) return 0;
  const on = new Set(workDays);
  let n = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const [y, m, dd] = d.split("-").map(Number);
    if (on.has(new Date(Date.UTC(y, m - 1, dd)).getUTCDay())) n++;
  }
  return n;
}

/**
 * One day of someone's regular week, in their own timezone.
 * A break is either set times (break_start–break_end) or just a length (break_minutes),
 * which is how most rosters hold breaks: "1h meal", taken whenever.
 */
/**
 * Days a leave request charges: its working days, or 0.5 for a half day. A half day
 * is one date that's a working day; anything else is NaN (refuse it).
 */
export function leaveDays(start: string, end: string, workDays: number[] = MON_FRI, halfDay = false): number {
  const days = workingDays(start, end, workDays);
  if (!halfDay) return days;
  return start === end && days === 1 ? 0.5 : NaN;
}

/** The months (YYYY-MM) a leave request has working days in, oldest first. */
export function leaveMonths(start: string, end: string, workDays: number[] = MON_FRI): string[] {
  const out: string[] = [];
  for (let first = `${start.slice(0, 7)}-01`; first <= end; ) {
    const [y, m] = first.split("-").map(Number);
    const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const from = start > first ? start : first, to = end < addDays(next, -1) ? end : addDays(next, -1);
    if (workingDays(from, to, workDays) > 0) out.push(first.slice(0, 7));
    first = next;
  }
  return out;
}

export interface RegularDay { dow: number; start: string; end: string; break_start?: string | null; break_end?: string | null; break_minutes?: number | null }

/** Valid regular hours: at most one entry per day, real times, a break inside the day's hours. */
export function isRegularHours(v: unknown): v is RegularDay[] {
  if (!Array.isArray(v) || v.length > 7) return false;
  const seen = new Set<number>();
  for (const d of v) {
    if (!d || typeof d !== "object") return false;
    const r = d as RegularDay;
    if (!Number.isInteger(r.dow) || r.dow < 0 || r.dow > 6 || seen.has(r.dow)) return false;
    seen.add(r.dow);
    if (!isTime(r.start) || !isTime(r.end) || r.start === r.end) return false;
    const hasBreak = r.break_start != null || r.break_end != null;
    if (hasBreak && (!isTime(r.break_start) || !isTime(r.break_end) || r.break_start === r.break_end)) return false;
    if (r.break_minutes != null && (hasBreak || !Number.isInteger(r.break_minutes) || r.break_minutes <= 0 || r.break_minutes >= span(r.start, r.end))) return false;
  }
  return true;
}

const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** Minutes from a to b on a clock, running past midnight when b is at or before a. */
const span = (a: string, b: string) => { const d = mins(b) - mins(a); return d > 0 ? d : d + 1440; };

/** A regular day's working minutes: start to end (overnight allowed) less the break. */
export function regularMinutes(d: RegularDay): number {
  const whole = span(d.start, d.end);
  const brk = d.break_start && d.break_end ? span(d.break_start, d.break_end) : d.break_minutes ?? 0;
  return Math.max(0, whole - (brk < whole ? brk : 0));
}

/** Weekday (0 = Sunday) of a YYYY-MM-DD date. */
export const dowOf = (date: string) => { const [y, m, d] = date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

/**
 * Minutes someone is expected to work on `date` (their local date): their regular
 * hours for that weekday if set, else a standard 8-hour day on their working days.
 */
export function expectedMinutesOn(date: string, regular: RegularDay[] | null | undefined, workDays: number[] = MON_FRI): number {
  const dow = dowOf(date);
  if (regular && regular.length) {
    const d = regular.find((r) => r.dow === dow);
    return d ? regularMinutes(d) : 0;
  }
  return workDays.includes(dow) ? 480 : 0;
}

/**
 * A scheduled shift as real instants. Shifts can start any hour of any day; an
 * end at or before the start means it runs past midnight into the next day.
 */
export function shiftInterval(date: string, startLocal: string, endLocal: string, tz = "UTC"): Interval {
  const start = zonedTime(date, startLocal, tz);
  const end = zonedTime(endLocal <= startLocal ? addDays(date, 1) : date, endLocal, tz);
  return { start, end };
}

/**
 * The same shift written on another wall clock. A manager in Los Angeles clicks
 * Tue 09:00–17:00; for an agent in Karachi that's Tue 21:00–05:00 (overnight).
 * Shifts are stored on the person's own clock, so the schedule converts before saving.
 */
export function shiftInZone(date: string, startLocal: string, endLocal: string, fromTz: string, toTz: string): { date: string; start_local: string; end_local: string } {
  if (fromTz === toTz) return { date, start_local: startLocal, end_local: endLocal };
  const i = shiftInterval(date, startLocal, endLocal, fromTz);
  const s = fmtLocal(i.start, toTz), e = fmtLocal(i.end, toTz);
  return { date: s.slice(0, 10), start_local: s.slice(11), end_local: e.slice(11) };
}

export function fmtLocal(ms: number, tz = "UTC"): string {
  const p = parts(ms, tz);
  return `${localDate(ms, tz)} ${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
}

/** What a clock button press may do from each state. */
export const NEXT: Record<"out" | "in" | "break", ClockKind[]> = {
  out: ["in"],
  in: ["out", "break_start"],
  break: ["break_end", "out"],
};

export const isTz = (tz: unknown): tz is string => {
  // IANA names only ("Asia/Karachi", "UTC"): offsets ("+05:30") and abbreviations ("EST") are read
  // differently by Postgres's AT TIME ZONE than by JavaScript, so days would split differently.
  if (typeof tz !== "string" || !tz || !(tz === "UTC" || tz.includes("/"))) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
};

/** The first real IANA timezone of those given (most trusted first), else UTC. */
export const pickTz = (...zones: unknown[]): string => zones.find(isTz) ?? "UTC";

// ── Availability ────────────────────────────────────────────────────────────

/**
 * When someone can't work, in their own timezone: every week on a day
 * (optionally only between two times; an end before the start runs past
 * midnight), or a whole one-off date.
 */
export interface Unavailable {
  kind: "weekly" | "date";
  /** 0 = Sunday … 6, for weekly. */
  dow?: number | null;
  /** YYYY-MM-DD, for one-off dates. */
  date?: string | null;
  start_local?: string | null;
  end_local?: string | null;
  note?: string | null;
}

/** Does an availability item cover (part of) local date `date`, as a minute range from that date's midnight? */
function itemRanges(u: Unavailable, date: string): [number, number][] {
  const applies = u.kind === "date" ? u.date === date : u.dow === dowOf(date);
  if (!applies) return [];
  if (u.kind === "date" || !u.start_local || !u.end_local) return [[0, 1440]];
  const s = mins(u.start_local), e = mins(u.end_local);
  return [[s, e <= s ? e + 1440 : e]];
}

/**
 * The first unavailability a shift (date + local start/end, an end at or
 * before the start runs past midnight) runs into, or null. Checks the shift's
 * own day, the next day for overnight shifts, and an overnight unavailability
 * carried over from the day before.
 */
export function availabilityClash(shift: { date: string; start_local: string; end_local: string }, items: Unavailable[]): Unavailable | null {
  const s = mins(shift.start_local);
  let e = mins(shift.end_local);
  if (e <= s) e += 1440;
  for (const u of items) {
    for (const k of [-1, 0, 1]) {
      for (const [a, b] of itemRanges(u, addDays(shift.date, k))) {
        const lo = a + k * 1440, hi = b + k * 1440;
        if (Math.max(s, lo) < Math.min(e, hi)) return u;
      }
    }
  }
  return null;
}

/** A person-readable line for an availability item. */
export function describeUnavailable(u: Unavailable): string {
  const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
  const when = u.kind === "date" ? u.date : DAYS[u.dow ?? 0];
  const hours = u.kind === "weekly" && u.start_local && u.end_local ? ` ${u.start_local}–${u.end_local}` : u.kind === "weekly" ? " (all day)" : "";
  return `Unavailable ${when}${hours}${u.note ? ` — ${u.note}` : ""}`;
}

// ── Reminders and lateness ─────────────────────────────────────────────────

/** Reminder window: a shift starting 25–35 minutes from now gets one heads-up. */
export const REMIND_MIN = 25, REMIND_MAX = 35, LATE_AFTER = 10;

/** Is a scheduled shift starting soon enough to remind someone who hasn't clocked in? */
export const dueForReminder = (startsAt: number, now: number) => startsAt - now > REMIND_MIN * 60_000 && startsAt - now <= REMIND_MAX * 60_000;

/**
 * Minutes late for a shift, or 0: the shift started more than LATE_AFTER
 * minutes ago, hasn't ended, and the person hasn't clocked in since 30 minutes
 * before it started.
 */
export function lateBy(shift: Interval, lastClockIn: number | null, clockedIn: boolean, now: number): number {
  if (now < shift.start + LATE_AFTER * 60_000 || now >= shift.end) return 0;
  if (clockedIn && lastClockIn !== null && lastClockIn >= shift.start - 30 * 60_000) return 0;
  return Math.floor((now - shift.start) / 60_000);
}

// ── Publishing ─────────────────────────────────────────────────────────────

export interface ShiftSnap { id: number; user_id: number | null; date: string; start_local: string; end_local: string; timezone: string }

/** What changed between the last published week and the schedule now. */
export function diffShifts(before: ShiftSnap[], now: ShiftSnap[]) {
  const was = new Map(before.map((s) => [s.id, s]));
  const is = new Map(now.map((s) => [s.id, s]));
  const added = now.filter((s) => !was.has(s.id));
  const removed = before.filter((s) => !is.has(s.id));
  const changed = now.filter((s) => {
    const b = was.get(s.id);
    return b && (b.user_id !== s.user_id || b.date !== s.date || b.start_local !== s.start_local || b.end_local !== s.end_local || b.timezone !== s.timezone);
  }).map((s) => ({ before: was.get(s.id)!, after: s }));
  return { added, removed, changed, any: added.length + removed.length + changed.length > 0 };
}
