// What makes a floor plan usable, checked the same way by the tests and by the
// server before an Office Designer change can go live. Returns plain-English
// problems; an empty list means the floor is good.

import { blocked, doorPoint, doorwayZone, gapsOf, seatOf, WALL, type Floor, type ObjType, type Pt } from "./floor";

export const OBJ_TYPES: ObjType[] = [
  "plant", "plantTall", "sofa", "armchair", "beanbag", "table", "coffeeTable", "cafe", "rug", "logo", "mat",
  "counter", "fridge", "tv", "whiteboard", "cooler", "lamp", "bookshelf", "link", "sign", "note", "timer", "music",
  "pingpong", "pool", "piano", "arcade", "bench",
  "chair", "ottoman", "desk", "laptop", "monitor", "keyboard", "chess", "mannequin", "cabinet", "cup", "food", "tray",
  "frame", "plate", "flowers", "planter", "plantWall", "tree", "trinket", "deskLamp", "sideTable", "console", "reception",
  "microwave", "stove", "pet", "coatRack", "aquarium", "bicycle", "surfboard", "statue", "banjo", "elevator", "basket",
  "jumbotron", "custom",
];
/** Things you can walk over or that sit on walls: they don't count as clutter. */
const FLAT = new Set([
  "rug", "mat", "link", "note", "sign", "tv", "whiteboard", "logo", "frame", "plate", "plantWall", "jumbotron",
  // Tabletop things: they sit on a table, never on the floor in anyone's way.
  "laptop", "monitor", "keyboard", "cup", "food", "tray", "trinket", "deskLamp", "chess", "microwave",
]);

/** A seated avatar (64px bubble) may cover a table's edge by this little (seat ≥ 20px off the table)… */
export const SEAT_CLEAR = 20;
/** …the wall band by 4px at most (seat ≥ 46px from the room's edge)… */
export const SEAT_WALL = 46;
/** …and never the person at the next desk. */
export const SEAT_APART = 64;
/** One of the three rules above: how a seated person looks, not whether the office works. */
export const isSeatProblem = (p: string) => /^the seat at desk |^whoever sits at desks? /.test(p);

const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
interface Box { x: number; y: number; w: number; h: number }

