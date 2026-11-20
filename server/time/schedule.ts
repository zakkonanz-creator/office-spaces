// Time tracking beyond clocking in: publishing the schedule,
// shift reminders and lateness, availability, who's on today, the leave
// calendar, and timesheet/hours exports. Managers see hours, never pay.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { one, q } from "../db";
import type { UserRow } from "../auth";
import { config } from "../config";
import { setStatusFor, statusOf } from "../office";
import { isPayrollAdmin, managedTeams } from "../payroll/grants";
import { esc } from "../payroll/csv";
import {
  addDays, availabilityClash, describeUnavailable, diffShifts, dueForReminder, fmtLocal, isDate, isTime, lateBy, localDate,
  minutesByDay, pairEvents, shiftInterval, weekStart, zonedTime, isTz, type ShiftSnap, type Unavailable,
} from "../../shared/time";
import { audit } from "./db";
import { approvedMinutes, eventsBetween, tzOf } from "./hours";

type Member = (req: FastifyRequest, reply: FastifyReply) => UserRow | null;
type Manager = (req: FastifyRequest, reply: FastifyReply) => Promise<{ user: UserRow; teams: string[] } | null>;
type Person = { id: number; name: string; team: string | null; tz: string | null; work_days: number[] | null };
export interface ScheduleDeps {
  member: Member;
  manager: Manager;
  peopleIn: (teams: string[]) => Promise<Person[]>;
  tell: (userId: number, text: string) => Promise<void>;
}

const bad = (reply: FastifyReply, error: string, code = 400) => reply.code(code).send({ error });
const body = (req: FastifyRequest) => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
const intParam = (v: unknown) => (typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : NaN);
const canSee = (teams: string[], team: string) => teams.includes("*") || teams.includes(team);
const hm = (m: number) => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, "0")}`;
const csvReply = (reply: FastifyReply, name: string, rows: unknown[][]) =>
  reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="${name}"`)
    .send(rows.map((r) => r.map(esc).join(",")).join("\n") + "\n");

/** "Mon 5 Oct". */
const dayName = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
};

/** A shift as its person reads it, in their own timezone: "Mon 5 Oct 22:00–06:00 (+1)". */
function shiftLine(s: ShiftSnap, personTz: string): string {
  const tz = isTz(s.timezone) ? s.timezone : "UTC";
  const i = shiftInterval(s.date, s.start_local, s.end_local, tz);
  const a = fmtLocal(i.start, personTz), b = fmtLocal(i.end, personTz);
  const nextDay = a.slice(0, 10) !== b.slice(0, 10);
  return `${dayName(a.slice(0, 10))} ${a.slice(11)}–${b.slice(11)}${nextDay ? " (+1)" : ""}`;
}

async function teamWeek(team: string, week: string): Promise<ShiftSnap[]> {
  return q<ShiftSnap>(
    `SELECT id, user_id, date::text AS date, start_local, end_local, timezone FROM shifts WHERE team = $1 AND date BETWEEN $2 AND $3 ORDER BY date, start_local, id`,
    [team, week, addDays(week, 6)],
  );
}
async function lastPublication(team: string, week: string) {
  return one<{ id: number; published_at: Date; snapshot: ShiftSnap[] | string }>(
    `SELECT id, published_at, snapshot FROM shift_publications WHERE team = $1 AND week_start = $2 ORDER BY id DESC LIMIT 1`,
    [team, week],
  );
}
const snapOf = (p: { snapshot: ShiftSnap[] | string } | null): ShiftSnap[] => (!p ? [] : typeof p.snapshot === "string" ? JSON.parse(p.snapshot) : p.snapshot);

/** Someone's clock right now, and when they last clocked in. */
async function clockNow(userId: number, now: number) {
  const tz = await tzOf(userId);
  const events = await eventsBetween(userId, now - 24 * 3600_000, now + 1);
  const { state } = pairEvents(events, now, tz);
  const lastIn = [...events].reverse().find((e) => e.kind === "in")?.at ?? null;
  return { tz, state, lastIn };
}

async function availabilityOf(userId: number): Promise<(Unavailable & { id: number })[]> {
  return q(`SELECT id, kind, dow, date::text AS date, start_local, end_local, note FROM availability WHERE user_id = $1 ORDER BY kind DESC, dow, date, start_local`, [userId]);
}

