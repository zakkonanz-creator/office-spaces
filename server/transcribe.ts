// "Transcribe this room". Anyone on the team in a room switches it on; everyone
// in the room sees the badge. Each teammate's browser records only its own mic
// in ~30 s clips and uploads the ones with speech (web/src/office/transcribe.ts).
// When it stops, the clips go one at a time to the Whisper service on Railway
// (transcriber/), their audio is deleted, and Claude writes the notes. The notes
// go to the people who were in the room — not to admins — in Recordings and a
// Slack DM.
//
// Guests are never recorded: their browsers don't send audio, so a customer in a
// room isn't transcribed. Stops by itself when the room empties, after 10 minutes
// with no speech, at 2 hours, or when the monthly hours cap is reached.

import Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config";
import { getSetting, one, q } from "./db";
import { floor } from "./floorStore";
import { slackDm } from "./slack";
import { memberIdsInRoom, roomTranscribing, setTranscribing, toastUsers } from "./office";
import { mergeClips, slackSafe, stopReason, transcriptText, type Segment } from "../shared/transcript";
import type { UserRow } from "./auth";

const SUMMARY_MODEL = "claude-haiku-5-5";
const DEFAULT_MONTHLY_HOURS = 40;
/** Clips that arrive this long after the stop (the last one in flight) still count. */
const LATE_MS = 90_000;
/** Present this long, or this much said, makes you an attendee: you get the notes. Walking in to say
 *  hi doesn't — that would hand the whole meeting to anyone who passed through. */
const ATTEND_MS = 60_000;
const SPOKE_MS = 20_000;
const SWEEP_MS = 20_000;
/** Browsers send ~24 kbps (Safari's mp4 can be more); a clip far bigger than its length is refused. */
const MAX_BYTES_PER_S = 12_000;
/** Safari records AAC in mp4 and may ignore the bitrate asked for (its defaults run ~96–128 kbps). */
const MAX_BYTES_PER_S_MP4 = 24_000;
const MAX_TRANSCRIPT_BYTES = 80 * 1024 * 1024;
/** Give up on a transcriber that stays down this long after the meeting; until then the audio waits. */
const GIVE_UP_MS = 24 * 3600e3;

interface Active {
  id: number;
  roomId: string;
  startedAt: number;
  lastSpeechAt: number;
  /** Everyone who was in the room at some point, and for how long (ms). */
  present: Map<number, number>;
  /** How much each person said (ms of clips sent). */
  spoke: Map<number, number>;
  startedBy: number;
  /** Per person: when their last clip ended, so the server (not the browser) decides each clip's length. */
  lastClipEnd: Map<number, number>;
  bytes: number;
}
const active = new Map<string, Active>(); // by room
/** Rooms whose start is between the check and the insert: a second start waits for the first. */
const starting = new Set<string>();
/** Just stopped: who was there, so their in-flight last clip still lands. */
const recentlyStopped = new Map<number, { seen: Set<number>; at: number }>();

const attendeesOf = (a: Active) =>
  [...a.present.entries()].filter(([id, ms]) => id === a.startedBy || ms >= ATTEND_MS || (a.spoke.get(id) ?? 0) >= SPOKE_MS).map(([id]) => id);
const saveAttendees = (a: Active) => q(`UPDATE transcripts SET attendee_ids = $2 WHERE id = $1`, [a.id, attendeesOf(a)]);

export async function migrateTranscripts() {
  await q(`CREATE TABLE IF NOT EXISTS transcripts (
    id SERIAL PRIMARY KEY,
    room_id TEXT NOT NULL,
    room_name TEXT NOT NULL DEFAULT '',
    started_by INTEGER REFERENCES users(id),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    ended_reason TEXT,
    status TEXT NOT NULL DEFAULT 'recording',
    attendee_ids INTEGER[] NOT NULL DEFAULT '{}',
    transcript_md TEXT,
    summary_md TEXT,
    error TEXT,
    processed_at TIMESTAMPTZ
  )`);
  await q(`CREATE INDEX IF NOT EXISTS transcripts_status ON transcripts (status)`);
  await q(`ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS summary_tries INTEGER NOT NULL DEFAULT 0`);
  // The transcriber down or waking: when to try again, and how many times we have.
  await q(`ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS retry_at TIMESTAMPTZ`);
  await q(`ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS retries INTEGER NOT NULL DEFAULT 0`);
  await q(`CREATE TABLE IF NOT EXISTS transcript_chunks (
    id BIGSERIAL PRIMARY KEY,
    transcript_id INTEGER NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    started_at TIMESTAMPTZ NOT NULL,
    duration_ms INTEGER NOT NULL,
    mime TEXT NOT NULL,
    audio BYTEA,
    segments JSONB,
    status TEXT NOT NULL DEFAULT 'pending',
    tries INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS transcript_chunks_t ON transcript_chunks (transcript_id)`);
  // A restart drops the in-memory "who's recording": those transcripts end here and get processed.
  await q(`UPDATE transcripts SET status = 'queued', ended_at = COALESCE(ended_at, now()), ended_reason = COALESCE(ended_reason, 'the office server restarted')
            WHERE status = 'recording'`);
  // Processing interrupted by a restart: pick it up again.
  await q(`UPDATE transcripts SET status = 'queued' WHERE status = 'processing'`);
}

