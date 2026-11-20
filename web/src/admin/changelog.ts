// Admin → Settings → Changelog & backlog. When something ships, add it to the top of CHANGELOG;
// when it's asked for or parked, add it to BACKLOG. Plain words: this is what admins read, not
// commit messages.

export interface Release { date: string; title: string; items: string[] }

export const CHANGELOG: Release[] = [
  {
    date: "2026-11-17",
    title: "First public release",
    items: [
      "Proximity audio and video on a 2D floor: walk up to someone to talk, step away to stop.",
      "Rooms with doors and knocking, desks, status (Available / Focusing / Away), guest links for one room.",
      "Transcribe this room: notes from each teammate's own mic, sent only to the people who were there.",
      "Time tracking: clock in and out, schedules, timesheets and time off, with managers per team.",
      "Office Designer for admins, points, streaks, outfits and easter eggs.",
    ],
  },
];

export type BacklogStatus = "next" | "idea" | "waiting" | "parked";
export interface BacklogItem { title: string; why: string; status: BacklogStatus; from?: string }

export const BACKLOG: BacklogItem[] = [
  { title: "Auto-refresh after a deploy", why: "A tab left open across a deploy can freeze; reload it quietly when nobody is mid-conversation.", status: "idea" },
  { title: "Rotate the easter eggs monthly", why: "Once everyone has found them all, the hunt is over. New spots each month keep it alive.", status: "idea" },
  { title: "Chat", why: "Left out on purpose: most teams already have Slack or Teams.", status: "parked" },
];
