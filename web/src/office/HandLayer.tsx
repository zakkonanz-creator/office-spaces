// The grab handles over the floor while hand-editing (Design → Edit by hand).
// Furniture and desk nameplates become draggable boxes; the selected one gets
// an outline and a corner handle to resize. Rooms stay put — grow the building
// through the Designer to move everything at once.

import { useEffect, useRef } from "react";
import type { Floor, Obj } from "../../../shared/floor";
import { camera } from "./World";
import { hand, useHand, select, preview, commit, snap, nudge, rotate, remove, duplicate, undoHand } from "./handEdit";

const TABLETOP = new Set(["laptop", "monitor", "keyboard", "cup", "food", "tray", "trinket", "deskLamp", "chess", "plate", "frame", "flowers"]);
const layer = (o: Obj) => (o.type === "rug" || o.type === "mat" ? 0 : TABLETOP.has(o.type) ? 2 : 1);

/** Where a desk's grab box sits: its nameplate. */
export const deskBox = (d: Floor["desks"][number]) =>
  d.bare && d.seat ? { x: d.x - 42, y: d.y + (d.seat.y < d.y ? 14 : -34), w: 84, h: 20 } : { x: d.x - 42, y: d.y - 26, w: 84, h: 52 };

type Drag = { kind: "move" | "size"; id: string; desk: boolean; sx: number; sy: number; x: number; y: number; w: number; h: number; moved: boolean };

export function HandLayer({ floor }: { floor: Floor }) {
  const h = useHand();
  const drag = useRef<Drag | null>(null);

  // Keys act on the selection, and only then — otherwise they walk your avatar as usual.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hand.on || !hand.sel || (e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      const step = e.shiftKey ? 10 : 1;
      const k = e.key;
      const act =
        k === "ArrowLeft" ? () => nudge(-step, 0) : k === "ArrowRight" ? () => nudge(step, 0)
        : k === "ArrowUp" ? () => nudge(0, -step) : k === "ArrowDown" ? () => nudge(0, step)
        : k === "Delete" || k === "Backspace" ? remove
        : k === "Escape" ? () => select(null)
        : (k === "r" || k === "R") && !e.metaKey && !e.ctrlKey ? rotate
        : (k === "d" || k === "D") && (e.metaKey || e.ctrlKey) ? duplicate
        : (k === "z" || k === "Z") && (e.metaKey || e.ctrlKey) ? undoHand
        : null;
      if (!act) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      act();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const start = (e: React.PointerEvent, kind: Drag["kind"], id: string, desk: boolean, box: { x: number; y: number; w: number; h: number }, at: { x: number; y: number }) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    select({ kind: desk ? "desk" : "obj", id });
    drag.current = { kind, id, desk, sx: e.clientX, sy: e.clientY, x: at.x, y: at.y, w: box.w, h: box.h, moved: false };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / camera.zoom, dy = (e.clientY - d.sy) / camera.zoom;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    d.moved = true;
    const free = e.altKey; // hold Alt for pixel-exact, otherwise a 4px grid
    const g = (n: number) => (free ? Math.round(n) : snap(n));
    if (d.kind === "size") preview({ op: "update_object", id: d.id, w: Math.max(8, g(d.w + dx)), h: Math.max(8, g(d.h + dy)) });
    else if (d.desk) preview({ op: "move_desk", id: d.id, x: g(d.x + dx), y: g(d.y + dy) });
    else preview({ op: "update_object", id: d.id, x: g(d.x + dx), y: g(d.y + dy) });
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved && hand.temp) commit(hand.temp);
    else preview(null);
  };

  const objs = [...floor.objects].sort((a, b) => layer(a) * 1e5 + a.y + a.h - (layer(b) * 1e5 + b.y + b.h));
  return (
    <div className="hand-layer" onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      {objs.map((o) => {
        const sel = h.sel?.kind === "obj" && h.sel.id === o.id;
        return (
          <div key={o.id} data-id={o.id} className={`hand-box${sel ? " sel" : ""}`} style={{ left: o.x, top: o.y, width: o.w, height: o.h }} title={o.label || o.type}
            onPointerDown={(e) => start(e, "move", o.id, false, o, { x: o.x, y: o.y })}>
            {sel ? <span className="hand-size" onPointerDown={(e) => start(e, "size", o.id, false, o, { x: o.x, y: o.y })} /> : null}
          </div>
        );
      })}
      {floor.desks.map((d) => {
        const b = deskBox(d);
        const sel = h.sel?.kind === "desk" && h.sel.id === d.id;
        return (
          <div key={d.id} className={`hand-box desk${sel ? " sel" : ""}`} style={{ left: b.x, top: b.y, width: b.w, height: b.h }} title={d.owner ? `${d.owner}'s desk — drag to move the whole workstation` : "Desk — drag to move the whole workstation"}
            onPointerDown={(e) => start(e, "move", d.id, true, b, { x: d.x, y: d.y })} />
        );
      })}
    </div>
  );
}
