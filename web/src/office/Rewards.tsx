// The next reward (shared/rewards.ts): a thin bar by your name, and a card with fireworks when
// your points pass one.

import { useEffect } from "react";
import { KIND_NAME, nextReward, type Reward } from "../../../shared/rewards";
import { fmtPoints } from "../../../shared/points";
import { MAX_LEVEL, levelOf } from "../../../shared/emotes";
import { state, bump, useOffice } from "./store";
import { sock } from "./net";
import { OutfitPreview } from "./Outfits";
import { RARITY_LABEL } from "../../../shared/outfits";

/** A thin bar toward your next reward. Only on your own name. */
export function NextBar({ points, wide }: { points: number | undefined; wide?: boolean }) {
  if (points == null) return null;
  const n = nextReward(points);
  if (!n) return null;
  const tip = `Level ${levelOf(points)} of ${MAX_LEVEL} · ${fmtPoints(points)} / ${fmtPoints(n.reward.points)} to ${n.reward.icon} ${n.reward.label} (${KIND_NAME[n.reward.kind]})`;
  return (
    <span className={`next-bar${wide ? " wide" : ""}`} title={tip} aria-label={tip}>
      <i style={{ width: `${Math.round(n.progress * 100)}%` }} />
    </span>
  );
}

/** You just unlocked something: say what, and let them try it. */
export function UnlockCard() {
  const s = useOffice();
  const u = s.unlocked;
  useEffect(() => {
    if (!u) return;
    const t = setTimeout(() => { if (state.unlocked?.at === u.at) { state.unlocked = null; bump(); } }, 14_000);
    return () => clearTimeout(t);
  }, [u?.at]);
  if (!u) return null;
  const close = () => { state.unlocked = null; bump(); };
  const tryIt = (r: Reward) => {
    if (r.kind === "pet") sock().emit("setPet", { pet: r.id });
    else if (r.kind === "outfit") sock().emit("setOutfit", { outfit: r.id });
    else sock().emit("emote", { name: r.id });
    close();
  };
  // The welcome bonus: its own, bigger moment.
  if (u.bonus) {
    return (
      <div className="unlock-card bonus-card" role="status" key={u.at}>
        <div className="bonus-burst" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ ["--a" as any]: `${i * 30}deg` }} />)}</div>
        <div className="unlock-kicker">WELCOME BONUS</div>
        <div className="bonus-points"><span>+{fmtPoints(u.bonus.points)}</span><b>⭐</b></div>
        <h3>{u.bonus.title}</h3>
        <p className="muted">{u.bonus.text}</p>
        {u.items.length ? <p className="bonus-got">Unlocked already: {u.items.map((r) => `${r.icon} ${r.label}`).join(" · ")}</p> : null}
        <div className="unlock-actions">
          {u.items.length ? <button className="primary" onClick={() => tryIt(u.items[u.items.length - 1])}>Try {u.items[u.items.length - 1].label}</button> : null}
          <button className="ghost" onClick={close}>Let's go!</button>
        </div>
      </div>
    );
  }
  const top = u.items[u.items.length - 1];
  return (
    <div className="unlock-card" role="status" key={u.at}>
      {top.kind === "outfit" ? <div className={`unlock-outfit rarity-${top.rarity}`}><OutfitPreview id={top.id} /></div> : <div className="unlock-icon">{top.icon}</div>}
      <div className="unlock-kicker">{top.kind === "pet" ? "UNLOCKED" : top.kind === "outfit" ? `${RARITY_LABEL[top.rarity ?? "common"].toUpperCase()} OUTFIT` : `LEVEL ${levelOf(state.me?.points)}${top.kind === "epic" ? " · EPIC" : ""}`}</div>
      <h3>{u.items.length === 1 ? top.label : `${u.items.length} new rewards!`}</h3>
      <p className="muted">
        {u.items.length === 1
          ? top.kind === "pet" ? `A new pet to walk the office with you.` : top.kind === "outfit" ? `A new outfit in your Locker (Points tab).` : `A new ${KIND_NAME[top.kind]} for your React menu (E).`
          : u.items.map((r) => `${r.icon} ${r.label}`).join(" · ")}
      </p>
      <div className="unlock-actions">
        {u.items.slice(-3).reverse().map((r) => (
          <button key={r.id} className="primary" onClick={() => tryIt(r)}>{r.kind === "pet" ? `Walk with the ${r.label.toLowerCase()}` : r.kind === "outfit" ? `Wear ${r.label}` : `Try ${r.label}`}</button>
        ))}
        <button className="ghost" onClick={close}>Nice!</button>
      </div>
    </div>
  );
}
