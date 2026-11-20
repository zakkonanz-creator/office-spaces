// Hand editing in the Design panel: drag, resize, rotate, duplicate, delete.
// Every action is an edit in the same list Claude produces, applied with the
// same shared function the server uses — so what you see while dragging is
// exactly what the server will check. Only you see it until you press Apply.

import { useSyncExternalStore } from "react";
import type { Floor, Obj } from "../../../shared/floor";
import { applyEdits, fullEdit, type Edit } from "../../../shared/floorEdits";
import { state, bump } from "./store";

export type Sel = { kind: "obj" | "desk"; id: string } | null;

export const hand = {
  on: false,
  base: null as Floor | null,
  ops: [] as Edit[],
  /** The edit being dragged right now, not committed until the pointer lets go. */
  temp: null as Edit | null,
  sel: null as Sel,
  problems: [] as string[],
  /** Our own Apply is in flight: the "floor changed" broadcast it causes isn't someone else's change. */
  applying: false,
  version: 0,
};

const subs = new Set<() => void>();
const notify = () => {
  hand.version++;
  subs.forEach((f) => f());
};
export function useHand() {
  useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => hand.version);
  return hand;
}

function render() {
  if (!hand.base) return;
  const r = applyEdits(hand.base, hand.temp ? [...hand.ops, hand.temp] : hand.ops);
  hand.problems = r.problems;
  state.previewFloor = r.floor;
  bump();
  notify();
}

export function startHand() {
  if (!state.floor) return;
  hand.on = true;
  hand.base = structuredClone(state.floor);
  hand.ops = [];
  hand.temp = null;
  hand.sel = null;
  render();
}

export function stopHand() {
  hand.on = false;
  hand.base = null;
  hand.ops = [];
  hand.temp = null;
  hand.sel = null;
  state.previewFloor = null;
  bump();
  notify();
}

/** Record an edit. A run of changes to the same piece folds into one, so the list stays short. */
export function commit(e: Partial<Edit>) {
  const op = fullEdit(e);
  const last = hand.ops[hand.ops.length - 1];
  if (last && last.id === op.id && last.op === op.op && (op.op === "update_object" || op.op === "move_desk")) {
    hand.ops[hand.ops.length - 1] = { ...last, ...Object.fromEntries(Object.entries(op).filter(([, v]) => v !== null)) } as Edit;
  } else hand.ops.push(op);
  hand.temp = null;
  render();
}

/** While dragging: show it, don't record it yet. */
export function preview(e: Partial<Edit> | null) {
  hand.temp = e ? fullEdit(e) : null;
  render();
}

export function undoHand() {
  hand.ops.pop();
  hand.temp = null;
  render();
}

export function select(sel: Sel) {
  hand.sel = sel;
  notify();
}

/** The live (edited) version of the selected piece. */
export function selected(): { obj?: Obj; desk?: Floor["desks"][number] } {
  const f = state.previewFloor;
  if (!f || !hand.sel) return {};
  return hand.sel.kind === "obj" ? { obj: f.objects.find((o) => o.id === hand.sel!.id) } : { desk: f.desks.find((d) => d.id === hand.sel!.id) };
}

export const snap = (n: number, grid = 4) => Math.round(n / grid) * grid;

export function nudge(dx: number, dy: number) {
  const { obj, desk } = selected();
  if (obj) commit({ op: "update_object", id: obj.id, x: obj.x + dx, y: obj.y + dy });
  if (desk) commit({ op: "move_desk", id: desk.id, x: desk.x + dx, y: desk.y + dy });
}

export function rotate() {
  const { obj } = selected();
  if (obj) commit({ op: "update_object", id: obj.id, r: (((obj.r ?? 0) + 90) % 360) });
}

export function remove() {
  const { obj } = selected();
  if (!obj) return;
  commit({ op: "remove_object", id: obj.id });
  select(null);
}

export function duplicate() {
  const { obj } = selected();
  if (!obj) return;
  const id = `h${Math.random().toString(36).slice(2, 10).padEnd(8, "0")}`;
  const { id: _old, ...rest } = obj;
  commit({ op: "add_object", id, ...(rest as Partial<Edit>), x: obj.x + 24, y: obj.y + 24 });
  select({ kind: "obj", id });
}

export function resize(w: number, h: number) {
  const { obj } = selected();
  if (obj) commit({ op: "update_object", id: obj.id, w: Math.max(8, Math.round(w)), h: Math.max(8, Math.round(h)) });
}
