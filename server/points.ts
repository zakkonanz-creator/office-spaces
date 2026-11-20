// Points (shared/points.ts): tenure and office time are counted from what's already recorded;
// everything else is a row in points_ledger. Totals are computed on demand (a few cheap queries).

import { q, one } from "./db";
import { POINTS, tenurePoints, type LedgerKind, type PointsBreakdown } from "../shared/points";
import { daysSince } from "../shared/tenure";

/** Award once per (user, kind, ref); a null ref can repeat. True if it was new. */
export async function award(userId: number, kind: LedgerKind, points: number, reason: string, ref: string | null, by: number | null = null): Promise<boolean> {
  const r = await q(
    `INSERT INTO points_ledger (user_id, kind, points, reason, ref, created_by) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING RETURNING id`,
    [userId, kind, Math.round(points), reason.slice(0, 200), ref, by],
  );
  return r.length > 0;
}

/** How many awards of this kind someone got since UTC midnight (for the daily caps). */
export async function countToday(userId: number, kind: LedgerKind): Promise<number> {
  const r = await one<{ n: string | number }>(`SELECT count(*) AS n FROM points_ledger WHERE user_id = $1 AND kind = $2 AND created_at >= date_trunc('day', now())`, [userId, kind]);
  return Number(r?.n ?? 0);
}

/** Office-time points per user: hours not Away, at most the daily cap per (UTC) day. */
const ONLINE_SQL = `
  SELECT user_id, SUM(LEAST(secs, ${POINTS.onlineHoursCap * 3600})) AS secs FROM (
    SELECT user_id, date_trunc('day', started_at) AS d,
           SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at))) AS secs
      FROM status_events WHERE status <> 'away' %WHERE% GROUP BY 1, 2
  ) x GROUP BY 1`;

export async function breakdown(userId: number, since: string | null): Promise<PointsBreakdown> {
  const online = await one<{ secs: string | number | null }>(ONLINE_SQL.replace("%WHERE%", "AND user_id = $1"), [userId]);
  const ledger = await q<{ kind: string; points: string | number }>(`SELECT kind, SUM(points) AS points FROM points_ledger WHERE user_id = $1 GROUP BY kind`, [userId]);
  const parts: PointsBreakdown["parts"] = [
    { kind: "tenure", points: tenurePoints(daysSince(since), since) },
    { kind: "online", points: Math.floor((Number(online?.secs ?? 0) / 3600) * POINTS.onlinePerHour) },
    ...ledger.map((l) => ({ kind: l.kind as LedgerKind, points: Number(l.points) })),
  ];
  return { total: Math.max(0, parts.reduce((a, p) => a + p.points, 0)), parts: parts.filter((p) => p.points !== 0) };
}

export const totalFor = async (userId: number, since: string | null) => (await breakdown(userId, since)).total;

/** Everyone's totals, for the leaderboard: [userId, name, avatar, total]. */
export async function leaderboard(limit = 10) {
  const users = await q<{ id: number; name: string; avatar_url: string | null; since: string }>(
    `SELECT id, name, avatar_url, to_char(COALESCE(started_on, created_at::date), 'YYYY-MM-DD') AS since FROM users WHERE NOT removed`,
  );
  const online = new Map((await q<{ user_id: number; secs: string }>(ONLINE_SQL.replace("%WHERE%", ""))).map((r) => [r.user_id, Number(r.secs)]));
  const ledger = new Map((await q<{ user_id: number; points: string }>(`SELECT user_id, SUM(points) AS points FROM points_ledger GROUP BY user_id`)).map((r) => [r.user_id, Number(r.points)]));
  const rows = users.map((u) => ({
    id: u.id, name: u.name, avatar: u.avatar_url,
    points: Math.max(0, tenurePoints(daysSince(u.since), u.since) + Math.floor(((online.get(u.id) ?? 0) / 3600) * POINTS.onlinePerHour) + (ledger.get(u.id) ?? 0)),
  }));
  rows.sort((a, b) => b.points - a.points);
  const highfives = await q<{ id: number; name: string; n: string }>(
    `SELECT u.id, u.name, count(*) AS n FROM points_ledger l JOIN users u ON u.id = l.user_id
      WHERE l.kind = 'highfive' AND l.created_at >= date_trunc('week', now()) GROUP BY u.id, u.name ORDER BY n DESC LIMIT 5`,
  );
  return { top: rows.slice(0, limit), highfives: highfives.map((h) => ({ id: h.id, name: h.name, n: Number(h.n) })) };
}

/** Eggs someone has found, and which eggs anyone has found first. */
export async function eggsFound(userId: number): Promise<string[]> {
  return (await q<{ ref: string }>(`SELECT ref FROM points_ledger WHERE user_id = $1 AND kind = 'egg' AND ref IS NOT NULL`, [userId])).map((r) => r.ref);
}
export async function eggFoundByAnyone(egg: string): Promise<boolean> {
  return Boolean(await one(`SELECT 1 FROM points_ledger WHERE kind = 'egg' AND ref = $1 LIMIT 1`, [egg]));
}

/** The latest awards (admin view). */
export async function recentLedger(limit = 60) {
  return q(
    `SELECT l.id, l.kind, l.points, l.reason, l.created_at, u.name AS user_name, b.name AS by_name
       FROM points_ledger l JOIN users u ON u.id = l.user_id LEFT JOIN users b ON b.id = l.created_by
      ORDER BY l.created_at DESC LIMIT $1`,
    [limit],
  );
}

/** Pilot teammates who arrived before the welcome bonus existed get it too (QA 2026-11-06), so Monday's joiners
 * aren't 100 ahead. Idempotent: the ledger's (user, kind, ref) key means each person gets it once. Returns how many. */
export async function backfillWelcome(): Promise<number> {
  const rows = await q<{ user_id: number }>(
    `INSERT INTO points_ledger (user_id, kind, points, reason, ref)
     SELECT id, 'welcome', $1, 'Welcome to Proximity Office', 'welcome' FROM users
      WHERE first_office_at IS NOT NULL AND NOT removed
     ON CONFLICT DO NOTHING RETURNING user_id`, [POINTS.welcome]);
  return rows.length;
}
