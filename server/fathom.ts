// Fathom → Office Spaces. Fathom posts `new-meeting-content-ready` when a
// recording's summary is ready. We match it to the room meeting we started
// (by title, which we set), then: show it in the room's Recordings list, DM
// everyone who was there on Slack, and file a copy in the Drive recordings tree.
//
// Each person's Fathom webhook has its own whsec_ secret, so several are
// accepted (FATHOM_WEBHOOK_SECRETS, comma-separated). Signature scheme is
// Standard Webhooks: base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)).

import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { one, q } from "./db";
import { slackDm } from "./slack";
import { writeSummaryToDrive } from "./drive";
import { notifyAttendees } from "./office";

export function verifyFathom(headers: Record<string, string | string[] | undefined>, raw: string): boolean {
  const id = String(headers["webhook-id"] ?? "");
  const ts = String(headers["webhook-timestamp"] ?? "");
  const sigs = String(headers["webhook-signature"] ?? "");
  if (!id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 5 * 60) return false;
  const provided = sigs.split(" ").map((s) => Buffer.from(s.split(",")[1] ?? "", "base64"));
  for (const secret of config.fathom.webhookSecrets) {
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const want = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest();
    if (provided.some((p) => p.length === want.length && timingSafeEqual(p, want))) return true;
  }
  return false;
}

/** The payload shape isn't pinned in Fathom's docs; read every name we've seen for each field. */
function fields(m: any) {
  const summary =
    m?.default_summary?.markdown_formatted ?? m?.summary?.markdown_formatted ?? (typeof m?.summary === "string" ? m.summary : "") ?? "";
  const items: string[] = (m?.action_items ?? []).map((a: any) =>
    typeof a === "string" ? a : [a?.description ?? a?.text, a?.assignee?.name ? `(${a.assignee.name})` : ""].filter(Boolean).join(" "),
  );
  return {
    title: String(m?.meeting_title ?? m?.title ?? ""),
    url: String(m?.share_url ?? m?.url ?? ""),
    summary: String(summary),
    items,
  };
}

export async function handleFathom(payload: any): Promise<string> {
  const f = fields(payload?.meeting ?? payload);
  if (!f.title.startsWith("Office Spaces ·")) return "ignored: not a room meeting";
  const rec = await one(
    `SELECT * FROM recordings WHERE title = $1 AND created_at > now() - interval '2 days' ORDER BY created_at DESC LIMIT 1`,
    [f.title],
  );
  if (!rec) return "ignored: no matching room meeting";
  if (rec.summarized_at) return "duplicate";

  const md = [
    f.summary.trim(),
    f.items.length ? `\n### Action items\n${f.items.map((i) => `- ${i}`).join("\n")}` : "",
  ].join("\n").trim();
  // Claim it atomically: every attendee's Fathom can deliver the same meeting at once,
  // and only one delivery may send the DMs and file the notes.
  const claimed = await one(`UPDATE recordings SET fathom_url = $1, summary_md = $2, summarized_at = now() WHERE id = $3 AND summarized_at IS NULL RETURNING id`, [f.url || null, md, rec.id]);
  if (!claimed) return "duplicate";

  const roomName = String(rec.title).split(" · ")[1] ?? "a room";
  notifyAttendees(rec.attendee_emails ?? [], { roomId: rec.room_id, title: rec.title, url: f.url });

  // Slack DM to everyone who was invited (people in the room when it started).
  const ids = await q<{ slack_id: string }>(`SELECT slack_id FROM users WHERE email = ANY($1::text[]) AND slack_id IS NOT NULL`, [rec.attendee_emails]);
  const short = md.length > 2500 ? `${md.slice(0, 2500)}…` : md;
  for (const { slack_id } of ids) {
    await slackDm(slack_id, `Fathom notes from ${roomName}`, [
      { type: "section", text: { type: "mrkdwn", text: `*Fathom notes — ${roomName}*${f.url ? `  ·  <${f.url}|Open in Fathom>` : ""}` } },
      { type: "section", text: { type: "mrkdwn", text: toMrkdwn(short) || "_No summary text._" } },
    ]);
  }

  const driveUrl = await writeSummaryToDrive(rec, f.url, md).catch((e) => {
    console.warn("drive: could not file the summary:", e.message);
    return null;
  });
  if (driveUrl) await q(`UPDATE recordings SET drive_file_url = $1 WHERE id = $2`, [driveUrl, rec.id]);
  return "ok";
}

const toMrkdwn = (md: string) =>
  md
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[(.+?)\]\((https?:[^)]+)\)/g, "<$2|$1>");
