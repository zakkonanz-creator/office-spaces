// Taylor's feedback (2026-10-14): leave that accrues monthly, project time on a
// stopwatch, timesheets for a month or any dates — on a throwaway embedded database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "es-feedback-"));
process.env.SESSION_SECRET ??= "x".repeat(40);
process.env.PAYROLL_ADMIN_EMAILS = "boss@example.com";
delete process.env.DATABASE_URL;

const { openDb, one, q } = await import("../db");
const Fastify = (await import("fastify")).default;
const { migratePayroll } = await import("../payroll/schema");
const { migrateTime } = await import("./db");
const { accrueLeave, bringForward, monthlyRelease, releasesFor, takenBetween, unpaidReleases } = await import("./accrual");
const { registerTimeRoutes } = await import("./routes");
const { approversFor } = await import("../payroll/grants");

await openDb();
await migratePayroll();
await migrateTime();

const boss = (await one<{ id: number }>(`INSERT INTO users (email, name, role) VALUES ('boss@example.com', 'Boss Person', 'member') RETURNING id`))!.id;
const agent = (await one<{ id: number }>(`INSERT INTO users (email, name, role, tz) VALUES ('agent@example.org', 'Agent One', 'member', 'Asia/Manila') RETURNING id`))!.id;

const app = Fastify();
app.decorateRequest("viewer", null);
app.addHook("onRequest", async (req) => {
  const id = Number(req.headers["x-as"]);
  const user = id ? await one(`SELECT * FROM users WHERE id = $1`, [id]) : null;
  (req as any).viewer = user ? { kind: "user", user } : null;
});
registerTimeRoutes(app, (req, reply) => {
  const v = (req as any).viewer;
  if (!v) { reply.code(401).send({ error: "sign in" }); return null; }
  return v.user;
});
const call = async (as: number, method: string, url: string, body?: unknown) => {
  const r = await app.inject({ method: method as any, url, headers: { "x-as": String(as), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.statusCode, json: () => r.json(), text: r.body };
};

test("releases follow Deputy: monthly on the hire-date day, the holiday year on Jan 1", () => {
  const dates = (r: { date: string }[]) => r.map((x) => x.date);
  // Standard PTO, hired Apr 21: Deputy's export on Oct 13 already had Sep 21's release.
  assert.deepEqual(releasesFor("monthly", 12, "2025-04-21", "2026-10-13", "2026-10-20"), []);
  assert.deepEqual(releasesFor("monthly", 12, "2025-04-21", "2026-10-13", "2026-11-30"), [
    { date: "2026-10-21", days: 1, reset: false }, { date: "2026-11-21", days: 1, reset: false }]);
  assert.deepEqual(dates(releasesFor("monthly", 12, "2024-01-31", "2027-01-31", "2027-03-31")), ["2027-02-28", "2027-03-31"], "the 31st falls back to the month's last day");
  assert.deepEqual(dates(releasesFor("monthly", 12, "2026-11-03", "2026-10-13", "2026-12-05")), ["2026-11-03", "2026-12-03"], "a new hire's first release is their first day");
  assert.equal(releasesFor("monthly", 10, null, "2026-09-30", "2026-10-01")[0].days, 0.83);
  // National Holiday PTO: the year on Jan 1, resetting the balance; a joiner gets the rest of their first year.
  assert.deepEqual(releasesFor("yearly", 5, "2024-02-13", "2026-10-13", "2027-01-01"), [{ date: "2027-01-01", days: 5, reset: true }]);
  assert.deepEqual(releasesFor("yearly", 5, "2026-07-01", "2026-06-01", "2026-12-31"), [{ date: "2026-07-01", days: 2.52, reset: false }], "184 of 365 days");
  assert.deepEqual(releasesFor("yearly", 5, "2024-02-13", "2026-10-13", "2026-12-31"), []);
});

test("accrual starts after the Deputy snapshot, posts each release once, and a late snapshot keeps them", async () => {
  await q(`INSERT INTO locations (name) VALUES ('WL') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO time_members (user_id, team, start_date) VALUES ($1, 'WL', '2025-04-21') ON CONFLICT (user_id) DO UPDATE SET start_date = '2025-04-21'`, [agent]);
  const exportedAt = "2026-10-14T03:12:22Z"; // Oct 13, 8:12pm in Deputy's timezone
  await q(`INSERT INTO deputy_import (email, deputy_id, name, payload, exported_at, user_id) VALUES ('agent@example.org', 177, 'Agent One', '{}', $1, $2)`, [exportedAt, agent]);
  await q(`INSERT INTO leave_entitlements (user_id, code, days_per_year) VALUES ($1, 'vacation', 12), ($1, 'holiday', 5)`, [agent]);
  await q(`INSERT INTO leave_balances (user_id, code, days) VALUES ($1, 'vacation', 3), ($1, 'holiday', -1)`, [agent]);
  const bal = async (code: string) => (await one<{ days: number }>(`SELECT days::float AS days FROM leave_balances WHERE user_id = $1 AND code = $2`, [agent, code]))!.days;
  assert.equal(await accrueLeave("2026-10-20"), 0, "nothing due between the export and their day");
  assert.equal(await accrueLeave("2026-10-21"), 1);
  assert.equal(await accrueLeave("2026-10-21"), 0, "a second run doesn't pay it twice");
  assert.equal(await bal("vacation"), 4);
  // A server that was down catches up: Nov 21, Dec 21, and the holiday year (overdraw wiped).
  assert.equal(await accrueLeave("2027-01-02"), 3);
  assert.equal(await bal("vacation"), 6);
  assert.equal(await bal("holiday"), 5);
  // Applying the Oct 13 snapshot now brings it forward instead of wiping the releases.
  assert.equal(await bringForward(agent, "vacation", 3, exportedAt), 6);
  assert.equal(await bringForward(agent, "holiday", -1, exportedAt), 5);
  const me = (await call(agent, "GET", "/api/time/me")).json();
  const b = (code: string) => me.leaveBalances.find((x: { code: string }) => x.code === code);
  assert.equal(b("vacation").per_month, 1);
  assert.equal(b("holiday").per_year, 5);
  assert.equal(b("holiday").per_month, null);
});

test("a corrected hire date never pays a month (or a holiday year) twice", async () => {
  const rel = (date: string, reset = false) => ({ date, days: 1, reset });
  // Oct was paid on the 21st; the hire day is now the 25th: Oct is skipped, Nov is paid once.
  assert.deepEqual(unpaidReleases("monthly", [rel("2026-10-25"), rel("2026-11-25")], ["2026-10-21"]), [rel("2026-11-25")]);
  // The joiner's prorated year was paid; a new start date in the same year doesn't pay it again.
  assert.deepEqual(unpaidReleases("yearly", [rel("2026-07-15")], ["2026-07-01"]), []);
  assert.deepEqual(unpaidReleases("yearly", [rel("2027-01-01", true)], ["2026-07-01"]), [rel("2027-01-01", true)]);
  // In the ledger: move the agent's hire day from the 21st to the 2nd. Nov 2 and Dec 2 were
  // already paid (on the 21st); only January's release is new.
  await q(`UPDATE time_members SET start_date = '2025-04-02' WHERE user_id = $1`, [agent]);
  const before = (await one<{ days: number }>(`SELECT days::float AS days FROM leave_balances WHERE user_id = $1 AND code = 'vacation'`, [agent]))!.days;
  assert.equal(await accrueLeave("2027-01-03"), 1);
  assert.equal((await one<{ days: number }>(`SELECT days::float AS days FROM leave_balances WHERE user_id = $1 AND code = 'vacation'`, [agent]))!.days, before + 1);
  await q(`UPDATE time_members SET start_date = '2025-04-21' WHERE user_id = $1`, [agent]);
});

test("project time: only while clocked in, one at a time, and clocking out stops it", async () => {
  let r = await call(agent, "POST", "/api/time/projects/start", { client: "Certainty Engine", project: "Website" });
  assert.equal(r.status, 409, "not clocked in");
  assert.equal((await call(agent, "POST", "/api/time/clock", { kind: "in" })).status, 200);
  r = await call(agent, "POST", "/api/time/projects/start", { client: "  Certainty   Engine ", project: "Website" });
  assert.equal(r.status, 200);
  assert.equal((await call(agent, "POST", "/api/time/projects/start", { client: "" })).status, 400);
  // Starting another stops the first.
  assert.equal((await call(agent, "POST", "/api/time/projects/start", { client: "Acme Dental" })).status, 200);
  let me = (await call(agent, "GET", "/api/time/projects/me")).json();
  assert.equal(me.running.client, "Acme Dental");
  assert.equal(me.today.length, 2);
  assert.ok(me.clients.includes("Certainty Engine"), "client names are tidied");
  // A break stops it too.
  await call(agent, "POST", "/api/time/clock", { kind: "break_start" });
  me = (await call(agent, "GET", "/api/time/projects/me")).json();
  assert.equal(me.running, null);
  await call(agent, "POST", "/api/time/clock", { kind: "break_end" });
  await call(agent, "POST", "/api/time/projects/start", { client: "Acme Dental" });
  await call(agent, "POST", "/api/time/clock", { kind: "out" });
  me = (await call(agent, "GET", "/api/time/projects/me")).json();
  assert.equal(me.running, null, "clocking out stopped it");
  // Someone else can't touch it.
  const id = me.today[0].id;
  assert.equal((await call(boss, "DELETE", `/api/time/projects/${id}`)).status, 404);
});

test("managers get project time by client and person, and as CSV", async () => {
  await q(`UPDATE project_time SET started_at = now() - interval '2 hours', ended_at = now() - interval '1 hour' WHERE client = 'Certainty Engine'`);
  // The agent is in Manila: their today can be UTC's tomorrow.
  const today = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  const from = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
  assert.equal((await call(agent, "GET", `/api/time/projects/report?from=${from}&to=${today}`)).status, 403, "agents aren't managers");
  const r = (await call(boss, "GET", `/api/time/projects/report?from=${from}&to=${today}`)).json();
  const ce = r.projects.find((p: { client: string }) => p.client === "Certainty Engine");
  assert.equal(ce.minutes, 60);
  assert.deepEqual(ce.people, ["Agent One"]);
  const csv = (await call(boss, "GET", `/api/time/projects/export?from=${from}&to=${today}`)).text;
  assert.match(csv, /Certainty Engine,Website,,60,1.00/);
});

test("timesheets for any dates: worked, expected and approved weeks per person", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 20 * 86400_000).toISOString().slice(0, 10);
  const r = await call(boss, "GET", `/api/time/team/range?from=${from}&to=${today}`);
  assert.equal(r.status, 200);
  const row = r.json().people.find((p: { name: string }) => p.name === "Agent One");
  assert.ok(row, "the agent is listed");
  assert.ok(row.weeks >= 3);
  assert.equal((await call(boss, "GET", `/api/time/team/range?from=2026-01-01&to=2026-06-01`)).status, 400, "ranges are capped");
});

