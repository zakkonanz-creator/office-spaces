// Hidden easter eggs (the owner, 2026-11-05). Each sits at a spot in a room; stand on it to find it.
// A faint glint shows only when you're close. Found once per person, for points (shared/points.ts);
// the first person ever to find each one gets a bonus and the office hears about it.

import type { Floor, Pt } from "./floor";

export const EGGS = [
  { id: "golden-mug", name: "The Golden Mug", badge: "☕", room: "kitchen", fx: 0.92, fy: 0.12, hint: "Where the coffee never stops, in a far corner." },
  { id: "lost-sock", name: "The Lost Sock", badge: "🧦", room: "lounge", fx: 0.08, fy: 0.9, hint: "Someone got very comfortable in the lounge." },
  { id: "rubber-duck", name: "The Debugging Duck", badge: "🐤", room: "engineering", fx: 0.95, fy: 0.9, hint: "Every bug fixed starts with explaining it to me." },
  { id: "old-pager", name: "The Old Pager", badge: "📟", room: "huddle", fx: 0.1, fy: 0.12, hint: "Support's on call, even in the breakout room." },
  { id: "first-dollar", name: "The First Dollar", badge: "💵", room: "sales", fx: 0.9, fy: 0.88, hint: "Every deal room keeps its first one." },
  { id: "time-capsule", name: "The Time Capsule", badge: "⏳", room: "team-north", fx: 0.1, fy: 0.88, hint: "Where everyone's first day begins." },
  { id: "whiteboard-cat", name: "The Whiteboard Cat", badge: "🐾", room: "conference", fx: 0.06, fy: 0.1, hint: "Someone drew on the conference room board." },
  { id: "crystal-ball", name: "The Crystal Ball", badge: "🔮", room: "ops", fx: 0.92, fy: 0.1, hint: "RevOps knows next month's numbers already." },
] as const;

export type EggId = (typeof EGGS)[number]["id"];
/** How close you have to stand. */
export const EGG_RADIUS = 46;
/** How close before the glint shows. */
export const EGG_GLINT = 170;

/** Where each egg is on this floor (an egg whose room isn't on the floor is skipped). */
export function eggSpots(floor: Floor): { id: EggId; at: Pt }[] {
  const out: { id: EggId; at: Pt }[] = [];
  for (const e of EGGS) {
    const r = floor.rooms.find((x) => x.id === e.room);
    if (r) out.push({ id: e.id, at: { x: Math.round(r.x + r.w * e.fx), y: Math.round(r.y + r.h * e.fy) } });
  }
  return out;
}
