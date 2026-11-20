// Outfits, Fortnite style (the owner, 2026-11-06: "make it so outfits can be unlocked, make it cool like
// fortnite"). Each has a rarity (the colour of its card in the Locker) and unlocks with points like
// emotes and pets. Worn on your avatar for everyone to see; the look is in styles.css under
// `[data-outfit="…"]`. Without one you wear your own colours (World.tsx `look`).

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary" | "mythic";

export const OUTFITS = [
  { id: "tee", icon: "👕", label: "Acme Tee", rarity: "common", points: 0 },
  { id: "hoodie", icon: "🧥", label: "Cozy Hoodie", rarity: "uncommon", points: 300 },
  { id: "tracksuit", icon: "🏃", label: "Tracksuit", rarity: "uncommon", points: 600 },
  { id: "chef", icon: "👨‍🍳", label: "Head Chef", rarity: "rare", points: 1000 },
  { id: "suit", icon: "👔", label: "Closer", rarity: "rare", points: 1500 },
  { id: "astronaut", icon: "👨‍🚀", label: "Astronaut", rarity: "epic", points: 2000 },
  { id: "ninja", icon: "🥋", label: "Ninja", rarity: "epic", points: 2800 },
  { id: "knight", icon: "🛡️", label: "Knight", rarity: "epic", points: 3500 },
  { id: "superhero", icon: "🦸", label: "Super Acme", rarity: "legendary", points: 4600 },
  { id: "wizard", icon: "🧙", label: "Wizard", rarity: "legendary", points: 5800 },
  { id: "gold", icon: "🥇", label: "24 Karat", rarity: "legendary", points: 7000 },
  { id: "galaxy", icon: "🌌", label: "Galaxy", rarity: "mythic", points: 9000 },
] as const satisfies readonly { id: string; icon: string; label: string; rarity: Rarity; points: number }[];

export type OutfitId = (typeof OUTFITS)[number]["id"];
export const outfitDef = (id: string | null | undefined) => OUTFITS.find((o) => o.id === id);
export const outfitUnlocked = (id: string, points: number | null | undefined) => { const o = outfitDef(id); return Boolean(o) && (points ?? 0) >= o!.points; };
export const RARITY_LABEL: Record<Rarity, string> = { common: "Common", uncommon: "Uncommon", rare: "Rare", epic: "Epic", legendary: "Legendary", mythic: "Mythic" };