test("a leave request goes to the team's managers, or to the payroll admins when there are none", async () => {
  // The agent is on WL, which has no manager yet: the payroll admin (boss, by email) hears.
  assert.deepEqual(await approversFor(agent), [boss]);
  const lead = (await one<{ id: number }>(`INSERT INTO users (email, name, role) VALUES ('lead@example.org', 'Team Lead', 'member') RETURNING id`))!.id;
  await q(`INSERT INTO grants (user_id, grant_kind, team) VALUES ($1, 'manager', 'WL')`, [lead]);
  assert.deepEqual(await approversFor(agent), [lead]);
  assert.deepEqual(await approversFor(lead), [boss], "a manager's own request doesn't go to themselves");
  await q(`DELETE FROM grants WHERE user_id = $1`, [lead]);
});

test("shift swaps from the member side: ask, decline, ask again, cancel; only your own", async () => {
  const mate = (await one<{ id: number }>(`INSERT INTO users (email, name, role) VALUES ('mate@example.org', 'Sam Mate', 'member') RETURNING id`))!.id;
  const gone = (await one<{ id: number }>(`INSERT INTO users (email, name, role, removed) VALUES ('gone@example.org', 'Gone Person', 'member', TRUE) RETURNING id`))!.id;
  await q(`INSERT INTO time_members (user_id, team) VALUES ($1, 'WL'), ($2, 'WL')`, [mate, gone]);
  const date = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  const shift = (await one<{ id: number }>(`INSERT INTO shifts (user_id, team, date, start_local, end_local, timezone, published_at) VALUES ($1, 'WL', $2, '09:00', '17:00', 'Asia/Manila', now()) RETURNING id`, [agent, date]))!.id;
  // Teammates: same team, not removed, not me.
  assert.deepEqual((await call(agent, "GET", "/api/time/teammates")).json().map((m: { name: string }) => m.name), ["Sam Mate"]);
  let r = await call(agent, "POST", "/api/time/swaps", { shift_id: shift, to_user: mate, note: "dentist" });
  assert.equal(r.status, 200);
  const first = r.json().id;
  let mine = (await call(mate, "GET", "/api/time/swaps/mine")).json();
  assert.equal(mine.incoming.length, 1);
  assert.equal(mine.incoming[0].from_name, "Agent One");
  assert.equal(mine.incoming[0].start_local, "09:00");
  assert.equal((await call(agent, "POST", `/api/time/swaps/${first}/decline`)).status, 404, "only the person asked can decline");
  assert.equal((await call(mate, "POST", `/api/time/swaps/${first}/decline`)).status, 200);
  assert.equal((await call(mate, "POST", `/api/time/swaps/${first}/accept`)).status, 404, "a declined swap can't be accepted");
  mine = (await call(agent, "GET", "/api/time/swaps/mine")).json();
  assert.equal(mine.outgoing[0].status, "declined");
  assert.equal(mine.outgoing[0].to_name, "Sam Mate");
  // Declined frees the shift for a new ask; the asker can cancel it after it's accepted.
  r = await call(agent, "POST", "/api/time/swaps", { shift_id: shift, to_user: mate });
  assert.equal(r.status, 200);
  const second = r.json().id;
  assert.equal((await call(mate, "POST", `/api/time/swaps/${second}/accept`)).status, 200);
  assert.equal((await call(mate, "POST", `/api/time/swaps/${second}/cancel`)).status, 404, "only the asker can cancel");
  assert.equal((await call(agent, "POST", `/api/time/swaps/${second}/cancel`)).status, 200);
  assert.equal((await call(agent, "POST", `/api/time/swaps/${second}/cancel`)).status, 404, "already cancelled");
  assert.equal((await call(boss, "POST", `/api/time/swaps/${second}/decide`, { approve: true })).status, 404, "a cancelled swap never reaches approval");
  assert.equal((await one<{ user_id: number }>(`SELECT user_id FROM shifts WHERE id = $1`, [shift]))!.user_id, agent, "the shift is still theirs");
  assert.equal((await call(mate, "GET", "/api/time/swaps/mine")).json().incoming.length, 0);
});

