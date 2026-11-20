// Restore a nightly Drive export (office-spaces-YYYY-MM-DD.json.gz) into a database.
//   DATABASE_URL=postgres://… npx tsx scripts/restore-backup.ts path/to/office-spaces-2026-10-09.json.gz [--dry-run]
// Run the app once against the target first so its tables exist. Rows are inserted with
// ON CONFLICT DO NOTHING, so a restore into a partly filled database only adds what's missing.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { openDb, q } from "../server/db";

const file = process.argv[2];
const dry = process.argv.includes("--dry-run");
if (!file) throw new Error("usage: restore-backup.ts <file.json.gz> [--dry-run]");
const dump = JSON.parse(gunzipSync(readFileSync(file)).toString()) as { exportedAt: string; tables: Record<string, Record<string, unknown>[]> };
console.log(`export from ${dump.exportedAt}: ${Object.entries(dump.tables).map(([t, r]) => `${t} ${r.length}`).join(", ")}`);
if (dry) process.exit(0);
await openDb();
// Parents before children: a table loads only after every table its foreign keys point at.
const fks = await q<{ child: string; parent: string }>(
  `SELECT tc.table_name AS child, ccu.table_name AS parent
     FROM information_schema.table_constraints tc
     JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`,
);
const order: string[] = [];
const pending = new Set(Object.keys(dump.tables));
while (pending.size) {
  const ready = [...pending].filter((t) => !fks.some((f) => f.child === t && f.parent !== t && pending.has(f.parent)));
  const next = ready.length ? ready : [...pending]; // a cycle: load the rest as-is
  for (const t of next) { order.push(t); pending.delete(t); }
}
for (const table of order) {
  const rows = dump.tables[table];
  // JSON columns get JSON text; native array columns (text[], int[]) take the array as-is.
  const types = new Map((await q<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table],
  )).map((c) => [c.column_name, c.data_type]));
  if (!types.size) { console.warn(`${table}: not in this database — skipped`); continue; }
  let n = 0;
  for (const row of rows) {
    const cols = Object.keys(row).filter((c) => types.has(c));
    const vals = cols.map((c) => (row[c] !== null && /json/.test(types.get(c)!) ? JSON.stringify(row[c]) : row[c]));
    await q(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT DO NOTHING`, vals);
    n++;
  }
  console.log(`${table}: ${n} rows`);
}
// Move every id counter past the restored rows, so new rows don't collide with old ids.
const seqs = await q<{ tbl: string; col: string; seq: string }>(
  `SELECT c.table_name AS tbl, c.column_name AS col, pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) AS seq
     FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.column_default LIKE 'nextval%'`,
);
for (const s of seqs) if (s.seq) await q(`SELECT setval('${s.seq}', GREATEST((SELECT COALESCE(MAX("${s.col}"), 0) FROM "${s.tbl}"), 1))`);
console.log(`restored; ${seqs.length} id counters moved past the restored rows`);
process.exit(0);
