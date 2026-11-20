// "Ana is in": a quiet note (no sound) every time a teammate comes into the office, not only the
// first time. The first-ever visit keeps its own "Say hi" welcome instead.

/** Back within this long of leaving = a reload or a network blip, not an arrival. */
export const BLIP_MS = 3 * 60e3;

export function arrivalNote(
  p: { id: string; name: string; role: string },
  me: { id: string; role: string; status: string } | null,
  leftAt: number | undefined,
  now: number,
): string | null {
  if (!me || p.id === me.id) return null;
  if (p.role === "guest" || me.role === "guest") return null; // guests come and go with their host
  if (me.status === "focusing") return null; // Focusing means no interruptions, quiet ones included
  if (leftAt !== undefined && now - leftAt < BLIP_MS) return null;
  return `${p.name.split(" ")[0]} is in`;
}
