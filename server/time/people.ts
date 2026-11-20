// Deputy parity:
//   dashboard   what's waiting on me: leave requests, timesheets to approve, swaps
//   locations   departments (Deputy's "locations") that people, shifts and managers hang off
//   people      each person's start date, regular week (hours + break) and leave entitlements
//   coverage    who's expected on a day / week / month, and who's off and why
// Managers see hours, never pay.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { one, q } from "../db";
import type { UserRow } from "../auth";
import { canManage, isPayrollAdmin } from "../payroll/grants";
import { addDays, expectedMinutesOn, isDate, isRegularHours, isWorkDays, lastFullWeek, shiftInterval, isTz, MON_FRI, type RegularDay } from "../../shared/time";
import { audit } from "./db";
import { tzOf, viewerTz, weekSummary } from "./hours";

type Member = (req: FastifyRequest, reply: FastifyReply) => UserRow | null;
type Manager = (req: FastifyRequest, reply: FastifyReply) => Promise<{ user: UserRow; teams: string[] } | null>;
type PeopleIn = (teams: string[]) => Promise<{ id: number; name: string; team: string | null; tz: string | null; work_days: number[] | null }[]>;

const bad = (reply: FastifyReply, error: string, code = 400) => reply.code(code).send({ error });
const body = (req: FastifyRequest) => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
const intParam = (v: unknown) => (typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : NaN);
const canSee = (teams: string[], team: string) => teams.includes("*") || teams.includes(team);
const LOCATION = /^[\p{L}\p{N} &'’().,/+-]{1,60}$/u;

interface ProfileRow { id: number; name: string; email: string; team: string | null; tz: string | null; work_days: number[] | null; start_date: string | null; regular_hours: unknown; profile_start: string | null; profile_tz: string | null }

export function registerPeopleRoutes(app: FastifyInstance, { member, manager, peopleIn }: { member: Member; manager: Manager; peopleIn: PeopleIn }) {
  const allTeams = (teams: string[]) => teams.includes("*");

  // ── Dashboard: what's waiting on me ────────────────────────────────────────
  app.get("/api/time/dashboard", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const admin = await isPayrollAdmin(m.user.id);
    // Only people placed in a location are on the time system; the rest have nothing to approve.
    const people = (await peopleIn(m.teams)).filter((p) => p.team && (p.id !== m.user.id || admin));
    const ids = people.map((p) => p.id);
    if (!ids.length) return { leave: [], leaveCount: 0, swapCount: 0, timesheets: [], timesheetCount: 0, week: null };
    const leave = await q(
      `SELECT r.id, r.user_id, u.name, r.code, t.name AS type_name, r.start_date::text AS start_date, r.end_date::text AS end_date, r.days::float AS days, r.note
         FROM leave_requests r JOIN users u ON u.id = r.user_id JOIN leave_types t ON t.code = r.code
        WHERE r.status = 'pending' AND r.user_id = ANY($1::int[]) ORDER BY r.start_date LIMIT 50`,
      [ids],
    );
    const swaps = await one<{ n: number }>(`SELECT count(*)::int AS n FROM swap_requests WHERE status = 'accepted' AND from_user = ANY($1::int[])`, [ids]);
    // Last full week (Monday-first) where the manager is: the one waiting for sign-off.
    const week = lastFullWeek(Date.now(), await viewerTz(m.user.id, req.headers["x-timezone"]));
    const approved = new Set((await q<{ user_id: number }>(`SELECT user_id FROM timesheet_weeks WHERE week_start = $1 AND approved_at IS NOT NULL AND user_id = ANY($2::int[])`, [week, ids])).map((r) => r.user_id));
    const timesheets = [];
    for (const p of people) {
      if (approved.has(p.id)) continue;
      const s = await weekSummary(p.id, week);
      const regular = await regularOf(p.id);
      const days = s.days.map((d) => d.date);
      const leaveDays = await leaveDaysOf(p.id, days[0], days[6]);
      const expected = days.reduce((sum, d) => sum + (leaveDays.has(d) ? 0 : expectedMinutesOn(d, regular, isWorkDays(p.work_days) ? p.work_days : MON_FRI)), 0);
      // Nothing logged and nothing expected: no timesheet to look at.
      if (!s.total && !expected) continue;
      timesheets.push({ userId: p.id, name: p.name, team: p.team, weekStart: week, minutes: s.total, expected, flags: s.flags.length });
    }
    timesheets.sort((a, b) => b.flags - a.flags || (a.minutes - a.expected) - (b.minutes - b.expected));
    return { leave, leaveCount: leave.length, swapCount: swaps?.n ?? 0, timesheets, timesheetCount: timesheets.length, week };
  });

  // ── Locations (departments) ───────────────────────────────────────────────
  app.get("/api/time/locations", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const rows = await q<{ name: string; description: string | null; people: number; managers: string[] | null }>(
      `SELECT l.name, l.description,
              (SELECT count(*)::int FROM time_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team = l.name AND NOT u.removed) AS people,
              (SELECT array_agg(u.name ORDER BY u.name) FROM grants g JOIN users u ON u.id = g.user_id WHERE g.grant_kind = 'manager' AND g.team = l.name) AS managers
         FROM locations l ORDER BY l.name`,
    );
    return rows.filter((r) => canSee(m.teams, r.name)).map((r) => ({ ...r, managers: r.managers ?? [] }));
  });

  app.post("/api/time/locations", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    if (!allTeams(m.teams)) return bad(reply, "only payroll admins (or all-team managers) can add locations", 403);
    const b = body(req);
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const description = typeof b.description === "string" ? b.description.trim().slice(0, 300) || null : null;
    if (!LOCATION.test(name)) return bad(reply, "a location name: letters, numbers and simple punctuation, up to 60 characters");
    const r = await one(`INSERT INTO locations (name, description) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING name`, [name, description]);
    if (!r) return bad(reply, "there's already a location with that name", 409);
    await audit(m.user.id, "create", "location", name, null, { name, description });
    return { ok: true, name };
  });

  app.put("/api/time/locations/:name", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    if (!allTeams(m.teams)) return bad(reply, "only payroll admins (or all-team managers) can change locations", 403);
    const from = decodeURIComponent((req.params as { name: string }).name);
    const cur = await one<{ name: string; description: string | null }>(`SELECT name, description FROM locations WHERE name = $1`, [from]);
    if (!cur) return bad(reply, "no such location", 404);
    const b = body(req);
    const to = typeof b.name === "string" ? b.name.trim() : from;
    const description = typeof b.description === "string" ? b.description.trim().slice(0, 300) || null : cur.description;
    if (!LOCATION.test(to)) return bad(reply, "a location name: letters, numbers and simple punctuation, up to 60 characters");
    if (to !== from) {
      if (await one(`SELECT 1 FROM locations WHERE name = $1`, [to])) return bad(reply, "there's already a location with that name", 409);
      // A rename carries everything that hangs off the location: people, shifts, templates,
      // published weeks and manager grants.
      await q(`INSERT INTO locations (name, description, created_at) SELECT $2, $3, created_at FROM locations WHERE name = $1`, [from, to, description]);
      for (const [t, col] of [["time_members", "team"], ["shifts", "team"], ["shift_templates", "team"], ["shift_publications", "team"], ["grants", "team"]] as const) {
        await q(`UPDATE ${t} SET ${col} = $2 WHERE ${col} = $1`, [from, to]);
      }
      await q(`DELETE FROM locations WHERE name = $1`, [from]);
    } else {
      await q(`UPDATE locations SET description = $2 WHERE name = $1`, [from, description]);
    }
    await audit(m.user.id, "update", "location", to, cur, { name: to, description });
    return { ok: true, name: to };
  });

  app.delete("/api/time/locations/:name", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    if (!allTeams(m.teams)) return bad(reply, "only payroll admins (or all-team managers) can remove locations", 403);
    const name = decodeURIComponent((req.params as { name: string }).name);
    const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM time_members WHERE team = $1`, [name]);
    if (n && n.n > 0) return bad(reply, `${n.n} ${n.n === 1 ? "person is" : "people are"} still in ${name} — move them first`, 409);
    const r = await one(`DELETE FROM locations WHERE name = $1 RETURNING name`, [name]);
    if (!r) return bad(reply, "no such location", 404);
    await audit(m.user.id, "delete", "location", name, { name }, null);
    return { ok: true };
  });

  // ── People: start date, regular week, leave entitlements ──────────────────
  const profileQuery = `SELECT u.id, u.name, u.email, m.team, u.tz, m.work_days, m.start_date::text AS start_date, m.regular_hours,
      (SELECT p.start_date::text FROM pay_profiles p WHERE p.user_id = u.id OR p.email = lower(u.email) ORDER BY p.effective_from DESC, p.id DESC LIMIT 1) AS profile_start,
      (SELECT p.timezone FROM pay_profiles p WHERE p.user_id = u.id OR p.email = lower(u.email) ORDER BY p.effective_from DESC, p.id DESC LIMIT 1) AS profile_tz
    FROM users u LEFT JOIN time_members m ON m.user_id = u.id`;
  const profiles = async (where: string, args: unknown[]) =>
    q<ProfileRow>(`${profileQuery} ${where}`, args).catch(() =>
      // Before payroll's tables exist (a fresh database), there's no pay-profile start date or timezone to fall back on.
      q<ProfileRow>(`SELECT u.id, u.name, u.email, m.team, u.tz, m.work_days, m.start_date::text AS start_date, m.regular_hours, NULL AS profile_start, NULL AS profile_tz FROM users u LEFT JOIN time_members m ON m.user_id = u.id ${where}`, args));

  const entitlementsOf = async (ids: number[]) => {
    const rows = ids.length ? await q<{ user_id: number; code: string; days_per_year: number }>(`SELECT user_id, code, days_per_year::float AS days_per_year FROM leave_entitlements WHERE user_id = ANY($1::int[])`, [ids]) : [];
    const balances = ids.length ? await q<{ user_id: number; code: string; days: number }>(`SELECT user_id, code, days::float AS days FROM leave_balances WHERE user_id = ANY($1::int[])`, [ids]) : [];
    return { rows, balances };
  };
  const shape = (p: ProfileRow, ent: { rows: { user_id: number; code: string; days_per_year: number }[]; balances: { user_id: number; code: string; days: number }[] }) => ({
    // The zone their hours are split in (tzOf's order), or null if Space doesn't know one yet.
    id: p.id, name: p.name, email: p.email, team: p.team, timezone: isTz(p.profile_tz) ? p.profile_tz : isTz(p.tz) ? p.tz : null,
    startDate: p.start_date ?? p.profile_start ?? null,
    workDays: isWorkDays(p.work_days) ? p.work_days : MON_FRI,
    regularHours: isRegularHours(p.regular_hours) ? p.regular_hours : [],
    entitlements: Object.fromEntries(ent.rows.filter((r) => r.user_id === p.id).map((r) => [r.code, r.days_per_year])),
    balances: Object.fromEntries(ent.balances.filter((r) => r.user_id === p.id).map((r) => [r.code, r.days])),
  });

  app.get("/api/time/people", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const ids = (await peopleIn(m.teams)).map((p) => p.id);
    if (!ids.length) return [];
    const rows = await profiles(`WHERE u.id = ANY($1::int[]) ORDER BY u.name`, [ids]);
    const ent = await entitlementsOf(ids);
    return rows.map((p) => shape(p, ent));
  });

  /** One person's profile: managers of their team, or the person themselves. */
  app.get("/api/time/people/:id", async (req, reply) => {
    const u = member(req, reply);
    if (!u) return;
    const raw = (req.params as { id: string }).id;
    const id = raw === "me" ? u.id : intParam(raw);
    if (!Number.isFinite(id)) return bad(reply, "not found", 404);
    if (id !== u.id && !(await canManage(u.id, id))) return bad(reply, "not your team", 403);
    const [p] = await profiles(`WHERE u.id = $1`, [id]);
    if (!p) return bad(reply, "not found", 404);
    return shape(p, await entitlementsOf([id]));
  });

  app.put("/api/time/people/:id", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const id = intParam((req.params as { id: string }).id);
    if (!Number.isFinite(id) || !(await one(`SELECT 1 FROM users WHERE id = $1`, [id]))) return bad(reply, "not found", 404);
    // Your own week and leave feed your own pay: payroll admins only (canManage says so too).
    if (!(await canManage(m.user.id, id))) return bad(reply, id === m.user.id ? "ask a payroll admin to change your own profile" : "not your team", 403);
    const b = body(req);
    const [before] = await profiles(`WHERE u.id = $1`, [id]);
    const team = typeof b.team === "string" ? b.team.trim() : undefined;
    if (team !== undefined && team !== (before.team ?? "")) {
      if (!allTeams(m.teams)) return bad(reply, "only payroll admins (or all-team managers) can move people between locations", 403);
      if (team && !(await one(`SELECT 1 FROM locations WHERE name = $1`, [team]))) return bad(reply, `there's no location called ${team} — add it under Locations first`);
    }
    if (b.start_date !== undefined && b.start_date !== null && !isDate(b.start_date)) return bad(reply, "start_date as YYYY-MM-DD");
    if (b.regular_hours !== undefined && !isRegularHours(b.regular_hours)) return bad(reply, "regular_hours: one entry per day with start, end and an optional break (HH:MM)");
    const ent = b.entitlements;
    if (ent !== undefined && (typeof ent !== "object" || ent === null || Object.values(ent).some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 366))) return bad(reply, "entitlements: days per year by leave type, 0–366");
    if (ent && typeof ent === "object") {
      const codes = new Set((await q<{ code: string }>(`SELECT code FROM leave_types`)).map((r) => r.code));
      const unknown = Object.keys(ent).filter((c) => !codes.has(c));
      if (unknown.length) return bad(reply, `unknown leave type: ${unknown.join(", ")}`);
    }
    const memberTeam = team !== undefined ? team : before.team ?? "";
    if (!memberTeam) return bad(reply, "put them in a location first");
    const regular = b.regular_hours as RegularDay[] | undefined;
    // Their working days follow their regular week, so leave and proration count the right days.
    const workDays = regular && regular.length ? [...new Set(regular.map((r) => r.dow))].sort((a, c) => a - c) : null;
    await q(
      `INSERT INTO time_members (user_id, team, work_days, start_date, regular_hours) VALUES ($1, $2, COALESCE($3::int[], '{1,2,3,4,5}'), $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET team = $2, work_days = COALESCE($3::int[], time_members.work_days),
         start_date = CASE WHEN $6 THEN $4::date ELSE time_members.start_date END,
         regular_hours = CASE WHEN $7 THEN $5::jsonb ELSE time_members.regular_hours END`,
      [id, memberTeam, workDays, b.start_date ?? null, regular ? JSON.stringify(regular) : null, b.start_date !== undefined, regular !== undefined],
    );
    if (ent && typeof ent === "object") {
      for (const [code, days] of Object.entries(ent as Record<string, number>)) {
        await q(`INSERT INTO leave_entitlements (user_id, code, days_per_year) VALUES ($1, $2, $3) ON CONFLICT (user_id, code) DO UPDATE SET days_per_year = $3`, [id, code, days]);
      }
    }
    await audit(m.user.id, "update", "profile", id,
      { team: before.team, start_date: before.start_date, regular_hours: before.regular_hours, work_days: before.work_days },
      { team: memberTeam, start_date: b.start_date, regular_hours: regular, entitlements: ent }, typeof b.reason === "string" ? b.reason.slice(0, 300) : null);
    const [after] = await profiles(`WHERE u.id = $1`, [id]);
    return shape(after, await entitlementsOf([id]));
  });

  // ── Coverage: who's expected, who's off and why ───────────────────────────
  app.get("/api/time/coverage", async (req, reply) => {
    const m = await manager(req, reply);
    if (!m) return;
    const { from, to, team: teamQ } = req.query as { from?: string; to?: string; team?: string };
    if (!isDate(from) || !isDate(to) || to < from) return bad(reply, "from and to as YYYY-MM-DD");
    if (to > addDays(from, 62)) return bad(reply, "at most about two months at a time");
    if (teamQ && !canSee(m.teams, teamQ)) return bad(reply, "not your team", 403);
    const admin = await isPayrollAdmin(m.user.id);
    const people = (await peopleIn(teamQ ? [teamQ] : m.teams)).filter((p) => p.team && (!teamQ || p.team === teamQ) && (p.id !== m.user.id || admin));
    const ids = people.map((p) => p.id);
    const dates: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
    const regular = new Map((ids.length ? await q<{ user_id: number; regular_hours: unknown }>(`SELECT user_id, regular_hours FROM time_members WHERE user_id = ANY($1::int[])`, [ids]) : [])
      .map((r) => [r.user_id, isRegularHours(r.regular_hours) && (r.regular_hours as RegularDay[]).length ? (r.regular_hours as RegularDay[]) : null]));
    const leave = ids.length ? await q<{ user_id: number; code: string; type_name: string; start_date: string; end_date: string; status: string }>(
      `SELECT r.user_id, r.code, t.name AS type_name, r.start_date::text AS start_date, r.end_date::text AS end_date, r.status
         FROM leave_requests r JOIN leave_types t ON t.code = r.code
        WHERE r.user_id = ANY($1::int[]) AND r.status IN ('approved', 'pending') AND r.start_date <= $3 AND r.end_date >= $2`,
      [ids, from, to],
    ) : [];
    const shifts = ids.length ? await q<{ user_id: number; date: string; start_local: string; end_local: string; timezone: string }>(
      `SELECT user_id, date::text AS date, start_local, end_local, timezone FROM shifts
        WHERE user_id = ANY($1::int[]) AND published_at IS NOT NULL AND date BETWEEN $2 AND $3`,
      [ids, from, to],
    ) : [];
    type DayInfo = { expected: number; hours: { start: string; end: string; break_start: string | null; break_end: string | null } | null; shifts: { start: string; end: string; starts_at: string; ends_at: string }[]; leave: { code: string; name: string; status: string } | null };
    const rows: { userId: number; name: string; team: string | null; timezone: string; byDay: Record<string, DayInfo> }[] = [];
    for (const p of people) {
      const tz = await tzOf(p.id); // their pay-profile zone first, like their timesheets
      const reg = regular.get(p.id) ?? null;
      const wd = isWorkDays(p.work_days) ? p.work_days : MON_FRI;
      const byDay: Record<string, DayInfo> = {};
      for (const d of dates) {
        const l = leave.find((x) => x.user_id === p.id && x.start_date <= d && x.end_date >= d && x.status === "approved") ?? leave.find((x) => x.user_id === p.id && x.start_date <= d && x.end_date >= d);
        const dow = new Date(d + "T00:00:00Z").getUTCDay();
        const r = reg?.find((x) => x.dow === dow) ?? null;
        const sh = shifts.filter((s) => s.user_id === p.id && s.date === d).map((s) => {
          const i = shiftInterval(s.date, s.start_local, s.end_local, isTz(s.timezone) ? s.timezone : "UTC");
          return { start: s.start_local, end: s.end_local, starts_at: new Date(i.start).toISOString(), ends_at: new Date(i.end).toISOString() };
        });
        byDay[d] = {
          expected: expectedMinutesOn(d, reg, wd),
          hours: r ? { start: r.start, end: r.end, break_start: r.break_start ?? null, break_end: r.break_end ?? null } : null,
          shifts: sh,
          leave: l ? { code: l.code, name: l.type_name, status: l.status } : null,
        };
      }
      rows.push({ userId: p.id, name: p.name, team: p.team, timezone: tz, byDay });
    }
    const days = dates.map((d) => {
      const scheduled = rows.filter((r) => r.byDay[d].expected > 0 || r.byDay[d].shifts.length);
      const off = rows.filter((r) => r.byDay[d].leave).map((r) => ({ userId: r.userId, name: r.name, code: r.byDay[d].leave!.code, type: r.byDay[d].leave!.name, status: r.byDay[d].leave!.status }));
      const offApproved = off.filter((o) => o.status === "approved");
      const offIds = new Set(offApproved.map((o) => o.userId));
      return { date: d, scheduled: scheduled.length, available: scheduled.filter((r) => !offIds.has(r.userId)).length, offCount: offApproved.length, pendingCount: off.length - offApproved.length, off };
    });
    return { from, to, days, people: rows };
  });
}

/** Regular hours for one person, or null. */
async function regularOf(userId: number): Promise<RegularDay[] | null> {
  const r = await one<{ regular_hours: unknown }>(`SELECT regular_hours FROM time_members WHERE user_id = $1`, [userId]);
  return isRegularHours(r?.regular_hours) && (r!.regular_hours as RegularDay[]).length ? (r!.regular_hours as RegularDay[]) : null;
}

/** Dates in [from, to] someone has approved leave. */
async function leaveDaysOf(userId: number, from: string, to: string): Promise<Set<string>> {
  const rows = await q<{ start_date: string; end_date: string }>(
    `SELECT start_date::text AS start_date, end_date::text AS end_date FROM leave_requests WHERE user_id = $1 AND status = 'approved' AND start_date <= $3 AND end_date >= $2`,
    [userId, from, to],
  );
  const out = new Set<string>();
  for (const r of rows) for (let d = r.start_date < from ? from : r.start_date; d <= r.end_date && d <= to; d = addDays(d, 1)) out.add(d);
  return out;
}
