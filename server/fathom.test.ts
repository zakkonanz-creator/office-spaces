import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SESSION_SECRET ??= "x".repeat(40);
process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "es-fathom-"));
delete process.env.DATABASE_URL;

const { openDb, one, q } = await import("./db");
const { handleFathom } = await import("./fathom");
await openDb();

test("a Fathom summary finds its room meeting and is stored once", async () => {
  await q(`INSERT INTO recordings (room_id, title, attendee_emails, meet_url) VALUES ('sales', 'Office Spaces · Sales · 14:00 UTC', '{a@example.com}', 'https://meet.google.com/abc-defg-hij')`);
  const payload = {
    meeting_title: "Office Spaces · Sales · 14:00 UTC",
    share_url: "https://fathom.video/share/xyz",
    default_summary: { markdown_formatted: "## Decisions\n- Ship the **launch** offer Friday" },
    action_items: [{ description: "Draft the email", assignee: { name: "Alex" } }],
  };
  assert.equal(await handleFathom(payload), "ok");
  const r = await one(`SELECT * FROM recordings WHERE room_id = 'sales'`);
  assert.equal(r!.fathom_url, "https://fathom.video/share/xyz");
  assert.match(r!.summary_md, /Ship the \*\*launch\*\* offer/);
  assert.match(r!.summary_md, /- Draft the email \(Alex\)/);
  assert.equal(r!.drive_file_url, null, "no Drive link configured, so nothing filed — and no crash");
  assert.equal(await handleFathom(payload), "duplicate", "a retried webhook doesn't double-post");
});

test("meetings that weren't started from a room are ignored", async () => {
  assert.equal(await handleFathom({ meeting_title: "Weekly L10" }), "ignored: not a room meeting");
  assert.equal(await handleFathom({ meeting_title: "Office Spaces · Kitchen · 09:00 UTC" }), "ignored: no matching room meeting");
  assert.equal(await handleFathom({ meeting: { meeting_title: "Weekly L10" } }), "ignored: not a room meeting");
});
