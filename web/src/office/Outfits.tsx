// The Locker (shared/outfits.ts): Fortnite-style cards, coloured by rarity, each with the outfit
// on a little figure. Lives in the Points tab; the unlock card shows the same figure.

import { OUTFITS, RARITY_LABEL, outfitDef, outfitUnlocked } from "../../../shared/outfits";
import { fmtPoints } from "../../../shared/points";
import { sock } from "./net";

/** A little figure wearing the outfit (or your own colours with none). */
export function OutfitPreview({ id, style }: { id: string | null; style?: React.CSSProperties }) {
  return (
    <span className="outfit-preview" data-outfit={id ?? undefined} aria-hidden="true">
      <span className="fig" style={id ? undefined : style}>
        <i className="leg l" />
        <i className="leg r" />
        <i className="arm l" />
        <i className="arm r" />
        <i className="torso" />
      </span>
      <i className="bubble" />
    </span>
  );
}

export function Locker({ points, wearing, look }: { points: number; wearing: string | null | undefined; look: React.CSSProperties }) {
  const on = outfitDef(wearing);
  return (
    <>
      <h4>Locker <span className="muted">· {OUTFITS.filter((o) => outfitUnlocked(o.id, points)).length} of {OUTFITS.length} outfits</span></h4>
      <div className="locker">
        <button className={`locker-card rarity-common${!on ? " on" : ""}`} onClick={() => sock().emit("setOutfit", { outfit: null })} title="Your own colours">
          <OutfitPreview id={null} style={look} />
          <b>Your colours</b>
          <span className="rarity">Default</span>
        </button>
        {OUTFITS.map((o) => {
          const open = outfitUnlocked(o.id, points);
          return (
            <button key={o.id} className={`locker-card rarity-${o.rarity}${on?.id === o.id ? " on" : ""}${open ? "" : " locked"}`} disabled={!open}
              onClick={() => sock().emit("setOutfit", { outfit: o.id })}
              title={open ? `${o.label} · ${RARITY_LABEL[o.rarity]}` : `${o.label} · ${RARITY_LABEL[o.rarity]}: unlocks at ${fmtPoints(o.points)} points`}>
              <OutfitPreview id={o.id} />
              {open ? null : <span className="locker-lock">🔒 {fmtPoints(o.points)}</span>}
              <b>{o.label}</b>
              <span className="rarity">{RARITY_LABEL[o.rarity]}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
