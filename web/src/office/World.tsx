// The floor: rooms, doors, furniture, desks and everyone on it. Static parts
// render through React; positions and the camera are written straight to the
// DOM every animation frame so 30 people walking around never re-render React.

import { EMOTES } from "../../../shared/emotes";
import { daysSince, pinOf } from "../../../shared/tenure";
import { anniversaryYears } from "../../../shared/points";
import { EGG_GLINT } from "../../../shared/eggs";
import { Eggs, Pets, Pumpkins, Snow, eggEls, petEls, petPos } from "./Extras";
import { NextBar } from "./Rewards";
import { stuckFrame, stuckIntent, stuckLost } from "./stuck";
import { reportError } from "../clientErrors";
import { noteFrame } from "./quality";
import { memo, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { Icon } from "../icons";
import { Track } from "livekit-client";
import { blocked, findPath, roomAt, step, type Floor, type Obj, type Pt, type Room } from "../../../shared/floor";
import type { Person } from "../../../shared/protocol";
import { state, live, useOffice, everyone, bump } from "./store";
import { serverMe, sock } from "./net";
import { videoFor, onMediaChange } from "./media";
import { VideoTile } from "./VideoTile";
import { JumbotronScreen } from "./Jumbotron";
import { HandLayer } from "./HandLayer";
import { useHand, select } from "./handEdit";
import { kumoArt } from "./kumoSprites";
import { roomChanged } from "./meet";
import {
  SpriteDefs, Desk, Plant, Rug, Sofa, Armchair, Beanbag, MeetingTable, CoffeeTable, CafeTable, Tv, Bookshelf,
  Counter, Fridge, Whiteboard, WaterCooler, Lamp, LogoWall, PingPong, PoolTable, Piano, Arcade, Bench,
} from "./sprites";

const SPEED = 320; // px per second
const avatarEls = new Map<string, HTMLDivElement>();
/** Someone's avatar on the page (for screenFx.ts to aim at). */
export const avatarEl = (id: string) => avatarEls.get(id);
const lastPos = new Map<string, { x: number; y: number }>();
const walkUntil = new Map<string, number>();
const keys = new Set<string>();
let path: Pt[] = [];

export const camera = { x: 0, y: 0, zoom: 1, panX: 0, panY: 0 };

/** When I last stepped out of each room. Lets me finish walking out through my own closed door. */
const leftAt = new Map<string, number>();
export const EXIT_GRACE_MS = 5000;

export function passable(roomId: string): boolean {
  const me = state.me;
  if (!me) return false;
  if (me.guestRoom) return roomId === me.guestRoom;
  const r = state.rooms[roomId];
  return !r?.closed || r.admitted.includes(me.id) || me.roomId === roomId || Date.now() - (leftAt.get(roomId) ?? 0) < EXIT_GRACE_MS;
}

export function walkTo(to: Pt) {
  const me = state.me && live.get(state.me.id);
  if (!me || !state.floor) return false;
  if (state.me!.guestRoom && roomAt(state.floor, to)?.id !== state.me!.guestRoom) return false;
  path = findPath(state.floor, me, to, passable);
  return path.length > 0;
}

export function jumpTo(p: Pt) {
  const me = state.me && live.get(state.me.id);
  if (!me) return;
  me.x = me.tx = p.x;
  me.y = me.ty = p.y;
  path = [];
  camera.panX = camera.panY = 0;
  sock().emit("move", { x: p.x, y: p.y });
}

/**
 * Keep the view on the building. The pan offset itself is clamped, so it never
 * drifts past an edge and then "snaps back" on the next frame. `now` moves the
 * camera there immediately (scrolling/dragging should feel 1:1, not eased).
 */
function settlePan(vp: HTMLElement, now: boolean) {
  const me = state.me && live.get(state.me.id);
  if (!me || !state.floor) return;
  const hw = vp.clientWidth / 2 / camera.zoom, hh = vp.clientHeight / 2 / camera.zoom;
  const fit = (v: number, half: number, size: number) => (size <= half * 2 ? size / 2 : Math.min(size - half, Math.max(half, v)));
  const cx = fit(me.x + camera.panX, hw, state.floor.width);
  const cy = fit(me.y + camera.panY, hh, state.floor.height);
  camera.panX = cx - me.x;
  camera.panY = cy - me.y;
  if (now) {
    camera.x = cx;
    camera.y = cy;
  }
}

/** Point the camera at a spot without moving anyone (e.g. "show me that change"). */
export function lookAt(p: Pt) {
  const me = state.me && live.get(state.me.id);
  if (!me) return;
  camera.panX = p.x - me.x;
  camera.panY = p.y - me.y;
}

export function recenter() {
  camera.panX = camera.panY = 0;
}

const ZOOM_MAX = 2;
/** Zoomed all the way out, the whole floor fits on screen (with a little margin). */
function minZoom(vp: HTMLElement | null) {
  const f = state.floor;
  if (!vp || !f) return 0.3;
  return Math.min(0.5, Math.max(0.12, Math.min(vp.clientWidth / f.width, vp.clientHeight / f.height) * 0.95));
}

export function zoomBy(f: number) {
  const vp = document.querySelector<HTMLElement>(".viewport");
  camera.zoom = Math.min(ZOOM_MAX, Math.max(minZoom(vp), camera.zoom * f));
  if (vp) settlePan(vp, false);
}

interface Props {
  onPerson: (id: string, at: { x: number; y: number }) => void;
  onObject: (o: Obj, at: { x: number; y: number }) => void;
  onDesk: (deskId: string, at: { x: number; y: number }) => void;
}

export function World({ onPerson, onObject, onDesk }: Props) {
  const s = useOffice();
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  // Drawing uses the admin's preview when there is one; walking always uses the live plan.
  const floor = s.previewFloor ?? s.floor!;
  const h = useHand();

  // Keyboard movement. Typing in a field never moves you.
  useEffect(() => {
    const isField = (e: KeyboardEvent) => (e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]");
    const down = (e: KeyboardEvent) => {
      if (isField(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"].includes(k)) {
        keys.add(k);
        stuckIntent();
        path = [];
        if (state.me?.following) sock().emit("follow", { to: null });
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    const blur = () => keys.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // Moved by the server: a teleport, a bounce off a closed door, or a teammate's "Say hi".
  useEffect(() => {
    const placed = (e: Event) => {
      path = [];
      if ((e as CustomEvent<{ far?: boolean }>).detail?.far) camera.panX = camera.panY = 0;
    };
    const bring = (e: Event) => jumpTo((e as CustomEvent<Pt>).detail);
    window.addEventListener("es:placed", placed);
    window.addEventListener("es:bring", bring);
    return () => {
      window.removeEventListener("es:placed", placed);
      window.removeEventListener("es:bring", bring);
    };
  }, []);

  // The frame loop: move me, ease everyone else, follow, camera.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastSent = 0;
    let sent = { x: -1, y: -1 };
    let stillSince = 0, lastResync = 0;
    let followTick = 0;
    camera.zoom = window.innerWidth < 700 ? 0.6 : 0.85;
    // One frame. An error in it must never stop the loop: before, a single throw here froze every
    // avatar on the floor (audio carried on) until a reload. Now it's reported and the next frame runs.
    let frameAt = 0;
    const frame = (now: number) => {
      if (frameAt) noteFrame(now - frameAt); // a slow computer shows up here first (quality.ts)
      frameAt = now;
      stuckFrame(now);
      try {
        tick(now);
      } catch (e) {
        reportError("frame", e);
      }
      if (!document.hidden) raf = requestAnimationFrame(frame);
    };
    const tick = (now: number) => {
      const dt = Math.min(0.12, (now - last) / 1000);
      last = now;
      const me = state.me && live.get(state.me.id);
      if (state.me && !me && (keys.size || path.length)) stuckLost(); // trying to move, but this tab has lost me
      if (me && state.floor) {
        // Follow: re-path toward the person every half second when they've moved away.
        if (state.me!.following && now - followTick > 500) {
          followTick = now;
          const t = live.get(state.me!.following);
          if (t && Math.hypot(t.x - me.x, t.y - me.y) > 110) walkTo({ x: t.x - 60, y: t.y + 30 });
          else if (!t) sock().emit("follow", { to: null });
        }
        let dx = 0, dy = 0;
        if (keys.has("arrowleft") || keys.has("a")) dx -= 1;
        if (keys.has("arrowright") || keys.has("d")) dx += 1;
        if (keys.has("arrowup") || keys.has("w")) dy -= 1;
        if (keys.has("arrowdown") || keys.has("s")) dy += 1;
        let target: Pt | null = null;
        if (dx || dy) {
          const len = Math.hypot(dx, dy);
          target = { x: me.x + (dx / len) * SPEED * dt, y: me.y + (dy / len) * SPEED * dt };
        } else if (path.length) {
          const wp = path[0];
          const d = Math.hypot(wp.x - me.x, wp.y - me.y);
          const stepLen = SPEED * dt;
          if (d <= stepLen) {
            target = wp;
            path.shift();
          } else target = { x: me.x + ((wp.x - me.x) / d) * stepLen, y: me.y + ((wp.y - me.y) / d) * stepLen };
        }
        if (target) {
          let next = step(state.floor, me, target, passable);
          // Guests stay in their room; don't even let them try the door.
          if (state.me!.guestRoom && roomAt(state.floor, next)?.id !== state.me!.guestRoom) next = { x: me.x, y: me.y };
          if (path.length && next.x === me.x && next.y === me.y) path = []; // stuck: give up quietly
          me.x = me.tx = next.x;
          me.y = me.ty = next.y;
          if (target) camera.panX = camera.panY = 0;
        }
        // Standing still but the server has me somewhere else (a move that never landed): say
        // where I am again. The server checks it like any move, and corrects me if I can't be here.
        if (target) {
          stillSince = now;
          // Moving ends your emote, for everyone.
          if (state.emotes.has(state.me!.id)) {
            state.emotes.delete(state.me!.id);
            sock().emit("emote", { name: null });
            bump();
          }
        }
        else if (!(window as any).__esNoResync && now - stillSince > 1500 && now - lastResync > 2000 && Number.isFinite(serverMe.x) && Math.hypot(serverMe.x - me.x, serverMe.y - me.y) > 24) {
          lastResync = now;
          sent = { x: NaN, y: NaN }; // forces the send below
          lastSent = 0;
        }
        if ((me.x !== sent.x || me.y !== sent.y) && now - lastSent > 66) {
          sock().emit("move", { x: me.x, y: me.y });
          sent = { x: me.x, y: me.y };
          lastSent = now;
          // Update my room locally right away so audio switches without a round trip.
          const r = roomAt(state.floor, me)?.id ?? null;
          if (r !== state.me!.roomId) {
            if (state.me!.roomId) leftAt.set(state.me!.roomId, Date.now());
            state.me!.roomId = r;
            roomChanged(r);
          }
        }
      }
      // Everyone else eases toward where the server says they are.
      for (const [id, p] of live) {
        if (id !== state.me?.id) {
          const k = 1 - Math.pow(0.0005, dt);
          p.x += (p.tx - p.x) * k;
          p.y += (p.ty - p.y) * k;
        }
        const el = avatarEls.get(id);
        if (el) {
          el.style.transform = `translate(${p.x}px, ${p.y}px)`;
          // Walk cycle while moving, facing the way they're going.
          const prev = lastPos.get(id);
          const dx = prev ? p.x - prev.x : 0;
          const dy = prev ? p.y - prev.y : 0;
          const moving = Math.abs(dx) + Math.abs(dy) > 0.4;
          if (moving) {
            walkUntil.set(id, now + 140);
            if (Math.abs(dx) > 0.2) el.dataset.dir = dx < 0 ? "l" : "r";
          }
          const walking = (walkUntil.get(id) ?? 0) > now;
          if (walking !== (el.dataset.walk === "1")) el.dataset.walk = walking ? "1" : "0";
          lastPos.set(id, { x: p.x, y: p.y });
        }
        // Their pet trots after them, a step behind, and faces the way it's going.
        const pe = petEls.get(id);
        if (pe) {
          const side = el?.dataset.dir === "l" ? 34 : -34;
          const tx = p.x + side, ty = p.y + 8;
          let pp = petPos.get(id);
          if (!pp || Math.hypot(tx - pp.x, ty - pp.y) > 600) petPos.set(id, (pp = { x: tx, y: ty, dir: "l" }));
          const k = 1 - Math.pow(0.02, dt);
          const mx = (tx - pp.x) * k, my = (ty - pp.y) * k;
          pp.x += mx; pp.y += my;
          if (Math.abs(mx) > 0.15) pp.dir = mx < 0 ? "l" : "r";
          const trotting = Math.abs(mx) + Math.abs(my) > 0.25;
          pe.style.transform = `translate(${pp.x}px, ${pp.y}px)`;
          if (pe.dataset.dir !== pp.dir) pe.dataset.dir = pp.dir;
          if ((pe.dataset.trot === "1") !== trotting) pe.dataset.trot = trotting ? "1" : "0";
        }
      }
      // Easter-egg glints show only up close.
      if (me && eggEls.size) {
        for (const [eid, el] of eggEls) {
          const d = Math.hypot(parseFloat(el.style.left) - me.x, parseFloat(el.style.top) - me.y);
          const o = d > EGG_GLINT ? 0 : Math.min(1, (EGG_GLINT - d) / 90);
          const v = o.toFixed(2);
          if (el.style.opacity !== v) el.style.opacity = v;
          void eid;
        }
      }
      // Camera.
      const vp = viewport.current, w = world.current;
      if (me && vp && w) {
        // Keep the view on the building: no staring into the void past its edges.
        settlePan(vp, false);
        const tx = me.x + camera.panX;
        const ty = me.y + camera.panY;
        camera.x += (tx - camera.x) * Math.min(1, dt * 8);
        camera.y += (ty - camera.y) * Math.min(1, dt * 8);
        w.style.transform = `translate(${vp.clientWidth / 2 - camera.x * camera.zoom}px, ${vp.clientHeight / 2 - camera.y * camera.zoom}px) scale(${camera.zoom})`;
      }
    };
    const me = state.me && live.get(state.me.id);
    if (me) {
      camera.x = me.x;
      camera.y = me.y;
    }
    raf = requestAnimationFrame(frame);
    // Hidden tabs get no animation frames. Keep walking/following (and keep
    // positions current) on a timer until the tab is visible again.
    let timer: ReturnType<typeof setInterval> | null = null;
    const onVis = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        // The timer only ticks; it never schedules animation frames (that could start a second loop).
        if (!timer) timer = setInterval(() => { try { tick(performance.now()); } catch (e) { reportError("frame", e); } }, 100);
      } else {
        if (timer) clearInterval(timer);
        timer = null;
        last = performance.now();
        cancelAnimationFrame(raf); // exactly one loop
        frameAt = 0; // the gap while hidden isn't a slow frame
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    if (document.hidden) onVis();
    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Pointer: double-click to walk, drag to look around, ctrl/⌘+wheel to zoom.
  const toWorld = (cx: number, cy: number): Pt => {
    const vp = viewport.current!.getBoundingClientRect();
    return {
      x: (cx - vp.left - vp.width / 2) / camera.zoom + camera.x,
      y: (cy - vp.top - vp.height / 2) / camera.zoom + camera.y,
    };
  };
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  // Two fingers pinch to zoom on phones (the owner, 2026-11-09), toward the point between them, like a map.
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  const zoomAt = (cx: number, cy: number, next: number) => {
    const vp = viewport.current!;
    next = Math.min(ZOOM_MAX, Math.max(minZoom(vp), next));
    if (next === camera.zoom) return;
    const rect = vp.getBoundingClientRect();
    const ox = cx - rect.left - rect.width / 2, oy = cy - rect.top - rect.height / 2;
    const wx = ox / camera.zoom + camera.x, wy = oy / camera.zoom + camera.y;
    camera.zoom = next;
    const me = state.me && live.get(state.me.id);
    if (!me) return;
    camera.panX = wx - ox / next - me.x;
    camera.panY = wy - oy / next - me.y;
    settlePan(vp, true);
  };
  const pinchSpan = () => {
    const [a, b] = [...touches.current.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  };

  // Scroll wheel / trackpad pinch zooms toward the cursor, like a map. Native and
  // non-passive so a pinch doesn't zoom the whole browser page instead.
  useEffect(() => {
    const vp = viewport.current!;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".popover, .modal, .side, .toolbar-wrap")) return;
      e.preventDefault();
      // Like Kumospace and maps: scrolling zooms toward the cursor (mouse wheel,
      // trackpad scroll, pinch). Sideways scrolling or Shift+scroll pans, and so
      // does dragging. Telling a mouse from a trackpad by delta size is
      // unreliable — smooth-scrolling mice send small steps too.
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? vp.clientHeight : 1;
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (!e.ctrlKey && (e.shiftKey || Math.abs(dx) > Math.abs(dy))) {
        camera.panX += (e.shiftKey && !dx ? dy : dx) / camera.zoom;
        if (!e.shiftKey) camera.panY += dy / camera.zoom;
        settlePan(vp, true);
        return;
      }
      const rect = vp.getBoundingClientRect();
      const ox = e.clientX - rect.left - rect.width / 2;
      const oy = e.clientY - rect.top - rect.height / 2;
      // The world point under the cursor before zooming…
      const wx = ox / camera.zoom + camera.x;
      const wy = oy / camera.zoom + camera.y;
      const speed = e.ctrlKey ? 0.012 : 0.0022;
      const next = Math.min(ZOOM_MAX, Math.max(minZoom(vp), camera.zoom * Math.exp(-Math.max(-120, Math.min(120, dy)) * speed)));
      if (next === camera.zoom) return;
      camera.zoom = next;
      // …stays under the cursor after.
      const me = state.me && live.get(state.me.id);
      if (!me) return;
      camera.panX = wx - ox / next - me.x;
      camera.panY = wy - oy / next - me.y;
      settlePan(vp, true);
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      ref={viewport}
      className="viewport"
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest(".avatar, .obj-click")) return;
        const p = toWorld(e.clientX, e.clientY);
        stuckIntent();
        if (state.me?.following) sock().emit("follow", { to: null });
        if (!walkTo(p)) {
          const r = roomAt(floor, p);
          if (r && !passable(r.id)) window.dispatchEvent(new CustomEvent("es:closed-door", { detail: r.id }));
        }
      }}
      onPointerDown={(e) => {
        if (e.pointerType === "touch") {
          touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (touches.current.size === 2) {
            // Second finger: stop dragging, start pinching. Never a tap-to-walk.
            pinch.current = { dist: Math.max(1, pinchSpan().dist), zoom: camera.zoom };
            if (drag.current) drag.current.moved = true;
            return;
          }
        }
        if (h.on && !(e.target as HTMLElement).closest(".hand-box")) select(null);
        if ((e.target as HTMLElement).closest(".avatar, .obj-click, button, .hand-box")) return;
        drag.current = { x: e.clientX, y: e.clientY, px: camera.panX, py: camera.panY, moved: false };
      }}
      onPointerMove={(e) => {
        if (e.pointerType === "touch" && touches.current.has(e.pointerId)) {
          touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pinch.current && touches.current.size >= 2) {
            const sp = pinchSpan();
            zoomAt(sp.cx, sp.cy, pinch.current.zoom * (sp.dist / pinch.current.dist));
            return;
          }
        }
        if (pinch.current) return;
        const d = drag.current;
        if (!d) return;
        const mx = e.clientX - d.x, my = e.clientY - d.y;
        if (Math.abs(mx) + Math.abs(my) > 4) d.moved = true;
        if (d.moved) {
          camera.panX = d.px - mx / camera.zoom;
          camera.panY = d.py - my / camera.zoom;
          settlePan(viewport.current!, true);
        }
      }}
      onPointerUp={(e) => {
        touches.current.delete(e.pointerId);
        if (pinch.current) {
          // Lifting the fingers after a pinch never walks; the last finger up ends it.
          if (touches.current.size === 0) pinch.current = null;
          drag.current = null;
          return;
        }
        const d = drag.current;
        drag.current = null;
        // Phones have no keyboard and double-tap is unreliable: a plain tap walks.
        if (d && !d.moved && e.pointerType === "touch") {
          const p = toWorld(e.clientX, e.clientY);
          if (state.me?.following) sock().emit("follow", { to: null });
          if (!walkTo(p)) {
            const r = roomAt(floor, p);
            if (r && !passable(r.id)) window.dispatchEvent(new CustomEvent("es:closed-door", { detail: r.id }));
          }
        }
      }}
      onPointerLeave={(e) => { drag.current = null; touches.current.delete(e.pointerId); if (!touches.current.size) pinch.current = null; }}
      onPointerCancel={(e) => { drag.current = null; touches.current.delete(e.pointerId); if (!touches.current.size) pinch.current = null; }}
    >
      <div ref={world} className="world" style={{ width: floor.width, height: floor.height }}>
        <StaticFloor floor={floor} desks={s.desks} onObject={onObject} onDesk={onDesk} />
        <Doors floor={floor} />
        {h.on ? <HandLayer floor={floor} /> : null}
        <Pumpkins floor={floor} />
        <Eggs floor={floor} />
        <Pets people={everyone()} />
        {everyone().map((p) => (
          <Avatar key={p.id} person={p} onClick={(at) => onPerson(p.id, at)} />
        ))}
      </div>
      <Snow />
    </div>
  );
}

// ── The building ───────────────────────────────────────────────────────────

// Memoised on its props only (no store subscription): the floor, the desk directory
// and stable click handlers. ~450 SVG pieces must not redraw when someone talks or moves.
const StaticFloor = memo(function StaticFloor({ floor, desks, onObject, onDesk }: { floor: Floor; desks: typeof state.desks; onObject: Props["onObject"]; onDesk: Props["onDesk"] }) {
  // Rugs first, then furniture back to front (lower on screen draws on top),
  // then what sits on tables, then desks' nameplates.
  const layer = (o: Obj) => (o.type === "rug" || o.type === "mat" ? 0 : TABLETOP.has(o.type) ? 2 : 1);
  const order = (o: Obj) => layer(o) * 100000 + o.y + o.h;
  // Sorted once per layout, not on every store change (joins, status, media all re-render this).
  const sorted = useMemo(() => [...floor.objects].sort((a, b) => order(a) - order(b)), [floor, floor.objects.length]);
  return (
    <>
      <SpriteDefs />
      <div className="building" />
      <div className="hallway" />
      {floor.rooms.map((r) => (
        <div key={r.id} className={`room floor-${r.floor} kind-${r.kind} wall-${r.wall ?? "glass"}`} style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
          {/* The name hangs on the room's top wall like a door sign, at the end away from a top door. */}
          {backWall(r).map(([x0, x1], i) => <div key={i} className="backwall" style={{ left: x0, width: x1 - x0 }} />)}
          {r.name ? <div className="room-plaque" style={[r.door, ...(r.openings ?? [])].some((g) => g.side === "n" && g.at - g.width / 2 < 90) ? { right: 14 } : { left: 14 }}>{r.name}</div> : null}
        </div>
      ))}
      {sorted.map((o) => (
        <Furniture key={o.id} o={o} onClick={onObject} />
      ))}
      {floor.desks.map((d) => {
        const who = desks.get(d.id);
        const name = who?.name ?? d.owner ?? null;
        return (
          <div
            key={d.id}
            data-desk={d.id}
            className={`desk${d.bare ? " bare" : ""} ${who ? "claimed" : d.owner ? "seeded" : "free"} obj-click`}
            style={d.bare && d.seat ? { left: d.x - 42, top: d.y + (d.seat.y < d.y ? 14 : -34) } : { left: d.x - 42, top: d.y - 26 }}
            onClick={(e) => onDesk(d.id, { x: e.clientX, y: e.clientY })}
            title={name ? `${name}${who?.title || d.title ? ` — ${who?.title ?? d.title}` : ""}` : "Free desk"}
          >
            {d.bare ? <span className="desk-plate">{name ? name.split(" ")[0] : "Free"}</span> : <Desk id={d.id} facing={d.facing} name={name ? name.split(" ")[0] : null} />}
          </div>
        );
      })}
    </>
  );
});

/** Seating drawn facing south, turned `o.r`° clockwise to fit its footprint. */
function Turn({ o, children }: { o: Obj; children: (w: number, h: number) => ReactNode }) {
  const r = ((o.r ?? 0) % 360 + 360) % 360;
  if (!r) return <>{children(o.w, o.h)}</>;
  const side = r % 180 !== 0;
  const w = side ? o.h : o.w, h = side ? o.w : o.h;
  return (
    <div style={{ position: "absolute", left: (o.w - w) / 2, top: (o.h - h) / 2, width: w, height: h, transform: `rotate(${r}deg)` }}>
      {children(w, h)}
    </div>
  );
}

/** The stretches of a room's top wall that aren't doorways (inner coordinates, inside the 6px border). */
function backWall(r: Room): [number, number][] {
  const inner = r.w - 12;
  const gaps = [r.door, ...(r.openings ?? [])].filter((g) => g.side === "n").map((g) => [g.at - g.width / 2 - 6, g.at + g.width / 2 - 6]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let x = 0;
  for (const [a, b] of gaps) {
    if (a > x) out.push([x, Math.min(a, inner)]);
    x = Math.max(x, b);
  }
  if (x < inner) out.push([x, inner]);
  return out.filter(([a, b]) => b - a > 4);
}

const TABLETOP = new Set(["laptop", "monitor", "keyboard", "cup", "food", "tray", "trinket", "deskLamp", "chess", "plate", "frame", "flowers"]);

const Furniture = memo(function Furniture({ o, onClick }: { o: Obj; onClick: Props["onObject"] }) {
  const clickable = ["link", "music", "timer", "sign", "note", "jumbotron", "chess"].includes(o.type);
  const style: React.CSSProperties = { left: o.x, top: o.y, width: o.w, height: o.h, ...(o.color ? { ["--c" as any]: o.color } : {}) };
  let art: ReactNode = kumoArt(o);
  if (art === null) switch (o.type) {
    case "plant": art = <Plant w={o.w} id={o.id} />; break;
    case "plantTall": art = <Plant w={o.w} id={o.id} tall />; break;
    case "rug": art = <Rug w={o.w} h={o.h} color={o.color} id={o.id} runner={o.style === "runner"} />; break;
    case "sofa": art = <Turn o={o}>{(w, h) => <Sofa w={w} h={h} color={o.color} cushions={o.variant === "cushions"} />}</Turn>; break;
    case "armchair": art = <Turn o={o}>{(w, h) => <Armchair w={w} h={h} color={o.color} />}</Turn>; break;
    case "beanbag": art = <Beanbag w={o.w} h={o.h} color={o.color ?? "#e2a53a"} />; break;
    case "table": art = <MeetingTable w={o.w} h={o.h} id={o.id} plain={o.variant?.startsWith("plain")} dark={o.variant === "plain-dark"} />; break;
    case "coffeeTable": art = <CoffeeTable w={o.w} h={o.h} />; break;
    case "cafe": art = <CafeTable w={o.w} id={o.id} plain={o.variant?.startsWith("plain")} tone={o.variant === "plain-rattan" ? "rattan" : o.variant === "plain-wood" ? "wood" : o.variant === "plain-dark" ? "dark" : undefined} />; break;
    case "tv": art = <Tv w={o.w} h={o.h} />; break;
    case "bookshelf": art = <Bookshelf w={o.w} h={o.h} id={o.id} />; break;
    case "counter": art = <Counter w={o.w} h={o.h} />; break;
    case "fridge": art = <Fridge w={o.w} h={o.h} />; break;
    case "whiteboard": art = <Whiteboard w={o.w} h={o.h} />; break;
    case "cooler": art = <WaterCooler w={o.w} />; break;
    case "lamp": art = <Lamp w={o.w} />; break;
    case "pingpong": art = <PingPong w={o.w} h={o.h} />; break;
    case "pool": art = <PoolTable w={o.w} h={o.h} />; break;
    case "piano": art = <Piano w={o.w} h={o.h} />; break;
    case "arcade": art = <Arcade w={o.w} h={o.h} color={o.color} />; break;
    case "bench": art = <Bench w={o.w} h={o.h} color={o.color} />; break;
    case "logo": art = <><LogoWall w={o.w} h={o.h} /><img src="/logo.svg" alt="Acme" draggable={false} /></>; break;
    case "link": art = <><span className="link-tablet" aria-hidden /><span className="link-label">{o.label}</span></>; break;
    case "sign": case "note": case "mat": case "plate": art = <span>{o.text}</span>; break;
    case "music": art = <span title={o.label}>♫</span>; break;
    case "timer": art = <span>⏱</span>; break;
    case "jumbotron": art = <JumbotronScreen w={o.w} h={o.h} />; break;
    // Claude's own drawing, as an image: an <img> can't run script or load anything.
    case "custom": art = o.svg ? <Turn o={o}>{(w, h) => <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(o.svg!)}`} alt={o.label ?? ""} width={w} height={h} draggable={false} />}</Turn> : null; break;
  }
  return (
    <div
      data-v={o.variant}
      className={`obj obj-${o.type}${clickable ? " obj-click" : ""}${o.type === "link" && !o.url ? " unset" : ""}`}
      style={style}
      onClick={clickable ? (e) => onClick(o, { x: e.clientX, y: e.clientY }) : undefined}
    >
      {art}
    </div>
  );
});

function Doors({ floor }: { floor: Floor }) {
  const s = useOffice();
  return (
    <>
      {floor.rooms.map((r) => {
        const st = s.rooms[r.id];
        const closed = Boolean(st?.closed);
        // The door, then any other gaps (the far side of a neighbour's door, open-plan sides).
        // A shut room shuts all of them; a shut gap draws over a neighbour's open one.
        return [r.door, ...(r.openings ?? [])].map((g, i) => (
          <div key={`${r.id}-${i}`} className={`door door-${g.side}${closed ? " closed" : ""}`} style={doorStyle(r, g)}>
            {/* Frames on every doorway; the swinging door belongs to the room's own door. */}
            {r.closable || g.width <= 200 ? <DoorLeaf side={g.side} width={g.width} closed={closed && r.closable} leaf={i === 0 && r.closable} /> : null}
            {i === 0 && st?.recording ? <span className="door-rec" title="Meeting in progress">●</span> : null}
          </div>
        ));
      })}
    </>
  );
}

/** A real door: hinged at one jamb, swung into the room when open, across the gap when shut. */
function DoorLeaf({ side, width, closed, leaf }: { side: Room["door"]["side"]; width: number; closed: boolean; leaf: boolean }) {
  const len = width - 12;
  // Drawn for a south wall (the room is "up", y < 0), then rotated into place.
  const rot = { s: 0, n: 180, w: 90, e: -90 }[side];
  const horizontal = side === "n" || side === "s";
  const box = horizontal ? { w: width, h: 10 } : { w: 10, h: width };
  const wide = len > 200; // an open-plan side: just the frame
  // Doorways over ~1.2m get a pair of doors.
  const leaves = len > 110 ? [{ hinge: -len / 2, dir: 1, l: len / 2 }, { hinge: len / 2, dir: -1, l: len / 2 }] : [{ hinge: -len / 2, dir: 1, l: len }];
  const jamb = (x: number) => <rect x={x} y={-6} width={6} height={12} rx={1} fill="#3f2715" />;
  return (
    <svg className="door-leaf" width={box.w} height={box.h} viewBox={`${-box.w / 2} ${-box.h / 2} ${box.w} ${box.h}`} style={{ overflow: "visible" }} aria-hidden>
      <g transform={`rotate(${rot})`}>
        {jamb(-len / 2 - 6)}
        {jamb(len / 2)}
        {closed && !wide
          ? leaves.map((v, k) => {
              // Shut: wooden door panels filling the frame.
              const x0 = v.dir > 0 ? v.hinge : v.hinge - v.l;
              return (
                <g key={k}>
                  <rect x={x0 + 0.5} y={-3.5} width={v.l - 1} height={7} rx={1} fill="#8a5a33" stroke="#4e3019" strokeWidth={1} />
                  <line x1={x0 + 3} y1={0} x2={x0 + v.l - 3} y2={0} stroke="#000" strokeOpacity={0.12} />
                  <circle cx={v.dir > 0 ? x0 + v.l - 5 : x0 + 5} cy={0} r={1.6} fill="#e0bd6f" />
                </g>
              );
            })
          : !wide && leaf
            ? leaves.map((v, k) => (
                // Open: the door stands at 90° into the room, its swing traced on the floor.
                <g key={k}>
                  {/* the swing: a soft quarter-circle on the floor, as on an architect's plan */}
                  <path d={`M${v.hinge} 0 L${v.hinge + v.dir * v.l} 0 A${v.l} ${v.l} 0 0 ${v.dir > 0 ? 0 : 1} ${v.hinge} ${-v.l} Z`} fill="#6b4425" fillOpacity={0.1} />
                  <path d={`M${v.hinge + v.dir * v.l} 0 A${v.l} ${v.l} 0 0 ${v.dir > 0 ? 0 : 1} ${v.hinge} ${-v.l}`} fill="none" stroke="#5a3a20" strokeOpacity={0.45} strokeWidth={1.2} strokeDasharray="4 3" />
                  {/* the door itself, standing open: a solid wood panel with a handle */}
                  <rect x={v.dir > 0 ? v.hinge : v.hinge - 9} y={-v.l} width={9} height={v.l} rx={1.5} fill="#9a6639" stroke="#4e3019" strokeWidth={1.2} />
                  <rect x={v.dir > 0 ? v.hinge + 2 : v.hinge - 7} y={-v.l + 4} width={5} height={v.l - 8} rx={1} fill="#b27a48" />
                  <circle cx={v.dir > 0 ? v.hinge + 4.5 : v.hinge - 4.5} cy={-v.l + 9} r={2} fill="#e8c46f" stroke="#7a5a20" strokeWidth={0.5} />
                </g>
              ))
            : null}
      </g>
    </svg>
  );
}

function doorStyle(r: Room, g: Room["door"] = r.door): React.CSSProperties {
  const t = 16; // covers the 6px wall plus a little either side
  const { side, at, width } = g;
  if (side === "n") return { left: r.x + at - width / 2, top: r.y - t / 2, width, height: t };
  if (side === "s") return { left: r.x + at - width / 2, top: r.y + r.h - t / 2, width, height: t };
  if (side === "w") return { left: r.x - t / 2, top: r.y + at - width / 2, width: t, height: width };
  return { left: r.x + r.w - t / 2, top: r.y + at - width / 2, width: t, height: width };
}

// ── People ─────────────────────────────────────────────────────────────────

/** An office in-joke (the owner, 2026-11-05): these people walk like a wacky inflatable tube man. */
const FLOPPY = new Set(["morgan@example.com"]);

function Avatar({ person, onClick }: { person: Person; onClick: (at: { x: number; y: number }) => void }) {
  const s = useOffice();
  const ref = useRef<HTMLDivElement>(null);
  const isMe = person.id === s.me?.id;
  const heard = isMe || (s.hearing.get(person.id) ?? 0) > 0;
  const [, force] = useStateTick();
  useEffect(() => onMediaChange(force), [force]);

  useEffect(() => {
    const el = ref.current!;
    avatarEls.set(person.id, el);
    const p = live.get(person.id);
    if (p) el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    return () => {
      avatarEls.delete(person.id);
      lastPos.delete(person.id);
      walkUntil.delete(person.id);
    };
  }, [person.id]);

  const cam = person.cam ? videoFor(person.id, Track.Source.Camera) : null;
  const showVideo = Boolean(cam) && heard;
  const emote = s.emotes.get(person.id);
  const emoteDef = emote ? EMOTES.find((e) => e.id === emote.name) : undefined;
  const reaction = s.reactions.get(person.id);
  const showReaction = reaction && Date.now() - reaction.at < 3000;
  const initials = person.name.replace(/\(.*?\)/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");

  return (
    <div
      ref={ref}
      data-emote={emoteDef?.id}
      data-outfit={person.outfit ?? undefined}
      data-five={s.fives.has(person.id) ? "1" : s.handUp.has(person.id) ? "up" : undefined}
      className={`avatar status-${person.status}${isMe ? " me" : ""}${heard && !isMe ? " heard" : ""}${showVideo ? " has-video" : ""}${s.speaking.has(person.id) ? " speaking" : ""}${person.email && FLOPPY.has(person.email.toLowerCase()) ? " floppy" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="fig" style={person.outfit ? undefined : look(person.id)}>
        <i className="leg l" />
        <i className="leg r" />
        <i className="arm l" />
        <i className="arm r" />
        <i className="torso" />
        {person.since ? <i className={`pin pin-${pinOf(daysSince(person.since)).tier}`} /> : null}
      </div>
      {anniversaryYears(person.since, localDay()) ? <i className="party-hat" title={`${anniversaryYears(person.since, localDay())} year${anniversaryYears(person.since, localDay()) === 1 ? "" : "s"} at Acme today!`} /> : null}
      {s.fives.has(person.id) ? <span className="five-burst" aria-hidden="true">✋</span> : null}
      <div className="bubble">
        {showVideo && cam ? (
          <VideoTile pub={cam} mirror={isMe} />
        ) : person.avatar ? (
          <img src={person.avatar} alt="" draggable={false} referrerPolicy="no-referrer" />
        ) : (
          <span className="initials">{initials || "?"}</span>
        )}
        {!person.mic ? <span className="badge mic-off" title="Muted"><Icon name="micOff" size={12} /></span> : null}
        {person.sharing ? <span className="badge sharing" title="Presenting"><Icon name="screen" size={12} /></span> : null}
        {person.inMeeting ? <span className="badge in-meeting" title="In a meeting">●</span> : null}
        {person.clock ? <span className={`badge clock ${person.clock}`} title={person.clock === "break" ? "Clocked in · on a break" : "Clocked in"}><Icon name="clock" size={12} /></span> : null}
      </div>
      <div className="label">
        <span className="name">{isMe ? "You" : person.name.split(" ")[0]}</span>
        {isMe && !s.me?.guestRoom ? <NextBar points={person.points} /> : null}
        {person.statusText ? <span className="status-text">{person.statusText}</span> : null}
      </div>
      {showReaction ? <div className="reaction">{reaction!.emoji}</div> : null}
      {emoteDef && "prop" in emoteDef ? <div className="emote-prop" key={emote!.at} aria-hidden="true"><span>{emoteDef.prop}</span><span>{emoteDef.prop}</span><span>{emoteDef.prop}</span></div> : null}
    </div>
  );
}

/** Each person gets their own outfit, the same every day. */
const SHIRTS = ["#e86f50", "#4a8af4", "#2f9e6e", "#e9b949", "#8b5cf6", "#e05a8a", "#1fa2a8", "#f08a24", "#5b7cc4", "#7aa83f"];
const PANTS = ["#2d3a55", "#3b3530", "#4f5b66", "#6b5440", "#2f4a3a"];
export function look(id: string): React.CSSProperties {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return { ["--shirt" as any]: SHIRTS[h % SHIRTS.length], ["--pants" as any]: PANTS[(h >>> 5) % PANTS.length] };
}

function useStateTick() {
  return useReducer((x: number) => x + 1, 0);
}

/** Nearest closed door I can't pass, within reach. Used for the knock prompt. */
export function closedDoorNearby(): Room | null {
  const me = state.me && live.get(state.me.id);
  if (!me || !state.floor || state.me!.guestRoom) return null;
  for (const r of state.floor.rooms) {
    if (!state.rooms[r.id]?.closed || passable(r.id)) continue;
    for (const d of [r.door, ...(r.openings ?? [])]) {
      const dp = d.side === "n" ? { x: r.x + d.at, y: r.y } : d.side === "s" ? { x: r.x + d.at, y: r.y + r.h } : d.side === "w" ? { x: r.x, y: r.y + d.at } : { x: r.x + r.w, y: r.y + d.at };
      if (Math.hypot(dp.x - me.x, dp.y - me.y) < 110) return r;
    }
  }
  return null;
}

export const isBlocked = (p: Pt) => (state.floor ? blocked(state.floor, p, passable) : true);

/** Today in this browser's timezone, "YYYY-MM-DD" (for the anniversary hat). */
function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
