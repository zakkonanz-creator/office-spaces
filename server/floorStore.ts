// The live floor plan. Starts from floor/demo-office.json; Office Designer
// changes are saved as numbered versions in Postgres and the newest one wins
// at boot. Every module shares this one object, and a change replaces its
// contents in place so references held elsewhere stay valid.

import { one, q, getSetting, setSetting } from "./db";
import type { Floor } from "../shared/floor";
import { checkFloor, isSeatProblem } from "../shared/floorCheck";
import { fixSeats } from "../shared/seatFix";
import seed from "../floor/demo-office.json";
import { createHash } from "node:crypto";

/** Which layout file this release ships. A Designer version applies only on top of the file it
 *  was made from: when a new layout is deployed, older versions stay in History but don't load. */
export const SEED_HASH = createHash("sha256").update(JSON.stringify(seed)).digest("hex").slice(0, 16);

export const floor: Floor = structuredClone(seed as Floor);

let liveVersion = 0;
export const currentVersion = () => liveVersion;

/** Room names admins give rooms in the app. They sit on top of whatever layout is live, so a
 *  new layout release or a Designer change never loses them. Empty = unnamed. */
let roomNames: Record<string, string> = {};
function applyRoomNames() {
  for (const r of floor.rooms) if (r.id in roomNames) r.name = roomNames[r.id];
}
export async function setRoomName(roomId: string, name: string) {
  roomNames = { ...roomNames, [roomId]: name };
  await setSetting("roomNames", roomNames);
  applyRoomNames();
}

export async function loadFloor() {
  roomNames = await getSetting<Record<string, string>>("roomNames", {});
  applyRoomNames();
  await q(`CREATE TABLE IF NOT EXISTS floor_versions (
    id SERIAL PRIMARY KEY,
    floor JSONB NOT NULL,
    summary TEXT NOT NULL,
    prompt TEXT,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`ALTER TABLE floor_versions ADD COLUMN IF NOT EXISTS base_hash TEXT`);
  const latest = await one<{ id: number; floor: Floor; base_hash: string | null }>(`SELECT id, floor, base_hash FROM floor_versions ORDER BY id DESC LIMIT 1`);
  if (!latest || latest.base_hash !== SEED_HASH) {
    if (latest) console.log(`floor version ${latest.id} was made on an earlier layout file — using this release's layout (it's still in History)`);
    // The layout file's own seats, made to fit (see seatFix) and saved as a version of it.
    const moves = fixSeats(floor);
    if (moves.length && !checkFloor(floor).length) await saveSeatFix(structuredClone(floor), moves.length);
    return;
  }
  // A saved layout must still fit the building in this release (rooms come from
  // the code). If it doesn't, run on the file's layout and say why.
  const candidate = structuredClone(floor);
  candidate.desks = latest.floor.desks;
  candidate.objects = latest.floor.objects;
  for (const r of candidate.rooms) {
    const n = latest.floor.rooms.find((x) => x.id === r.id);
    if (n) Object.assign(r, { name: n.name, floor: n.floor });
  }
  takeGeometry(candidate, latest.floor);
  // Seats that don't fit a seated person (on a table, through a wall, on a neighbour) move first:
  // that rule arrived after many versions were saved, and it shouldn't cost anyone their layout.
  const moves = fixSeats(candidate);
  const all = checkFloor(candidate);
  // A seat that still doesn't fit is cosmetic: it never costs the office its layout.
  const problems = all.filter((p) => !isSeatProblem(p));
  if (all.length > problems.length) console.error(`floor version ${latest.id}: ${all.length - problems.length} seats still don't fit a seated person (${all.find(isSeatProblem)})`);
  if (problems.length) {
    console.error(`floor version ${latest.id} doesn't fit this release (${problems.slice(0, 3).join("; ")}) — using the layout file instead. An admin can restore or redesign.`);
    fixSeats(floor); // the layout file's seats too, in memory only: the failed version stays the newest
    return;
  }
  replaceFloor(candidate);
  liveVersion = latest.id;
  if (moves.length && all.length === problems.length) await saveSeatFix(structuredClone(floor), moves.length);
}