test("two leave approvals at once can't overdraw a balance (regression: both passed the check)", async () => {
  const two = (await one<{ id: number }>(`INSERT INTO users (email, name, role, tz) VALUES ('two@example.org', 'Two Requests', 'member', 'UTC') RETURNING id`))!.id;
  await q(`INSERT INTO leave_balances (user_id, code, days) VALUES ($1, 'vacation', 3)`, [two]);
  const ask = async (start: string, end: string) =>
    (await one<{ id: number }>(`INSERT INTO leave_requests (user_id, code, start_date, end_date, days) VALUES ($1, 'vacation', $2, $3, 2) RETURNING id`, [two, start, end]))!.id;
  const ids = [await ask("2027-03-01", "2027-03-02"), await ask("2027-03-08", "2027-03-09"), await ask("2027-03-15", "2027-03-16"), await ask("2027-03-22", "2027-03-23")];
  await q(`UPDATE leave_balances SET days = 5 WHERE user_id = $1 AND code = 'vacation'`, [two]);
  const results = await Promise.all(ids.map((id) => call(boss, "POST", `/api/time/leave/${id}/decide`, { approve: true })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 409, 409], results.map((r) => r.text).join(" | "));
  assert.match(results.find((r) => r.status === 409)!.json().error, /1 vacation day\(s\) left and asked for 2/);
  const balance = async () => Number((await one<{ days: string }>(`SELECT days FROM leave_balances WHERE user_id = $1 AND code = 'vacation'`, [two]))!.days);
  assert.equal(await balance(), 1);
  // The same request decided twice at once: one wins, and the balance is charged once.
  const c = await ask("2027-04-05", "2027-04-06");
  await q(`UPDATE leave_balances SET days = 5 WHERE user_id = $1 AND code = 'vacation'`, [two]);
  const same = await Promise.all([1, 2].map(() => call(boss, "POST", `/api/time/leave/${c}/decide`, { approve: true })));
  assert.equal(same.filter((r) => r.status === 200).length, 1, same.map((r) => r.text).join(" | "));
  assert.equal(await balance(), 3);
});

