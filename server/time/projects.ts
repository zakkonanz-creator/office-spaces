// Project time: a stopwatch on top of the clock, for done-for-you work.
// Clocked in says "I'm working"; a project timer says "on this client, this
// project". One runs at a time; starting another stops the first, and clocking
// out stops it too. Reports total it per client and project, so the team can see
// what the work really costs — whether or not it's billed by the hour.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { one, q } from "../db";
import type { UserRow } from "../auth";
import { addDays, isDate, localDate, zonedTime } from "../../shared/time";
import { esc } from "../payroll/csv";
import { tzOf } from "./hours";

type Member = (req: FastifyRequest, reply: FastifyReply) => UserRow | null;
type Manager = (req: FastifyRequest, reply: FastifyReply) => Promise<{ user: UserRow; teams: string[] } | null>;
type PeopleIn = (teams: string[]) => Promise<{ id: number; name: string; team: string | null }[]>;

const bad = (reply: FastifyReply, error: string, code = 400) => reply.code(code).send({ error });
const body = (req: FastifyRequest) => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const csvReply = (reply: FastifyReply, name: string, rows: unknown[][]) =>
  reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${name}"`)
    .send(rows.map((r) => r.map(esc).join(",")).join("\n") + "\n");
/** A timer left running past this is a forgotten one: it's capped, and flagged in the report. */
export const MAX_TIMER_MS = 12 * 3600_000;