/** Hours of audio sent this calendar month (UTC), and the cap. */
export async function usage() {
  const r = await one<{ ms: string | null }>(`SELECT SUM(duration_ms) AS ms FROM transcript_chunks WHERE created_at >= date_trunc('month', now())`);
  const cap = await getSetting<number>("transcribeMonthlyHours", DEFAULT_MONTHLY_HOURS);
  return { hours: Number(r?.ms ?? 0) / 3600e3, cap };
}

async function stop(a: Active, reason: string) {
  // A sweep and a Stop press can both get here; only the current transcription for the room stops.
  if (active.get(a.roomId) !== a) return;
  active.delete(a.roomId);
  for (const id of memberIdsInRoom(a.roomId)) a.present.set(id, a.present.get(id) ?? 0);
  const who = attendeesOf(a);
  // The row first, then the badge: the last clips that arrive meanwhile must find it stopped.
  recentlyStopped.set(a.id, { seen: new Set(a.present.keys()), at: Date.now() });
  setTimeout(() => recentlyStopped.delete(a.id), LATE_MS).unref();
  await q(`UPDATE transcripts SET status = 'queued', ended_at = now(), ended_reason = $2, attendee_ids = $3 WHERE id = $1`, [a.id, reason, who]);
  if (roomTranscribing(a.roomId)?.id === a.id) setTranscribing(a.roomId, null);
  toastUsers([...a.present.keys()], `Transcription stopped: ${reason}. Notes arrive in Recordings and on Slack once they're ready.`);
}

type Need = (req: FastifyRequest, reply: FastifyReply) => UserRow | null;

