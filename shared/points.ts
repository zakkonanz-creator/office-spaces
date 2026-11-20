// Points (the owner, 2026-11-05): one number per teammate that tenure, time in the office, streaks,
// high-fives, easter eggs, anniversaries, #wins and admin awards all add to. Points unlock emotes
// (shared/emotes.ts) and pets (shared/pets.ts). Tenure and office time are counted from what's
// already recorded; everything else is a row in points_ledger (server/points.ts).

export const POINTS = {
  /** Every day at Acme (from the Slack start date, shared/tenure.ts). Kept small on purpose
   *  (the owner, 2026-11-05: "the points overindex on tenure"): what you do counts more than how long. */
  tenurePerDay: 1,
  /** On top: each full year at Acme. Counted with tenure, so it's there for past years too. */
  perYear: 250,
  /** Every hour in the office, not Away. At most `onlineHoursCap` hours count per day. */
  onlinePerHour: 2,
  onlineHoursCap: 8,
  /** A streak milestone (server/streaks.ts MILESTONES) is worth this × the streak's days. */
  streakPerDay: 5,
  highFive: 5,
  highFivesPerDay: 10,
  /** #wins posts that earn points each day (the bell still rings for every one). */
  winsPerDay: 2,
  /** Petting a teammate's pet (to the one petting). */
  pat: 1,
  patsPerDay: 5,
  egg: 100,
  /** On top of `egg`, for the first person ever to find that one. */
  firstFinder: 100,
  /** Posting in #wins. */
  win: 50,
  /** Your very first time in the office (the owner, 2026-11-05). */
  welcome: 100,
} as const;

export type LedgerKind = "welcome" | "streak" | "highfive" | "pat" | "egg" | "anniversary" | "win" | "grant";

export const KIND_LABEL: Record<LedgerKind | "tenure" | "online", string> = {
  tenure: "Time at Acme",
  online: "Time in the office",
  welcome: "Welcome bonus",
  streak: "Streak milestones",
  highfive: "High-fives",
  pat: "Petting pets",
  egg: "Easter eggs",
  anniversary: "Work anniversaries",
  win: "Wins posted",
  grant: "Awarded by an admin",
};

export interface PointsBreakdown {
  total: number;
  parts: { kind: keyof typeof KIND_LABEL; points: number }[];
}

/** Tenure points for someone `days` in: a point a day, and `perYear` for each full year. */
/** Whole years since `since` ("YYYY-MM-DD"), counted by the calendar: the bonus lands on the anniversary itself, not a day or two early (QA 2026-11-06). */
export function fullYears(since: string | null | undefined, now = Date.now()): number {
  if (!since || since.length < 10) return 0;
  const today = new Date(now).toISOString().slice(0, 10);
  let y = Number(today.slice(0, 4)) - Number(since.slice(0, 4));
  if (today.slice(5, 10) < since.slice(5, 10)) y--;
  return Math.max(0, y);
}
/** A point a day, and a bonus for each full year. Pass `since` for exact years (without it, days/365.25). */
export const tenurePoints = (days: number, since?: string | null, now = Date.now()) =>
  days * POINTS.tenurePerDay + (since ? fullYears(since, now) : Math.floor(days / 365.25)) * POINTS.perYear;

/** "1,250". */
export const fmtPoints = (n: number) => Math.round(n).toLocaleString("en-US");

/** Is `today` ("YYYY-MM-DD") a work anniversary for someone who started on `since`? Years, or 0. Feb 29 starters celebrate Feb 28 in other years. */
export function anniversaryYears(since: string | null | undefined, today: string): number {
  if (!since || since.length < 10) return 0;
  const years = Number(today.slice(0, 4)) - Number(since.slice(0, 4));
  if (years < 1) return 0;
  let md = since.slice(5, 10);
  const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (md === "02-29" && !leap(Number(today.slice(0, 4)))) md = "02-28";
  return today.slice(5, 10) === md ? years : 0;
}