export async function migrateProjects() {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS project_time (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      client TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '',
      note TEXT,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS project_time_user_start ON project_time (user_id, started_at)`,
    `CREATE INDEX IF NOT EXISTS project_time_start ON project_time (started_at)`,
    // At most one running timer per person, even with two tabs.
    `CREATE UNIQUE INDEX IF NOT EXISTS project_time_one_running ON project_time (user_id) WHERE ended_at IS NULL`,
  ]) await q(sql);
}

/** Stop whatever is running for this person (clocking out calls this). */
export async function stopProjectTimer(userId: number) {
  await q(`UPDATE project_time SET ended_at = LEAST(now(), started_at + $2 * interval '1 millisecond') WHERE user_id = $1 AND ended_at IS NULL`, [userId, MAX_TIMER_MS]);
}

interface Row { id: number; user_id: number; client: string; project: string; note: string | null; started_at: Date; ended_at: Date | null }
const minutesOf = (r: Row, now: number) => Math.max(0, Math.round(((r.ended_at ? r.ended_at.getTime() : Math.min(now, r.started_at.getTime() + MAX_TIMER_MS)) - r.started_at.getTime()) / 60_000));

export function registerProjectRoutes(app: FastifyInstance, h: { member: Member; manager: Manager; peopleIn: PeopleIn; clockedIn: (userId: number) => Promise<boolean> }) {
  /** Mine: what's running, today's entries, and the clients and projects I've used (for quick picking). */
  app.get("/api/time/projects/me", async (req, reply) => {
    const u = h.member(req, reply);
    if (!u) return;
    const tz = await tzOf(u.id);
    const today = localDate(Date.now(), tz);
    const now = Date.now();
    const rows = await q<Row>(`SELECT * FROM project_time WHERE user_id = $1 AND (started_at >= $2 OR ended_at IS NULL) ORDER BY started_at DESC`, [u.id, new Date(zonedTime(today, "00:00", tz))]);
    const recent = await q<{ client: string; project: string }>(
      `SELECT client, project FROM project_time WHERE user_id = $1 GROUP BY client, project ORDER BY max(started_at) DESC LIMIT 12`, [u.id]);
    // Everyone's clients, so two people don't spell the same one two ways.
    const clients = (await q<{ client: string }>(`SELECT client FROM project_time GROUP BY client ORDER BY count(*) DESC LIMIT 200`)).map((r) => r.client);
    const running = rows.find((r) => !r.ended_at) ?? null;
    return {
      running: running ? { id: running.id, client: running.client, project: running.project, note: running.note, startedAt: running.started_at } : null,
      today: rows.map((r) => ({ id: r.id, client: r.client, project: r.project, note: r.note, startedAt: r.started_at, endedAt: r.ended_at, minutes: minutesOf(r, now) })),
      todayMinutes: rows.reduce((n, r) => n + minutesOf(r, now), 0),
      recent, clients,
    };
  });

  app.post("/api/time/projects/start", async (req, reply) => {
    const u = h.member(req, reply);
    if (!u) return;
    const b = body(req);
    const client = text(b.client, 80), project = text(b.project, 80), note = text(b.note, 200) || null;
    if (!client) return bad(reply, "which client is this for?");
    if (!(await h.clockedIn(u.id))) return bad(reply, "Clock in first — project time sits inside your working time.", 409);
    await stopProjectTimer(u.id);
    const r = await one<{ id: number }>(`INSERT INTO project_time (user_id, client, project, note, started_at) VALUES ($1, $2, $3, $4, now()) RETURNING id`, [u.id, client, project, note]);
    return { ok: true, id: r!.id };
  });

  app.post("/api/time/projects/stop", async (req, reply) => {
    const u = h.member(req, reply);
    if (!u) return;
    await stopProjectTimer(u.id);
    return { ok: true };
  });

  /** Fix your own entry from the last week: wrong client, or a forgotten stop. */
  app.put("/api/time/projects/:id", async (req, reply) => {
    const u = h.member(req, reply);
    if (!u) return;
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0 || id > 2e9) return bad(reply, "bad id");
    const b = body(req);
    const row = await one<Row>(`SELECT * FROM project_time WHERE id = $1 AND user_id = $2`, [id, u.id]);
    if (!row) return bad(reply, "not found", 404);
    if (row.started_at.getTime() < Date.now() - 7 * 86400_000) return bad(reply, "entries older than a week are locked");
    const client = b.client !== undefined ? text(b.client, 80) : row.client;
    if (!client) return bad(reply, "client can't be empty");
    const project = b.project !== undefined ? text(b.project, 80) : row.project;
    let minutes: number | null = null;
    if (b.minutes !== undefined) {
      minutes = Math.round(Number(b.minutes));
      if (!row.ended_at || !Number.isFinite(minutes) || minutes < 0 || minutes > MAX_TIMER_MS / 60_000) return bad(reply, "minutes: a stopped entry, 0–720");
    }
    await q(`UPDATE project_time SET client = $2, project = $3, ended_at = CASE WHEN $4::int IS NULL THEN ended_at ELSE started_at + $4::int * interval '1 minute' END WHERE id = $1`, [id, client, project, minutes]);
    return { ok: true };
  });

  app.delete("/api/time/projects/:id", async (req, reply) => {
    const u = h.member(req, reply);
    if (!u) return;
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0 || id > 2e9) return bad(reply, "bad id");
    const r = await one(`DELETE FROM project_time WHERE id = $1 AND user_id = $2 AND started_at > now() - interval '7 days' RETURNING id`, [id, u.id]);
    if (!r) return bad(reply, "not found, or older than a week", 404);
    return { ok: true };
  });

  /** Managers: time per client and project, and per person, for any range up to a year. */
  const report = async (req: FastifyRequest, reply: FastifyReply) => {
    const m = await h.manager(req, reply);
    if (!m) return null;
    const { from, to } = req.query as { from?: string; to?: string };
    if (!isDate(from) || !isDate(to) || to < from) { bad(reply, "from and to as YYYY-MM-DD"); return null; }
    if (to > addDays(from, 366)) { bad(reply, "at most a year at a time"); return null; }
    const people = await h.peopleIn(m.teams);
    const names = new Map(people.map((p) => [p.id, p.name]));
    // A day's edges in UTC, padded: each person's own day is checked below.
    const rows = await q<Row>(
      `SELECT * FROM project_time WHERE user_id = ANY($1::int[]) AND started_at >= $2 AND started_at < $3 ORDER BY started_at`,
      [[...names.keys()], new Date(Date.parse(`${from}T00:00:00Z`) - 14 * 3600_000), new Date(Date.parse(`${addDays(to, 1)}T00:00:00Z`) + 14 * 3600_000)],
    );
    const now = Date.now();
    const entries = [];
    const zones = new Map<number, string>();
    for (const r of rows) {
      if (!zones.has(r.user_id)) zones.set(r.user_id, await tzOf(r.user_id));
      const tz = zones.get(r.user_id)!;
      const date = localDate(r.started_at.getTime(), tz);
      if (date < from || date > to) continue;
      entries.push({ ...r, date, minutes: minutesOf(r, now), name: names.get(r.user_id) ?? "", capped: !r.ended_at && now - r.started_at.getTime() > MAX_TIMER_MS });
    }
    return { from, to, entries };
  };

  app.get("/api/time/projects/report", async (req, reply) => {
    const r = await report(req, reply);
    if (!r) return;
    const byProject = new Map<string, { client: string; project: string; minutes: number; people: Set<string> }>();
    const byPerson = new Map<string, { name: string; minutes: number; clients: Set<string> }>();
    for (const e of r.entries) {
      const k = `${e.client}\u0000${e.project}`;
      const p = byProject.get(k) ?? { client: e.client, project: e.project, minutes: 0, people: new Set() };
      p.minutes += e.minutes; p.people.add(e.name); byProject.set(k, p);
      const w = byPerson.get(e.name) ?? { name: e.name, minutes: 0, clients: new Set() };
      w.minutes += e.minutes; w.clients.add(e.client); byPerson.set(e.name, w);
    }
    return {
      from: r.from, to: r.to,
      total: r.entries.reduce((n, e) => n + e.minutes, 0),
      projects: [...byProject.values()].sort((a, b) => b.minutes - a.minutes).map((p) => ({ ...p, people: [...p.people].sort() })),
      people: [...byPerson.values()].sort((a, b) => b.minutes - a.minutes).map((p) => ({ ...p, clients: [...p.clients].sort() })),
    };
  });

  app.get("/api/time/projects/export", async (req, reply) => {
    const r = await report(req, reply);
    if (!r) return;
    const rows: unknown[][] = [["date", "person", "client", "project", "note", "minutes", "hours", "started_utc", "ended_utc"]];
    for (const e of r.entries) rows.push([e.date, e.name, e.client, e.project, e.note ?? "", e.minutes, (e.minutes / 60).toFixed(2), e.started_at.toISOString(), e.ended_at ? e.ended_at.toISOString() : e.capped ? "never stopped (capped at 12h)" : "running"]);
    return csvReply(reply, `project-time-${r.from}-to-${r.to}.csv`, rows);
  });
}
