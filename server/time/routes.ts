// Time & Payroll — time routes: clock, timesheets, leave, shifts, swaps.
// Pay never appears here; managers see hours only.
// Nothing in this file touches LiveKit, so clocking in works while audio/video is down.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { one, q, tx } from "../db";
import type { UserRow } from "../auth";
import { setClockLookup, setLeaveLookup, showOnLeave, updateUser } from "../office";
import { runAwayNudges } from "./away";
import { config } from "../config";
import { slackDm } from "../slack";
import { approversFor, canManage, isPayrollAdmin, managedTeams, teamOf } from "../payroll/grants";
import { addDays, isDate, isTime, isTz, isWorkDays, leaveDays, leaveMonths, localDate, minutesByDay, NEXT, pairEvents, shiftInterval, thisWeek, weekStart, zonedTime, type ClockKind } from "../../shared/time";
import { audit } from "./db";
import { accrualNote, type AccrualKind } from "./accrual";
import { registerTimeDevRoutes } from "./dev";
import { eventsBetween, expectedByDay, tzOf, viewerTz, weekSummary, workDaysOf } from "./hours";
import { registerPeopleRoutes } from "./people";
import { applyPendingDeputy, registerDeputyRoutes } from "./deputy";
import { registerScheduleRoutes, scheduleConflicts, statusOnClock } from "./schedule";
import { registerProjectRoutes, stopProjectTimer } from "./projects";

type NeedUser = (req: FastifyRequest, reply: FastifyReply) => UserRow | null;

const KINDS: ClockKind[] = ["in", "out", "break_start", "break_end"];
const bad = (reply: FastifyReply, error: string, code = 400) => reply.code(code).send({ error });
const body = (req: FastifyRequest) => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
const intParam = (v: unknown) => (typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : NaN);
/** An id from a JSON body: a positive integer Postgres can hold, else NaN (a 400, never a 500). */
const idOf = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 && (v as number) < 2_000_000_000 ? (v as number) : typeof v === "string" ? intParam(v) : NaN);
/** Run `fn` after any earlier call for the same key has finished (per-person clock changes). */
const queues = new Map<number, Promise<unknown>>();
function serial<T>(key: number, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}
const DATE_COLS = (alias = "") => `${alias}start_date::text AS start_date, ${alias}end_date::text AS end_date`;

interface ShiftRow { id: number; user_id: number | null; team: string; date: string; start_local: string; end_local: string; timezone: string; note: string | null; published_at?: Date | string | null }

/** Add real start/end instants: shifts run any hour, and an end before the start is the next morning. */
const withInstants = <T extends ShiftRow>(rows: T[]) =>
  rows.map((s) => {
    const i = shiftInterval(s.date, s.start_local, s.end_local, isTz(s.timezone) ? s.timezone : "UTC");
    return { ...s, starts_at: new Date(i.start).toISOString(), ends_at: new Date(i.end).toISOString(), overnight: s.end_local <= s.start_local, published: Boolean(s.published_at) };
  });

