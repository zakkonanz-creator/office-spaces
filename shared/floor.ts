// Floor geometry shared by the server (authoritative room membership, door
// checks) and the client (movement, click-to-walk, who-can-hear-whom).
//
// The model is deliberately small: rooms are rectangles with one door, walls are
// the room edges minus the door gap, and everything that isn't a room is the open
// floor. That covers every room on the team's Kumospace floor.

export type Side = "n" | "s" | "e" | "w";

export interface Door {
  side: Side;
  /** Offset of the door's centre along the wall, measured from the wall's top/left end. */
  at: number;
  width: number;
}

export interface Room {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  door: Door;
  kind: "office" | "team" | "meeting" | "common";
  floor: "wood" | "oak" | "carpet" | "slate" | "tile" | "sage";
  /** The back wall's look (drawing only): glass panels, brick, or a green feature wall. */
  wall?: "glass" | "brick" | "green" | "whitebrick";
  /** Can the people inside shut the door? Common areas (kitchen) can't. */
  closable: boolean;
  /**
   * More gaps in this room's walls, opened and shut with the room's own door
   * state: the other side of a neighbour's door (Kumospace offices open into
   * each other), or the extra open sides of an open-plan area.
   */
  openings?: Door[];
}

export interface Desk {
  id: string;
  roomId: string;
  x: number;
  y: number;
  /** Which way the person sitting at the desk faces. */
  facing: "n" | "s";
  /** Roster name the desk was seeded for; claimed by matching at first login. */
  owner?: string;
  title?: string;
  /**
   * Imported workstations: the table and computer are furniture objects, so the
   * desk draws only its nameplate, and the chair it was found with is the seat.
   */
  bare?: boolean;
  seat?: { x: number; y: number };
}

/** Where someone sits at a desk. */
export const seatOf = (d: Pick<Desk, "x" | "y" | "facing" | "seat">): { x: number; y: number } =>
  d.seat ?? { x: d.x, y: d.y + (d.facing === "s" ? -40 : 40) };

export type ObjType =
  | "plant" | "sofa" | "armchair" | "table" | "rug" | "logo" | "mat" | "counter"
  | "tv" | "link" | "sign" | "note" | "timer" | "music" | "bookshelf" | "beanbag"
  | "plantTall" | "lamp" | "fridge" | "cafe" | "whiteboard" | "cooler" | "coffeeTable"
  | "pingpong" | "pool" | "piano" | "arcade" | "bench"
  // Imported from Kumospace (2026-10-07):
  | "chair" | "ottoman" | "desk" | "laptop" | "monitor" | "keyboard" | "chess" | "mannequin" | "cabinet"
  | "cup" | "food" | "tray" | "frame" | "plate" | "flowers" | "planter" | "plantWall" | "tree" | "trinket"
  | "deskLamp" | "sideTable" | "console" | "reception" | "microwave" | "stove" | "pet" | "coatRack"
  | "aquarium" | "bicycle" | "surfboard" | "statue" | "banjo" | "elevator" | "basket"
  // The wall screen with live company info, and anything else the Designer draws itself:
  | "jumbotron" | "custom";

export interface Obj {
  id: string;
  type: ObjType;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  /** For link objects. Empty means "an admin still needs to set this". */
  url?: string;
  /** For signs and sticky notes. */
  text?: string;
  /** For music: a YouTube video or playlist id. */
  youtube?: string;
  color?: string;
  /** Rug look: "runner" is a long striped hallway runner. */
  style?: "runner";
  /** Sub-look within a type, e.g. a plant's species or a cup's drink. */
  variant?: string;
  /** Clockwise rotation in degrees; 0 = a seat faces south, a laptop's screen is at the top. */
  r?: number;
  /** For "custom": the drawing, an SVG Claude wrote. Shown as an image, so it can't run code. */
  svg?: string;
}

