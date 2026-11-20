// Postgres on Railway; an embedded PGlite database for local dev. Both speak the
// same SQL and return { rows }, so the rest of the server doesn't care which.

import { mkdirSync } from "node:fs";
import { config } from "./config";

type Row = Record<string, any>;
interface Db {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

let db: Db;
let begin: <T>(fn: (t: Db) => Promise<T>) => Promise<T>;

export async function openDb(): Promise<void> {
  if (config.databaseUrl) {
    const pg = await import("pg");
    const pool = new pg.default.Pool({
      connectionString: config.databaseUrl,
      ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
      max: 8,
    });
    db = { query: (sql, params) => pool.query(sql, params as any[]) as any };
    begin = async (fn) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const out = await fn({ query: (sql, params) => c.query(sql, params as any[]) as any });
        await c.query("COMMIT");
        return out;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    };
  } else {
    if (config.production) throw new Error("DATABASE_URL is required in production");
    const { PGlite } = await import("@electric-sql/pglite");
    mkdirSync(config.pgliteDir, { recursive: true });
    const lite = new PGlite(config.pgliteDir);
    db = { query: (sql, params) => lite.query(sql, params as any[]) as any };
    // PGlite holds every other query until the transaction ends, and rolls back on a throw.
    begin = (fn) => lite.transaction((t) => fn({ query: (sql, params) => t.query(sql, params as any[]) as any }));
  }
  await migrate();
}

export const q = <T extends Row = Row>(sql: string, params: unknown[] = []) => db.query<T>(sql, params).then((r) => r.rows);
export const one = async <T extends Row = Row>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0] ?? null;

export interface Tx {
  q: <T extends Row = Row>(sql: string, params?: unknown[]) => Promise<T[]>;
  one: <T extends Row = Row>(sql: string, params?: unknown[]) => Promise<T | null>;
}

/**
 * Run `fn` in one transaction on one connection: all of it commits, or a throw rolls all of
 * it back. Inside, use only the `t` it's given (the global q would run outside it, and on
 * PGlite would wait for this transaction to finish: a deadlock). Keep it short.
 */
export function tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
  return begin((c) => {
    const tq = <R extends Row = Row>(sql: string, params: unknown[] = []) => c.query<R>(sql, params).then((r) => r.rows);
    return fn({ q: tq, one: async <R extends Row = Row>(sql: string, params?: unknown[]): Promise<R | null> => (await tq<R>(sql, params))[0] ?? null });
  });
}

async function migrate() {
  // Each statement runs alone: PGlite's parameterless multi-statement exec and pg differ.
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      title TEXT,
      avatar_url TEXT,
      slack_id TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      desk_id TEXT,
      tz TEXT,
      removed BOOLEAN NOT NULL DEFAULT FALSE,
      google_refresh_token TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS users_desk ON users (desk_id) WHERE desk_id IS NOT NULL`,
    // Bumped on sign-out: every session cookie carries the version it was issued at.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0`,
    // Their own GHL Meeting Room link, for "Start meeting" (shared/ghlRooms.ts).
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS ghl_room_url TEXT`,
    // Their first day at Acme (shared/tenure.ts): from Slack, or set by an admin. NULL = the day they first signed in.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS started_on DATE`,
    // Points (shared/points.ts): every award that isn't tenure or office time. `ref` makes an award
    // happen once (the egg found, the anniversary year, the #wins message); NULL refs can repeat.
    `CREATE TABLE IF NOT EXISTS points_ledger (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL,
      points INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      ref TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS points_ledger_once ON points_ledger (user_id, kind, ref) WHERE ref IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS points_ledger_user ON points_ledger (user_id, created_at)`,
    // Anniversary points moved into tenure (POINTS.perYear): the rows stay for the once-a-year cheer.
    `UPDATE points_ledger SET points = 0 WHERE kind = 'anniversary' AND points <> 0`,
    // Their pet (shared/pets.ts), or NULL.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS pet TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS outfit TEXT`,
    // One row per stretch of time someone spent in a status while in the office.
    // ended_at NULL = still going. This is the analytics source.
    `CREATE TABLE IF NOT EXISTS status_events (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS status_events_time ON status_events (started_at)`,
    `CREATE INDEX IF NOT EXISTS status_events_open ON status_events (user_id) WHERE ended_at IS NULL`,
    `CREATE TABLE IF NOT EXISTS guest_invites (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      room_id TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      expires_at TIMESTAMPTZ,
      can_present BOOLEAN NOT NULL DEFAULT FALSE,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS recordings (
      id SERIAL PRIMARY KEY,
      room_id TEXT NOT NULL,
      title TEXT NOT NULL,
      started_by INTEGER REFERENCES users(id),
      attendee_emails TEXT[] NOT NULL DEFAULT '{}',
      meet_url TEXT,
      event_id TEXT,
      conference_id TEXT,
      auto_record TEXT,
      fathom_url TEXT,
      summary_md TEXT,
      drive_file_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      summarized_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL)`,
    // The screenshot or video still from a #wins post, for the jumbotron (server/wins.ts). Kept two weeks.
    `CREATE TABLE IF NOT EXISTS win_images (
      id SERIAL PRIMARY KEY,
      ts TEXT UNIQUE NOT NULL,
      mime TEXT NOT NULL,
      bytes BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // Report a bug or an idea (server/feedback.ts).
    `CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      context JSONB NOT NULL DEFAULT '{}',
      user_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'new',
      fix_branch TEXT,
      fix_pr_url TEXT,
      agent_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // Close any stretches left open by a crash or redeploy: nobody is connected at boot.
    `UPDATE status_events SET ended_at = COALESCE((SELECT last_seen FROM users u WHERE u.id = user_id), now())
       WHERE ended_at IS NULL`,
  ];
  for (const s of statements) await db.query(s);
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const r = await one<{ value: T }>(`SELECT value FROM settings WHERE key = $1`, [key]);
  return r ? r.value : fallback;
}

export async function setSetting(key: string, value: unknown) {
  await q(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [key, JSON.stringify(value)]);
}
