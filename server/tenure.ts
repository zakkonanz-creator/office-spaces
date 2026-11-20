// Start dates for shared/tenure.ts. users.started_on comes from Slack's "Account created" date
// (Analytics → Members, seeded by scripts/seed-start-dates.py) or an admin's correction; without one,
// the day they first signed in to Space stands in, which for a new hire is their first day.

import type { UserRow } from "./auth";

/** A pg DATE arrives as local midnight; a TIMESTAMPTZ as an instant. Either way: the local "YYYY-MM-DD". */
function ymd(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  if (Number.isNaN(v.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
}

export function sinceOf(u: Pick<UserRow, "started_on" | "created_at">): string | null {
  return ymd(u.started_on) ?? ymd(u.created_at);
}

/**
 * Fills users.started_on from server/start-dates.json ({ email: "YYYY-MM-DD" }, made by
 * scripts/seed-start-dates.py from Slack) for anyone who hasn't got one. Never overwrites, so an
 * admin's correction stands. People who sign in later get theirs when they first arrive.
 */
let seedCache: Record<string, string> | null = null;
async function seedFile(): Promise<Record<string, string>> {
  if (seedCache) return seedCache;
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(new URL("./start-dates.json", import.meta.url), "utf8").catch(() => null);
  const out: Record<string, string> = {};
  for (const [e, d] of Object.entries(raw ? (JSON.parse(raw) as Record<string, string>) : {})) if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out[e.toLowerCase()] = d;
  return (seedCache = out);
}

/** A first-time sign-in's start date from the seed, if they were here before Space. */
export async function startDateFor(email: string): Promise<string | null> {
  return (await seedFile())[email.toLowerCase()] ?? null;
}

export async function seedStartDates(): Promise<number> {
  const { q } = await import("./db");
  let n = 0;
  for (const [email, d] of Object.entries(await seedFile())) {
    const r = await q(`UPDATE users SET started_on = $2 WHERE lower(email) = $1 AND started_on IS NULL RETURNING id`, [email, d]);
    n += r.length;
  }
  return n;
}
