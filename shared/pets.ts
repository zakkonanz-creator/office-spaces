// Pets: a little animal that trots after your avatar. Teammates can pet it.
// Unlocked by points (shared/points.ts); two for everyone from day one.

export const PETS = [
  { id: "cat", label: "Cat", icon: "🐈", points: 0 },
  { id: "dog", label: "Dog", icon: "🐕", points: 0 },
  { id: "bunny", label: "Bunny", icon: "🐇", points: 150 },
  { id: "duck", label: "Duck", icon: "🦆", points: 400 },
  { id: "fox", label: "Fox", icon: "🦊", points: 900 },
  { id: "penguin", label: "Penguin", icon: "🐧", points: 1800 },
  { id: "owl", label: "Owl", icon: "🦉", points: 3500 },
  { id: "dragon", label: "Dragon", icon: "🐉", points: 7000 },
] as const;

export type PetId = (typeof PETS)[number]["id"];
export const petDef = (id: string | null | undefined) => PETS.find((p) => p.id === id);
export const petUnlocked = (id: string, points: number | null | undefined) => { const p = petDef(id); return Boolean(p) && (points ?? 0) >= p!.points; };
