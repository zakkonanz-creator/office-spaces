// Slack, used two ways only: look people up (id + photo for "Message on Slack")
// and DM them a Fathom summary. Plain Web API calls with a bot token. Use its own
// HTTP-only Slack app (deploy/slack-app-manifest.json), not a Socket Mode bot.

import { config } from "./config";

async function api(method: string, params: Record<string, string>): Promise<any | null> {
  if (!config.slack.botToken) return null;
  // A Slack outage or hang must never break sign-in or a webhook: time out, log, carry on.
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.slack.botToken}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(10_000),
  }).catch((e) => { console.warn(`slack ${method}: ${(e as Error).message}`); return null; });
  if (!r) return null;
  const j = await r.json().catch(() => null);
  if (!j?.ok) {
    console.warn(`slack ${method}: ${j?.error ?? r.status}`);
    return null;
  }
  return j;
}

export async function slackProfile(email: string): Promise<{ id: string; avatar: string | null; title: string | null } | null> {
  const j = await api("users.lookupByEmail", { email });
  if (!j?.user) return null;
  const p = j.user.profile ?? {};
  // Slack's default "no photo" avatars live under a gravatar URL; don't prefer those over Google's.
  const avatar: string | null = p.image_192 && !/gravatar\.com/.test(p.image_192) ? p.image_192 : null;
  return { id: j.user.id, avatar, title: p.title || null };
}

export async function slackDm(userId: string, text: string, blocks?: unknown[]) {
  const open = await api("conversations.open", { users: userId });
  const channel = open?.channel?.id;
  if (!channel) return false;
  const r = await api("chat.postMessage", { channel, text, ...(blocks ? { blocks: JSON.stringify(blocks) } : {}), unfurl_links: "false" });
  return Boolean(r);
}

/** Post in a channel the app is in. False if Slack refused (not set up, not in the channel). */
export async function postToChannel(channel: string, text: string): Promise<boolean> {
  return Boolean(await api("chat.postMessage", { channel, text, unfurl_links: "false", unfurl_media: "false" }));
}

// ── #wins (server/wins.ts): needs channels:read + channels:history, and the app added to #wins. ──

/** A public channel's id by name (paged; cached by the caller). */
export async function channelId(name: string): Promise<string | null> {
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const j = await api("conversations.list", { limit: "200", exclude_archived: "true", types: "public_channel", ...(cursor ? { cursor } : {}) });
    if (!j) return null;
    const c = (j.channels ?? []).find((x: any) => x.name === name);
    if (c) return c.id;
    cursor = j.response_metadata?.next_cursor ?? "";
    if (!cursor) return null;
  }
  return null;
}

export interface SlackFile { mimetype?: string; url_private?: string; thumb_720?: string; thumb_480?: string; thumb_360?: string; thumb_video?: string }
export interface SlackMessage { ts: string; user?: string; text?: string; subtype?: string; bot_id?: string; thread_ts?: string; files?: SlackFile[] }

/** Messages newer than `oldest` (a Slack ts), oldest first. Null when Slack refuses (scope, not in channel). */
export async function channelSince(channel: string, oldest: string, limit = 50): Promise<SlackMessage[] | null> {
  const j = await api("conversations.history", { channel, oldest, limit: String(limit) });
  if (!j) return null;
  return [...(j.messages ?? [])].reverse();
}

export async function slackUserName(id: string): Promise<string | null> {
  const j = await api("users.info", { user: id });
  const u = j?.user;
  return u ? (u.profile?.real_name || u.real_name || u.name || null) : null;
}

/** A file a message carries (needs the files:read scope; without it Slack answers 403). Images only, ≤ 8 MB. */
export async function slackFile(url: string): Promise<{ mime: string; bytes: Buffer } | null> {
  if (!config.slack.botToken) return null;
  const r = await fetch(url, { headers: { authorization: `Bearer ${config.slack.botToken}` }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  const mime = r?.headers.get("content-type")?.split(";")[0].trim() ?? "";
  if (!r?.ok || !/^image\/(png|jpe?g|gif|webp)$/.test(mime)) return null; // a 403 login page is text/html
  const bytes = Buffer.from(await r.arrayBuffer());
  return bytes.length && bytes.length <= 8e6 ? { mime, bytes } : null;
}
