// Clocked in but out of the office: after 2 hours away, one Slack DM asking
// whether they're done. The clock itself never changes on its own (pay stays
// what the person clocked); this only catches the forgotten clock-out early.

import { q } from "../db";
import { config } from "../config";
import { personForUser } from "../office";

export const AWAY_NUDGE_MS = 2 * 3600_000;

/**
 * Due a nudge? Away since = the later of clocking in and last being in the
 * office. One nudge per away stretch: coming back to the office and leaving
 * again starts a new one.
 */
export function dueForAwayNudge(a: { clockedInAt: number; lastInOffice: number | null; inOfficeNow: boolean; lastNudgedAwaySince: number | null; now: number }) {
  if (a.inOfficeNow) return null;
  const awaySince = Math.max(a.clockedInAt, a.lastInOffice ?? 0);
  if (a.now - awaySince < AWAY_NUDGE_MS) return null;
  if (a.lastNudgedAwaySince !== null && a.lastNudgedAwaySince >= awaySince) return null;
  return awaySince;
}

type ClockNow = (userId: number, now: number) => Promise<{ state: string; since: string | null }>;

/** One pass over everyone with a clock event in the last day. Never throws. */
export async function runAwayNudges(clockNow: ClockNow, tell: (userId: number, text: string) => Promise<void>, now = Date.now()) {
  const sent: number[] = [];
  try {
    const rows = await q<{ user_id: number; last_seen: Date | null; away_since: Date | null }>(
      `SELECT DISTINCT e.user_id, u.last_seen, n.away_since
         FROM clock_events e JOIN users u ON u.id = e.user_id
         LEFT JOIN clock_nudges n ON n.user_id = e.user_id
        WHERE e.at > to_timestamp($1 / 1000.0) - interval '24 hours' AND NOT u.removed`,
      [now],
    );
    for (const r of rows) {
      const c = await clockNow(r.user_id, now);
      if (c.state !== "in" || !c.since) continue; // clocked out, or on a break
      const awaySince = dueForAwayNudge({
        clockedInAt: Date.parse(c.since),
        lastInOffice: r.last_seen ? r.last_seen.getTime() : null,
        inOfficeNow: Boolean(personForUser(r.user_id)),
        lastNudgedAwaySince: r.away_since ? r.away_since.getTime() : null,
        now,
      });
      if (awaySince === null) continue;
      await q(
        `INSERT INTO clock_nudges (user_id, away_since, sent_at) VALUES ($1, to_timestamp($2 / 1000.0), now())
         ON CONFLICT (user_id) DO UPDATE SET away_since = EXCLUDED.away_since, sent_at = now()`,
        [r.user_id, awaySince],
      );
      sent.push(r.user_id);
      await tell(r.user_id, `You're still clocked in, but you haven't been in Office Spaces for ${Math.floor((now - awaySince) / 3600_000)} hours. If you're done for the day, clock out: ${config.publicUrl}/time. Still working? Hop back into the office: ${config.publicUrl}`);
    }
  } catch (e) {
    console.error("time: away nudge pass failed:", (e as Error).message);
  }
  return sent;
}
