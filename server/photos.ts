// Your own photo. Until now the office photo came only from
// Slack (or Google at first sign-in) and nobody could change it here.
//
// An uploaded photo lives in user_photos and avatar_url points at /api/photos/<token>. The token is random
// and changes with every upload, so the address can be cached forever and can't be guessed (guests see
// avatars too, and they aren't signed-in users). The browser shrinks the picture to a small square first;
// the server still checks it really is a JPEG/PNG/WebP and small.
//
// "Use my Slack photo" looks the person up in Slack again and drops the upload.

import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { one, q } from "./db";
import { slackProfile } from "./slack";

export const PHOTO_PREFIX = "/api/photos/";
export const MAX_PHOTO_BYTES = 400 * 1024;

/** True when this avatar is one somebody uploaded here (a Slack sync must leave it alone). */
export const isUploaded = (avatar: string | null | undefined) => Boolean(avatar && avatar.startsWith(PHOTO_PREFIX));

/** A data: URL from the browser → the picture, or a plain-English reason it was refused. */
export function parsePhoto(raw: unknown): { mime: string; bytes: Buffer } | { error: string } {
  if (typeof raw !== "string") return { error: "Pick a picture first." };
  const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(raw);
  if (!m) return { error: "That isn't a picture we can use. Try a JPG or PNG." };
  const bytes = Buffer.from(m[1], "base64");
  if (bytes.length < 100) return { error: "That picture looks empty." };
  if (bytes.length > MAX_PHOTO_BYTES) return { error: "That picture is too big. Try a smaller one." };
  // Trust the bytes, not the label.
  const mime =
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg"
    : bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "image/png"
    : bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP" ? "image/webp"
    : null;
  if (!mime) return { error: "That isn't a picture we can use. Try a JPG or PNG." };
  return { mime, bytes };
}

export const migratePhotos = () =>
  q(`CREATE TABLE IF NOT EXISTS user_photos (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    mime TEXT NOT NULL,
    bytes BYTEA NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

type NeedUser = (req: FastifyRequest, reply: FastifyReply) => { id: number; email: string } | null;
type Tell = (userId: number, patch: { avatar: string | null }) => void;

export function registerPhotos(app: FastifyInstance, needUser: NeedUser, tell: Tell) {
  app.get("/api/photos/:token", async (req, reply) => {
    const token = String((req.params as { token: string }).token ?? "");
    if (!/^[a-f0-9]{32}$/.test(token)) return reply.code(404).send({ error: "no such photo" });
    const row = await one<{ mime: string; bytes: Buffer }>(`SELECT mime, bytes FROM user_photos WHERE token = $1`, [token]);
    if (!row) return reply.code(404).send({ error: "no such photo" });
    return reply
      .header("content-type", row.mime)
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .send(row.bytes);
  });

  /** Upload your own photo. */
  app.put("/api/me/photo", { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return;
    const p = parsePhoto((req.body as { image?: unknown } | null)?.image);
    if ("error" in p) return reply.code(400).send(p);
    const token = randomBytes(16).toString("hex");
    await q(
      `INSERT INTO user_photos (user_id, token, mime, bytes) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET token = EXCLUDED.token, mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, updated_at = now()`,
      [u.id, token, p.mime, p.bytes],
    );
    const avatar = PHOTO_PREFIX + token;
    const r = await one<{ avatar_url: string }>(`UPDATE users SET avatar_url = $2 WHERE id = $1 AND NOT removed RETURNING avatar_url`, [u.id, avatar]);
    if (!r) return reply.code(404).send({ error: "no such member" });
    tell(u.id, { avatar });
    return { avatar };
  });

  /** Go back to the Slack photo (also how someone picks up a newer Slack photo). */
  app.post("/api/me/photo/slack", async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return;
    const s = await slackProfile(u.email).catch(() => null);
    if (!s?.avatar) return reply.code(404).send({ error: "Couldn't find a photo on your Slack profile. Add one in Slack, or upload a picture here." });
    await q(`DELETE FROM user_photos WHERE user_id = $1`, [u.id]);
    await q(`UPDATE users SET avatar_url = $2, slack_id = COALESCE(slack_id, $3) WHERE id = $1`, [u.id, s.avatar, s.id]);
    tell(u.id, { avatar: s.avatar });
    return { avatar: s.avatar };
  });
}
