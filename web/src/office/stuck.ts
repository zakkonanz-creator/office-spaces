// "Am I stuck?" (the owner, 2026-11-05). Twice today a tab left open across a deploy stopped moving and
// a refresh fixed it. This spots the ways a tab gets stuck and offers the refresh:
//   · frozen: you're trying to move and the office has stopped drawing;
//   · lost: you're trying to move but this tab has lost track of where you are;
//   · bounced: the server keeps putting you back where you were (not a closed door, a mismatch).
// Walking into a wall isn't stuck. Each one is logged on the server with the person's name.

import { state, toast } from "./store";
import { reportError } from "../clientErrors";

let lastFrame = performance.now();
let lastIntent = 0;
const bounces: number[] = [];
let warnedAt = 0;

/** World's frame loop ran. */
export const stuckFrame = (now: number) => { lastFrame = now; };
/** A movement key or double-click: they want to move. */
export const stuckIntent = () => { lastIntent = Date.now(); };
/** The server put me somewhere else (not a closed door). */
export function stuckBounce() {
  const now = Date.now();
  bounces.push(now);
  while (bounces.length && now - bounces[0] > 6000) bounces.shift();
  if (bounces.length >= 4 && now - lastIntent < 3000) flag("bounced");
}
/** Trying to move with no position for me in this tab. */
export function stuckLost() {
  if (Date.now() - lastIntent < 1500) flag("lost");
}

export function flag(why: "frozen" | "lost" | "bounced") {
  const now = Date.now();
  if (now - warnedAt < 60_000) return; // once a minute at most
  warnedAt = now;
  const newer = state.updateReady ? " There's also a newer version of Space." : "";
  toast(`Looks like you're stuck.${newer} A refresh fixes it.`, { ttl: 30_000, action: { label: "Refresh", run: () => location.reload() } });
  reportError("stuck", new Error(`${why}${state.updateReady ? " (old version open)" : ""}`));
}

// The office stops drawing while the tab is showing (requestAnimationFrame runs whenever it's visible).
setInterval(() => {
  if (document.hidden || !state.me) { lastFrame = performance.now(); return; }
  // Only when they're trying to move: a window that's showing but not drawing (behind another app) isn't stuck.
  if (performance.now() - lastFrame > 5000 && Date.now() - lastIntent < 4000) flag("frozen");
}, 2000);
