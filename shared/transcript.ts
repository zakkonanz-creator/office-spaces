// Turning per-person clips into one conversation. Each teammate's browser sends
// only its own mic, so every clip already knows who's talking; the work here is
// putting everyone's words back in time order and joining a speaker's runs.

export interface Segment {
  /** Seconds from the start of the clip. */
  start: number;
  end: number;
  text: string;
}

export interface Clip {
  speaker: string;
  /** When the clip started, ms since epoch (server clock). */
  startedAt: number;
  segments: Segment[];
}

export interface Line {
  speaker: string;
  /** ms since the transcript started */
  at: number;
  text: string;
}

/** Same speaker, less than this apart: one paragraph. */
const JOIN_MS = 8000;

export function mergeClips(clips: Clip[], startedAt: number): Line[] {
  const all = clips
    .flatMap((c) => c.segments.map((s) => ({ speaker: c.speaker, at: c.startedAt + s.start * 1000, end: c.startedAt + s.end * 1000, text: s.text.trim() })))
    .filter((s) => s.text)
    .sort((a, b) => a.at - b.at || a.speaker.localeCompare(b.speaker));
  const out: (Line & { end: number })[] = [];
  for (const s of all) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker && s.at - last.end < JOIN_MS) {
      last.text += ` ${s.text}`;
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ speaker: s.speaker, at: Math.max(0, s.at - startedAt), end: s.end, text: s.text });
    }
  }
  return out.map(({ end, ...l }) => l);
}

const mmss = (ms: number) => {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
};

/** "[03:12] Alex Admin: …" one line per turn. */
export const transcriptText = (lines: Line[]) => lines.map((l) => `[${mmss(l.at)}] ${l.speaker}: ${l.text}`).join("\n");

/** Why a transcription should stop now, or null to keep going. Checked every sweep. */
export function stopReason(t: { startedAt: number; lastSpeechAt: number; occupants: number; badgeOn: boolean; overCap: boolean }, now: number): string | null {
  if (!t.badgeOn || t.occupants === 0) return "everyone left the room";
  if (t.overCap) return "this month's transcription hours are used up";
  if (now - t.startedAt >= 2 * 3600e3) return "it reached the two-hour limit";
  if (now - t.lastSpeechAt >= 10 * 60e3) return "nobody spoke for 10 minutes";
  return null;
}

/** Machine-written notes into Slack: Slack's own control characters escaped, and Markdown links
 *  shown as "text (url)" so a crafted one can't hide where it goes. */
export function slackSafe(md: string): string {
  return md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    .replace(/\*\*(.+?)\*\*/g, "*$1*");
}