test("the Jan 1 holiday reset keeps January leave approved in December taken (regression: it gave the days back)", async () => {
  // Mon–Fri. Dec 31 (Thu) → Jan 1 (Fri) has one day in the new year; Jan 4–5 has two.
  const asked = [{ start_date: "2026-12-31", end_date: "2027-01-01", days: 2 }, { start_date: "2027-01-04", end_date: "2027-01-05", days: 2 }, { start_date: "2026-12-01", end_date: "2026-12-02", days: 2 }];
  assert.equal(takenBetween("2027-01-01", "2027-12-31", asked), 3);
  assert.equal(takenBetween("2027-01-01", "2027-12-31", [{ start_date: "2027-01-01", end_date: "2027-01-01", days: 0.5 }]), 0.5, "a half day");
  assert.equal(takenBetween("2027-01-01", "2027-12-31", [{ start_date: "2028-01-03", end_date: "2028-01-03", days: 1 }]), 0, "next year's leave is next year's");

  const hol = (await one<{ id: number }>(`INSERT INTO users (email, name, role, tz) VALUES ('hol@example.org', 'Holiday Planner', 'member', 'UTC') RETURNING id`))!.id;
  await q(`INSERT INTO deputy_import (email, deputy_id, name, payload, exported_at, user_id) VALUES ('hol@example.org', 901, 'Holiday Planner', '{}', '2026-12-01T12:00:00Z', $1)`, [hol]);
  await q(`INSERT INTO leave_entitlements (user_id, code, days_per_year) VALUES ($1, 'holiday', 5)`, [hol]);
  await q(`INSERT INTO leave_balances (user_id, code, days) VALUES ($1, 'holiday', 5)`, [hol]);
  const bal = async () => (await one<{ days: number }>(`SELECT days::float AS days FROM leave_balances WHERE user_id = $1 AND code = 'holiday'`, [hol]))!.days;
  for (const [start, end] of [["2026-12-31", "2027-01-01"], ["2027-01-04", "2027-01-05"]]) {
    const id = (await one<{ id: number }>(`INSERT INTO leave_requests (user_id, code, start_date, end_date, days) VALUES ($1, 'holiday', $2, $3, 2) RETURNING id`, [hol, start, end]))!.id;
    const r = await call(boss, "POST", `/api/time/leave/${id}/decide`, { approve: true });
    assert.equal(r.status, 200, r.text);
  }
  assert.equal(await bal(), 1, "December's balance paid for all four days");
  assert.ok((await accrueLeave("2027-01-01")) >= 1);
  assert.equal(await bal(), 2, "the year's 5, less the 3 January days already approved");
  assert.equal(await bringForward(hol, "holiday", 5, "2026-12-01T12:00:00Z"), 2, "a late snapshot lands on the same number");
});