export function registerTranscribe(app: FastifyInstance, needUser: Need) {
  app.post("/api/rooms/:roomId/transcribe", async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return;
    const roomId = (req.params as any).roomId as string;
    const room = floor.rooms.find((r) => r.id === roomId);
    if (!room) return reply.code(404).send({ error: "no such room" });
    if (!memberIdsInRoom(roomId).includes(u.id)) return reply.code(403).send({ error: "You need to be in the room." });
    const on = (req.body as any)?.on === true;
    const cur = active.get(roomId);
    if (!on) {
      if (cur) await stop(cur, `${u.name.split(" ")[0]} stopped it`);
      return { ok: true };
    }
    if (cur || starting.has(roomId)) return reply.code(409).send({ error: "This room is already being transcribed." });
    if (!config.transcriber.url || !config.transcriber.key) return reply.code(503).send({ error: "Transcription isn't set up on this server yet." });
    starting.add(roomId);
    try {
      const { hours, cap } = await usage();
      if (hours >= cap) return reply.code(429).send({ error: `This month's ${cap} hours of transcription are used up. An admin can raise the limit in Admin → Settings.` });
      const here = memberIdsInRoom(roomId);
      const t = await one<{ id: number }>(`INSERT INTO transcripts (room_id, room_name, started_by, attendee_ids) VALUES ($1, $2, $3, $4) RETURNING id`, [roomId, room.name || "", u.id, [u.id]]);
      const now = Date.now();
      active.set(roomId, { id: t!.id, roomId, startedAt: now, lastSpeechAt: now, present: new Map(here.map((id) => [id, 0])), spoke: new Map(), startedBy: u.id, lastClipEnd: new Map(), bytes: 0 });
      setTranscribing(roomId, { id: t!.id, by: String(u.id), byName: u.name, startedAt: now });
      return { id: t!.id };
    } finally {
      starting.delete(roomId);
    }
  });

  // One person's clip. Raw audio body (audio/webm or audio/mp4), ?dur=<ms>[&unsure=1].
  app.register(async (scope) => {
    // Signed-out requests are refused before their body is read.
    scope.addHook("onRequest", async (req, reply) => {
      if (req.viewer?.kind !== "user") return reply.code(401).send({ error: "sign in" });
    });
    scope.addContentTypeParser(/^audio\//, { parseAs: "buffer", bodyLimit: 3 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    scope.post("/api/transcripts/:id/chunks", async (req, reply) => {
      const u = needUser(req, reply);
      if (!u) return;
      const id = Number((req.params as any).id);
      const claimed = Math.round(Number((req.query as any).dur));
      const unsure = (req.query as any).unsure === "1";
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || !body.length) return reply.code(400).send({ error: "no audio" });
      if (!Number.isFinite(claimed) || claimed < 300 || claimed > 90_000) return reply.code(400).send({ error: "dur out of range" });
      const now = Date.now();
      const a = [...active.values()].find((x) => x.id === id);
      let since: number;
      if (a) {
        // From someone in the room now, or someone who was (their last clip, sent as they walked out).
        if (!memberIdsInRoom(a.roomId).includes(u.id) && !a.present.has(u.id)) return reply.code(403).send({ error: "not in that room" });
        since = a.lastClipEnd.get(u.id) ?? a.startedAt;
      } else {
        const r = recentlyStopped.get(id);
        if (r) {
          if (!r.seen.has(u.id)) return reply.code(409).send({ error: "not transcribing" });
        } else {
          // After a restart there's no memory: the stored attendees decide.
          const t = await one<{ attendee_ids: number[]; ended_at: string | null; status: string }>(`SELECT attendee_ids, ended_at, status FROM transcripts WHERE id = $1`, [id]);
          if (!t?.ended_at || t.status !== "queued" || now - new Date(t.ended_at).getTime() > LATE_MS || !t.attendee_ids.includes(u.id)) return reply.code(409).send({ error: "not transcribing" });
        }
        since = now - claimed;
      }
      // The server decides how long a clip is: no longer than the time since your last one ended.
      const dur = Math.max(300, Math.min(claimed, now - since));
      const perS = String(req.headers["content-type"] ?? "").startsWith("audio/mp4") ? MAX_BYTES_PER_S_MP4 : MAX_BYTES_PER_S;
      if (body.length > (dur / 1000) * perS + 32_000) {
        req.log.warn({ bytes: body.length, dur, type: req.headers["content-type"], user: u.id }, "transcribe: clip refused as too large for its length");
        return reply.code(413).send({ error: "clip too large for its length" });
      }
      if (a) {
        if (a.bytes + body.length > MAX_TRANSCRIPT_BYTES) return reply.code(413).send({ error: "this transcription is too long" });
        const { hours, cap } = await usage();
        if (hours >= cap) return reply.code(429).send({ error: "monthly limit reached" });
        a.bytes += body.length;
        a.lastClipEnd.set(u.id, now);
        a.present.set(u.id, a.present.get(u.id) ?? 0);
        a.spoke.set(u.id, (a.spoke.get(u.id) ?? 0) + dur);
        // A browser that couldn't measure (background tab) still sends; that isn't proof anyone spoke.
        if (!unsure) a.lastSpeechAt = now;
      }
      const mime = String(req.headers["content-type"] ?? "audio/webm").split(";")[0];
      // Server time, so speakers on machines with wrong clocks still line up.
      await q(`INSERT INTO transcript_chunks (transcript_id, user_id, started_at, duration_ms, mime, audio) VALUES ($1, $2, $3, $4, $5, $6)`, [id, u.id, new Date(now - dur), dur, mime, body]);
      if (a) void saveAttendees(a).catch(() => {}); // a restart mid-meeting keeps who spoke
      return { ok: true };
    });
  });

  app.get("/api/transcripts", async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return;
    // The people who were in the room. Admins don't get everyone's room conversations.
    return q(
      `SELECT t.id, t.room_id, t.room_name, t.started_at, t.ended_at, t.ended_reason, t.status, t.summary_md, t.error, s.name AS started_by
         FROM transcripts t LEFT JOIN users s ON s.id = t.started_by
        WHERE $1 = ANY(t.attendee_ids) OR t.started_by = $1 ORDER BY t.started_at DESC LIMIT 50`,
      [u.id],
    );
  });

  app.get("/api/transcripts/:id", async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return;
    const t = await one(`SELECT id, room_name, started_at, transcript_md, summary_md FROM transcripts WHERE id = $1 AND ($2 = ANY(attendee_ids) OR started_by = $2)`, [Number((req.params as any).id), u.id]);
    return t ?? reply.code(404).send({ error: "not found" });
  });

  // Every 20 s: time in the room counts toward attending, attendees are saved (a restart keeps
  // them), and a transcription that should stop, stops.
  setInterval(() => {
    void (async () => {
      const over = active.size ? (await usage().then((x) => x.hours >= x.cap).catch(() => false)) : false;
      for (const a of [...active.values()]) {
        for (const id of memberIdsInRoom(a.roomId)) a.present.set(id, (a.present.get(id) ?? 0) + SWEEP_MS);
        await saveAttendees(a).catch((e) => console.error("transcribe attendees", e));
        const why = stopReason({ startedAt: a.startedAt, lastSpeechAt: a.lastSpeechAt, occupants: memberIdsInRoom(a.roomId).length, badgeOn: roomTranscribing(a.roomId)?.id === a.id, overCap: over }, Date.now());
        if (why) await stop(a, why).catch((e) => console.error("transcribe stop", e));
      }
    })();
  }, SWEEP_MS).unref();

  setInterval(() => void processQueue().catch((e) => console.error("transcribe queue", e)), 15_000).unref();
}

