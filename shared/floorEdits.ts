// The edit list both the Office Designer (Claude) and hand editing produce, and
// the one function that applies it. Shared so the browser's live preview while
// you drag is exactly what the server will check and save.

import type { Desk, Floor, Obj } from "./floor";

/** Largest the building may grow to (px, either side). */
export const MAX_BUILDING = 6000;

export type Edit = {
  op: string; id: string | null; type: string | null; roomId: string | null;
  x: number | null; y: number | null; w: number | null; h: number | null;
  facing: "n" | "s" | null; color: string | null; label: string | null; url: string | null;
  text: string | null; youtube: string | null; name: string | null; floor: string | null;
  variant?: string | null; r?: number | null; svg?: string | null;
  side?: "n" | "s" | "e" | "w" | null; by?: number | null;
};

/** Every field present, "not set" = null — the shape both editors send. */
export const BLANK_EDIT: Edit = { op: "", id: null, type: null, roomId: null, x: null, y: null, w: null, h: null, facing: null, color: null, label: null, url: null, text: null, youtube: null, name: null, floor: null, variant: null, r: null, svg: null, side: null, by: null };
export const fullEdit = (e: Partial<Edit>): Edit => ({ ...BLANK_EDIT, ...e });

/** Apply edits to a copy of the plan. Unknown ids are reported, not thrown. */
export function applyEdits(base: Floor, edits: Edit[]): { floor: Floor; problems: string[] } {
  const f: Floor = structuredClone(base);
  const problems: string[] = [];
  const uid = () => globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const pick = <T extends object>(e: Edit, keys: (keyof Edit)[]) =>
    Object.fromEntries(keys.filter((k) => e[k] !== null && e[k] !== undefined).map((k) => [k, e[k]])) as Partial<T>;
  for (const e of edits) {
    switch (e.op) {
      case "add_object": {
        if (!e.type || e.x === null || e.y === null || e.w === null || e.h === null) { problems.push("add_object needs type, x, y, w, h"); break; }
        // Hand edits name their new piece (so it stays selected while you drag it); Claude's get a fresh id.
        if (e.id && (f.objects.some((o) => o.id === e.id) || !/^h[a-z0-9]{6,16}$/.test(e.id))) { problems.push(`can't add a second object with id ${e.id}`); break; }
        f.objects.push({ id: e.id ?? `d${uid()}`, type: e.type as Obj["type"], x: e.x, y: e.y, w: e.w, h: e.h, ...pick<Obj>(e, ["color", "label", "url", "text", "youtube", "variant", "r", "svg"]) });
        break;
      }
      case "update_object": {
        const o = f.objects.find((x) => x.id === e.id);
        if (!o) { problems.push(`no object with id ${e.id}`); break; }
        // A new type starts from its own look: a chair turned plant shouldn't keep "plastic" or a 270° turn.
        if (e.type && e.type !== o.type) { delete o.variant; delete o.r; }
        if (e.type && e.type !== o.type && e.type !== "custom") delete o.svg;
        Object.assign(o, pick<Obj>(e, ["type", "x", "y", "w", "h", "color", "label", "url", "text", "youtube", "variant", "r", "svg"]));
        break;
      }
      case "remove_object": {
        const i = f.objects.findIndex((x) => x.id === e.id);
        if (i < 0) problems.push(`no object with id ${e.id}`);
        else f.objects.splice(i, 1);
        break;
      }
      case "add_desk": {
        const room = f.rooms.find((r) => r.id === e.roomId);
        if (!room || e.x === null || e.y === null) { problems.push(`add_desk needs a real roomId and x, y (got ${e.roomId})`); break; }
        // Never reuse an id: a reused id would hand someone's claimed seat to a new desk.
        f.desks.push({ id: `${room.id}-${uid()}`, roomId: room.id, x: e.x, y: e.y, facing: e.facing ?? "s" } as Desk);
        break;
      }
      case "move_desk": {
        const d = f.desks.find((x) => x.id === e.id);
        if (!d) { problems.push(`no desk with id ${e.id}`); break; }
        if (d.bare && d.seat) {
          // An imported workstation moves as a whole: its table, what's on it, and its chair.
          const dx = (e.x ?? d.x) - d.x, dy = (e.y ?? d.y) - d.y;
          const within = (p: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }, m = 0) => p.x >= b.x - m && p.x <= b.x + b.w + m && p.y >= b.y - m && p.y <= b.y + b.h + m;
          const mid = (o: Obj) => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 });
          const table = f.objects.find((o) => ["desk", "table", "console", "reception"].includes(o.type) && within(d, o, 30));
          const seat = d.seat;
          const moving = f.objects.filter((o) =>
            o === table ||
            (["laptop", "monitor", "keyboard", "cup", "trinket", "deskLamp", "plate", "frame", "food"].includes(o.type) && (table ? within(mid(o), table) : Math.hypot(mid(o).x - d.x, mid(o).y - d.y) < 50)) ||
            ((o.type === "chair" || o.type === "armchair") && Math.hypot(mid(o).x - seat.x, mid(o).y - seat.y) < 30));
          for (const o of moving) { o.x += dx; o.y += dy; }
          d.x += dx; d.y += dy;
          d.seat = { x: seat.x + dx, y: seat.y + dy };
          break;
        }
        Object.assign(d, pick<Desk>(e, ["x", "y", "facing"]));
        break;
      }
      case "remove_desk": {
        const i = f.desks.findIndex((x) => x.id === e.id);
        if (i < 0) problems.push(`no desk with id ${e.id}`);
        else f.desks.splice(i, 1);
        break;
      }
      case "grow_building": {
        const by = Math.round(e.by ?? 0);
        if (!e.side || !["n", "s", "e", "w"].includes(e.side) || by < 40 || by > 1000) { problems.push("grow_building needs a side (n/s/e/w) and by between 40 and 1000"); break; }
        const dx = e.side === "w" ? by : 0, dy = e.side === "n" ? by : 0;
        if (e.side === "n" || e.side === "s") f.height += by; else f.width += by;
        if (f.width > MAX_BUILDING || f.height > MAX_BUILDING) { problems.push(`the building can't be bigger than ${MAX_BUILDING}px`); break; }
        for (const r of f.rooms) { r.x += dx; r.y += dy; }
        for (const d of f.desks) { d.x += dx; d.y += dy; if (d.seat) d.seat = { x: d.seat.x + dx, y: d.seat.y + dy }; }
        for (const o of f.objects) { o.x += dx; o.y += dy; }
        f.spawn = { x: f.spawn.x + dx, y: f.spawn.y + dy };
        break;
      }
      case "update_room": {
        const r = f.rooms.find((x) => x.id === e.id);
        if (!r) { problems.push(`no room with id ${e.id}`); break; }
        if (e.name) r.name = e.name.slice(0, 40);
        if (e.floor) r.floor = e.floor as typeof r.floor;
        break;
      }
      default:
        problems.push(`unknown edit ${e.op}`);
    }
  }
  return { floor: f, problems };
}

