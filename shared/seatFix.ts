// Moves imported seats (and their chairs) to where a seated avatar fits: just off its own
// table, inside the walls, clear of the next person. Kumospace's chairs were drawn tucked
// under tables, so a 64px bubble landed on the table, through a wall or on a neighbour
// (pilot feedback, 2026-11-03).
//
// checkFloor's SEAT_* rules define "fits"; only seats they'd flag move, so a floor that
// already fits comes back untouched. Coordinates are room-relative throughout, so it works
// on a building that has been grown (every room shifted) as well as on the layout file.

import { doorwayZone, gapsOf, type Desk, type Floor, type Obj } from "./floor";
import { SEAT_APART, SEAT_CLEAR, SEAT_WALL } from "./floorCheck";

type Side = "n" | "s" | "e" | "w";
export interface SeatMove { id: string; owner?: string; from: { x: number; y: number }; to: { x: number; y: number }; side: Side }

const GAP = 36; // seat centre to table edge, when the room has space for it
const opposite: Record<Side, Side> = { n: "s", s: "n", e: "w", w: "e" };
/** A chair drawn facing south, turned clockwise: a seat north of its table faces south (0°), etc. */
const turn: Record<Side, number> = { n: 0, e: 90, s: 180, w: 270 };
/** Things a seated person may overlap: flat things, tabletop things, and seating itself. */
const SOFT = new Set(["rug", "mat", "link", "note", "sign", "tv", "whiteboard", "logo", "frame", "plate", "plantWall", "jumbotron",
  "laptop", "monitor", "keyboard", "cup", "food", "tray", "trinket", "deskLamp", "chess", "microwave", "chair", "armchair", "desk", "table"]);

type Pt = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };
const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inBox = (p: Pt, o: Box) => p.x >= o.x && p.x <= o.x + o.w && p.y >= o.y && p.y <= o.y + o.h;
const off = (p: Pt, o: Box) => Math.hypot(Math.max(o.x - p.x, 0, p.x - (o.x + o.w)), Math.max(o.y - p.y, 0, p.y - (o.y + o.h)));

/** The side of the table a seat is on (the edge it's furthest past, or nearest to from inside). */
function sideOf(s: Pt, t: Box): Side {
  const d = { n: t.y - s.y, s: s.y - (t.y + t.h), w: t.x - s.x, e: s.x - (t.x + t.w) };
  return (Object.keys(d) as Side[]).reduce((a, b) => (d[b] > d[a] ? b : a));
}

/**
 * Re-seats every imported desk whose seat doesn't fit, in place. Returns what moved; empty
 * means nothing needed to (or nothing could be improved — checkFloor will still say why).
 */
