// Points (shared/points.ts) in the office: the Points tab (your total and where it comes from,
// what unlocks next, your pet, the egg hunt, the leaderboard), the #wins banner, and loading
// which easter eggs you've found.

import { useEffect, useState } from "react";
import { firstName } from "../../../shared/names";
import { KIND_NAME, REWARDS, nextReward } from "../../../shared/rewards";
import { EMOTES, LEVELS } from "../../../shared/emotes";
import { OUTFITS, RARITY_LABEL } from "../../../shared/outfits";
import { MAX_LEVEL, levelOf } from "../../../shared/emotes";
import { PETS, petUnlocked } from "../../../shared/pets";
import { EGGS } from "../../../shared/eggs";
import { KIND_LABEL, POINTS, fmtPoints, type PointsBreakdown } from "../../../shared/points";
import { state, bump, useOffice } from "./store";
import { winImg } from "./Jumbotron";
import { sock } from "./net";
import { Locker } from "./Outfits";
import { GivePoints } from "./GivePoints";
import { look } from "./World";

interface PointsData extends PointsBreakdown {
  canGive?: boolean;
  eggs: string[];
  leaderboard: { id: number; name: string; avatar: string | null; points: number }[];
  highfives: { id: number; name: string; n: number }[];
}

/** Which eggs I've found, once, so their glints stay hidden. */
export function useMyEggs() {
  const s = useOffice();
  const teammate = Boolean(s.me && !s.me.guestRoom);
  useEffect(() => {
    if (!teammate || state.myEggs) return;
    fetch("/api/points").then((r) => (r.ok ? r.json() : null)).then((d: PointsData | null) => {
      if (d) { state.myEggs = new Set(d.eggs); bump(); }
    }).catch(() => {});
  }, [teammate]);
}