// ── After the meeting ───────────────────────────────────────────────────────

let busy = false;
type Queued = { id: number; room_name: string; started_at: string; ended_at: string; attendee_ids: number[]; summary_tries: number; retries: number };

async function processQueue() {
  if (busy || !config.transcriber.url) return;
  busy = true;
  let t: Queued | null = null;
  try {
    // Wait out the late clips; a transcript waiting on a retry steps aside for the others.
    t = await one<Queued>(
      `UPDATE transcripts SET status = 'processing' WHERE id = (
         SELECT id FROM transcripts WHERE status = 'queued' AND ended_at < now() - interval '${LATE_MS / 1000} seconds'
            AND (retry_at IS NULL OR retry_at < now()) ORDER BY ended_at LIMIT 1
       ) RETURNING id, room_name, started_at, ended_at, attendee_ids, summary_tries, retries`,
    );
    if (t) await processOne(t);
  } catch (e) {
    // Never leave it saying "Writing notes…" until the next restart.
    console.error("transcribe process", e);
    if (t) await later(t, (e as Error).message).catch(() => {});
  } finally {
    busy = false;
  }
}

/** Back in the queue with a growing wait, until a day after the meeting; then whatever's missing is given up. */
async function later(t: Queued, why: string) {
  if (Date.now() - new Date(t.ended_at).getTime() > GIVE_UP_MS) {
    await q(`UPDATE transcript_chunks SET status = 'failed', audio = NULL WHERE transcript_id = $1 AND status = 'pending'`, [t.id]);
    await q(`UPDATE transcripts SET status = 'queued', retry_at = NULL, error = $2 WHERE id = $1`, [t.id, `gave up waiting for the transcriber: ${why}`.slice(0, 300)]);
    return;
  }
  const waitS = Math.min(1800, 60 * 2 ** Math.min(t.retries, 5));
  await q(`UPDATE transcripts SET status = 'queued', retries = retries + 1, retry_at = now() + make_interval(secs => $3), error = $2 WHERE id = $1`, [t.id, why.slice(0, 300), waitS]);
}

class TranscriberError extends Error {
  constructor(message: string, readonly permanent: boolean) { super(message); }
}

async function whisper(audio: Buffer, mime: string): Promise<Segment[]> {
  let r: Response;
  try {
    r = await fetch(`${config.transcriber.url}/transcribe`, {
      method: "POST",
      headers: { "x-transcriber-key": config.transcriber.key, "content-type": mime },
      body: new Uint8Array(audio),
      redirect: "error", // never send the key on to somewhere else
      signal: AbortSignal.timeout(10 * 60e3), // a sleeping service loads the model first
    });
  } catch (e) {
    throw new TranscriberError(`transcriber unreachable: ${(e as Error).message}`, false);
  }
  if (!r.ok) {
    // A clip it can't read (400/413/415/422) won't get better; anything else (down, waking, a key mix-up) might.
    const permanent = [400, 413, 415, 422].includes(r.status);
    throw new TranscriberError(`transcriber ${r.status}: ${(await r.text()).slice(0, 200)}`, permanent);
  }
  return ((await r.json()) as { segments: Segment[] }).segments;
}