export function fixSeats(floor: Floor): SeatMove[] {
  const room = (id: string) => floor.rooms.find((r) => r.id === id);
  const tables = floor.objects.filter((o) => o.type === "desk" || o.type === "table");
  const zones = floor.rooms.flatMap((r) => gapsOf(r).map((g) => doorwayZone(r, g)).filter((z): z is Box => !!z));
  const chairOf = new Map<string, Obj>();
  for (const d of floor.desks) {
    const c = d.seat && floor.objects.find((o) => (o.type === "chair" || o.type === "armchair") && Math.abs(o.x + o.w / 2 - d.seat!.x) <= 3 && Math.abs(o.y + o.h / 2 - d.seat!.y) <= 3);
    if (c) chairOf.set(d.id, c);
  }

  /** Would a seat here fit, with the other seats where they are now? */
  const fits = (d: Desk, p: Pt): boolean => {
    const r = room(d.roomId);
    if (!r) return true;
    if (tables.some((t) => off(p, t) < SEAT_CLEAR)) return false;
    if (Math.min(p.x - r.x, r.x + r.w - p.x, p.y - r.y, r.y + r.h - p.y) < SEAT_WALL) return false;
    if (floor.desks.some((b) => b !== d && b.bare && b.seat && Math.hypot(b.seat.x - p.x, b.seat.y - p.y) < SEAT_APART)) return false;
    if (floor.objects.some((o) => !SOFT.has(o.type) && hit({ x: p.x - 14, y: p.y - 14, w: 28, h: 28 }, o))) return false;
    // The chair comes along, and a chair mustn't stand in a doorway.
    const c = chairOf.get(d.id);
    if (c && zones.some((z) => hit(z, { x: p.x - c.w / 2, y: p.y - c.h / 2, w: c.w, h: c.h }))) return false;
    return true;
  };
  const needsMove = (d: Desk) => !!d.bare && !!d.seat && !fits(d, d.seat);
  if (!floor.desks.some(needsMove)) return [];

  const moved = new Map<string, { from: Pt; side: Side }>();
  const note = (d: Desk, side: Side) => {
    if (!moved.has(d.id)) moved.set(d.id, { from: { ...d.seat! }, side });
    moved.get(d.id)!.side = side;
  };

  // Tech Support's tablet shelves stood 18px off the south wall, right where the people at the
  // wooden benches sit: back to the wall and shallower (the tablets are wall-mounted links).
  const ts = room("engineering");
  if (ts) for (const o of floor.objects) {
    if (o.type === "console" && o.h === 64 && o.y + o.h === ts.y + ts.h - 22 && o.y > ts.y + ts.h / 2) {
      o.h = 44;
      o.y = ts.y + ts.h - 18 - o.h;
    }
  }

  // Onboarding's back row is eight people on four tables between the front row's chairs and the
  // south wall; seated one by one, some end up in the aisle. Seat it together on the south side,
  // 64px apart, each as close to their own computer as that allows.
  const ob = room("team-north");
  if (ob) {
    // A vase on the floor stood exactly where the row sits: to the room's south-west corner.
    const vase = floor.objects.find((o) => o.id === "k393" && o.type === "flowers" && o.x - ob.x === 262 && o.y - ob.y === 342);
    if (vase) { vase.x = ob.x + 18; vase.y = ob.y + 360; }
    const y = ob.y + ob.h - SEAT_WALL - 1;
    for (const ids of [["team-north-k13", "team-north-k3", "team-north-k12", "team-north-k11", "team-north-k7"], ["team-north-k14", "team-north-k8", "team-north-k4"]]) {
      const ds = ids.map((id) => floor.desks.find((d) => d.id === id)).filter((d): d is Desk => !!d?.seat && d.roomId === "team-north");
      if (ds.length !== ids.length || !ds.some(needsMove)) continue;
      const from = new Map(ds.map((d) => [d.id, { ...d.seat! }]));
      const size = new Map(ds.map((d) => [d.id, chairOf.get(d.id) && { w: chairOf.get(d.id)!.w, h: chairOf.get(d.id)!.h }]));
      for (const d of ds) {
        d.seat = { x: -1e4, y: -1e4 }; // out of the way while the row is laid out
        // Office chairs (61px) here would reach into the doorways in the south wall; desk chairs fit.
        const c = chairOf.get(d.id);
        if (c && c.w > 52) { c.w = 52; c.h = 52; }
      }
      ds.sort((a, b) => a.x - b.x);
      let prev = -Infinity, ok = true;
      for (const d of ds) {
        let x = NaN;
        for (let o = 0; o <= 160 && Number.isNaN(x); o += 2) for (const c of [d.x + o, d.x - o]) {
          if (c >= prev + SEAT_APART && fits(d, { x: c, y })) { x = c; break; }
        }
        if (Number.isNaN(x)) { ok = false; break; }
        d.seat = { x, y };
        prev = x;
      }
      if (!ok) {
        // Didn't fit (the room was redesigned): put the row back and leave it to the search below.
        for (const d of ds) {
          d.seat = from.get(d.id)!;
          const c = chairOf.get(d.id), s = size.get(d.id);
          if (c && s) Object.assign(c, s);
        }
        continue;
      }
      for (const d of ds) moved.set(d.id, { from: from.get(d.id)!, side: "s" });
    }
  }

  // Everyone else: the best spot around their own table that fits. The side they're on now,
  // 36px off the edge and in line with where they were; then closer, then slid along the edge;
  // then the other edges, nearest their own computer first.
  for (let pass = 0; pass < 3; pass++) {
    for (const d of floor.desks) {
      if (!needsMove(d)) continue;
      const t = tables.find((o) => inBox(d, o) && off(d.seat!, o) < 60) ?? tables.find((o) => inBox(d, o));
      if (!t) continue;
      const s = d.seat!, now = sideOf(s, t);
      const toEdge = { n: d.y - t.y, s: t.y + t.h - d.y, w: d.x - t.x, e: t.x + t.w - d.x };
      const order: Side[] = [now, ...(["n", "s", "e", "w"] as Side[]).filter((x) => x !== now).sort((a, b) => toEdge[a] - toEdge[b])];
      let best: (Pt & { side: Side; cost: number }) | null = null;
      for (const [rank, side] of order.entries()) for (let gap = GAP; gap > SEAT_CLEAR; gap -= 2) for (const slide of [0, 8, -8, 16, -16, 24, -24, 32, -32, 40, -40, 48, -48]) {
        const cost = rank * 1000 + (GAP - gap) * 3 + Math.abs(slide);
        if (best && cost >= best.cost) continue;
        const along = side === "n" || side === "s";
        const p = {
          x: Math.round(along ? (side === now ? s.x : d.x) + slide : side === "w" ? t.x - gap : t.x + t.w + gap),
          y: Math.round(along ? (side === "n" ? t.y - gap : t.y + t.h + gap) : (side === now ? s.y : d.y) + slide),
        };
        if (fits(d, p)) best = { ...p, side, cost };
      }
      if (!best) continue;
      note(d, best.side);
      d.seat = { x: best.x, y: best.y };
    }
  }

  // The chair goes with the person, turned to face the table; the desk's facing follows the seat.
  const out: SeatMove[] = [];
  for (const [id, m] of moved) {
    const d = floor.desks.find((x) => x.id === id)!;
    d.facing = d.seat!.y < d.y ? "s" : "n";
    const chair = chairOf.get(id);
    if (chair) {
      chair.x = Math.round(d.seat!.x - chair.w / 2);
      chair.y = Math.round(d.seat!.y - chair.h / 2);
      chair.r = turn[m.side];
    }
    out.push({ id, owner: d.owner, from: m.from, to: { ...d.seat! }, side: m.side });
  }
  return out;
}