test("unpaid leave in a month whose pay is closed is refused; approving one asked for earlier warns (regression)", async () => {
  const late = (await one<{ id: number }>(`INSERT INTO users (email, name, role, tz) VALUES ('late@example.org', 'Late Asker', 'member', 'UTC') RETURNING id`))!.id;
  await q(`INSERT INTO pay_runs (period, status, closed_at) VALUES ('2026-08', 'closed', now())`);
  const ask = (start: string, end: string, code = "unpaid") => call(late, "POST", "/api/time/leave", { code, start_date: start, end_date: end });
  const r = await ask("2026-08-10", "2026-08-10");
  assert.equal(r.status, 409, r.text);
  assert.match(r.json().error, /August 2026 pay is already closed/);
  assert.equal((await ask("2026-08-31", "2026-09-01")).status, 409, "a request reaching into the closed month");
  assert.equal((await ask("2026-08-10", "2026-08-10", "sick")).status, 200, "paid leave doesn't change pay: still fine");
  assert.equal((await ask("2026-09-08", "2026-09-08")).status, 200, "an open month is fine");
  // Asked before the close (the close was forced past it), approved after: on record, with a warning.
  const id = (await one<{ id: number }>(`INSERT INTO leave_requests (user_id, code, start_date, end_date, days) VALUES ($1, 'unpaid', '2026-08-20', '2026-08-20', 1) RETURNING id`, [late]))!.id;
  const ok = await call(boss, "POST", `/api/time/leave/${id}/decide`, { approve: true });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.json().warning, /August 2026 pay is already closed, so this unpaid leave won't come off it/);
});