export function PointsTab() {
  const s = useOffice();
  const me = s.me!;
  const [d, setD] = useState<PointsData | null>(null);
  // Reload when my total changes (a high-five, an egg, an award).
  useEffect(() => {
    fetch("/api/points").then((r) => (r.ok ? r.json() : null)).then(setD).catch(() => {});
  }, [me.points]);
  if (me.guestRoom) return <p className="muted pad">Points are for the Acme team.</p>;
  const pts = me.points ?? d?.total ?? 0;
  const nx = nextReward(pts);
  const next = nx ? { what: `${nx.reward.icon} ${nx.reward.label}`, kind: KIND_NAME[nx.reward.kind], need: nx.reward.points } : null;
  const found = new Set(d?.eggs ?? []);
  return (
    <div className="points-tab">
      <div className="points-total">
        <span className="points-star">⭐</span>
        <b>{fmtPoints(pts)}</b>
        <span className="muted">points</span>
        <span className="points-level">Level {levelOf(pts)} <span className="muted">of {MAX_LEVEL}</span></span>
      </div>
      {next ? (
        <div className="points-next">
          <div className="small-text">Next: <b>{next.what}</b> <span className="muted">({next.kind})</span> at {fmtPoints(next.need)}</div>
          <div className="points-bar"><i style={{ width: `${Math.round((nx?.progress ?? 0) * 100)}%` }} /></div>
        </div>
      ) : <p className="small-text muted">You've unlocked everything. Legend.</p>}

      <h4>Where they come from</h4>
      <dl className="points-parts">
        {(d?.parts ?? []).map((p) => (<div key={p.kind}><dt>{KIND_LABEL[p.kind]}</dt><dd>{fmtPoints(p.points)}</dd></div>))}
      </dl>
      <details className="points-how">
        <summary>How to earn more</summary>
        <ul>
          <li>{POINTS.onlinePerHour} an hour in the office, up to {POINTS.onlineHoursCap} hours a day (Away doesn't count)</li>
          <li>{POINTS.tenurePerDay} a day at Acme, plus {POINTS.perYear} for every full year</li>
          <li>Streak milestones: {POINTS.streakPerDay} × the streak's days</li>
          <li>High-fives: {POINTS.highFive} each, both of you (walk up and press Y)</li>
          <li>Easter eggs: {POINTS.egg} each, +{POINTS.firstFinder} if you're first</li>
          <li>Posting in #wins: {POINTS.win}</li>
          <li>Admins can award points for great work</li>
        </ul>
      </details>

      {d?.canGive ? <><h4>Give points</h4><GivePoints /></> : null}

      <Unlocks points={pts} />

      <Locker points={pts} wearing={me.outfit} look={look(me.id)} />

      <h4>Your pet</h4>
      <div className="pet-grid">
        <button className={!me.pet ? "on" : ""} onClick={() => sock().emit("setPet", { pet: null })} title="No pet">—<span>None</span></button>
        {PETS.map((p) => {
          const open = petUnlocked(p.id, pts);
          return (
            <button key={p.id} className={`${me.pet === p.id ? "on" : ""}${open ? "" : " locked"}`} disabled={!open} onClick={() => sock().emit("setPet", { pet: p.id })} title={open ? p.label : `${p.label}: unlocks at ${fmtPoints(p.points)} points`}>
              {open ? p.icon : "🔒"}<span>{open ? p.label : `${fmtPoints(p.points)}`}</span>
            </button>
          );
        })}
      </div>

      <h4>Easter eggs <span className="muted">· {found.size} of {EGGS.length}</span></h4>
      <ul className="egg-list">
        {EGGS.map((e) => (
          <li key={e.id} className={found.has(e.id) ? "found" : ""}>
            <span className="egg-badge">{found.has(e.id) ? e.badge : "?"}</span>
            <span>{found.has(e.id) ? <b>{e.name}</b> : <span className="muted">{e.hint}</span>}</span>
          </li>
        ))}
      </ul>

      <h4>Leaderboard</h4>
      <ol className="leaderboard">
        {(d?.leaderboard ?? []).map((r) => (
          <li key={r.id} className={r.name === me.name ? "me" : ""}><span>{r.name}</span><b>{fmtPoints(r.points)}</b></li>
        ))}
      </ol>
      {d?.highfives.length ? (
        <>
          <h4>Most high-fives this week</h4>
          <ol className="leaderboard">{d.highfives.map((r) => <li key={r.id}><span>{r.name}</span><b>✋ {r.n}</b></li>)}</ol>
        </>
      ) : null}
    </div>
  );
}

/** A #wins post: a banner across the top for a few seconds (the bell is in sounds.ts). */
export function WinBanner() {
  const s = useOffice();
  if (!s.win) return null;
  return (
    <div className="win-banner" role="status" key={s.win.at}>
      <span className="win-bell">🔔</span>
      <div>
        <b>{firstName(s.win.name)}</b> posted a win
        {s.win.text ? <div className="win-text">{s.win.text}</div> : null}
        {s.win.img ? <img className="win-img" src={winImg(s.win.img)} alt={s.win.text || "The win"} /> : null}
      </div>
      <button className="ghost small" onClick={() => { state.win = null; bump(); }} aria-label="Dismiss">✕</button>
    </div>
  );
}

/** Everything points unlock, with its emoji, in order (the owner, 2026-11-06: "so it's clear what people get"). */
function Unlocks({ points }: { points: number }) {
  const [all, setAll] = useState(false);
  const got = REWARDS.filter((r) => r.points <= points).length;
  const next = REWARDS.findIndex((r) => r.points > points);
  // Around where you are: the last two you got and the next six. "Show all" for the whole ladder.
  const from = all ? 0 : Math.max(0, (next < 0 ? REWARDS.length : next) - 2);
  const rows = all ? REWARDS : REWARDS.slice(from, from + 8);
  const tag = (r: (typeof REWARDS)[number]) =>
    r.kind === "outfit" ? `${RARITY_LABEL[r.rarity ?? "common"]} outfit` : r.kind === "pet" ? "Pet" : `Level ${LEVELS.indexOf(r.points) + 1} ${r.kind === "epic" ? "epic emote" : "emote"}`;
  const free = [...EMOTES.filter((e) => e.points === 0).map((e) => e.icon), ...PETS.filter((p) => p.points === 0).map((p) => p.icon), ...OUTFITS.filter((o) => o.points === 0).map((o) => o.icon)];
  return (
    <>
      <h4>Unlocks <span className="muted">· {got} of {REWARDS.length}</span></h4>
      <p className="small-text muted unlock-free">Day one: <span className="unlock-free-icons">{free.join(" ")}</span></p>
      <ul className="unlock-list">
        {rows.map((r) => {
          const have = r.points <= points;
          const isNext = REWARDS.indexOf(r) === next;
          return (
            <li key={r.kind + r.id} className={`${have ? "have" : ""}${isNext ? " next" : ""}${r.kind === "epic" ? " epic" : ""}`}>
              <span className="unlock-emoji">{r.icon}</span>
              <span className="unlock-name"><b>{r.label}</b><span className="muted">{tag(r)}</span></span>
              <span className="unlock-pts">{have ? "✓" : isNext ? `${fmtPoints(r.points - points)} to go` : fmtPoints(r.points)}</span>
            </li>
          );
        })}
      </ul>
      <button className="link small-text" onClick={() => setAll(!all)}>{all ? "Show less" : `Show all ${REWARDS.length} unlocks`}</button>
    </>
  );
}
