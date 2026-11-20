// Emotes, Fortnite style (the owner, 2026-11-05: "make them funny"). Played on your avatar for everyone
// who can see you; quick (the owner, 2026-11-05: "make it quick"): a few seconds, or until you move. The animation for each is in styles.css under
// `[data-emote="…"]`; `prop` floats above the head while it plays.
//
// Unlocked by points (shared/points.ts). Twenty levels (the owner, 2026-11-06: "make them a little harder
// to get, more emotes, like 20 levels"): Level 1 is the day-one four, and each level after unlocks
// one more emote. Sized for someone active in the office (~20 points a day): Level 5 in about three
// weeks, the first epic (Level 11) in about three months, Legend (Level 20) in about a year.
// An epic emote also plays `fx` once across the screen of everyone near you (web/src/office/screenFx.ts).


export type ScreenFx = "shake" | "flash" | "wind" | "fireworks" | "nova" | "spotlight" | "launch" | "matrix" | "rainbow" | "vortex";

interface EmoteDef { id: string; label: string; icon: string; prop?: string; points: number; epic?: boolean; fx?: ScreenFx; blurb?: string }

export const EMOTES = [
  // Level 1: day one, everyone.
  { id: "dance", label: "Dance", icon: "🕺", prop: "🎵", points: 0 },
  { id: "chicken", label: "Chicken", icon: "🐔", points: 0 },
  { id: "robot", label: "Robot", icon: "🤖", points: 0 },
  { id: "faint", label: "Faint", icon: "😵", prop: "💫", points: 0 },
  // Levels 2–10: the days add up.
  { id: "jacks", label: "Jumping jacks", icon: "🏋️", points: 50 },
  { id: "moonwalk", label: "Moonwalk", icon: "🌙", prop: "✨", points: 125 },
  { id: "floss", label: "Floss", icon: "🧵", points: 225 },
  { id: "tpose", label: "T-pose", icon: "✈️", points: 350 },
  { id: "airguitar", label: "Air guitar", icon: "🎸", prop: "🎶", points: 500 },
  { id: "headspin", label: "Headspin", icon: "🌀", points: 675 },
  { id: "disco", label: "Disco", icon: "💃", prop: "✨", points: 875 },
  { id: "victory", label: "Victory", icon: "🏆", prop: "🎉", points: 1100 },
  { id: "micdrop", label: "Mic drop", icon: "🎤", points: 1400 },
  // Levels 11–20, epic: they light up the screen.
  { id: "landing", label: "Hero landing", icon: "💥", points: 1750, epic: true, fx: "shake", blurb: "Leap off the screen, land with a shockwave" },
  { id: "rocket", label: "Rocket", icon: "🚀", prop: "💨", points: 2150, epic: true, fx: "launch", blurb: "Blast off in a cloud of smoke" },
  { id: "thunder", label: "Thunder", icon: "⚡", prop: "⚡", points: 2600, epic: true, fx: "flash", blurb: "Call down lightning" },
  { id: "matrix", label: "The Matrix", icon: "🕶️", points: 3100, epic: true, fx: "matrix", blurb: "Dodge bullets in falling green code" },
  { id: "flight", label: "Take flight", icon: "🦸", points: 3650, epic: true, fx: "wind", blurb: "Cape out, up, up and away" },
  { id: "rainbow", label: "Rainbow", icon: "🌈", prop: "✨", points: 4250, epic: true, fx: "rainbow", blurb: "Ride a rainbow across the office" },
  { id: "fireworks", label: "Fireworks", icon: "🎆", prop: "✨", points: 4900, epic: true, fx: "fireworks", blurb: "Fireworks over the whole office" },
  { id: "vortex", label: "Vortex", icon: "🌪️", points: 5600, epic: true, fx: "vortex", blurb: "Spin up a storm" },
  { id: "supernova", label: "Supernova", icon: "🌟", prop: "✨", points: 6400, epic: true, fx: "nova", blurb: "Go supernova" },
  { id: "legend", label: "Legend", icon: "👑", points: 7500, epic: true, fx: "spotlight", blurb: "Spotlight, crown, gold rain" },
] as const satisfies readonly EmoteDef[];

/** The points each level starts at: Level 1 at 0, then one level per emote unlock (20 in all). */
export const LEVELS: number[] = [0, ...EMOTES.filter((e) => e.points > 0).map((e) => e.points)];
export const MAX_LEVEL = LEVELS.length;
/** 1–20. */
export function levelOf(points: number | null | undefined): number {
  const p = points ?? 0;
  let n = 0;
  for (const at of LEVELS) if (p >= at) n++;
  return Math.max(1, n);
}

export type EmoteId = (typeof EMOTES)[number]["id"];
export type Emote = (typeof EMOTES)[number];
export const isEmote = (x: unknown): x is EmoteId => typeof x === "string" && EMOTES.some((e) => e.id === x);
export const emoteDef = (id: string | null | undefined): EmoteDef | undefined => EMOTES.find((e) => e.id === id);
/** How long an emote plays: a few seconds (epic ones a little longer, so the move lands). Moving stops it sooner. */
export const EMOTE_MS = 4_000;
export const EPIC_EMOTE_MS = 5_200;
export const emoteMs = (id: string) => ("epic" in (emoteDef(id) ?? {}) ? EPIC_EMOTE_MS : EMOTE_MS);

/** Points this emote needs. */
export const emotePoints = (id: string) => emoteDef(id)?.points ?? Infinity;

/** Can someone with these points use this emote? Guests (no points) get the day-one set. */
export function unlocked(id: string, points: number | null | undefined): boolean {
  const e = emoteDef(id);
  return Boolean(e) && (points ?? 0) >= e!.points;
}