/**
 * Why `userId` shouldn't work these shifts, if anything: they marked
 * themselves unavailable, or they're on approved leave that day.
 */
export async function scheduleConflicts(userId: number, dates: string[], start: string, end: string): Promise<{ date: string; reason: string }[]> {
  const items = await availabilityOf(userId);
  const leave = await q<{ start_date: string; end_date: string; code: string }>(
    `SELECT start_date::text AS start_date, end_date::text AS end_date, code FROM leave_requests WHERE user_id = $1 AND status = 'approved' AND end_date >= $2 AND start_date <= $3`,
    [userId, dates.reduce((a, b) => (a < b ? a : b)), dates.reduce((a, b) => (a > b ? a : b))],
  );
  const out: { date: string; reason: string }[] = [];
  for (const date of dates) {
    const hit = availabilityClash({ date, start_local: start, end_local: end }, items);
    if (hit) out.push({ date, reason: describeUnavailable(hit) });
    const lv = leave.find((l) => l.start_date <= date && l.end_date >= date);
    if (lv) out.push({ date, reason: `On approved ${lv.code} leave` });
  }
  return out;
}

/**
 * One pass of shift reminders: anyone with a published shift starting in
 * 25–35 minutes who hasn't clocked in gets one Slack DM. Never throws: no
 * Slack token simply means nobody is messaged (the dedupe row is still kept).
 */
export async function runReminders(tell: ScheduleDeps["tell"], now = Date.now()) {
  const sent: { shiftId: number; userId: number }[] = [];
  try {
    const today = localDate(now, "UTC");
    const rows = await q<ShiftSnap & { team: string }>(
      `SELECT s.id, s.user_id, s.team, s.date::text AS date, s.start_local, s.end_local, s.timezone FROM shifts s
        WHERE s.user_id IS NOT NULL AND s.published_at IS NOT NULL AND s.date BETWEEN $1 AND $2
          AND NOT EXISTS (SELECT 1 FROM shift_reminders r WHERE r.shift_id = s.id AND r.kind = 'soon')
          -- Nobody is nudged to clock in on a day they're on approved leave.
          AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.user_id = s.user_id AND l.status = 'approved' AND l.start_date <= s.date AND l.end_date >= s.date)`,
      [addDays(today, -1), addDays(today, 1)],
    );
    for (const s of rows) {
      const i = shiftInterval(s.date, s.start_local, s.end_local, isTz(s.timezone) ? s.timezone : "UTC");
      if (!dueForReminder(i.start, now)) continue;
      const c = await clockNow(s.user_id!, now);
      if (c.state !== "out") continue;
      const claimed = await one(`INSERT INTO shift_reminders (shift_id, kind) VALUES ($1, 'soon') ON CONFLICT DO NOTHING RETURNING shift_id`, [s.id]);
      if (!claimed) continue; // another pass got it first
      sent.push({ shiftId: s.id, userId: s.user_id! });
      await tell(s.user_id!, `Heads-up: your ${s.team} shift starts at ${fmtLocal(i.start, c.tz).slice(11)} (${Math.round((i.start - now) / 60_000)} min). Clock in at Office Spaces → Time when you start.`);
    }
  } catch (e) {
    console.error("time: reminder pass failed:", (e as Error).message);
  }
  return sent;
}

