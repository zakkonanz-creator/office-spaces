// The fun layer on the floor: pets trotting after their people, easter-egg
// glints you only see up close, and the season (pumpkins in October, snow in December).
// Positions are moved by World's frame loop through `petEls` / `eggEls` (no React per frame).

import { memo } from "react";
import type { Floor } from "../../../shared/floor";
import { petDef } from "../../../shared/pets";
import { EGGS, eggSpots } from "../../../shared/eggs";
import type { Person } from "../../../shared/protocol";
import { state, useOffice } from "./store";
import { sock } from "./net";
import { isLighter } from "./quality";

/** Each pet's element and where it is now (it lags behind its person). */
export const petEls = new Map<string, HTMLDivElement>();
export const petPos = new Map<string, { x: number; y: number; dir: "l" | "r" }>();
export const eggEls = new Map<string, HTMLDivElement>();

export function Pets({ people }: { people: Person[] }) {
  useOffice();
  return (
    <>
      {people.filter((p) => p.pet && petDef(p.pet)).map((p) => {
        const def = petDef(p.pet)!;
        const patted = (state.pats.get(p.id) ?? 0) > Date.now() - 1600;
        return (
          <div
            key={p.id}
            className={`pet pet-${def.id}${patted ? " patted" : ""}`}
            ref={(el) => { if (el) petEls.set(p.id, el); else petEls.delete(p.id); }}
            title={`${p.id === state.me?.id ? "Your" : `${p.name.split(" ")[0]}'s`} ${def.label.toLowerCase()}. Click to pet.`}
            onClick={(e) => { e.stopPropagation(); sock().emit("pat", { to: p.id }); }}
          >
            <span className="pet-body">{def.icon}</span>
            {patted ? <span className="pet-hearts" aria-hidden="true"><i>💗</i><i>💗</i><i>💗</i></span> : null}
          </div>
        );
      })}
    </>
  );
}

/** Glints at the eggs I haven't found. Hidden from guests; each fades in only when I'm close (World's loop). */
export function Eggs({ floor }: { floor: Floor }) {
  const s = useOffice();
  if (!s.me || s.me.guestRoom || !s.myEggs) return null;
  return (
    <>
      {eggSpots(floor).filter((e) => !s.myEggs!.has(e.id)).map((e) => (
        <div key={e.id} className="egg-glint" style={{ left: e.at.x, top: e.at.y, opacity: 0 }} ref={(el) => { if (el) eggEls.set(e.id, el); else eggEls.delete(e.id); }} aria-hidden="true">
          <span>✦</span>
        </div>
      ))}
    </>
  );
}
export const eggAt = (id: string) => EGGS.find((e) => e.id === id);

/** October: pumpkins; December: snow. `?season=pumpkins|snow|none` overrides (for trying it out). */
export function season(now = new Date()): "pumpkins" | "snow" | null {
  const o = new URLSearchParams(location.search).get("season");
  if (o === "pumpkins" || o === "snow") return o;
  if (o === "none") return null;
  const m = now.getMonth();
  return m === 9 ? "pumpkins" : m === 11 ? "snow" : null;
}

/** Pumpkins sit in room corners (on the floor, in the world). */
export const Pumpkins = memo(function Pumpkins({ floor }: { floor: Floor }) {
  if (season() !== "pumpkins") return null;
  const spots = floor.rooms.filter((r) => r.kind !== "office").flatMap((r, i) => {
    const pad = 26;
    const corners = [[r.x + pad, r.y + r.h - pad], [r.x + r.w - pad, r.y + r.h - pad]];
    return i % 2 ? corners.slice(0, 1) : corners.slice(1);
  });
  return (
    <>
      {spots.map(([x, y], i) => (
        <div key={i} className={`pumpkin${i % 3 === 0 ? " lit" : ""}`} style={{ left: x, top: y }} aria-hidden="true">🎃</div>
      ))}
    </>
  );
});

/** Snow drifts down over the office view (fewer flakes, no drift, when the office is running lighter). */
export function Snow() {
  if (season() !== "snow") return null;
  const n = isLighter() ? 18 : 46;
  return (
    <div className="snow" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} style={{ left: `${(i * 61) % 100}%`, animationDelay: `${-((i * 7) % 13)}s`, animationDuration: `${9 + (i % 7)}s`, fontSize: `${8 + (i % 4) * 3}px`, opacity: 0.55 + (i % 4) * 0.1 }}>❄</i>
      ))}
    </div>
  );
}