/** "October 2026" for a YYYY-MM. */
const monthName = (period: string) => new Date(`${period}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** Months among `months` whose pay run is closed: leave there can't change pay any more. */
async function closedPayMonths(months: string[]): Promise<string[]> {
  if (!months.length) return [];
  try {
    return (await q<{ period: string }>(`SELECT period FROM pay_runs WHERE status = 'closed' AND period = ANY($1::text[]) ORDER BY period`, [months])).map((r) => r.period);
  } catch (e) {
    if ((e as { code?: string })?.code === "42P01") return []; // no payroll tables on this database
    throw e;
  }
}

/** Best-effort Slack DM; a Slack outage never fails the request. */
async function tell(userId: number, text: string) {
  try {
    const u = await one<{ slack_id: string | null }>(`SELECT slack_id FROM users WHERE id = $1`, [userId]);
    if (u?.slack_id) await slackDm(u.slack_id, text);
  } catch (e) {
    console.error("time: slack dm failed:", (e as Error).message);
  }
}

/** Person's current clock state, from today's (and a bit before) events. */
async function clockState(userId: number, now = Date.now()) {
  const tz = await tzOf(userId);
  const events = await eventsBetween(userId, now - 24 * 3600_000, now + 1);
  const { state, sessions, flags } = pairEvents(events, now, tz);
  const open = sessions.find((s) => s.end === null && s.work.length);
  return { tz, state, since: open ? new Date(open.start).toISOString() : null, onBreakSince: open?.breakOpen ? new Date(open.breakOpen).toISOString() : null, sessions, flags };
}

/** The office marks who's clocked in; tell it whenever someone's clock changes. */
async function syncClock(userId: number) {
  const st = await clockState(userId);
  updateUser(userId, { clock: st.state === "out" ? null : st.state });
  // Not working (or on a break) means not working on a project either.
  if (st.state !== "in") await stopProjectTimer(userId);
}

export function registerTimeRoutes(app: FastifyInstance, needUser: NeedUser) {
  registerTimeDevRoutes(app);
  // Clocked in but not in the office for 2 hours: one DM per away stretch (time/away.ts). Every 5 minutes.
  const awayClock = async (id: number, now: number) => { const st = await clockState(id, now); return { state: st.state, since: st.since }; };
  setInterval(() => void runAwayNudges(awayClock, tell), 5 * 60_000).unref();
  app.post("/api/dev/away-nudges", async (req, reply) => {
    if (!config.devLogin || config.production) return reply.code(404).send();
    const at = Date.parse(String((req.body as any)?.now ?? ""));
    return { sent: await runAwayNudges(awayClock, tell, Number.isFinite(at) ? at : Date.now()) };
  });
  setClockLookup(async (userId) => { const st = await clockState(userId); return st.state === "out" ? null : st.state; });
  // Walking into the office on a day of approved leave (their pay-profile timezone, else this browser's, else the one on file).
  setLeaveLookup(async (userId, tz) => {
    const today = localDate(Date.now(), await tzOf(userId, tz));
    return Boolean(await one(`SELECT 1 FROM leave_requests WHERE user_id = $1 AND status = 'approved' AND start_date <= $2 AND end_date >= $2 LIMIT 1`, [userId, today]));
  });
  /** Signed-in member; 403 for anyone removed. */
  const member = (req: FastifyRequest, reply: FastifyReply) => {
    const u = needUser(req, reply);
    if (u && u.removed) { bad(reply, "removed", 403); return null; }
    return u;
  };
  /** A manager of at least one team (or payroll admin). */
  const manager = async (req: FastifyRequest, reply: FastifyReply) => {
    const u = member(req, reply);
    if (!u) return null;
    const teams = await managedTeams(u.id);
    if (!teams.length) { bad(reply, "managers only", 403); return null; }
    return { user: u, teams };
  };
  /** User ids in the teams someone manages ('*' = everyone not removed). */
  // Each person's timezone the way tzOf decides it (pay profile first, then the last browser), so the
  // schedule converts a shift to the same clock their hours and pay use. NULL only when nothing's known.
  const TZ_SQL = `COALESCE((SELECT p.timezone FROM pay_profiles p WHERE (p.user_id = u.id OR p.email = lower(u.email)) AND p.timezone IS NOT NULL ORDER BY p.effective_from DESC, p.id DESC LIMIT 1), u.tz) AS tz`;
  const peopleIn = async (teams: string[]) => {
    type Row = { id: number; name: string; team: string | null; tz: string | null; work_days: number[] | null };
    const rows = teams.includes("*")
      ? await q<Row>(`SELECT u.id, u.name, m.team, ${TZ_SQL}, m.work_days FROM users u LEFT JOIN time_members m ON m.user_id = u.id WHERE NOT u.removed ORDER BY u.name`)
      : await q<Row>(`SELECT u.id, u.name, m.team, ${TZ_SQL}, m.work_days FROM users u JOIN time_members m ON m.user_id = u.id WHERE NOT u.removed AND m.team = ANY($1::text[]) ORDER BY u.name`, [teams]);
    return rows.map((r) => ({ ...r, tz: isTz(r.tz) ? r.tz : null }));
  };

  // ── Me ───────────────────────────────────────────────────────────────────

  app.get("/api/time/me", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    // Someone who only ever uses /time (never joins the office) still needs a timezone
    // for their days to split right: take the browser's if we have none.
    const browserTz = req.headers["x-timezone"];
    if (!u.tz && typeof browserTz === "string" && isTz(browserTz)) {
      await q(`UPDATE users SET tz = $1 WHERE id = $2 AND tz IS NULL`, [browserTz, u.id]);
      u.tz = browserTz;
      // A Deputy regular week waits for their timezone; now it's known.
      await applyPendingDeputy(null, u.id).catch((e) => console.error("deputy apply", e));
    }
    const now = Date.now();
    const st = await clockState(u.id, now);
    const today = localDate(now, st.tz);
    const week = await weekSummary(u.id, today, now);
    const team = await teamOf(u.id);
    const upcomingShifts = withInstants(await q<ShiftRow>(
      `SELECT id, user_id, team, date::text AS date, start_local, end_local, timezone, note FROM shifts
        WHERE user_id = $1 AND published_at IS NOT NULL AND date >= $2 AND date <= $3 ORDER BY date, start_local`,
      [u.id, addDays(today, -1), addDays(today, 14)],
    )).filter((s) => Date.parse(s.ends_at) > now);
    const leaveBalances = (await q<{ code: string; has_balance: boolean; accrual: AccrualKind | null; days_per_year: number | null }>(
      `SELECT t.code, t.name, t.paid, t.has_balance, t.accrual, COALESCE(b.days, 0)::float AS days, e.days_per_year::float AS days_per_year
         FROM leave_types t
        LEFT JOIN leave_balances b ON b.code = t.code AND b.user_id = $1
        LEFT JOIN leave_entitlements e ON e.code = t.code AND e.user_id = $1 ORDER BY t.code`,
      [u.id],
    )).map(({ accrual, days_per_year, ...b }) => ({ ...b, ...accrualNote(b.has_balance ? accrual : null, days_per_year) }));
    const leaveRequests = await q(
      `SELECT id, code, ${DATE_COLS()}, days::float AS days, status, note, decision_note, created_at FROM leave_requests
        WHERE user_id = $1 ORDER BY start_date DESC LIMIT 30`,
      [u.id],
    );
    return {
      clockedIn: st.state !== "out",
      onBreak: st.state === "break",
      state: st.state,
      next: NEXT[st.state],
      since: st.since,
      onBreakSince: st.onBreakSince,
      timezone: st.tz,
      todayMinutes: week.days.find((d) => d.date === today)?.minutes ?? 0,
      weekMinutes: week.total,
      flags: [...st.flags, ...week.flags].filter((f, i, a) => a.findIndex((g) => g.at === f.at && g.code === f.code) === i),
      upcomingShifts,
      leaveBalances,
      leaveRequests,
      team,
      isManager: (await managedTeams(u.id)).length > 0,
      isPayrollAdmin: await isPayrollAdmin(u.id),
    };
  });

  app.post("/api/time/clock", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    const kind = body(req).kind as ClockKind;
    if (!KINDS.includes(kind)) return bad(reply, "kind must be in, out, break_start or break_end");
    // One clock change per person at a time: two tabs pressing "Clock in" together
    // must not both pass the state check (Postgres runs them on separate connections).
    return serial(u.id, async () => {
    const st = await clockState(u.id);
    if (!NEXT[st.state].includes(kind)) {
      const msg = { out: "You're not clocked in.", in: kind === "in" ? "You're already clocked in." : "You're not on a break.", break: "You're on a break — end it or clock out." }[st.state];
      return bad(reply, msg, 409);
    }
    const row = await one<{ id: number; at: Date }>(`INSERT INTO clock_events (user_id, kind, at, source, created_by) VALUES ($1, $2, now(), 'web', $1) RETURNING id, at`, [u.id, kind]);
    const after = await clockState(u.id);
    await syncClock(u.id);
    return { ok: true, id: row!.id, at: row!.at, state: after.state, next: NEXT[after.state], since: after.since, ...statusOnClock(u.id, kind) };
    });
  });

  app.get("/api/time/timesheet", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    const qs = req.query as { week?: string; user?: string };
    let target = u.id;
    if (qs.user !== undefined) {
      target = intParam(qs.user);
      if (!Number.isFinite(target)) return bad(reply, "bad user");
      if (target !== u.id && !(await canManage(u.id, target))) return bad(reply, "not your team", 403);
    }
    const week = qs.week && isDate(qs.week) ? qs.week : localDate(Date.now(), await tzOf(target));
    return weekSummary(target, week);
  });

  // ── Leave ────────────────────────────────────────────────────────────────

  app.post("/api/time/leave", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    const b = body(req);
    const { code, start_date, end_date } = b as { code?: string; start_date?: string; end_date?: string };
    const note = typeof b.note === "string" ? b.note.slice(0, 500) : null;
    if (!isDate(start_date) || !isDate(end_date) || end_date < start_date) return bad(reply, "start_date and end_date (YYYY-MM-DD), end on or after start");
    // Bound the span before counting days: a year-9999 end date would block the server for seconds.
    if (end_date > addDays(start_date, 366)) return bad(reply, "leave can span at most a year — talk to payroll");
    // Counted against their own working days: Acme is open 24/7. A half day is one date, 0.5.
    const halfDay = b.half_day === true;
    const days = leaveDays(start_date, end_date, await workDaysOf(u.id), halfDay);
    if (halfDay && Number.isNaN(days)) return bad(reply, start_date !== end_date ? "a half day is one date — pick the same From and To" : "that isn't one of your working days");
    if (days === 0) return bad(reply, "none of those days are your working days");
    if (days > 60) return bad(reply, "more than 60 working days — talk to payroll");
    const type = await one<{ code: string; name: string; has_balance: boolean; paid: boolean }>(`SELECT code, name, has_balance, paid FROM leave_types WHERE code = $1`, [code ?? ""]);
    if (!type) return bad(reply, "unknown leave type");
    // Unpaid leave comes off that month's pay. Once the month's pay run is closed it never would.
    if (!type.paid) {
      const closed = await closedPayMonths(leaveMonths(start_date, end_date, await workDaysOf(u.id)));
      if (closed.length) return bad(reply, `${closed.map(monthName).join(" and ")} pay is already closed, so unpaid leave then can't come off it. Ask payroll to take it off a later month instead.`, 409);
    }
    // Check and insert one request at a time per person: a double-click must not make two.
    const row = await serial(u.id, async () => {
      const overlap = await one(`SELECT id FROM leave_requests WHERE user_id = $1 AND status IN ('pending', 'approved') AND start_date <= $3 AND end_date >= $2`, [u.id, start_date, end_date]);
      if (overlap) return null;
      return one<{ id: number }>(
        `INSERT INTO leave_requests (user_id, code, start_date, end_date, days, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [u.id, type.code, start_date, end_date, days, note],
      );
    });
    if (!row) return bad(reply, "you already have leave on some of those days", 409);
    await audit(u.id, "request", "leave_request", row!.id, null, { code: type.code, start_date, end_date, days }, note);
    // Their managers hear about it (no manager on the team: the payroll admins). Never holds up the request.
    const when = start_date === end_date ? start_date : `${start_date} → ${end_date}`;
    const ask = `${u.name} asked for ${type.name.toLowerCase()} leave: ${when} (${days} ${days === 1 ? "day" : "days"})${note ? `: "${note}"` : ""}. Approve or decline in Proximity Office → Time → Team → Approvals.`;
    void approversFor(u.id).then((ids) => Promise.all(ids.map((id) => tell(id, ask)))).catch((e) => console.error("leave request dm:", e));
    return { ok: true, id: row!.id, days };
  });

  app.delete("/api/time/leave/:id", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    const id = intParam((req.params as any).id);
    if (!Number.isFinite(id)) return bad(reply, "not found", 404);
    const r = await one(`UPDATE leave_requests SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING id`, [id, u.id]);
    if (!r) return bad(reply, "no pending leave request of yours with that id", 404);
    await audit(u.id, "cancel", "leave_request", id, { status: "pending" }, { status: "cancelled" }, null);
    return { ok: true };
  });

  // ── Shifts & swaps ───────────────────────────────────────────────────────

  app.get("/api/time/shifts", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    const { from, to, team: teamQ } = req.query as { from?: string; to?: string; team?: string };
    const today = localDate(Date.now(), await tzOf(u.id));
    const f = isDate(from) ? from : weekStart(today);
    const t = isDate(to) ? to : addDays(f, 13);
    if (t < f || t > addDays(f, 92)) return bad(reply, "bad range (at most ~3 months)");
    const myTeam = await teamOf(u.id);
    const teams = await managedTeams(u.id);
    // Managers can look at a team they manage; everyone sees their own shifts and their team's open shifts.
    if (teamQ && (teams.includes("*") || teams.includes(teamQ))) {
      return withInstants(await q<ShiftRow>(`SELECT s.id, s.user_id, u.name AS user_name, s.team, s.date::text AS date, s.start_local, s.end_local, s.timezone, s.note, s.published_at
                  FROM shifts s LEFT JOIN users u ON u.id = s.user_id WHERE s.team = $1 AND s.date BETWEEN $2 AND $3 ORDER BY s.date, s.start_local`, [teamQ, f, t]));
    }
    return withInstants(await q<ShiftRow>(
      `SELECT s.id, s.user_id, u.name AS user_name, s.team, s.date::text AS date, s.start_local, s.end_local, s.timezone, s.note, s.published_at
         FROM shifts s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.published_at IS NOT NULL AND s.date BETWEEN $2 AND $3 AND (s.user_id = $1 OR (s.user_id IS NULL AND s.team = $4)) ORDER BY s.date, s.start_local`,
      [u.id, f, t, myTeam ?? null],
    ));
  });

  app.post("/api/time/shifts/:id/claim", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    const id = intParam((req.params as any).id);
    if (!Number.isFinite(id)) return bad(reply, "not found", 404);
    const team = await teamOf(u.id);
    // Atomic: two people clicking at once can't both get it.
    const r = await one(`UPDATE shifts SET user_id = $1, updated_at = now() WHERE id = $2 AND user_id IS NULL AND team = $3 AND published_at IS NOT NULL RETURNING id`, [u.id, id, team ?? null]);
    if (!r) return bad(reply, "that shift isn't open (or isn't your team's)", 409);
    await audit(u.id, "claim", "shift", id, { user_id: null }, { user_id: u.id });
    return { ok: true };
  });

  app.post("/api/time/swaps", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    const b = body(req);
    const shiftId = idOf(b.shift_id), toUser = idOf(b.to_user);
    if (!Number.isInteger(shiftId) || !Number.isInteger(toUser)) return bad(reply, "shift_id and to_user");
    if (toUser === u.id) return bad(reply, "you can't swap with yourself");
    const shift = await one<{ user_id: number | null; team: string; date: string; published: boolean }>(`SELECT user_id, team, date::text AS date, published_at IS NOT NULL AS published FROM shifts WHERE id = $1`, [shiftId]);
    if (!shift || shift.user_id !== u.id) return bad(reply, "that's not your shift", 403);
    // Only shifts you can see and haven't worked yet (a day of slack for timezones).
    if (!shift.published || shift.date < addDays(localDate(Date.now(), "UTC"), -1)) return bad(reply, "you can only swap an upcoming, published shift");
    if ((await teamOf(toUser)) !== shift.team) return bad(reply, "they're not on this shift's team");
    const dup = await one(`SELECT id FROM swap_requests WHERE shift_id = $1 AND status IN ('proposed', 'accepted')`, [shiftId]);
    if (dup) return bad(reply, "there's already a swap open for that shift", 409);
    const row = await one<{ id: number }>(`INSERT INTO swap_requests (shift_id, from_user, to_user, note) VALUES ($1, $2, $3, $4) RETURNING id`, [shiftId, u.id, toUser, typeof b.note === "string" ? b.note.slice(0, 500) : null])
      .catch((e) => { if ((e as { code?: string }).code === "23505") return null; throw e; }); // two asks at once: the index keeps one
    if (!row) return bad(reply, "there's already a swap open for that shift", 409);
    void tell(toUser, `${u.name} asked you to take their ${shift.date} shift. Open Proximity Office → Time to accept.`);
    return { ok: true, id: row!.id };
  });

  app.post("/api/time/swaps/:id/accept", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    const id = intParam((req.params as any).id);
    if (!Number.isFinite(id)) return bad(reply, "not found", 404);
    const r = await one<{ from_user: number }>(`UPDATE swap_requests SET status = 'accepted', updated_at = now() WHERE id = $1 AND to_user = $2 AND status = 'proposed' RETURNING from_user`, [id, u.id]);
    if (!r) return bad(reply, "no swap waiting for you with that id", 404);
    void tell(r.from_user, `${u.name} accepted your shift swap. It goes to a manager for approval.`);
    return { ok: true };
  });

  /** The person asked says no. Only while it's still waiting on them. */
  app.post("/api/time/swaps/:id/decline", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    const id = intParam((req.params as any).id);
    if (!Number.isFinite(id)) return bad(reply, "not found", 404);
    const r = await one<{ from_user: number }>(`UPDATE swap_requests SET status = 'declined', updated_at = now() WHERE id = $1 AND to_user = $2 AND status = 'proposed' RETURNING from_user`, [id, u.id]);
    if (!r) return bad(reply, "no swap waiting for you with that id", 404);
    await audit(u.id, "decline", "swap", id, { status: "proposed" }, { status: "declined" });
    void tell(r.from_user, `${u.name} can't take your shift. Your swap request was declined, and the shift is still yours.`);
    return { ok: true };
  });

  /** The person who asked takes it back, until a manager has decided. */
  app.post("/api/time/swaps/:id/cancel", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    const id = intParam((req.params as any).id);
    if (!Number.isFinite(id)) return bad(reply, "not found", 404);
    const r = await one<{ to_user: number; before: string }>(
      `UPDATE swap_requests w SET status = 'cancelled', updated_at = now()
         FROM (SELECT id, status FROM swap_requests WHERE id = $1) old
        WHERE w.id = old.id AND w.from_user = $2 AND w.status IN ('proposed', 'accepted') RETURNING w.to_user, old.status AS before`,
      [id, u.id],
    );
    if (!r) return bad(reply, "no open swap of yours with that id", 404);
    await audit(u.id, "cancel", "swap", id, { status: r.before }, { status: "cancelled" });
    if (r.before === "accepted") void tell(r.to_user, `${u.name} cancelled the shift swap you'd accepted. You're not taking that shift.`);
    return { ok: true };
  });

  /** My swaps: ones waiting for my answer, and ones I asked for (recent only). */
  app.get("/api/time/swaps/mine", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    const today = localDate(Date.now(), await tzOf(u.id));
    const since = addDays(today, -14);
    const cols = `w.id, w.shift_id, w.status, w.note, w.created_at, w.updated_at,
                  s.date::text AS date, s.start_local, s.end_local, s.timezone, s.team`;
    // Waiting on me: only shifts that haven't happened yet (a day of slack for timezones).
    const incoming = await q(
      `SELECT ${cols}, w.from_user, fu.name AS from_name
         FROM swap_requests w JOIN shifts s ON s.id = w.shift_id JOIN users fu ON fu.id = w.from_user
        WHERE w.to_user = $1 AND w.status = 'proposed' AND s.date >= $2 ORDER BY s.date, s.start_local`,
      [u.id, addDays(today, -1)],
    );
    // What I asked for: still open, or settled in the last 14 days.
    const outgoing = await q(
      `SELECT ${cols}, w.to_user, tu.name AS to_name
         FROM swap_requests w JOIN shifts s ON s.id = w.shift_id JOIN users tu ON tu.id = w.to_user
        WHERE w.from_user = $1 AND (s.date >= $2 OR w.status IN ('proposed', 'accepted')) ORDER BY w.updated_at DESC LIMIT 50`,
      [u.id, since],
    );
    return { incoming, outgoing };
  });

  /** Who I can ask to take a shift: active people on my team, not me. */
  app.get("/api/time/teammates", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    const team = await teamOf(u.id);
    if (!team) return [];
    return q<{ id: number; name: string }>(
      `SELECT u.id, u.name FROM users u JOIN time_members m ON m.user_id = u.id WHERE m.team = $1 AND NOT u.removed AND u.id <> $2 ORDER BY u.name`,
      [team, u.id],
    );
  });

  // ── Manager ──────────────────────────────────────────────────────────────

  app.get("/api/time/team", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const wq = (req.query as { week?: string }).week;
    // No week asked for: this week where the manager is looking from.
    const week = isDate(wq) ? weekStart(wq) : thisWeek(Date.now(), await viewerTz(m.user.id, req.headers["x-timezone"]));
    const admin = await isPayrollAdmin(m.user.id);
    const people = (await peopleIn(m.teams)).filter((p) => p.id !== m.user.id || admin);
    const rows = [];
    for (const p of people) {
      const s = await weekSummary(p.id, week);
      // What they were supposed to work (Deputy: "did they work the 8 hours they're meant to?").
      const exp = await expectedByDay(p.id, s.days.map((d) => d.date));
      rows.push({
        userId: p.id, name: p.name, team: p.team, timezone: s.timezone,
        days: s.days.map((d) => ({ date: d.date, minutes: d.minutes, expected: exp[d.date] ?? 0 })),
        total: s.total, expectedTotal: Object.values(exp).reduce((a, b) => a + b, 0), approved: s.approved, flags: s.flags,
      });
    }
    return { weekStart: week, teams: m.teams, people: rows };
  });

  /** Any range (a month, a pay period): worked vs expected per person. Approving stays week by week. */
  app.get("/api/time/team/range", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const { from, to } = req.query as { from?: string; to?: string };
    if (!isDate(from) || !isDate(to) || to < from) return bad(reply, "from and to as YYYY-MM-DD");
    if (to > addDays(from, 62)) return bad(reply, "at most about two months at a time");
    const admin = await isPayrollAdmin(m.user.id);
    const people = (await peopleIn(m.teams)).filter((p) => p.id !== m.user.id || admin);
    const dates: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
    const weeks = [...new Set(dates.map(weekStart))];
    const rows = [];
    for (const p of people) {
      const tz = await tzOf(p.id);
      const { sessions, flags } = pairEvents(await eventsBetween(p.id, zonedTime(from, "00:00", tz), zonedTime(addDays(to, 1), "00:00", tz)), Date.now(), tz);
      const byDay = minutesByDay(sessions, tz);
      const worked = dates.reduce((n, d) => n + (byDay[d] ?? 0), 0);
      const exp = await expectedByDay(p.id, dates);
      const approved = await q<{ week_start: string }>(`SELECT week_start::text AS week_start FROM timesheet_weeks WHERE user_id = $1 AND approved_at IS NOT NULL AND week_start = ANY($2::date[])`, [p.id, weeks]);
      rows.push({
        userId: p.id, name: p.name, team: p.team, timezone: tz,
        worked, expected: Object.values(exp).reduce((a, b) => a + b, 0),
        daysWorked: dates.filter((d) => (byDay[d] ?? 0) > 0).length,
        flags: flags.filter((f) => { const d = localDate(f.at, tz); return d >= from && d <= to; }).length,
        weeksApproved: approved.length, weeks: weeks.length,
      });
    }
    return { from, to, people: rows };
  });

  app.post("/api/time/timesheets/approve", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const b = body(req);
    const userId = idOf(b.user_id);
    if (!Number.isInteger(userId) || !isDate(b.week_start)) return bad(reply, "user_id and week_start");
    if (!(await canManage(m.user.id, userId))) return bad(reply, "not your team", 403);
    const week = weekStart(b.week_start as string);
    // A week still in progress (in their timezone) can't be signed off: hours are still landing.
    if (Date.now() < zonedTime(addDays(week, 7), "00:00", await tzOf(userId))) return bad(reply, "that week isn't over yet in their timezone", 409);
    const s = await weekSummary(userId, week);
    if (s.flags.length && b.force !== true) return bad(reply, `fix ${s.flags.length} flagged clock problem(s) first: ${s.flags[0].message}`, 409);
    const before = await one(`SELECT approved_by, minutes_worked FROM timesheet_weeks WHERE user_id = $1 AND week_start = $2`, [userId, week]);
    // The days are kept as approved: pay counts these, not whatever the clock events say later.
    const byDay = Object.fromEntries(s.days.map((d) => [d.date, d.minutes]));
    await q(
      `INSERT INTO timesheet_weeks (user_id, week_start, approved_by, approved_at, minutes_worked, minutes_by_day) VALUES ($1, $2, $3, now(), $4, $5)
       ON CONFLICT (user_id, week_start) DO UPDATE SET approved_by = $3, approved_at = now(), minutes_worked = $4, minutes_by_day = $5`,
      [userId, week, m.user.id, s.total, JSON.stringify(byDay)],
    );
    await audit(m.user.id, "approve", "timesheet", `${userId}:${week}`, before, { minutes_worked: s.total, minutes_by_day: byDay }, b.force === true ? "approved with flags" : null);
    void tell(userId, `Your timesheet for the week of ${week} was approved (${Math.floor(s.total / 60)}h ${s.total % 60}m).`);
    return { ok: true, minutes: s.total };
  });

  app.post("/api/time/timesheets/unapprove", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const b = body(req);
    const userId = idOf(b.user_id);
    if (!Number.isInteger(userId) || !isDate(b.week_start)) return bad(reply, "user_id and week_start");
    if (!(await canManage(m.user.id, userId))) return bad(reply, "not your team", 403);
    const week = weekStart(b.week_start as string);
    const before = await one(`SELECT approved_by, minutes_worked FROM timesheet_weeks WHERE user_id = $1 AND week_start = $2`, [userId, week]);
    await q(`UPDATE timesheet_weeks SET approved_by = NULL, approved_at = NULL WHERE user_id = $1 AND week_start = $2`, [userId, week]);
    await audit(m.user.id, "unapprove", "timesheet", `${userId}:${week}`, before, null, typeof b.reason === "string" ? b.reason : null);
    return { ok: true };
  });

  /** A manager adds a missing clock event (e.g. the forgotten clock-out). Needs a reason; audited. */
  app.post("/api/time/events", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const b = body(req);
    const userId = idOf(b.user_id), kind = b.kind as ClockKind, reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "";
    const atMs = typeof b.at === "string" ? Date.parse(b.at) : NaN;
    if (!Number.isInteger(userId) || !KINDS.includes(kind) || !Number.isFinite(atMs)) return bad(reply, "user_id, kind and at (ISO time)");
    if (!reason) return bad(reply, "a reason is required");
    if (atMs > Date.now() + 60_000) return bad(reply, "that's in the future");
    if (!(await canManage(m.user.id, userId))) return bad(reply, "not your team", 403);
    if (await approvedWeek(userId, atMs)) return bad(reply, "that week is approved — unapprove it first", 409);
    const row = await one<{ id: number }>(
      `INSERT INTO clock_events (user_id, kind, at, source, created_by, reason) VALUES ($1, $2, $3, 'manager', $4, $5) RETURNING id`,
      [userId, kind, new Date(atMs).toISOString(), m.user.id, reason],
    );
    await audit(m.user.id, "add", "clock_event", row!.id, null, { user_id: userId, kind, at: new Date(atMs).toISOString() }, reason);
    await syncClock(userId);
    return { ok: true, id: row!.id };
  });

  app.post("/api/time/events/:id/void", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const id = intParam((req.params as any).id);
    if (!Number.isFinite(id)) return bad(reply, "not found", 404);
    const reason = typeof body(req).reason === "string" ? (body(req).reason as string).trim().slice(0, 500) : "";
    if (!reason) return bad(reply, "a reason is required");
    const ev = await one<{ user_id: number; kind: string; at: Date; voided_by: number | null }>(`SELECT user_id, kind, at, voided_by FROM clock_events WHERE id = $1`, [id]);
    if (!ev || ev.voided_by) return bad(reply, "no such event", 404);
    if (!(await canManage(m.user.id, ev.user_id))) return bad(reply, "not your team", 403);
    if (await approvedWeek(ev.user_id, new Date(ev.at).getTime())) return bad(reply, "that week is approved — unapprove it first", 409);
    await q(`UPDATE clock_events SET voided_by = $1, void_reason = $2 WHERE id = $3`, [m.user.id, reason, id]);
    await audit(m.user.id, "void", "clock_event", id, { kind: ev.kind, at: ev.at }, null, reason);
    await syncClock(ev.user_id);
    return { ok: true };
  });

  async function approvedWeek(userId: number, atMs: number) {
    const week = weekStart(localDate(atMs, await tzOf(userId)));
    return Boolean(await one(`SELECT 1 FROM timesheet_weeks WHERE user_id = $1 AND week_start = $2 AND approved_at IS NOT NULL`, [userId, week]));
  }

  app.get("/api/time/approvals", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const admin = await isPayrollAdmin(m.user.id);
    const ids = (await peopleIn(m.teams)).map((p) => p.id).filter((id) => id !== m.user.id || admin);
    if (!ids.length) return { leave: [], swaps: [], upcoming: [] };
    const leave = await q(
      `SELECT r.id, r.user_id, u.name, r.code, t.name AS type_name, t.paid, ${DATE_COLS("r.")}, r.days::float AS days, r.note, r.created_at,
              COALESCE(b.days, 0)::float AS balance
         FROM leave_requests r JOIN users u ON u.id = r.user_id JOIN leave_types t ON t.code = r.code
         LEFT JOIN leave_balances b ON b.user_id = r.user_id AND b.code = r.code
        WHERE r.status = 'pending' AND r.user_id = ANY($1::int[]) ORDER BY r.start_date`,
      [ids],
    );
    const swaps = await q(
      `SELECT w.id, w.shift_id, w.from_user, fu.name AS from_name, w.to_user, tu.name AS to_name, w.status, w.note,
              s.date::text AS date, s.start_local, s.end_local, s.team
         FROM swap_requests w JOIN shifts s ON s.id = w.shift_id JOIN users fu ON fu.id = w.from_user JOIN users tu ON tu.id = w.to_user
        WHERE w.status = 'accepted' AND w.from_user = ANY($1::int[]) ORDER BY s.date`,
      [ids],
    );
    // Approved leave still to come (or under way), so a manager can revoke it.
    const upcoming = await q(
      `SELECT r.id, r.user_id, u.name, r.code, t.name AS type_name, ${DATE_COLS("r.")}, r.days::float AS days
         FROM leave_requests r JOIN users u ON u.id = r.user_id JOIN leave_types t ON t.code = r.code
        WHERE r.status = 'approved' AND r.end_date >= CURRENT_DATE AND r.user_id = ANY($1::int[]) ORDER BY r.start_date LIMIT 200`,
      [ids],
    );
    return { leave, swaps, upcoming };
  });

  app.post("/api/time/leave/:id/decide", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const id = intParam((req.params as any).id);
    if (!Number.isFinite(id)) return bad(reply, "not found", 404);
    const b = body(req);
    const approve = b.approve === true;
    const note = typeof b.note === "string" ? b.note.slice(0, 500) : null;
    const r = await one<{ user_id: number; code: string; start_date: string; end_date: string; days: number; status: string }>(
      `SELECT user_id, code, ${DATE_COLS()}, days::float AS days, status FROM leave_requests WHERE id = $1`, [id]);
    if (!r || r.status !== "pending") return bad(reply, "no pending request with that id", 404);
    if (!(await canManage(m.user.id, r.user_id))) return bad(reply, "not your team", 403);
    const type = await one<{ has_balance: boolean; name: string; paid: boolean }>(`SELECT has_balance, name, paid FROM leave_types WHERE code = $1`, [r.code]);
    // One decision about a person's leave at a time, all or nothing: lock their user row, then
    // check overlap, decide, and charge the balance inside one transaction. Two managers approving
    // two overlapping requests at once can't both see "no overlap" (separate statements on separate
    // connections could), two approvals can't both find enough days, and a refusal undoes the rest.
    const charge = approve && type?.has_balance && r.days > 0;
    class Refused extends Error {}
    try {
      await tx(async (t) => {
        await t.q(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [r.user_id]);
        // Never two approved requests over the same days (that would charge the balance twice).
        if (approve && (await t.one(`SELECT id FROM leave_requests WHERE user_id = $1 AND id <> $2 AND status = 'approved' AND start_date <= $4 AND end_date >= $3`, [r.user_id, id, r.start_date, r.end_date]))) {
          throw new Refused("they already have approved leave on some of those days — decline this one");
        }
        // Only one decision wins if two managers click at once.
        const done = await t.one(`UPDATE leave_requests SET status = $1, decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $4 AND status = 'pending' RETURNING id`,
          [approve ? "approved" : "rejected", m.user.id, note, id]);
        if (!done) throw new Refused("someone else just decided it");
        // Checking and taking in one statement, as before; forced goes below zero.
        if (charge && b.force === true) {
          await t.q(`INSERT INTO leave_balances (user_id, code, days) VALUES ($1, $2, $3) ON CONFLICT (user_id, code) DO UPDATE SET days = leave_balances.days + $3`, [r.user_id, r.code, -r.days]);
        } else if (charge) {
          const took = await t.one(`UPDATE leave_balances SET days = days - $3 WHERE user_id = $1 AND code = $2 AND days >= $3 RETURNING days`, [r.user_id, r.code, r.days]);
          if (!took) {
            const bal = Number((await t.one<{ days: string }>(`SELECT days FROM leave_balances WHERE user_id = $1 AND code = $2`, [r.user_id, r.code]))?.days ?? 0);
            throw new Refused(`they have ${bal} ${type!.name.toLowerCase()} day(s) left and asked for ${r.days} — set their balance, decline, or approve anyway (force)`);
          }
        }
      });
    } catch (e) {
      if (e instanceof Refused) return bad(reply, e.message, 409);
      throw e;
    }
    await audit(m.user.id, approve ? "approve" : "reject", "leave_request", id, { status: "pending" }, { status: approve ? "approved" : "rejected" }, note);
    // On leave today: show it on the floor (the person can change it back). Walking in on a
    // later leave day does the same (setLeaveLookup above).
    if (approve) {
      const today = localDate(Date.now(), await tzOf(r.user_id));
      if (r.start_date <= today && r.end_date >= today) showOnLeave(r.user_id);
    }
    void tell(r.user_id, `Your ${type?.name ?? r.code} leave ${r.start_date} → ${r.end_date} was ${approve ? "approved" : "declined"}${note ? `: ${note}` : "."}`);
    // Asked before the month closed, approved after: it's on record, but pay won't see it by itself.
    const closed = approve && type && !type.paid ? await closedPayMonths(leaveMonths(r.start_date, r.end_date, await workDaysOf(r.user_id))) : [];
    if (closed.length) return { ok: true, warning: `Approved, but ${closed.map(monthName).join(" and ")} pay is already closed, so this unpaid leave won't come off it. Tell payroll to deduct it in an open month.` };
    return { ok: true };
  });

  // Approved leave that isn't happening after all (plans changed, entered wrong): the manager
  // revokes it, the balance comes back, and any pay run still open picks it up on recompute.
  app.post("/api/time/leave/:id/revoke", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const id = intParam((req.params as any).id);
    if (!Number.isFinite(id)) return bad(reply, "not found", 404);
    const note = typeof body(req).note === "string" ? (body(req).note as string).slice(0, 500) : null;
    if (!note) return bad(reply, "say why (note)");
    const r = await one<{ user_id: number; code: string; days: number }>(`SELECT user_id, code, days::float AS days FROM leave_requests WHERE id = $1 AND status = 'approved'`, [id]);
    if (!r) return bad(reply, "no approved request with that id", 404);
    if (!(await canManage(m.user.id, r.user_id))) return bad(reply, "not your team", 403);
    const done = await one(`UPDATE leave_requests SET status = 'cancelled', decided_by = $1, decided_at = now(), decision_note = $2 WHERE id = $3 AND status = 'approved' RETURNING id`, [m.user.id, note, id]);
    if (!done) return bad(reply, "someone else just changed it", 409);
    const type = await one<{ has_balance: boolean; name: string }>(`SELECT has_balance, name FROM leave_types WHERE code = $1`, [r.code]);
    if (type?.has_balance) {
      await q(`INSERT INTO leave_balances (user_id, code, days) VALUES ($1, $2, $3) ON CONFLICT (user_id, code) DO UPDATE SET days = leave_balances.days + $3`, [r.user_id, r.code, r.days]);
    }
    await audit(m.user.id, "revoke", "leave_request", id, { status: "approved" }, { status: "cancelled" }, note);
    void tell(r.user_id, `Your approved ${type?.name ?? r.code} leave was cancelled: ${note}`);
    return { ok: true };
  });

  app.post("/api/time/swaps/:id/decide", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const id = intParam((req.params as any).id);
    if (!Number.isFinite(id)) return bad(reply, "not found", 404);
    const approve = body(req).approve === true;
    const w = await one<{ shift_id: number; from_user: number; to_user: number; status: string }>(`SELECT shift_id, from_user, to_user, status FROM swap_requests WHERE id = $1`, [id]);
    if (!w || w.status !== "accepted") return bad(reply, "no accepted swap with that id", 404);
    if (!(await canManage(m.user.id, w.from_user)) || !(await canManage(m.user.id, w.to_user))) return bad(reply, "not your team", 403);
    const done = await one(`UPDATE swap_requests SET status = $1, decided_by = $2, updated_at = now() WHERE id = $3 AND status = 'accepted' RETURNING id`, [approve ? "approved" : "rejected", m.user.id, id]);
    if (!done) return bad(reply, "someone else just decided it", 409);
    if (approve) {
      const moved = await one(`UPDATE shifts SET user_id = $1, updated_at = now() WHERE id = $2 AND user_id = $3 RETURNING id`, [w.to_user, w.shift_id, w.from_user]);
      if (!moved) {
        await q(`UPDATE swap_requests SET status = 'cancelled' WHERE id = $1`, [id]);
        return bad(reply, "the shift changed hands since — swap cancelled", 409);
      }
    }
    await audit(m.user.id, approve ? "approve" : "reject", "swap", id, { status: "accepted" }, { status: approve ? "approved" : "rejected" });
    for (const uid of [w.from_user, w.to_user]) void tell(uid, `Your shift swap was ${approve ? "approved" : "declined"} by ${m.user.name}.`);
    return { ok: true };
  });

  app.post("/api/time/shifts", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const b = body(req);
    const team = typeof b.team === "string" ? b.team.trim() : "";
    const userId = b.user_id === null || b.user_id === undefined ? null : idOf(b.user_id);
    const dates = Array.isArray(b.dates) ? b.dates : [b.date];
    if (!team || !(m.teams.includes("*") || m.teams.includes(team))) return bad(reply, "not your team", 403);
    if (!dates.length || dates.length > 62 || !dates.every(isDate)) return bad(reply, "date (or dates[]) as YYYY-MM-DD");
    if (!isTime(b.start_local) || !isTime(b.end_local)) return bad(reply, "start_local and end_local as HH:MM (an end before the start runs past midnight)");
    if (b.start_local === b.end_local) return bad(reply, "a shift can't start and end at the same time");
    if (userId !== null) {
      if (!Number.isInteger(userId)) return bad(reply, "bad user_id");
      if ((await teamOf(userId)) !== team) return bad(reply, "they're not on that team");
    }
    // No timezone sent: the person's own; for an open shift, the manager's (never a silent UTC).
    const tz = isTz(b.timezone) ? b.timezone : await tzOf(userId ?? m.user.id);
    // They said they can't work then (or they're on leave): warn, and only go ahead if the manager insists.
    if (userId !== null && b.force !== true) {
      const conflicts = await scheduleConflicts(userId, dates as string[], b.start_local as string, b.end_local as string);
      if (conflicts.length) return reply.code(409).send({ error: `${conflicts[0].reason} (${conflicts[0].date}) — assign anyway?`, conflicts });
    }
    const ids: number[] = [];
    for (const date of dates as string[]) {
      const r = await one<{ id: number }>(
        `INSERT INTO shifts (user_id, team, date, start_local, end_local, timezone, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [userId, team, date, b.start_local, b.end_local, tz, typeof b.note === "string" ? b.note.slice(0, 300) : null, m.user.id],
      );
      ids.push(r!.id);
    }
    await audit(m.user.id, "create", "shift", ids.join(","), null, { team, user_id: userId, dates, start: b.start_local, end: b.end_local });
    return { ok: true, ids };
  });

  app.delete("/api/time/shifts/:id", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const id = intParam((req.params as any).id);
    if (!Number.isFinite(id)) return bad(reply, "not found", 404);
    const s = await one<{ team: string; user_id: number | null; date: string; start_local: string; end_local: string }>(`SELECT team, user_id, date::text AS date, start_local, end_local FROM shifts WHERE id = $1`, [id]);
    if (!s) return bad(reply, "no such shift", 404);
    if (!(m.teams.includes("*") || m.teams.includes(s.team))) return bad(reply, "not your team", 403);
    await q(`DELETE FROM shifts WHERE id = $1`, [id]);
    await audit(m.user.id, "delete", "shift", id, s, null);
    if (s.user_id) void tell(s.user_id, `Your ${s.date} ${s.start_local}–${s.end_local} shift was removed by ${m.user.name}.`);
    return { ok: true };
  });

  app.get("/api/time/templates", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    return m.teams.includes("*")
      ? q(`SELECT * FROM shift_templates ORDER BY team, name`)
      : q(`SELECT * FROM shift_templates WHERE team = ANY($1::text[]) ORDER BY team, name`, [m.teams]);
  });

  app.post("/api/time/templates", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const b = body(req);
    const team = typeof b.team === "string" ? b.team.trim() : "";
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : "";
    const dow = Array.isArray(b.days_of_week) ? b.days_of_week : [1, 2, 3, 4, 5];
    if (!team || !(m.teams.includes("*") || m.teams.includes(team))) return bad(reply, "not your team", 403);
    if (!name || !isTime(b.start_local) || !isTime(b.end_local)) return bad(reply, "name, start_local, end_local");
    if (!dow.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) return bad(reply, "days_of_week are 0 (Sunday) to 6");
    const r = await one<{ id: number }>(`INSERT INTO shift_templates (team, name, start_local, end_local, days_of_week) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [team, name, b.start_local, b.end_local, dow]);
    return { ok: true, id: r!.id };
  });

  /** Put someone on a team. Payroll admins and all-team managers only: teams decide who manages whom. */
  app.put("/api/time/members/:userId", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    if (!m.teams.includes("*")) return bad(reply, "only payroll admins (or all-team managers) can move people between teams", 403);
    const userId = intParam((req.params as any).userId);
    // Your own team and working days feed your own pay maths: payroll admins only.
    if (userId === m.user.id && !(await isPayrollAdmin(m.user.id))) return bad(reply, "ask a payroll admin to change your own team or working days", 403);
    const b = body(req);
    const team = typeof b.team === "string" ? b.team.trim().slice(0, 60) : "";
    if (!Number.isFinite(userId) || !(await one(`SELECT 1 FROM users WHERE id = $1`, [userId]))) return bad(reply, "bad user");
    if (b.work_days !== undefined && !isWorkDays(b.work_days)) return bad(reply, "work_days: distinct days 0 (Sunday) to 6");
    const before = await one(`SELECT team, work_days FROM time_members WHERE user_id = $1`, [userId]);
    if (!team) await q(`DELETE FROM time_members WHERE user_id = $1`, [userId]);
    else await q(`INSERT INTO locations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [team]);
    if (team) await q(
      `INSERT INTO time_members (user_id, team, work_days) VALUES ($1, $2, COALESCE($3::int[], '{1,2,3,4,5}'))
       ON CONFLICT (user_id) DO UPDATE SET team = $2, work_days = COALESCE($3::int[], time_members.work_days)`,
      [userId, team, b.work_days ?? null],
    );
    await audit(m.user.id, "set_team", "member", userId, before, { team: team || null, work_days: b.work_days ?? null });
    return { ok: true };
  });

  /** Set someone's leave balance (e.g. the yearly vacation allowance). Audited. */
  app.put("/api/time/balances/:userId", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const userId = intParam((req.params as any).userId);
    const b = body(req);
    const days = Number(b.days);
    if (!Number.isFinite(userId) || typeof b.code !== "string" || !Number.isFinite(days) || Math.abs(days) > 365) return bad(reply, "code and days");
    if (!(await canManage(m.user.id, userId))) return bad(reply, "not your team", 403);
    const type = await one<{ has_balance: boolean }>(`SELECT has_balance FROM leave_types WHERE code = $1`, [b.code]);
    if (!type?.has_balance) return bad(reply, "that leave type has no balance");
    const before = await one(`SELECT days FROM leave_balances WHERE user_id = $1 AND code = $2`, [userId, b.code]);
    await q(`INSERT INTO leave_balances (user_id, code, days) VALUES ($1, $2, $3) ON CONFLICT (user_id, code) DO UPDATE SET days = $3`, [userId, b.code, days]);
    await audit(m.user.id, "set_balance", "leave_balance", `${userId}:${b.code}`, before, { days }, typeof b.reason === "string" ? b.reason : null);
    return { ok: true };
  });

  registerScheduleRoutes(app, { member, manager, peopleIn, tell });
  registerPeopleRoutes(app, { member, manager, peopleIn });
  registerDeputyRoutes(app, member);
  registerProjectRoutes(app, { member, manager, peopleIn, clockedIn: async (id) => (await clockState(id)).state === "in" });

  app.get("/api/time/members", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    return peopleIn(m.teams);
  });

}
