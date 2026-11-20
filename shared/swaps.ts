// Shift swaps, as the person who asked sees them. Steps:
// proposed → accepted (or declined) by the teammate → approved (or rejected) by a manager.
// The asker can cancel while it's proposed or accepted.

export type SwapStatus = "proposed" | "accepted" | "declined" | "approved" | "rejected" | "cancelled";

/** Still in play: the shift can't have another swap until this one settles. */
export const swapOpen = (s: string) => s === "proposed" || s === "accepted";

const first = (name: string) => name.trim().split(/\s+/)[0] || name;

/** One line for a swap I asked for: "Asked Sam — waiting". */
export function outgoingSwapText(status: string, toName: string): string {
  const n = first(toName);
  switch (status) {
    case "proposed": return `Asked ${n} — waiting`;
    case "accepted": return `${n} accepted — waiting for your manager`;
    case "declined": return `${n} declined — the shift is still yours`;
    case "approved": return `Approved — ${n} has this shift now`;
    case "rejected": return `Your manager said no — the shift is still yours`;
    case "cancelled": return "You cancelled the swap";
    default: return status;
  }
}

/**
 * The swap to show on one of my shifts: an open one if there is one, else the newest.
 * Cancelled ones are left out (I did that myself, so there's nothing to tell me).
 */
export function swapForShift<T extends { shift_id: number; status: string; updated_at?: string | Date | null; id: number }>(swaps: T[], shiftId: number): T | null {
  const mine = swaps.filter((w) => w.shift_id === shiftId && w.status !== "cancelled");
  if (!mine.length) return null;
  const at = (w: T) => (w.updated_at ? new Date(w.updated_at).getTime() : 0);
  return mine.find((w) => swapOpen(w.status)) ?? mine.slice().sort((a, b) => at(b) - at(a) || b.id - a.id)[0];
}