export function checkFloor(floor: Floor): string[] {
  const problems: string[] = [];
  const open = () => true;
  const roomOf = (id: string) => floor.rooms.find((r) => r.id === id);
  // One flood fill from the arrival point, then O(1) per seat — a per-desk path
  // search would stall the server's event loop on big floors.
  const reach = reachable(floor);
  const deskBox = (d: Floor["desks"][number]): Box => ({ x: d.x - 42, y: d.y - 26 - (d.facing === "s" ? 30 : 0), w: 84, h: 82 });

  for (const r of floor.rooms) {
    const d = doorPoint(r);
    const off = { n: [0, -50], s: [0, 50], w: [-50, 0], e: [50, 0] }[r.door.side];
    if (blocked(floor, { x: d.x + off[0], y: d.y + off[1] }, open)) problems.push(`${r.name || r.id}: the way to its door is blocked`);
  }

  // Doorways stay clear: a walking lane through every door and opening (see doorwayZone).
  for (const r of floor.rooms) for (const g of gapsOf(r)) {
    const zone = doorwayZone(r, g);
    if (!zone) continue;
    for (const o of floor.objects) if (!FLAT.has(o.type) && o.type !== "music" && o.type !== "timer" && hit(zone, o)) problems.push(`${o.type} ${o.id} is in the doorway of ${r.name || r.id}`);
  }

  const ids = new Set<string>();
  for (const o of floor.objects) {
    if (ids.has(o.id)) problems.push(`two objects share the id ${o.id}`);
    ids.add(o.id);
    if (!OBJ_TYPES.includes(o.type)) problems.push(`${o.id}: unknown furniture type "${o.type}"`);
    if (![o.x, o.y, o.w, o.h].every(Number.isFinite) || o.w <= 0 || o.h <= 0) problems.push(`${o.id}: bad position or size`);
    if (o.w > 900 || o.h > 900) problems.push(`${o.id} (${o.type}) is ${o.w}×${o.h}px — too big`);
    if (o.x < 0 || o.y < 0 || o.x + o.w > floor.width || o.y + o.h > floor.height) problems.push(`${o.id} (${o.type}) is outside the building`);
    if (o.url && !/^https:\/\//.test(o.url)) problems.push(`${o.id}: links must start with https://`);
    if (o.type === "custom") problems.push(...svgProblems(o.id, o.svg));
    else if (o.svg) problems.push(`${o.id}: only custom objects carry a drawing`);
  }

  const deskIds = new Set<string>();
  for (const a of floor.desks) {
    if (deskIds.has(a.id)) problems.push(`two desks share the id ${a.id}`);
    deskIds.add(a.id);
    const r = roomOf(a.roomId);
    if (!r) {
      problems.push(`desk ${a.id} is in a room that doesn't exist (${a.roomId})`);
      continue;
    }
    const seat = seatOf(a);
    if (a.bare) {
      // An imported workstation: its table is furniture; only the seat has to work.
      const inside = (p: Pt) => p.x > r.x + WALL && p.x < r.x + r.w - WALL && p.y > r.y + WALL && p.y < r.y + r.h - WALL;
      if (!inside(seat) || !inside(a)) problems.push(`desk ${a.id} pokes out of ${r.name || r.id}`);
      if (!a.seat) problems.push(`desk ${a.id} has no seat`);
      // Its own chair is the seat; anything else solid there sits on the person.
      for (const o of floor.objects) {
        if (FLAT.has(o.type) || o.type === "chair" || o.type === "armchair" || o.type === "desk" || o.type === "table") continue;
        if (hit({ x: seat.x - 14, y: seat.y - 14, w: 28, h: 28 }, o)) problems.push(`desk ${a.id} is blocked by ${o.type} ${o.id}`);
      }
      for (const b of floor.desks) if (b.bare && a.id < b.id && Math.hypot(seatOf(b).x - seat.x, seatOf(b).y - seat.y) < 20) problems.push(`desks ${a.id} and ${b.id} share a seat`);
      // Whoever sits here is drawn as a 64px bubble around the seat: it shouldn't land on the
      // table, poke through a wall, or sit on the next person (pilot feedback, 2026-11-03).
      for (const o of floor.objects) {
        if (o.type !== "desk" && o.type !== "table") continue;
        const dx = Math.max(o.x - seat.x, 0, seat.x - (o.x + o.w)), dy = Math.max(o.y - seat.y, 0, seat.y - (o.y + o.h));
        if (Math.hypot(dx, dy) < SEAT_CLEAR) problems.push(`the seat at desk ${a.id} is on ${o.type} ${o.id}`);
      }
      if (Math.min(seat.x - r.x, r.x + r.w - seat.x, seat.y - r.y, r.y + r.h - seat.y) < SEAT_WALL) problems.push(`whoever sits at desk ${a.id} pokes through the wall of ${r.name || r.id}`);
      for (const b of floor.desks) if (b.bare && a.id < b.id && Math.hypot(seatOf(b).x - seat.x, seatOf(b).y - seat.y) < SEAT_APART) problems.push(`whoever sits at desks ${a.id} and ${b.id} would overlap`);
    } else {
      if (!(a.x - 42 >= r.x && a.x + 42 <= r.x + r.w && a.y - 56 >= r.y && a.y + 56 <= r.y + r.h)) problems.push(`desk ${a.id} pokes out of ${r.name || r.id}`);
      for (const b of floor.desks) {
        if (b.id === a.id) continue;
        if (!b.bare && a.id < b.id && hit({ x: a.x - 42, y: a.y - 26, w: 84, h: 52 }, { x: b.x - 42, y: b.y - 26, w: 84, h: 52 })) problems.push(`desks ${a.id} and ${b.id} overlap`);
        // On top of an imported workstation (its nameplate or its chair).
        const bs = seatOf(b);
        if (b.bare && (hit(deskBox(a), { x: b.x - 30, y: b.y - 10, w: 60, h: 20 }) || hit(deskBox(a), { x: bs.x - 20, y: bs.y - 20, w: 40, h: 40 }))) problems.push(`desks ${a.id} and ${b.id} overlap`);
      }
      for (const o of floor.objects) if (!FLAT.has(o.type) && hit(deskBox(a), o)) problems.push(`desk ${a.id} is blocked by ${o.type} ${o.id}`);
    }
    if (!reach(seat)) problems.push(`nobody can walk to desk ${a.id} in ${r.name || r.id}`);
  }
  if (blocked(floor, floor.spawn, open)) problems.push("the arrival point is inside a wall");
  return [...new Set(problems)];
}

const CELL = 20;
/** Which grid cells you can walk to from the arrival point. */
function reachable(floor: Floor): (p: Pt) => boolean {
  const cols = Math.floor(floor.width / CELL), rows = Math.floor(floor.height / CELL);
  const seen = new Uint8Array(cols * rows);
  const at = (c: number, r: number) => ({ x: c * CELL + CELL / 2, y: r * CELL + CELL / 2 });
  const sc = Math.floor(floor.spawn.x / CELL), sr = Math.floor(floor.spawn.y / CELL);
  const queue = [sc + sr * cols];
  seen[queue[0]] = 1;
  while (queue.length) {
    const i = queue.pop()!;
    const c = i % cols, r = (i / cols) | 0;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const ni = nc + nr * cols;
      if (seen[ni]) continue;
      seen[ni] = blocked(floor, at(nc, nr), () => true) ? 2 : 1;
      if (seen[ni] === 1) queue.push(ni);
    }
  }
  return (p) => {
    const c = Math.floor(p.x / CELL), r = Math.floor(p.y / CELL);
    if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
    // A seat may sit right against a wall band; any reachable neighbour counts.
    for (const [dc, dr] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const i = c + dc + (r + dr) * cols;
      if (seen[i] === 1) return true;
    }
    return false;
  };
}

/** A custom object's drawing: a self-contained SVG, nothing it could load or run. */
export const SVG_MAX = 16000;
export function svgProblems(id: string, svg: string | undefined): string[] {
  if (!svg) return [`${id}: a custom object needs its drawing (svg)`];
  const out: string[] = [];
  if (svg.length > SVG_MAX) out.push(`${id}: its drawing is ${svg.length} characters — keep it under ${SVG_MAX}`);
  if (!/^\s*<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) out.push(`${id}: the drawing must be one <svg>…</svg> element`);
  if (!/viewBox=/i.test(svg)) out.push(`${id}: the drawing needs a viewBox`);
  if (/<(script|foreignObject|image|iframe|object|embed|use|a|style)[\s>/]/i.test(svg)) out.push(`${id}: the drawing may only use shapes, paths, text and gradients (no script, style, image, use or links)`);
  if (/\son\w+\s*=|javascript:|href\s*=|url\(\s*['"]?(https?:|data:|\/\/)/i.test(svg)) out.push(`${id}: the drawing can't contain event handlers, links or outside references`);
  return out;
}