async function processOne(t: Queued) {
  // Ids first, then one clip's audio at a time: a long meeting never sits in memory all at once.
  const pending = await q<{ id: number; mime: string }>(`SELECT id, mime FROM transcript_chunks WHERE transcript_id = $1 AND status = 'pending' ORDER BY started_at`, [t.id]);
  for (const c of pending) {
    const row = await one<{ audio: Buffer | null }>(`SELECT audio FROM transcript_chunks WHERE id = $1`, [c.id]);
    if (!row?.audio) { await q(`UPDATE transcript_chunks SET status = 'failed' WHERE id = $1`, [c.id]); continue; }
    try {
      const segs = await whisper(row.audio, c.mime);
      // The audio goes as soon as its words are out.
      await q(`UPDATE transcript_chunks SET segments = $2, status = 'done', audio = NULL WHERE id = $1`, [c.id, JSON.stringify(segs)]);
    } catch (e) {
      if (e instanceof TranscriberError && e.permanent) {
        await q(`UPDATE transcript_chunks SET status = 'failed', tries = tries + 1, audio = NULL WHERE id = $1`, [c.id]);
        continue;
      }
      return later(t, (e as Error).message); // keep the audio; try again soon
    }
  }
  const rows = await q<{ user_id: number; name: string; started_at: string; segments: Segment[] | null; status: string }>(
    `SELECT c.user_id, u.name, c.started_at, c.segments, c.status FROM transcript_chunks c JOIN users u ON u.id = c.user_id WHERE c.transcript_id = $1`, [t.id]);
  if (!rows.length) {
    // Started and stopped with nothing said: no notes, nobody pinged.
    await q(`DELETE FROM transcripts WHERE id = $1`, [t.id]);
    return;
  }
  // Everyone who said enough gets the notes, even if the attendee list was cut short by a restart.
  const said = await q<{ user_id: number }>(`SELECT user_id FROM transcript_chunks WHERE transcript_id = $1 GROUP BY user_id HAVING SUM(duration_ms) >= $2`, [t.id, SPOKE_MS]);
  const attendees = [...new Set([...t.attendee_ids, ...said.map((r) => r.user_id)])];
  const lost = rows.filter((r) => r.status === "failed").length;
  const lines = mergeClips(rows.filter((r) => r.segments).map((r) => ({ speaker: r.name, startedAt: new Date(r.started_at).getTime(), segments: r.segments! })), new Date(t.started_at).getTime());
  const text = transcriptText(lines);
  let summary = lines.length ? await summarize(t.room_name, text).catch((e) => { console.error("transcribe summary", e); return null; }) : null;
  if (lines.length && summary === null && t.summary_tries < 2) {
    // Claude unavailable (credit, outage): try again on a later round before giving up on the notes.
    await q(`UPDATE transcripts SET status = 'queued', summary_tries = summary_tries + 1, retry_at = now() + interval '2 minutes', error = 'notes not written yet; retrying' WHERE id = $1`, [t.id]);
    return;
  }
  if (!lines.length) summary = lost ? "The audio couldn't be transcribed." : "Nobody's speech was picked up. Check that mics were on.";
  else if (summary && lost) summary += `\n\n_${lost} clip${lost === 1 ? "" : "s"} couldn't be transcribed, so part of the meeting may be missing._`;
  await q(`UPDATE transcripts SET status = 'done', transcript_md = $2, summary_md = $3, attendee_ids = $4, error = NULL, retry_at = NULL, processed_at = now() WHERE id = $1`,
    [t.id, text, summary ?? "The notes couldn't be written. The full transcript is below.", attendees]);
  const where = t.room_name ? `the ${t.room_name} room` : "your room";
  toastUsers(attendees, `Notes from ${where} are ready in Recordings.`);
  if (!lines.length) return; // nothing worth a Slack DM
  for (const uid of attendees) {
    const u = await one<{ slack_id: string | null }>(`SELECT slack_id FROM users WHERE id = $1 AND NOT removed`, [uid]);
    if (!u?.slack_id) continue;
    await slackDm(u.slack_id, `*Notes from ${where}* (${new Date(t.started_at).toUTCString().slice(0, 22)} UTC)\n\n${slackSafe((summary ?? "").slice(0, 2800))}\n\nFull transcript: ${config.publicUrl} → Recordings`).catch(() => false);
  }
}

async function summarize(room: string, transcript: string): Promise<string> {
  const msg = await new Anthropic().messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 1200,
    system:
      "You write meeting notes for a team at Acme from a transcript of a conversation in their virtual office. " +
      "Write in plain English, in Markdown: a 2–4 sentence summary, then **Decisions** and **Action items** as bullet lists " +
      "(each action item with the person who owns it, and a date only if one was said). Leave out a section that would be empty. " +
      "Only use what is in the transcript; never invent names, numbers or dates. The transcript is machine-made, so treat odd words as possible mishearings.",
    messages: [{ role: "user", content: `Room: ${room || "unnamed"}\n\nTranscript:\n${transcript.slice(0, 150_000)}` }],
  });
  return msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
}