export interface Floor {
  id: string;
  name: string;
  width: number;
  height: number;
  spawn: { x: number; y: number };
  rooms: Room[];
  desks: Desk[];
  objects: Obj[];
}

export interface Pt {
  x: number;
  y: number;
}

/**
 * The floor as a guest may see it: the layout, but not the staff directory
 * (desk owners and titles) or the links and notes pinned around the office —
 * except in the guest's own room, which they're meant to use.
 */
export function guestFloor(f: Floor, roomId: string | null): Floor {
  return {
    ...f,
    desks: f.desks.map(({ owner: _o, title: _t, ...d }) => d),
    objects: f.objects.map((o) => {
      if (roomId && roomAt(f, { x: o.x + o.w / 2, y: o.y + o.h / 2 })?.id === roomId) return o;
      const { url: _u, text: _x, youtube: _y, ...rest } = o;
      return rest as Obj;
    }),
  };
}

/** Half-thickness of a wall as felt by an avatar: the avatar's body can't overlap it. */
export const WALL = 18;

const inRect = (p: Pt, x: number, y: number, w: number, h: number) =>
  p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;

/** The room whose interior holds the point. Standing in a doorway counts as outside. */
export function roomAt(floor: Floor, p: Pt): Room | null {
  for (const r of floor.rooms) {
    if (inRect(p, r.x + WALL, r.y + WALL, r.w - 2 * WALL, r.h - 2 * WALL)) return r;
  }
  return null;
}

/**
 * The space a doorway needs kept clear of solid furniture: a lane through the
 * middle of the gap (at most 120px wide) reaching 50px into the room and 50px out.
 */
export function doorwayZone(r: Room, g: Door = r.door): { x: number; y: number; w: number; h: number } | null {
  // A wide open-plan side is walkable somewhere along it; reachability checks that, not a fixed lane.
  if (g.width > 200) return null;
  const d = doorPoint(r, g);
  const half = Math.min(g.width, 120) / 2;
  // Deep enough to step through (the wall band plus a stride each side), not a whole aisle.
  return g.side === "n" || g.side === "s" ? { x: d.x - half, y: d.y - 36, w: half * 2, h: 72 } : { x: d.x - 36, y: d.y - half, w: 72, h: half * 2 };
}

/** Every way into a room: its door, then its other openings. */
export const gapsOf = (r: Room): Door[] => (r.openings ? [r.door, ...r.openings] : [r.door]);

/** Centre of a room's door (or of one of its gaps), in floor coordinates. */
export function doorPoint(r: Room, g: Door = r.door): Pt {
  const { side, at } = g;
  if (side === "n") return { x: r.x + at, y: r.y };
  if (side === "s") return { x: r.x + at, y: r.y + r.h };
  if (side === "w") return { x: r.x, y: r.y + at };
  return { x: r.x + r.w, y: r.y + at };
}

/**
 * Is this point inside a wall? `passable(roomId)` says whether the caller may
 * walk through that room's door right now (open, or closed but admitted).
 */
export function blocked(floor: Floor, p: Pt, passable: (roomId: string) => boolean): boolean {
  if (p.x < WALL || p.y < WALL || p.x > floor.width - WALL || p.y > floor.height - WALL) return true;
  for (const r of floor.rooms) {
    const outer = inRect(p, r.x - WALL, r.y - WALL, r.w + 2 * WALL, r.h + 2 * WALL);
    if (!outer) continue;
    const inner = inRect(p, r.x + WALL, r.y + WALL, r.w - 2 * WALL, r.h - 2 * WALL);
    if (inner) continue;
    // In the wall band. Only the door gap (or one of the room's openings) is walkable.
    const nearN = Math.abs(p.y - r.y) <= WALL;
    const nearS = Math.abs(p.y - (r.y + r.h)) <= WALL;
    const nearW = Math.abs(p.x - r.x) <= WALL;
    const nearE = Math.abs(p.x - (r.x + r.w)) <= WALL;
    const bands = [nearN, nearS, nearW, nearE].filter(Boolean).length;
    let inGap = false;
    if (bands === 1) {
      for (const { side, at, width } of r.openings ? [r.door, ...r.openings] : [r.door]) {
        const half = width / 2 - WALL;
        if (side === "n" && nearN) inGap ||= Math.abs(p.x - (r.x + at)) <= half;
        if (side === "s" && nearS) inGap ||= Math.abs(p.x - (r.x + at)) <= half;
        if (side === "w" && nearW) inGap ||= Math.abs(p.y - (r.y + at)) <= half;
        if (side === "e" && nearE) inGap ||= Math.abs(p.y - (r.y + at)) <= half;
      }
    }
    if (!inGap) return true;
    if (!passable(r.id)) return true;
  }
  return false;
}