export function registerScheduleRoutes(app: FastifyInstance, d: ScheduleDeps) {
  const { member, manager, peopleIn, tell } = d;

  // Reminders run on their own, every minute. unref: they never hold the process open.
  const timer = setInterval(() => void runReminders(tell), 60_000);
  timer.unref?.();

  // Local testing only: run one reminder pass "as of" a given instant.
  app.post("/api/dev/time-reminders", async (req, reply) => {
    if (!config.devLogin || config.production) return reply.code(404).send();
    const at = typeof body(req).now === "string" ? Date.parse(body(req).now as string) : Date.now();
    return { sent: await runReminders(tell, Number.isFinite(at) ? at : Date.now()) };
  });

  // ── Publishing ───────────────────────────────────────────────────────────

  /** What a publish would send: changes since the team's last publish of this week. */
  app.get("/api/time/publish", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const { team, week } = req.query as { team?: string; week?: string };
    if (!team || !isDate(week)) return bad(reply, "team and week");
    if (!canSee(m.teams, team)) return bad(reply, "not your team", 403);
    const ws = weekStart(week);
    const last = await lastPublication(team, ws);
    const diff = diffShifts(snapOf(last), await teamWeek(team, ws));
    return {
      team, weekStart: ws,
      lastPublishedAt: last?.published_at ?? null,
      pending: { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length },
      upToDate: Boolean(last) && !diff.any,
    };
  });

  app.post("/api/time/publish", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const b = body(req);
    const team = typeof b.team === "string" ? b.team : "";
    if (!team || !isDate(b.week_start)) return bad(reply, "team and week_start");
    if (!canSee(m.teams, team)) return bad(reply, "not your team", 403);
    const ws = weekStart(b.week_start as string);
    const last = await lastPublication(team, ws);
    const before = snapOf(last);
    const now = await teamWeek(team, ws);
    const diff = diffShifts(before, now);
    if (last && !diff.any) return { ok: true, published: 0, notified: [], unchanged: true };
    await q(`UPDATE shifts SET published_at = now() WHERE team = $1 AND date BETWEEN $2 AND $3`, [team, ws, addDays(ws, 6)]);
    const pub = await one<{ id: number }>(`INSERT INTO shift_publications (team, week_start, published_by, snapshot) VALUES ($1, $2, $3, $4) RETURNING id`, [team, ws, m.user.id, JSON.stringify(now)]);
    // Who to tell: on a first publish everyone with a shift; after that, only the people a change touches.
    const touched = new Set<number>();
    if (!last) for (const s of now) if (s.user_id) touched.add(s.user_id);
    for (const s of diff.added) if (s.user_id) touched.add(s.user_id);
    for (const s of diff.removed) if (s.user_id) touched.add(s.user_id);
    for (const c of diff.changed) { if (c.before.user_id) touched.add(c.before.user_id); if (c.after.user_id) touched.add(c.after.user_id); }
    for (const uid of touched) {
      const tz = await tzOf(uid);
      const mine = now.filter((s) => s.user_id === uid);
      const lines = mine.length ? mine.map((s) => `• ${shiftLine(s, tz)}`).join("\n") : "• No shifts this week.";
      const changes: string[] = [];
      if (last) {
        for (const s of diff.added) if (s.user_id === uid) changes.push(`added ${shiftLine(s, tz)}`);
        for (const s of diff.removed) if (s.user_id === uid) changes.push(`removed ${shiftLine(s, tz)}`);
        for (const c of diff.changed) {
          if (c.after.user_id === uid && c.before.user_id !== uid) changes.push(`added ${shiftLine(c.after, tz)}`);
          else if (c.before.user_id === uid && c.after.user_id !== uid) changes.push(`removed ${shiftLine(c.before, tz)}`);
          else if (c.after.user_id === uid) changes.push(`moved ${shiftLine(c.before, tz)} → ${shiftLine(c.after, tz)}`);
        }
      }
      void tell(uid, `${last ? "Your schedule changed" : "Your schedule is out"} — ${team}, week of ${dayName(ws)} (your time, ${tz}):\n${lines}${changes.length ? `\nWhat changed: ${changes.join("; ")}` : ""}`);
    }
    await audit(m.user.id, last ? "republish" : "publish", "schedule", `${team}:${ws}`, last ? { publication: last.id } : null,
      { publication: pub!.id, shifts: now.length, added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length });
    return { ok: true, published: now.length, added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length, notified: [...touched], first: !last };
  });

  // ── Availability ─────────────────────────────────────────────────────────

  app.get("/api/time/availability", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    return { timezone: await tzOf(u.id), items: await availabilityOf(u.id) };
  });

  app.post("/api/time/availability", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    const b = body(req);
    const kind = b.kind === "date" ? "date" : b.kind === "weekly" ? "weekly" : null;
    if (!kind) return bad(reply, "kind is weekly or date");
    const note = typeof b.note === "string" ? b.note.trim().slice(0, 200) || null : null;
    if ((await one<{ n: number }>(`SELECT count(*)::int AS n FROM availability WHERE user_id = $1`, [u.id]))!.n >= 60) return bad(reply, "that's a lot of entries — remove some first");
    let row;
    if (kind === "weekly") {
      const dow = Number(b.dow);
      if (!Number.isInteger(dow) || dow < 0 || dow > 6) return bad(reply, "dow is 0 (Sunday) to 6");
      const hasTimes = b.start_local != null || b.end_local != null;
      if (hasTimes && (!isTime(b.start_local) || !isTime(b.end_local) || b.start_local === b.end_local)) return bad(reply, "start_local and end_local as HH:MM (or neither, for the whole day)");
      row = await one<{ id: number }>(`INSERT INTO availability (user_id, kind, dow, start_local, end_local, note) VALUES ($1, 'weekly', $2, $3, $4, $5) RETURNING id`,
        [u.id, dow, hasTimes ? b.start_local : null, hasTimes ? b.end_local : null, note]);
    } else {
      if (!isDate(b.date)) return bad(reply, "date as YYYY-MM-DD");
      const today = localDate(Date.now(), await tzOf(u.id));
      if ((b.date as string) < today) return bad(reply, "that date has passed");
      if ((b.date as string) > addDays(today, 366)) return bad(reply, "at most a year ahead");
      row = await one<{ id: number }>(`INSERT INTO availability (user_id, kind, date, note) VALUES ($1, 'date', $2, $3) RETURNING id`, [u.id, b.date, note]);
    }
    return { ok: true, id: row!.id };
  });

  app.delete("/api/time/availability/:id", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    const id = intParam((req.params as any).id);
    if (!Number.isFinite(id)) return bad(reply, "not found", 404);
    const r = await one(`DELETE FROM availability WHERE id = $1 AND user_id = $2 RETURNING id`, [id, u.id]);
    if (!r) return bad(reply, "no entry of yours with that id", 404);
    return { ok: true };
  });

  /** Managers: everyone's unavailability on their teams, for greying out the schedule. */
  app.get("/api/time/availability/team", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const people = await peopleIn(m.teams);
    if (!people.length) return [];
    const rows = await q<Unavailable & { id: number; user_id: number }>(
      `SELECT id, user_id, kind, dow, date::text AS date, start_local, end_local, note FROM availability WHERE user_id = ANY($1::int[]) ORDER BY user_id`,
      [people.map((p) => p.id)],
    );
    const out = [];
    for (const p of people) {
      const items = rows.filter((r) => r.user_id === p.id).map((r) => ({ ...r, label: describeUnavailable(r) }));
      if (items.length) out.push({ user_id: p.id, timezone: await tzOf(p.id), items }); // the zone they entered it in (tzOf's order)
    }
    return out;
  });

  // ── Who's on today ───────────────────────────────────────────────────────

  app.get("/api/time/today", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const teamQ = (req.query as { team?: string }).team;
    if (teamQ && !canSee(m.teams, teamQ)) return bad(reply, "not your team", 403);
    const people = (await peopleIn(teamQ ? [teamQ] : m.teams)).filter((p) => !teamQ || p.team === teamQ);
    const now = Date.now();
    interface TodayShift extends ShiftSnap { team: string; starts_at: string; ends_at: string; status: "upcoming" | "now" | "done" }
    interface TodayRow { userId: number; name: string; team: string | null; timezone: string; localTime: string; clock: string; onLeave: { code: string; name: string } | null; shifts: TodayShift[]; late: { minutes: number; shiftId: number } | null }
    const out: TodayRow[] = [];
    for (const p of people) {
      const c = await clockNow(p.id, now);
      const today = localDate(now, c.tz);
      const dayStart = zonedTime(today, "00:00", c.tz), dayEnd = zonedTime(addDays(today, 1), "00:00", c.tz);
      const shifts = (await q<ShiftSnap & { team: string }>(
        `SELECT id, user_id, team, date::text AS date, start_local, end_local, timezone FROM shifts
          WHERE user_id = $1 AND published_at IS NOT NULL AND date BETWEEN $2 AND $3 ORDER BY date, start_local`,
        [p.id, addDays(today, -1), addDays(today, 1)],
      )).map((s) => {
        const i = shiftInterval(s.date, s.start_local, s.end_local, isTz(s.timezone) ? s.timezone : "UTC");
        return { ...s, starts_at: new Date(i.start).toISOString(), ends_at: new Date(i.end).toISOString(), interval: i };
      }).filter((s) => s.interval.end > dayStart && s.interval.start < dayEnd);
      const late = shifts.map((s) => ({ s, mins: lateBy(s.interval, c.lastIn, c.state !== "out", now) })).find((x) => x.mins > 0);
      const leave = await one<{ code: string; name: string }>(
        `SELECT r.code, t.name FROM leave_requests r JOIN leave_types t ON t.code = r.code WHERE r.user_id = $1 AND r.status = 'approved' AND r.start_date <= $2 AND r.end_date >= $2 LIMIT 1`,
        [p.id, today],
      );
      out.push({
        userId: p.id, name: p.name, team: p.team, timezone: c.tz, localTime: fmtLocal(now, c.tz).slice(11),
        clock: c.state, onLeave: leave ? { code: leave.code, name: leave.name } : null,
        shifts: shifts.map(({ interval, ...s }) => ({ ...s, status: (now < interval.start ? "upcoming" : now >= interval.end ? "done" : "now") as TodayShift["status"] })),
        late: late ? { minutes: late.mins, shiftId: late.s.id } : null,
      });
    }
    // Late first, then working now, then scheduled later, then the rest.
    const rank = (r: TodayRow) => (r.late ? 0 : r.clock !== "out" ? 1 : r.shifts.some((s) => s.status !== "done") ? 2 : r.onLeave ? 3 : 4);
    out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return {
      now: new Date(now).toISOString(),
      counts: {
        working: out.filter((r) => r.clock !== "out").length,
        late: out.filter((r) => r.late).length,
        scheduled: out.filter((r) => r.shifts.length).length,
        onLeave: out.filter((r) => r.onLeave).length,
      },
      people: out,
    };
  });

  // ── Leave calendar ───────────────────────────────────────────────────────

  app.get("/api/time/leave-calendar", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const { month, team: teamQ } = req.query as { month?: string; team?: string };
    if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return bad(reply, "month as YYYY-MM");
    if (teamQ && !canSee(m.teams, teamQ)) return bad(reply, "not your team", 403);
    const first = `${month}-01`;
    const [y, mo] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); // day 0 of next month = last of this one
    const days: string[] = [];
    for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);
    const admin = await isPayrollAdmin(m.user.id);
    const people = (await peopleIn(teamQ ? [teamQ] : m.teams)).filter((p) => (!teamQ || p.team === teamQ) && (p.id !== m.user.id || admin));
    const leave = people.length ? await q(
      `SELECT r.id, r.user_id, r.code, t.name AS type_name, t.paid, r.start_date::text AS start_date, r.end_date::text AS end_date, r.days::float AS days, r.status
         FROM leave_requests r JOIN leave_types t ON t.code = r.code
        WHERE r.user_id = ANY($1::int[]) AND r.status IN ('approved', 'pending') AND r.start_date <= $3 AND r.end_date >= $2
        ORDER BY r.start_date`,
      [people.map((p) => p.id), first, last],
    ) : [];
    return { month, days, people: people.map((p) => ({ userId: p.id, name: p.name, team: p.team, workDays: p.work_days ?? [1, 2, 3, 4, 5] })), leave };
  });

  // ── Exports ──────────────────────────────────────────────────────────────

  /** Managers: every shift worked on their teams, one row per clock-in, for a week or a month. */
  app.get("/api/time/export/timesheets", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const { from, to, team: teamQ } = req.query as { from?: string; to?: string; team?: string };
    if (!isDate(from) || !isDate(to) || to < from) return bad(reply, "from and to as YYYY-MM-DD");
    if (to > addDays(from, 62)) return bad(reply, "at most about two months at a time");
    if (teamQ && !canSee(m.teams, teamQ)) return bad(reply, "not your team", 403);
    const admin = await isPayrollAdmin(m.user.id);
    const people = (await peopleIn(teamQ ? [teamQ] : m.teams)).filter((p) => (!teamQ || p.team === teamQ) && (p.id !== m.user.id || admin));
    const emails = new Map((await q<{ id: number; email: string }>(`SELECT id, email FROM users WHERE id = ANY($1::int[])`, [people.map((p) => p.id)])).map((r) => [r.id, r.email]));
    const rows: unknown[][] = [["name", "email", "team", "date", "clock_in", "clock_out", "break_min", "worked_min", "worked", "approved", "timezone", "note"]];
    const now = Date.now();
    for (const p of people) {
      const tz = await tzOf(p.id);
      const start = zonedTime(from, "00:00", tz), end = zonedTime(addDays(to, 1), "00:00", tz);
      const { sessions, flags } = pairEvents(await eventsBetween(p.id, start, end), now, tz);
      const approved = new Set((await q<{ week_start: string }>(`SELECT week_start::text AS week_start FROM timesheet_weeks WHERE user_id = $1 AND approved_at IS NOT NULL`, [p.id])).map((r) => r.week_start));
      for (const s of sessions) {
        const date = localDate(s.start, tz);
        if (date < from || date > to) continue;
        const brk = s.breaks.reduce((n, x) => n + (x.end - x.start), 0) / 60_000;
        const worked = s.work.reduce((n, x) => n + (x.end - x.start), 0) / 60_000;
        const flag = flags.find((f) => f.at === s.start);
        rows.push([
          p.name, emails.get(p.id) ?? "", p.team ?? "", date, fmtLocal(s.start, tz).slice(11), s.end ? fmtLocal(s.end, tz).slice(11) : "",
          Math.round(brk), Math.round(worked), hm(worked), approved.has(weekStart(date)) ? "yes" : "no", tz,
          flag ? flag.message : s.end === null ? "still clocked in" : "",
        ]);
      }
    }
    return csvReply(reply, `timesheets-${from}-to-${to}.csv`, rows);
  });

  /** Payroll admins: hours by person for any period — worked, and what managers approved. */
  app.get("/api/time/export/hours", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    if (!(await isPayrollAdmin(u.id))) return bad(reply, "payroll admins only", 403);
    const { from, to } = req.query as { from?: string; to?: string };
    if (!isDate(from) || !isDate(to) || to < from) return bad(reply, "from and to as YYYY-MM-DD");
    if (to > addDays(from, 366)) return bad(reply, "at most a year at a time");
    const people = await q<{ id: number; name: string; email: string; team: string | null }>(
      `SELECT u.id, u.name, u.email, m.team FROM users u LEFT JOIN time_members m ON m.user_id = u.id
        WHERE EXISTS (SELECT 1 FROM clock_events e WHERE e.user_id = u.id) ORDER BY u.name`,
    );
    const rows: unknown[][] = [["name", "email", "team", "timezone", "worked_min", "worked_hours", "approved_min", "approved_hours"]];
    const now = Date.now();
    for (const p of people) {
      const tz = await tzOf(p.id);
      const { sessions } = pairEvents(await eventsBetween(p.id, zonedTime(from, "00:00", tz), zonedTime(addDays(to, 1), "00:00", tz)), now, tz);
      const worked = Object.entries(minutesByDay(sessions, tz)).filter(([d]) => d >= from && d <= to).reduce((n, [, v]) => n + v, 0);
      const approvedMin = await approvedMinutes(p.id, from, to);
      if (!worked && !approvedMin) continue;
      rows.push([p.name, p.email, p.team ?? "", tz, worked, (worked / 60).toFixed(2), approvedMin, (approvedMin / 60).toFixed(2)]);
    }
    return csvReply(reply, `hours-${from}-to-${to}.csv`, rows);
  });

  // ── Status from the clock ────────────────────────────────────────────────

  /** After clocking out, the person may choose to show as Away in the office. Only ever their own status. */
  app.post("/api/time/status", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    const status = body(req).status;
    if (status !== "away" && status !== "available") return bad(reply, "status is away or available");
    return { ok: true, changed: setStatusFor(u.id, status), inOffice: statusOf(u.id) !== null };
  });
}

/** Called by the clock route: back on the clock means Available, if they'd been Away. */
export function statusOnClock(userId: number, kind: string): { statusChanged: "available" | null; suggestAway: boolean } {
  const now = statusOf(userId);
  if (kind === "in" && now === "away") return { statusChanged: setStatusFor(userId, "available") ? "available" : null, suggestAway: false };
  return { statusChanged: null, suggestAway: kind === "out" && now !== null && now !== "away" };
}
