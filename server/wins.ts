// The win bell. Every minute, new top-level posts in
// Slack #wins ring a soft bell in the office and show a banner with the poster's name; the
// poster gets points (shared/points.ts). Needs the Slack app to have channels:read and
// channels:history and to be added to #wins; until then it logs once and stays quiet.
// The last message seen is kept in settings, so a restart never re-rings old wins.

import { getSetting, one, q, setSetting } from "./db";
import { channelId, channelSince, postToChannel, slackFile, slackUserName, type SlackFile, type SlackMessage } from "./slack";
import { config } from "./config";
import { award, countToday } from "./points";
import { POINTS } from "../shared/points";
import { pointsChanged, ringWin } from "./office";
import { addWin, attachWinImage, winsMissingImages } from "./jumbotron";
import { firstName } from "../shared/names";

const CHANNEL = process.env.WINS_CHANNEL || "wins";
let id: string | null | undefined;
let warned = false;

/** Slack's markup → plain text, short. */
export function plain(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, "@$1")
    .replace(/<@[A-Z0-9]+>/g, "@someone")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/:[a-z0-9_+-]+:/g, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

/** Slack's three special characters, so a reason can't become a mention or a link. */
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The #wins post for points an admin awarded. Mentions them when we know their Slack id. */
export function awardText(a: { toName: string; toSlackId: string | null; byName: string; points: number; reason: string }): string {
  const who = a.toSlackId ? `<@${a.toSlackId}>` : `*${esc(a.toName)}*`;
  return `:star: ${who} got *+${a.points.toLocaleString("en-US")} points* from ${esc(firstName(a.byName))}: ${esc(a.reason)}`;
}

/** Post an admin's award in #wins. Our own post is a bot message, so checkWins never counts it as a win. */
export async function postAward(a: Parameters<typeof awardText>[0]): Promise<boolean> {
  if (!config.slack.botToken) return false;
  if (id === undefined) id = await channelId(CHANNEL);
  if (!id) { id = undefined; return false; }
  return postToChannel(id, awardText(a));
}

// Most #wins posts are a screenshot (a customer's kind words) or a video with little or no text, so
// the jumbotron shows the picture itself, not "posted a win". For a video, its still.
// Downloading needs the Slack app's files:read scope; without it the win shows as text and
// fillWinImages adds the picture once the scope is there.

/** The picture to show for a post: its first image, or a video's still. */
export function winMedia(files?: SlackFile[]): { url: string; video: boolean } | null {
  for (const f of files ?? []) {
    const mime = f.mimetype ?? "";
    if (mime.startsWith("image/")) {
      const url = f.thumb_720 || f.thumb_480 || f.url_private || f.thumb_360;
      if (url) return { url, video: false };
    }
    if (mime.startsWith("video/") && f.thumb_video) return { url: f.thumb_video, video: true };
  }
  return null;
}

/** A top-level post by a person (not a bot, not a thread reply). */
const isWin = (m: SlackMessage) => !m.subtype && !m.bot_id && !!m.user && !(m.thread_ts && m.thread_ts !== m.ts);
const msOf = (ts: string) => Math.round(Number(ts) * 1000);

/** Download a post's picture into win_images; its id, or null (no picture, or Slack refused). */
async function storeWinImage(ts: string, url: string): Promise<number | null> {
  const had = await one<{ id: number }>(`SELECT id FROM win_images WHERE ts = $1`, [ts]);
  if (had) return had.id;
  const f = await slackFile(url);
  if (!f) return null;
  const row = await one<{ id: number }>(
    `INSERT INTO win_images (ts, mime, bytes) VALUES ($1, $2, $3) ON CONFLICT (ts) DO UPDATE SET mime = EXCLUDED.mime RETURNING id`,
    [ts, f.mime, f.bytes],
  );
  return row?.id ?? null;
}

let lastFill = 0;
let refusedOnce = false;
/** This week's wins on the screen that should have a picture and don't yet (posted before this, or before files:read). */
export async function fillWinImages(now = Date.now()): Promise<number> {
  if (!id || now - lastFill < 30 * 60e3) return 0;
  lastFill = now;
  await q(`DELETE FROM win_images WHERE created_at < now() - interval '14 days'`).catch(() => {});
  const missing = new Set(winsMissingImages());
  if (!missing.size) return 0;
  const msgs = await channelSince(id, String((now - 8 * 864e5) / 1000), 200);
  let n = 0;
  for (const m of msgs ?? []) {
    if (!isWin(m) || !missing.has(msOf(m.ts))) continue;
    const media = winMedia(m.files);
    if (!media) { await attachWinImage(msOf(m.ts), null, false); continue; } // no picture: stop asking
    const img = await storeWinImage(m.ts, media.url);
    if (img) { await attachWinImage(msOf(m.ts), img, media.video); n++; }
    else if (!refusedOnce) { refusedOnce = true; console.warn("wins: Slack won't hand over #wins images (the Slack app needs the files:read scope)"); }
  }
  return n;
}

export async function checkWins(): Promise<number> {
  if (!config.slack.botToken) return 0;
  if (id === undefined) id = await channelId(CHANNEL);
  if (!id) {
    if (!warned) console.warn(`wins: can't see #${CHANNEL} (needs channels:read, and the app added to the channel)`);
    warned = true;
    id = undefined; // try again next time
    return 0;
  }
  const last = await getSetting<string | null>("winsLastTs", null);
  if (!last) {
    await setSetting("winsLastTs", String(Date.now() / 1000)); // start from now: never ring old wins
    return 0;
  }
  const msgs = await channelSince(id, last);
  if (!msgs) {
    if (!warned) console.warn(`wins: can't read #${CHANNEL} (needs channels:history, and the app added to the channel)`);
    warned = true;
    return 0;
  }
  warned = false;
  let rung = 0;
  for (const m of msgs) {
    await setSetting("winsLastTs", m.ts);
    if (!isWin(m)) continue;
    const u = await one<{ id: number; name: string }>(`SELECT id, name FROM users WHERE slack_id = $1 AND NOT removed`, [m.user]);
    const name = firstName(u?.name ?? (await slackUserName(m.user!)));
    const media = winMedia(m.files);
    const img = media ? await storeWinImage(m.ts, media.url).catch(() => null) : null;
    ringWin(name, plain(m.text ?? ""), img);
    await addWin(name, plain(m.text ?? ""), msOf(m.ts), { img, video: media?.video, pending: Boolean(media && !img) });
    rung++;
    // Points for the first few a day only (a top-level "congrats!" shouldn't farm points); the bell rings for every one.
    if (u && (await countToday(u.id, "win")) < POINTS.winsPerDay && (await award(u.id, "win", POINTS.win, "Posted a win in #wins", `win:${m.ts}`))) await pointsChanged(u.id, `🔔 +${POINTS.win} points for your win in #wins!`);
  }
  return rung;
}
