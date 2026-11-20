// Nightly export of the whole database to Google Drive, on top of Railway's own volume
// backups (daily/weekly/monthly, set 2026-10-08). If Railway — or the account — ever goes,
// pay history, timesheets and analytics are still in the team's Drive.
//
// Each night at ~03:00 UTC: every table → one gzipped JSON file, uploaded to
// DRIVE_BACKUP_FOLDER_ID as "proximity-office-YYYY-MM-DD.json.gz". The last 30 are kept.
// It writes with the Drive account a payroll admin linked (Admin → Settings → Link Drive; payroll admins only).
// Restoring: each table is a list of rows; load them back with INSERTs (scripts/restore-backup.ts).

import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
import { config } from "./config";
import { q, getSetting, setSetting } from "./db";
import { googleAccessToken, unseal } from "./auth";

const KEEP = 30;

async function backupToken(): Promise<string | null> {
  const sealed = await getSetting<string | null>("driveRefreshToken", null);
  if (!sealed || !config.drive.backupFolderId) return null;
  return googleAccessToken("drive", unseal(sealed));
}

/** Room conversations stay out of the backup: whoever can open it (payroll admins) would otherwise
 *  read every room's transcript, and the notes already live in attendees' Slack DMs. Clips (raw
 *  audio, deleted once transcribed) are skipped; transcripts keep who/when, not what was said. */
const SKIP = new Set(["transcript_chunks"]);
const REDACT: Record<string, string[]> = { transcripts: ["transcript_md", "summary_md"] };

/** Every table, every row, as one JSON document (minus room conversations, above). */
export async function dumpDatabase() {
  const tables = (await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  )).map((r) => r.table_name).filter((t) => !SKIP.has(t));
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    const rows = await q(`SELECT * FROM "${t.replace(/"/g, "")}"`);
    out[t] = REDACT[t] ? rows.map((r) => ({ ...r, ...Object.fromEntries(REDACT[t].map((c) => [c, null])) })) : rows;
  }
  return { exportedAt: new Date().toISOString(), tables: out };
}

let running = false;
/** One at a time: a double-clicked "Back up now" (or the nightly run meeting a manual one) uploads once. */
export async function runBackup(): Promise<{ ok: boolean; file?: string; rows?: number; error?: string }> {
  if (running) return { ok: false, error: "a backup is already running" };
  running = true;
  try {
    return await backupOnce();
  } finally {
    running = false;
  }
}

async function backupOnce(): Promise<{ ok: boolean; file?: string; rows?: number; error?: string }> {
  const token = await backupToken();
  if (!token) return { ok: false, error: !config.drive.backupFolderId ? "DRIVE_BACKUP_FOLDER_ID isn't set" : "Drive isn't linked (a payroll admin links it in Admin → Settings)" };
  const dump = await dumpDatabase();
  const rows = Object.values(dump.tables).reduce((n, t) => n + t.length, 0);
  // Compressed off the event loop: a big gzip must not freeze everyone's office.
  const body = await gzipAsync(Buffer.from(JSON.stringify(dump)));
  const name = `proximity-office-${dump.exportedAt.slice(0, 10)}.json.gz`;
  const h = { authorization: `Bearer ${token}` };
  const boundary = "es" + Math.random().toString(16).slice(2);
  const meta = Buffer.from(`--${boundary}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ name, parents: [config.drive.backupFolderId] })}\r\n--${boundary}\r\ncontent-type: application/gzip\r\n\r\n`);
  const up = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id", {
    method: "POST",
    headers: { ...h, "content-type": `multipart/related; boundary=${boundary}` },
    body: Buffer.concat([meta, body, Buffer.from(`\r\n--${boundary}--`)]),
  });
  if (!up.ok) return { ok: false, error: `upload ${up.status}: ${(await up.text()).slice(0, 160)}` };
  // Keep the newest KEEP exports.
  const list = await fetch(
    `https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=createdTime desc&pageSize=200&fields=files(id,name)&q=${encodeURIComponent(`'${config.drive.backupFolderId}' in parents and name contains 'proximity-office-' and trashed = false`)}`,
    { headers: h },
  );
  if (list.ok) {
    const files = ((await list.json()) as { files: { id: string }[] }).files;
    for (const f of files.slice(KEEP)) await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?supportsAllDrives=true`, { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ trashed: true }) });
  }
  await setSetting("lastBackup", { at: dump.exportedAt, file: name, rows, bytes: body.length });
  return { ok: true, file: name, rows };
}

/** Checks every 10 minutes; runs once per UTC day after 03:00. Never throws. */
export function scheduleBackups(log: (msg: string) => void) {
  setInterval(async () => {
    try {
      const now = new Date();
      if (now.getUTCHours() < 3) return;
      const last = await getSetting<{ at: string } | null>("lastBackup", null);
      const lastTry = await getSetting<string | null>("lastBackupTry", null);
      const today = now.toISOString().slice(0, 10);
      if (last?.at.slice(0, 10) === today || lastTry === today) return;
      await setSetting("lastBackupTry", today);
      const r = await runBackup();
      log(r.ok ? `nightly backup: ${r.file} (${r.rows} rows)` : `nightly backup skipped: ${r.error}`);
    } catch (e) {
      log(`nightly backup failed: ${(e as Error).message}`);
    }
  }, 10 * 60_000);
}
