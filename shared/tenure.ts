// How long someone has been at Acme (the owner, 2026-11-05). It unlocks emotes (shared/emotes.ts)
// and puts a small service pin on their avatar's shirt. The start date is users.started_on (from
// Slack: the day their account was created; an admin can correct it), else the day they first
// signed in to Space, which for a new hire is their first day.

export type PinTier = "new" | "bronze" | "silver" | "gold" | "diamond";

/** Whole days since `since` ("YYYY-MM-DD"). Null/garbage → 0: a brand-new starter. */
export function daysSince(since: string | null | undefined, now = Date.now()): number {
  if (!since) return 0;
  const t = Date.parse(`${since.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 864e5));
}

export const WEEK = 7;
export const MONTH = 30;
export const YEAR = 365;

/** The pin on their shirt: green for the first month, then bronze, silver, gold (with the years on it), diamond from 5 years. */
export function pinOf(days: number): { tier: PinTier; years: number } {
  const years = Math.floor(days / YEAR);
  if (years >= 5) return { tier: "diamond", years };
  if (years >= 1) return { tier: "gold", years };
  if (days >= 6 * MONTH) return { tier: "silver", years: 0 };
  if (days >= MONTH) return { tier: "bronze", years: 0 };
  return { tier: "new", years: 0 };
}

/** "3 days", "5 weeks", "8 months", "2 years". */
export function spanLabel(days: number): string {
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  if (days >= YEAR) return n(Math.floor(days / YEAR), "year");
  if (days >= 2 * MONTH) return n(Math.floor(days / MONTH), "month");
  if (days >= 2 * WEEK) return n(Math.floor(days / WEEK), "week");
  return n(days, "day");
}

/** For the profile card and the pin's tooltip. */
export function tenureTitle(since: string | null | undefined, now = Date.now()): string {
  const d = daysSince(since, now);
  if (!since) return "New to Acme";
  const when = new Date(`${since.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
  if (d < 1) return `Started today (${when})`;
  return `${spanLabel(d)} at Acme · since ${when}`;
}
