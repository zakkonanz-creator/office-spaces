import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SESSION_SECRET ??= "x".repeat(40);
process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "es-points-"));
delete process.env.DATABASE_URL;

const { openDb, one, q } = await import("./db");
const { award, breakdown, countToday, leaderboard, eggsFound, eggFoundByAnyone } = await import("./points");
const { plain, awardText } = await import("./wins");
await openDb();

test("points: tenure + office time (capped, Away doesn't count) + awards, once per ref", async () => {
  const u = (await one<{ id: number }>(`INSERT INTO users (email, name, started_on) VALUES ('p@example.com', 'Pat Points', (now() AT TIME ZONE 'UTC')::date - 10) RETURNING id`))!.id;
  // 3 hours available, 2 hours away, and a 12-hour day that counts as 8.
  await q(`INSERT INTO status_events (user_id, status, started_at, ended_at) VALUES ($1, 'available', now() - interval '3 days', now() - interval '3 days' + interval '3 hours')`, [u]);
  await q(`INSERT INTO status_events (user_id, status, started_at, ended_at) VALUES ($1, 'away', now() - interval '2 days', now() - interval '2 days' + interval '2 hours')`, [u]);
  await q(`INSERT INTO status_events (user_id, status, started_at, ended_at) VALUES ($1, 'focusing', date_trunc('day', now() - interval '5 days'), date_trunc('day', now() - interval '5 days') + interval '12 hours')`, [u]);
  assert.equal(await award(u, "egg", 200, "Found The Golden Mug (first!)", "golden-mug"), true);
  assert.equal(await award(u, "egg", 200, "again", "golden-mug"), false, "an egg counts once");
  assert.equal(await award(u, "highfive", 5, "High-five", null), true);
  assert.equal(await award(u, "highfive", 5, "High-five", null), true, "no ref: repeats are fine");
  assert.equal(await countToday(u, "highfive"), 2);
  const b = await breakdown(u, (await one<{ d: string }>(`SELECT to_char(started_on, 'YYYY-MM-DD') AS d FROM users WHERE id = $1`, [u]))!.d);
  const part = (k: string) => b.parts.find((p) => p.kind === k)?.points ?? 0;
  assert.equal(part("tenure"), 10);
  assert.equal(part("online"), (3 + 8) * 2);
  assert.equal(part("egg"), 200);
  assert.equal(part("highfive"), 10);
  assert.equal(b.total, 10 + 22 + 200 + 10);
  assert.deepEqual(await eggsFound(u), ["golden-mug"]);
  assert.equal(await eggFoundByAnyone("golden-mug"), true);
  assert.equal(await eggFoundByAnyone("lost-sock"), false);
  const lb = await leaderboard(5);
  assert.equal(lb.top[0].points, b.total);
  assert.equal(lb.highfives[0].n, 2);
});

test("#wins text comes through plain and short", () => {
  assert.equal(plain("*Closed* <@U123|morgan> on <https://x.com|the Smith deal> :tada:"), "Closed @morgan on the Smith deal");
  assert.equal(plain("x".repeat(300)).length, 140);
});

test("an admin's award reads well in #wins, mentions them, and can't smuggle in a mention", () => {
  assert.equal(
    awardText({ toName: "Morgan Lee", toSlackId: "U123", byName: "Alex Admin | Acme", points: 1500, reason: "Saved the Smith account" }),
    ":star: <@U123> got *+1,500 points* from Alex: Saved the Smith account",
  );
  assert.equal(
    awardText({ toName: "Jo <b>", toSlackId: null, byName: "Alex", points: 50, reason: "<!channel> & <@U999>" }),
    ":star: *Jo &lt;b&gt;* got *+50 points* from Alex: &lt;!channel&gt; &amp; &lt;@U999&gt;",
  );
});
