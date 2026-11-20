// Everything points unlock (emotes and pets), in order: the next one to aim for and the ones a
// change in points just opened. Drives the progress bar by your name and the unlock card.

import { EMOTES } from "./emotes";
import { PETS } from "./pets";
import { OUTFITS, type Rarity } from "./outfits";

export interface Reward { kind: "emote" | "epic" | "pet" | "outfit"; id: string; label: string; icon: string; points: number; rarity?: Rarity }

export const REWARDS: Reward[] = [
  ...EMOTES.map((e) => ({ kind: ("epic" in e ? "epic" : "emote") as Reward["kind"], id: e.id, label: e.label, icon: e.icon, points: e.points })),
  ...PETS.map((p) => ({ kind: "pet" as const, id: p.id, label: p.label, icon: p.icon, points: p.points })),
  ...OUTFITS.map((o) => ({ kind: "outfit" as const, id: o.id, label: o.label, icon: o.icon, points: o.points, rarity: o.rarity as Rarity })),
].filter((r) => r.points > 0).sort((a, b) => a.points - b.points);

/** The next reward above these points, and how far along you are from the last one (0–1). */
export function nextReward(points: number): { reward: Reward; from: number; progress: number } | null {
  const i = REWARDS.findIndex((r) => r.points > points);
  if (i < 0) return null;
  const from = i ? REWARDS[i - 1].points : 0;
  const reward = REWARDS[i];
  return { reward, from, progress: Math.max(0, Math.min(1, (points - from) / (reward.points - from))) };
}

/** Rewards crossed going from `before` to `after` points (none when points go down). */
export const newlyUnlocked = (before: number, after: number): Reward[] =>
  after > before ? REWARDS.filter((r) => r.points > before && r.points <= after) : [];

export const KIND_NAME: Record<Reward["kind"], string> = { emote: "emote", epic: "epic emote", pet: "pet", outfit: "outfit" };