/** Saves the boot-time seat fix as an ordinary version: it shows in History and can be undone. */
async function saveSeatFix(next: Floor, n: number) {
  const { version } = await saveFloorVersion(next, `Moved ${n} seat${n === 1 ? "" : "s"} so whoever sits there fits: clear of the table, inside the walls, not on the next person.`, null, null, true);
  console.log(`floor: moved ${n} seats so people fit at their desks (version ${version})`);
}

/** Swap in a new plan. Rooms keep their identity (doors and occupancy are keyed by id).
 *  Returns how far the building shifted, so people standing in it can move with it. */
export function replaceFloor(next: Floor): { dx: number; dy: number } {
  const before = { x: floor.rooms[0]?.x ?? 0, y: floor.rooms[0]?.y ?? 0 };
  for (const r of floor.rooms) {
    const n = next.rooms.find((x) => x.id === r.id);
    if (n) Object.assign(r, { name: n.name, floor: n.floor, closable: n.closable });
  }
  takeGeometry(floor, next);
  floor.desks.splice(0, floor.desks.length, ...next.desks);
  floor.objects.splice(0, floor.objects.length, ...next.objects);
  applyRoomNames();
  return { dx: (floor.rooms[0]?.x ?? 0) - before.x, dy: (floor.rooms[0]?.y ?? 0) - before.y };
}

// ── Growing the building ────────────────────────────────────────────────────
// Rooms come from the layout file and can't be moved one by one. What a layout
// version may do is grow the building: add space along an edge, which shifts
// every room by the same amount. That's the only geometry change accepted.

const seedFloor = seed as Floor;
import { MAX_BUILDING } from "../shared/floorEdits";
export { MAX_BUILDING };

/** The uniform shift of `f`'s rooms from the layout file, or null if they aren't the file's rooms moved together. */
export function geometryShift(f: Floor): { dx: number; dy: number } | null {
  let dx: number | null = null, dy: number | null = null;
  for (const r of seedFloor.rooms) {
    const n = f.rooms.find((x) => x.id === r.id);
    if (!n || n.w !== r.w || n.h !== r.h) return null;
    if (dx === null) { dx = n.x - r.x; dy = n.y - r.y; }
    else if (n.x - r.x !== dx || n.y - r.y !== dy) return null;
  }
  if (f.rooms.length !== seedFloor.rooms.length || dx === null || dy === null || dx < 0 || dy < 0) return null;
  if (f.width < seedFloor.width + dx || f.height < seedFloor.height + dy || f.width > MAX_BUILDING || f.height > MAX_BUILDING) return null;
  return { dx, dy };
}

/** Copy a version's building size and room positions onto `target`, if they're a valid grow of the file's. */
export function takeGeometry(target: Floor, source: Floor) {
  if (!geometryShift(source)) return;
  target.width = source.width;
  target.height = source.height;
  target.spawn = { ...source.spawn };
  for (const r of target.rooms) {
    const n = source.rooms.find((x) => x.id === r.id)!;
    r.x = n.x;
    r.y = n.y;
  }
}

export async function saveFloorVersion(next: Floor, summary: string, prompt: string | null, userId: number | null, keepNames = false) {
  // A Designer rename is a rename: keep it as the room's name across layouts too. Restoring an
  // older layout (keepNames) leaves room names alone — they're not part of a layout's history.
  if (!keepNames) for (const r of next.rooms) {
    const cur = floor.rooms.find((x) => x.id === r.id);
    if (cur && r.name !== cur.name) await setRoomName(r.id, r.name);
  }
  const row = await one<{ id: number }>(
    `INSERT INTO floor_versions (floor, summary, prompt, created_by, base_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [JSON.stringify(next), summary, prompt, userId, SEED_HASH],
  );
  const moved = replaceFloor(next);
  liveVersion = row!.id;
  return { version: row!.id, moved };
}

export const floorVersions = () =>
  q(`SELECT v.id, v.summary, v.prompt, v.created_at, u.name AS by FROM floor_versions v LEFT JOIN users u ON u.id = v.created_by ORDER BY v.id DESC LIMIT 30`);

/** The plan as of a version (0 = the original from the repo). */
export async function floorAt(versionId: number): Promise<Floor | null> {
  if (versionId === 0) return structuredClone(seed as Floor);
  const r = await one<{ floor: Floor }>(`SELECT floor FROM floor_versions WHERE id = $1`, [versionId]);
  return r?.floor ?? null;
}
