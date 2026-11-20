// The office streak, chess.com style: a flame and how many days in a row someone has been in
// the office (server/streaks.ts). Yours sits in the bottom bar beside the clock; teammates' show in the
// People list and on their card. Grey until today counts.

import type { Person } from "../../../shared/protocol";

export function Flame({ size = 16, lit = true }: { size?: number; lit?: boolean }) {
  const id = lit ? "es-flame-lit" : "es-flame-out";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="flame">
      <defs>
        <linearGradient id={id} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor={lit ? "#e8461b" : "#8a8580"} />
          <stop offset=".6" stopColor={lit ? "#f7841f" : "#a7a29c"} />
          <stop offset="1" stopColor={lit ? "#ffc23d" : "#c4bfb9"} />
        </linearGradient>
      </defs>
      <path fill={`url(#${id})`} d="M12.6 1.8c.4 2.7-.6 4.5-2.1 6.1C8.6 9.9 6 12 6 15.6 6 19.3 8.7 22 12 22s6-2.6 6-6.1c0-2.7-1.4-4.6-2.6-5.9.1 1.6-.4 2.9-1.6 3.6.3-3.6-.6-7.6-1.2-11.8Z" />
      <path fill={lit ? "#ffe08a" : "#ddd9d4"} d="M12.2 13.2c.2 1.4-.5 2.2-1.2 3-.6.6-1 1.3-1 2.2 0 1.3 1 2.3 2.2 2.3s2.2-1 2.2-2.3c0-1.7-1-3-2.2-5.2Z" />
    </svg>
  );
}

export const streakTitle = (p: Pick<Person, "streak">, you = false) => {
  const n = p.streak?.days ?? 0;
  const base = `${n} day${n === 1 ? "" : "s"} in a row in the office`;
  if (!you) return base;
  if (p.streak?.today) return `${base}. Weekend days count when you come in, and never break it.`;
  const wk = new Date().getDay(); // your own clock: the server counts in your timezone too
  return wk === 0 || wk === 6
    ? `${base}. It's the weekend: come in to add a day, or don't — it won't break.`
    : `${base}. Come in today to keep it going.`;
};

/** Yours, in the bottom bar. Hidden until there's a streak. */
export function MyStreak({ me }: { me: Person }) {
  const n = me.streak?.days ?? 0;
  if (!n) return null;
  return (
    <div className="streak-chip" title={streakTitle(me, true)} aria-label={streakTitle(me, true)} data-streak={n}>
      <Flame size={18} lit={me.streak?.today} />
      <b>{n}</b>
    </div>
  );
}

/** A teammate's, small, in the People list (from 2 days: everyone's at 1 on their first day). */
export function RowStreak({ p }: { p: Person }) {
  const n = p.streak?.days ?? 0;
  if (n < 2) return null;
  return (
    <span className="row-streak" title={streakTitle(p)}>
      <Flame size={13} lit={p.streak?.today} />
      {n}
    </span>
  );
}
