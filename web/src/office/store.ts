// Client-side office state. React re-renders on structural changes (someone
// joins, a status changes, a door shuts); positions are read every animation
// frame straight from `live` without going through React at all.

import { useSyncExternalStore } from "react";
import type { Floor } from "../../../shared/floor";
import type { Me, Person, RoomState } from "../../../shared/protocol";

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  ttl?: number;
}

export interface Pos {
  x: number;
  y: number;
  /** Where the server last said they are; rendering eases toward it. */
  tx: number;
  ty: number;
}

export const state = {
  floor: null as Floor | null,
  /** An Office Designer draft shown only to the admin reviewing it. */
  previewFloor: null as Floor | null,
  me: null as Me | null,
  people: new Map<string, Person>(),
  rooms: {} as Record<string, RoomState>,
  audioRange: 340, // the server sends the real one (AUDIO_RANGES) on joining
  desks: new Map<string, { name: string; title: string | null }>(),
  toasts: [] as Toast[],
  /** Volume (0–1) each person is heard at; drives the "nearby" ring and subscriptions. */
  hearing: new Map<string, number>(),
  speaking: new Set<string>(),
  reactions: new Map<string, { emoji: string; at: number }>(),
  /** Who's emoting (shared/emotes.ts): loops until they move. */
  emotes: new Map<string, { name: string; at: number }>(),
  locallyMuted: new Set<string>(),
  /** High-fives (shared/points.ts): whose hand is up for whom, and who just slapped hands. */
  handUp: new Map<string, { to: string; at: number }>(),
  fives: new Map<string, number>(),
  /** Pets just petted (owner id → when): hearts and a hop. */
  pats: new Map<string, number>(),
  /** Rewards just unlocked (shared/rewards.ts): the card. */
  unlocked: null as null | { items: import("../../../shared/rewards").Reward[]; at: number; bonus?: { points: number; title: string; text: string } },
  /** The #wins banner showing now. */
  win: null as null | { name: string; text: string; img?: number | null; at: number },
  /** Easter eggs I've found (shared/eggs.ts); null until loaded. */
  myEggs: null as Set<string> | null,
  /** YouTube id playing in this tab's music player, if any. */
  music: null as string | null,
  /** The server is on a newer web build than this tab: ask for a refresh. */
  updateReady: false,
  version: 0,
};

/** Positions, mutated every frame. Not part of the React snapshot on purpose. */
export const live = new Map<string, Pos>();

const listeners = new Set<() => void>();
export function bump() {
  state.version++;
  for (const l of listeners) l();
}
export function useOffice() {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state.version,
  );
  return state;
}

let toastId = 0;
export function toast(text: string, opts: Omit<Toast, "id" | "text"> = {}) {
  const t: Toast = { id: ++toastId, text, ...opts };
  // Keep 4. When full, drop the oldest plain toast first, so a burst of Monday arrivals never pushes out
  // a knock or a follow request you still have to answer (QA 2026-11-06).
  let list = [...state.toasts, t];
  while (list.length > 4) {
    const i = list.findIndex((x) => !x.action && x !== t);
    list = list.filter((_, k) => k !== (i >= 0 ? i : 0));
  }
  state.toasts = list;
  bump();
  setTimeout(() => dismiss(t.id), opts.ttl ?? (opts.action ? 15000 : 4000));
  return t.id;
}
export function dismiss(id: number) {
  state.toasts = state.toasts.filter((t) => t.id !== id);
  bump();
}

export const everyone = (): Person[] => (state.me ? [state.me, ...state.people.values()] : [...state.people.values()]);
export const personName = (id: string) => (state.me?.id === id ? state.me.name : state.people.get(id)?.name ?? "Someone");
/**
 * Opens a Slack DM with this person: the desktop app if it's installed, Slack in
 * the browser if not (Slack's own redirect decides). Null when Space hasn't
 * matched them to a Slack account (their email isn't in our Slack).
 */
export const slackDmUrl = (p: Pick<Person, "slackId">) =>
  p.slackId && state.me?.slackTeamId ? `https://slack.com/app_redirect?team=${state.me.slackTeamId}&channel=${p.slackId}` : null;
/** A room's name, or null if it hasn't been named. */
export const roomName = (id: string | null) => (id ? state.floor?.rooms.find((r) => r.id === id)?.name || null : null);
