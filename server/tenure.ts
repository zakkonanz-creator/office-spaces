// Start dates for shared/tenure.ts. users.started_on is set by an admin (Admin → Members); without
// one, the day they first signed in to the office stands in, which for a new hire is their first day.

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