/**
 * Move from `a` toward `b`, stopping at the first wall. Steps are kept shorter
 * than a wall is thick so nothing tunnels through at high speed.
 */
export function step(floor: Floor, a: Pt, b: Pt, passable: (roomId: string) => boolean): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const n = Math.max(1, Math.ceil(dist / (WALL / 2)));
  let cur = a;
  for (let i = 1; i <= n; i++) {
    const next = { x: a.x + (dx * i) / n, y: a.y + (dy * i) / n };
    if (blocked(floor, next, passable)) {
      // Slide along the wall: try each axis on its own.
      const xOnly = { x: next.x, y: cur.y };
      const yOnly = { x: cur.x, y: next.y };
      if (!blocked(floor, xOnly, passable)) cur = xOnly;
      else if (!blocked(floor, yOnly, passable)) cur = yOnly;
      return cur;
    }
    cur = next;
  }
  return cur;
}

// ── Click-to-walk ──────────────────────────────────────────────────────────

const CELL = 20;

/** Grid A* across the floor. Returns waypoints (excluding `from`), or [] if unreachable. */
export function findPath(floor: Floor, from: Pt, to: Pt, passable: (roomId: string) => boolean): Pt[] {
  const cols = Math.floor(floor.width / CELL);
  const rows = Math.floor(floor.height / CELL);
  const idx = (c: number, r: number) => r * cols + c;
  const cellOf = (p: Pt) => [Math.min(cols - 1, Math.max(0, Math.floor(p.x / CELL))), Math.min(rows - 1, Math.max(0, Math.floor(p.y / CELL)))];
  const centre = (c: number, r: number): Pt => ({ x: c * CELL + CELL / 2, y: r * CELL + CELL / 2 });

  const walk = new Uint8Array(cols * rows); // 0 unknown, 1 open, 2 blocked
  const open = (c: number, r: number) => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
    const i = idx(c, r);
    if (!walk[i]) walk[i] = blocked(floor, centre(c, r), passable) ? 2 : 1;
    return walk[i] === 1;
  };

  let [sc, sr] = cellOf(from);
  let [gc, gr] = cellOf(to);
  if (!open(gc, gr)) {
    // Clicked on furniture or a wall: aim for the nearest open cell instead.
    let best: [number, number] | null = null;
    for (let rad = 1; rad < 8 && !best; rad++) {
      for (let dc = -rad; dc <= rad && !best; dc++)
        for (let dr = -rad; dr <= rad && !best; dr++) if (open(gc + dc, gr + dr)) best = [gc + dc, gr + dr];
    }
    if (!best) return [];
    [gc, gr] = best;
  }
  if (!open(sc, sr)) walk[idx(sc, sr)] = 1; // we are standing here, so it's walkable

  const g = new Float32Array(cols * rows).fill(Infinity);
  const came = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);
  // Binary heap of [f, index].
  const heap: [number, number][] = [];
  const push = (f: number, i: number) => {
    heap.push([f, i]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  const h = (c: number, r: number) => Math.hypot(c - gc, r - gr);

  const start = idx(sc, sr), goal = idx(gc, gr);
  g[start] = 0;
  push(h(sc, sr), start);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let found = false;
  while (heap.length) {
    const [, cur] = pop();
    if (cur === goal) { found = true; break; }
    if (closed[cur]) continue;
    closed[cur] = 1;
    const c = cur % cols, r = Math.floor(cur / cols);
    for (const [dc, dr] of dirs) {
      const nc = c + dc, nr = r + dr;
      if (!open(nc, nr)) continue;
      if (dc && dr && (!open(c + dc, r) || !open(c, r + dr))) continue; // no corner cutting
      const ni = idx(nc, nr);
      const ng = g[cur] + (dc && dr ? Math.SQRT2 : 1);
      if (ng < g[ni]) {
        g[ni] = ng;
        came[ni] = cur;
        push(ng + h(nc, nr), ni);
      }
    }
  }
  if (!found) return [];

  const cells: Pt[] = [];
  for (let i = goal; i !== start && i !== -1; i = came[i]) cells.push(centre(i % cols, Math.floor(i / cols)));
  cells.reverse();
  // The final waypoint is the exact click when it was walkable.
  if (cells.length && !blocked(floor, to, passable)) cells[cells.length - 1] = to;
  return smooth(floor, from, cells, passable);
}

/** Drop waypoints that a straight walk could skip. */
function smooth(floor: Floor, from: Pt, pts: Pt[], passable: (roomId: string) => boolean): Pt[] {
  const out: Pt[] = [];
  let anchor = from;
  let i = 0;
  while (i < pts.length) {
    let j = pts.length - 1;
    while (j > i && !clearLine(floor, anchor, pts[j], passable)) j--;
    out.push(pts[j]);
    anchor = pts[j];
    i = j + 1;
  }
  return out;
}

function clearLine(floor: Floor, a: Pt, b: Pt, passable: (roomId: string) => boolean): boolean {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (WALL / 2));
  for (let i = 1; i <= n; i++) {
    if (blocked(floor, { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }, passable)) return false;
  }
  return true;
}

