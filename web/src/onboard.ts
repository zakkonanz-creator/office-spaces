// Getting-started progress on the client: one copy per tab, saved to the server
// (/api/onboarding) so it follows you across browsers. markStep is safe to call
// from anywhere, as often as you like — a step that's already done is a no-op.

import { useSyncExternalStore } from "react";

export type Track = "member" | "admin" | "time" | "manager" | "payroll";
export interface TrackInfo {
  done: Record<string, number>;
  of: number;
  finished: boolean;
  autoOpen: boolean;
  /** Hidden (or never meant for them: people already here when it shipped). */
  hidden?: boolean;
  since?: string | null;
  grantedBy?: string | null;
}

export const onboard = {
  loaded: false,
  member: null as TrackInfo | null,
  admin: null as TrackInfo | null,
  time: null as TrackInfo | null,
  manager: null as TrackInfo | null,
  payroll: null as TrackInfo | null,
  /** The office checklist is on screen. */
  checklistOpen: false,
  version: 0,
};

const listeners = new Set<() => void>();
const changed = () => {
  onboard.version++;
  for (const l of listeners) l();
};

export function useOnboard() {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => onboard.version,
  );
  return onboard;
}

/** Steps done before progress loaded (a Designer opened straight from a link): sent once it has. */
const pending: [Track, string][] = [];

export async function loadOnboarding() {
  const r = await fetch("/api/onboarding").catch(() => null);
  if (!r?.ok) return;
  const j = await r.json();
  onboard.member = j.member;
  onboard.admin = j.admin;
  onboard.time = j.time ?? null;
  onboard.manager = j.manager ?? null;
  onboard.payroll = j.payroll ?? null;
  onboard.loaded = true;
  changed();
  for (const [track, step] of pending.splice(0)) markStep(track, step);
}

async function send(track: Track, body: object) {
  const r = await fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ track, ...body }) }).catch(() => null);
  if (!r?.ok) return;
  const j = await r.json();
  const t = onboard[track];
  if (t) Object.assign(t, { done: j.done, finished: j.finished });
  changed();
}

export function markStep(track: Track, step: string) {
  if (!onboard.loaded) return void pending.push([track, step]);
  const t = onboard[track];
  if (!t || t.done[step]) return;
  // Someone who hid the checklist (or was here before it existed) isn't doing it: ordinary use of the
  // office mustn't tick it off behind their back and end in a surprise "You're all set".
  if (track === "member" && t.hidden && !t.autoOpen && !onboard.checklistOpen) return;
  t.done = { ...t.done, [step]: Date.now() }; // tick it now; the server confirms
  changed();
  void send(track, { step });
}

export function dismissTrack(track: Track) {
  const t = onboard[track];
  if (t) t.autoOpen = false;
  changed();
  void send(track, { dismiss: true });
}

export async function restartTrack(track: Track) {
  await send(track, { reset: true });
  const t = onboard[track];
  if (t) t.autoOpen = true;
  changed();
}
