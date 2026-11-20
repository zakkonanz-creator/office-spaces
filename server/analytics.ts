// Presence analytics: for a day or a week, each person's
// timeline of Available / Focusing / Away while they were in the office, with
// totals and a CSV export. Built from status_events stretches, clipped to the
// window. The window boundaries come from the browser so they're in the
// viewer's chosen timezone.

import { q } from "./db";

export interface Segment { status: string; start: number; end: number }
export interface PersonDay {
  id: number;
  name: string;
  email: string;
  role: string;
  segments: Segment[];
  totals: Record<"available" | "focusing" | "away", number>; // ms
}

export async function analytics(from: Date, to: Date): Promise<PersonDay[]> {
  const rows = await q<{ user_id: number; status: string; started_at: Date; ended_at: Date | null; name: string; email: string; role: string }>(
    `SELECT e.user_id, e.status, e.started_at, e.ended_at, u.name, u.email, u.role
       FROM status_events e JOIN users u ON u.id = e.user_id
      WHERE e.started_at < $2 AND COALESCE(e.ended_at, now()) > $1 AND NOT u.removed
        -- A lower bound the index can use (no stretch lasts a week: disconnects close them).
        AND e.started_at > $1::timestamptz - interval '7 days'
      ORDER BY u.name, e.started_at`,
    [from.toISOString(), to.toISOString()],
  );
  const now = Date.now();
  const byUser = new Map<number, PersonDay>();
  for (const r of rows) {
    let p = byUser.get(r.user_id);
    if (!p) {
      p = { id: r.user_id, name: r.name, email: r.email, role: r.role, segments: [], totals: { available: 0, focusing: 0, away: 0 } };
      byUser.set(r.user_id, p);
    }
    const start = Math.max(new Date(r.started_at).getTime(), from.getTime());
    const end = Math.min(r.ended_at ? new Date(r.ended_at).getTime() : now, to.getTime());
    if (end <= start) continue;
    p.segments.push({ status: r.status, start, end });
    if (r.status in p.totals) p.totals[r.status as keyof PersonDay["totals"]] += end - start;
  }
  return [...byUser.values()];
}

/** One row per person per local day in the window. `tz` is an IANA zone, e.g. America/Los_Angeles. */
export function toCsv(people: PersonDay[], tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const day = (t: number) => fmt.format(t);
  const all = people.flatMap((p) => p.segments);
  // Local midnights inside the data's span. Every real UTC offset is a multiple
  // of 15 minutes, so probing on the quarter hour finds each flip exactly.
  const Q = 15 * 60e3;
  const midnights: number[] = [];
  if (all.length) {
    // A loop, not Math.min(...spread): a month of segments overflows the call stack.
    let first = Infinity, hi = -Infinity;
    for (const s of all) { if (s.start < first) first = s.start; if (s.end > hi) hi = s.end; }
    const lo = Math.floor(first / Q) * Q;
    for (let t = lo + Q; t < hi; t += Q) if (day(t) !== day(t - Q)) midnights.push(t);
  }
  const mins = (ms: number) => Math.round(ms / 60000);
  const esc = (raw: string) => {
    const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw; // spreadsheets would run it as a formula
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lines = ["date,name,email,role,available_min,focusing_min,away_min,total_min"];
  for (const p of people) {
    const days = new Map<string, Record<string, number>>();
    for (const s of p.segments) {
      const cuts = [s.start, ...midnights.filter((m) => m > s.start && m < s.end), s.end];
      for (let i = 0; i < cuts.length - 1; i++) {
        const d = day(cuts[i]);
        const b = days.get(d) ?? { available: 0, focusing: 0, away: 0 };
        b[s.status] = (b[s.status] ?? 0) + (cuts[i + 1] - cuts[i]);
        days.set(d, b);
      }
    }
    for (const [d, b] of [...days].sort()) {
      const total = b.available + b.focusing + b.away;
      lines.push([d, esc(p.name), esc(p.email), p.role, mins(b.available), mins(b.focusing), mins(b.away), mins(total)].join(","));
    }
  }
  return lines.join("\n") + "\n";
}