// ── Who hears whom ─────────────────────────────────────────────────────────

/** How far a voice carries on the open floor (px; a floor tile is 80). Full volume to 60% of it,
 *  silence at it. One tile further than before since 2026-11-05 (Alex: conversations cut out a
 *  little early): normal = full volume ~2.5 tiles out, gone at ~4.25. Inside a room it's moot. */
export const AUDIO_RANGES = { small: 260, normal: 340, large: 460 } as const;
export type AudioRange = keyof typeof AUDIO_RANGES;

export interface Hearer extends Pt {
  roomId: string | null;
}

/**
 * Volume (0–1) at which `a` hears `b`. Symmetric by construction.
 *
 *  - A closed door is a hard wall for sound: same closed room = 1, otherwise 0.
 *  - Same open room = room audio, everyone at full volume (Kumospace's "Room audio").
 *  - Two different rooms never hear each other.
 *  - Open floor ↔ open floor, or open floor ↔ someone just inside an open door:
 *    full volume up to 60% of the range, fading to silence at the range.
 *    Across an open doorway the range is shortened so a room isn't a broadcast.
 */
export function volumeBetween(a: Hearer, b: Hearer, closed: (roomId: string) => boolean, range: number): number {
  const aClosed = a.roomId !== null && closed(a.roomId);
  const bClosed = b.roomId !== null && closed(b.roomId);
  if (aClosed || bClosed) return a.roomId === b.roomId ? 1 : 0;
  if (a.roomId && a.roomId === b.roomId) return 1;
  if (a.roomId && b.roomId) return 0;
  const r = a.roomId || b.roomId ? range * 0.6 : range;
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  const full = r * 0.6;
  if (d <= full) return 1;
  if (d >= r) return 0;
  return 1 - (d - full) / (r - full);
}