test("monthly accrual adds up to the year exactly (regression: 10 a year accrued 9.96)", () => {
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  for (const perYear of [10, 12, 15, 7.5, 1, 20, 0.5]) {
    const year = Array.from({ length: 12 }, (_, i) => monthlyRelease(perYear, i + 1));
    assert.equal(sum(year), perYear, `${perYear}: ${year.join(", ")}`);
    assert.ok(year.every((d) => Math.abs(d - perYear / 12) <= 0.01), "each month within a hundredth of a twelfth");
  }
  // Any twelve releases in a row, from any hire month, are the year.
  const r = releasesFor("monthly", 10, "2025-04-21", "2026-04-21", "2027-04-21");
  assert.equal(r.length, 12);
  assert.equal(sum(r.map((x) => x.days)), 10);
  assert.equal(releasesFor("monthly", 12, "2025-04-21", "2026-10-13", "2026-10-21")[0].days, 1);
});

test("two overlapping requests approved at once: one wins, the balance is charged once (regression: both passed the overlap check)", async () => {
  const ov = (await one<{ id: number }>(`INSERT INTO users (email, name, role, tz) VALUES ('overlap@example.org', 'Over Lap', 'member', 'UTC') RETURNING id`))!.id;
  await q(`INSERT INTO leave_balances (user_id, code, days) VALUES ($1, 'vacation', 10)`, [ov]);
  const ask = async (code: string, start: string, end: string, days: number) =>
    (await one<{ id: number }>(`INSERT INTO leave_requests (user_id, code, start_date, end_date, days) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [ov, code, start, end, days]))!.id;
  // The same week asked for twice (two tabs), both approved by two managers at the same moment.
  const a = await ask("vacation", "2027-06-07", "2027-06-11", 5), b = await ask("vacation", "2027-06-09", "2027-06-10", 2);
  const res = await Promise.all([a, b].map((id) => call(boss, "POST", `/api/time/leave/${id}/decide`, { approve: true })));
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 409], res.map((r) => r.text).join(" | "));
  assert.match(res.find((r) => r.status === 409)!.json().error, /already have approved leave on some of those days/);
  const approved = await q(`SELECT id FROM leave_requests WHERE user_id = $1 AND status = 'approved'`, [ov]);
  assert.equal(approved.length, 1);
  const won = approved[0].id === a ? 5 : 2;
  assert.equal((await one<{ days: number }>(`SELECT days::float AS days FROM leave_balances WHERE user_id = $1 AND code = 'vacation'`, [ov]))!.days, 10 - won, "only the winner's days came off");
  // Unpaid (no balance) the same: one approved, never both.
  const c = await ask("unpaid", "2027-07-05", "2027-07-06", 2), d = await ask("unpaid", "2027-07-06", "2027-07-07", 2);
  const res2 = await Promise.all([c, d].map((id) => call(boss, "POST", `/api/time/leave/${id}/decide`, { approve: true })));
  assert.deepEqual(res2.map((r) => r.status).sort(), [200, 409], res2.map((r) => r.text).join(" | "));
});
