// "Start meeting" on GHL Meeting Rooms. GHL has no API for them, so a room is
// just its permanent link (crm.example.com/meet/<name>?pwd=…): each person
// may save their own, and admins keep a small pool of shared team rooms for
// everyone else. Space can't see who is in a GHL room, so a pool room counts
// as busy only while a meeting Space started in it is running.

export interface PoolRoom { label: string; url: string }

/** A GHL Meeting Room link, tidied, or null if it isn't one. */
export function normalizeGhlUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s || s.length > 500) return null;
  // GHL shows the link without the scheme (crm.example.com/meet/…), so that's what people copy.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (!/^\/meet\/[^/]+\/?$/.test(u.pathname)) return null;
  u.hash = "";
  return u.toString();
}

/** Admin input: one link per line, optionally "Name | link". Bad lines are reported, not dropped silently. */
export function parsePool(text: string): { rooms: PoolRoom[]; bad: string[] } {
  const rooms: PoolRoom[] = [];
  const bad: string[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const bar = line.lastIndexOf("|");
    const name = bar >= 0 ? line.slice(0, bar).trim() : "";
    const url = normalizeGhlUrl(bar >= 0 ? line.slice(bar + 1) : line);
    if (!url) {
      bad.push(line);
      continue;
    }
    if (rooms.some((r) => r.url === url)) continue;
    rooms.push({ label: (name || `Team room ${rooms.length + 1}`).slice(0, 40), url });
  }
  return { rooms: rooms.slice(0, 20), bad };
}

/** Admin import: "email | link" per line → { email: link }. Bad lines are reported. */
export function parseRoomLinks(text: string): { links: Record<string, string>; bad: string[] } {
  const links: Record<string, string> = {};
  const bad: string[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const bar = line.indexOf("|");
    const email = (bar >= 0 ? line.slice(0, bar) : "").trim().toLowerCase();
    const url = normalizeGhlUrl(bar >= 0 ? line.slice(bar + 1) : "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !url) bad.push(line);
    else links[email] = url;
  }
  return { links, bad };
}

export type Pick =
  | { ok: true; url: string; label: string; pool: number | null }
  | { ok: false; reason: "no-room" | "all-busy" };

/** Your own room if you saved one; otherwise the first free shared room. */
export function pickRoom(own: string | null, pool: PoolRoom[], busy: Set<number>): Pick {
  if (own) return { ok: true, url: own, label: "your meeting room", pool: null };
  if (!pool.length) return { ok: false, reason: "no-room" };
  const i = pool.findIndex((_, n) => !busy.has(n));
  if (i < 0) return { ok: false, reason: "all-busy" };
  return { ok: true, url: pool[i].url, label: pool[i].label, pool: i };
}
