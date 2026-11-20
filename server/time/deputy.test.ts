// Deputy import on a throwaway embedded database: the timezone turn of a regular
// week, preview without writes, commit for someone already in Space, and the
// wait-then-apply for someone who hasn't signed in or whose timezone isn't known.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "es-deputy-"));
process.env.SESSION_SECRET ??= "x".repeat(40);
delete process.env.DATABASE_URL;

const { openDb, one, q } = await import("../db");
const { migratePayroll } = await import("../payroll/schema");
const { migrateTime } = await import("./db");
const { applyPendingDeputy, commitDeputy, leaveCodeFor, leaveDays, previewDeputy, recordDeputyPublications, toRegularHours } = await import("./deputy");
type DeputyExport = import("./deputy").DeputyExport;

await openDb();
await migratePayroll();
await migrateTime();
await (await import("../preassign")).migratePreassign();

const admin = (await one<{ id: number }>(`INSERT INTO users (email, name, role) VALUES ('boss@example.com', 'Boss Person', 'member') RETURNING id`))!.id;
const manila = (await one<{ id: number }>(`INSERT INTO users (email, name, role, tz) VALUES ('ana@example.org', 'Ana Reyes', 'member', 'Asia/Manila') RETURNING id`))!.id;

const day = (d: number, start: string, end: string, extra: Partial<{ breakStart: string; breakEnd: string; breakMinutes: number }> = {}) =>
  ({ day: d, start, end, breakStart: extra.breakStart ?? null, breakEnd: extra.breakEnd ?? null, breakMinutes: extra.breakMinutes ?? 0, area: "Zoom" });

const TODAY = "2026-10-14";
const file: DeputyExport = {
  source: "deputy", version: 1, exportedAt: "2026-10-14T03:00:00Z", timezone: "America/Los_Angeles",
  locations: [{ name: "Support Team", areas: ["Zoom", "Tickets"] }],
  leaveRules: [{ id: 1, name: "Standard PTO", paid: true }, { id: 10, name: "National Holiday PTO", paid: true }, { id: 11, name: "Buy Back PTO", paid: true }],
  people: [
    { deputyId: 1, name: "Ana Reyes", email: "ANA@example.org", location: "Support Team", startDate: "2025-04-21",
      regular: [1, 2, 3, 4, 5].map((d) => day(d, "05:00", "14:00", { breakStart: "11:00", breakEnd: "12:00" })),
      balances: [{ ruleId: 1, hours: 23 }, { ruleId: 10, hours: -72 }, { ruleId: 11, hours: 4 }] },
    { deputyId: 2, name: "Ben Cruz", email: "ben@example.org", location: "Support Team", startDate: "2024-02-13",
      regular: [1, 2, 3, 4, 5].map((d) => day(d, "21:00", "06:00", { breakMinutes: 60 })), balances: [{ ruleId: 1, hours: 64 }] },
    { deputyId: 3, name: "No Email", email: "", location: "Support Team", startDate: null, regular: null, balances: [] },
  ],
  shifts: [
    { id: 900, emp: 1, date: "2026-10-15", start: "05:00", end: "14:00", breakMinutes: 60, area: "Zoom", location: "Support Team", published: true },
    { id: 901, emp: 2, date: "2026-10-15", start: "21:00", end: "06:00", breakMinutes: 60, area: "Tickets", location: "Support Team", published: true },
    { id: 902, emp: null, date: "2026-10-16", start: "09:00", end: "17:00", breakMinutes: 0, area: "Tickets", location: "Support Team", published: false },
    { id: 903, emp: 1, date: "2026-10-01", start: "05:00", end: "14:00", breakMinutes: 0, area: "Zoom", location: "Support Team", published: true },
  ],
  leave: [
    { id: 50, emp: 1, ruleId: 1, start: "2026-10-20", end: "2026-10-21", days: 2, hours: 16, status: "approved" },
    { id: 51, emp: 2, ruleId: 1, start: "2026-11-30", end: "2026-12-04", days: 0, hours: 0, status: "pending" },
    { id: 52, emp: 1, ruleId: null, start: "2026-10-09", end: "2026-10-09", days: 0, hours: 0, status: "approved" },
  ],
};

test("Deputy leave rules map onto Space leave types", () => {
  assert.equal(leaveCodeFor("Standard PTO"), "vacation");
  assert.equal(leaveCodeFor("National Holiday PTO"), "holiday");
  assert.equal(leaveCodeFor("Sick (Deduct From PTO)"), "sick");
  assert.equal(leaveCodeFor("Unpaid Leave - No Show"), "unpaid");
  assert.equal(leaveCodeFor("Buy Back PTO"), null);
});

test("a Pacific regular week turns into the person's own time, across midnight", () => {
  // Mon 05:00–14:00 PDT is Mon 20:00 – Tue 05:00 in Manila (UTC+8, no DST).
  const { hours } = toRegularHours(file.people[0].regular!, "America/Los_Angeles", "Asia/Manila", TODAY);
  assert.equal(hours.length, 5);
  assert.deepEqual(hours[0], { dow: 1, start: "20:00", end: "05:00", break_start: "02:00", break_end: "03:00" });
  // Deputy's "1h meal, any time" stays a length.
  const night = toRegularHours(file.people[1].regular!, "America/Los_Angeles", "America/Los_Angeles", TODAY).hours;
  assert.deepEqual(night[0], { dow: 1, start: "21:00", end: "06:00", break_minutes: 60 });
  // A split day is one stretch with the gap as its break: 17:00–20:00 + 21:00–02:00.
  const split = toRegularHours([day(1, "17:00", "20:00"), day(1, "21:00", "02:00")], "America/Los_Angeles", "America/Los_Angeles", TODAY).hours;
  assert.deepEqual(split, [{ dow: 1, start: "17:00", end: "02:00", break_start: "20:00", break_end: "21:00" }]);
});

test("a pending Deputy request has no days yet: count their working days", () => {
  const p = file.people[1];
  assert.equal(leaveDays({ id: 1, emp: 2, ruleId: 1, start: "2026-11-30", end: "2026-12-06", days: 0, hours: 0, status: "pending" }, p), 5);
  assert.equal(leaveDays({ id: 1, emp: 2, ruleId: 1, start: "2026-11-30", end: "2026-11-30", days: 0, hours: 4, status: "approved" }, p), 0.5);
});

test("preview writes nothing and says who's in Space", async () => {
  const p = await previewDeputy(file, TODAY);
  const [ana, ben, none] = p.rows;
  assert.equal(ana.status, "ready");
  assert.equal(ana.userId, manila);
  assert.equal(ben.status, "waits-for-sign-in");
  assert.equal(none.status, "skipped");
  assert.deepEqual(ana.balances, [{ code: "vacation", days: 2.88 }, { code: "holiday", days: -9 }]);
  assert.deepEqual(p.skippedLeaveTypes, ["Buy Back PTO"]);
  assert.equal(ana.shifts, 1, "past shifts aren't brought over");
  assert.equal(p.openShifts, 1);
  assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM shifts`))!.n, 0);
  assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM deputy_import`))!.n, 0);
});

test("commit applies to people in Space and keeps the rest for their first sign-in", async () => {
  const r = await commitDeputy(file, admin, TODAY);
  assert.equal(r.staged, 2);
  const m = await one<{ team: string; start_date: string; regular_hours: unknown; work_days: number[] }>(`SELECT team, start_date::text AS start_date, regular_hours, work_days FROM time_members WHERE user_id = $1`, [manila]);
  assert.equal(m!.team, "Support Team");
  assert.equal(m!.start_date, "2025-04-21");
  assert.deepEqual(m!.work_days, [1, 2, 3, 4, 5]);
  const bal = await q<{ code: string; days: number }>(`SELECT code, days::float AS days FROM leave_balances WHERE user_id = $1 ORDER BY code`, [manila]);
  assert.deepEqual(bal, [{ code: "holiday", days: -9 }, { code: "vacation", days: 2.88 }]);
  const shifts = await q<{ user_id: number | null; timezone: string; published_at: string | null; note: string }>(`SELECT user_id, timezone, published_at, note FROM shifts ORDER BY external_id`);
  assert.equal(shifts.length, 2, "Ana's shift and the open one; Ben's waits");
  assert.equal(shifts[0].user_id, manila);
  assert.equal(shifts[0].timezone, "America/Los_Angeles");
  assert.ok(shifts[0].published_at);
  assert.equal(shifts[1].user_id, null);
  assert.equal(shifts[1].published_at, null, "a Deputy draft stays a draft");
  const leave = await q<{ status: string; code: string; days: number }>(`SELECT status, code, days::float AS days FROM leave_requests WHERE user_id = $1`, [manila]);
  assert.deepEqual(leave, [{ status: "approved", code: "vacation", days: 2 }]);
  assert.ok((await one(`SELECT 1 FROM time_audit WHERE entity = 'deputy'`)), "the import is in the audit log");
});

test("a week published in Deputy counts as published in Space, without its drafts", async () => {
  await recordDeputyPublications(TODAY);
  await recordDeputyPublications(TODAY);
  const pubs = await q<{ published_by: number | null; snapshot: { user_id: number | null }[] }>(`SELECT published_by, snapshot FROM shift_publications`);
  assert.equal(pubs.length, 1, "one publication, and a second sync with nothing new adds none");
  assert.equal(pubs[0].published_by, null);
  assert.deepEqual(pubs[0].snapshot.map((s) => s.user_id), [manila], "the open draft isn't in it");
  // Once a manager publishes in Space, Deputy stops writing that week's publication.
  await q(`UPDATE shift_publications SET published_by = $1`, [admin]);
  await q(`UPDATE shifts SET published_at = now() WHERE user_id IS NULL`);
  await recordDeputyPublications(TODAY);
  assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM shift_publications`))!.n, 1);
  await q(`UPDATE shifts SET published_at = NULL WHERE user_id IS NULL`);
  await q(`DELETE FROM shift_publications`);
});

test("re-importing doesn't duplicate, and keeps what Space has decided", async () => {
  await q(`UPDATE leave_requests SET status = 'cancelled', decided_by = $1 WHERE external_id = 'deputy:50'`, [admin]);
  await commitDeputy(file, admin, TODAY);
  assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM shifts`))!.n, 2);
  assert.equal((await one<{ status: string }>(`SELECT status FROM leave_requests WHERE external_id = 'deputy:50'`))!.status, "cancelled");
  // A shift claimed in Space after the import stays claimed when Deputy is re-imported.
  await q(`UPDATE shifts SET user_id = $1, updated_at = now() + interval '1 second' WHERE external_id = 'deputy:902'`, [manila]);
  await commitDeputy(file, admin, TODAY);
  assert.equal((await one<{ user_id: number }>(`SELECT user_id FROM shifts WHERE external_id = 'deputy:902'`))!.user_id, manila, "the claim survives a re-import");
  await q(`UPDATE shifts SET user_id = NULL, updated_at = deputy_synced_at WHERE external_id = 'deputy:902'`);
  // A shift gone from Deputy goes from Space.
  await commitDeputy({ ...file, shifts: file.shifts.filter((s) => s.id !== 902) }, admin, TODAY);
  assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM shifts WHERE external_id = 'deputy:902'`))!.n, 0);
});

test("someone who signs in later gets their Deputy data, and their week once Space knows their timezone", async () => {
  const ben = (await one<{ id: number }>(`INSERT INTO users (email, name, role) VALUES ('ben@example.org', 'Ben Cruz', 'member') RETURNING id`))!.id;
  await applyPendingDeputy(null, ben);
  const m = await one<{ team: string; regular_hours: unknown }>(`SELECT team, regular_hours FROM time_members WHERE user_id = $1`, [ben]);
  assert.equal(m!.team, "Support Team");
  assert.equal(m!.regular_hours, null, "no timezone yet: the week waits");
  assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM shifts WHERE user_id = $1`, [ben]))!.n, 1);
  assert.deepEqual(await one(`SELECT status, days::float AS days FROM leave_requests WHERE user_id = $1`, [ben]), { status: "pending", days: 5 });
  await q(`UPDATE users SET tz = 'America/Los_Angeles' WHERE id = $1`, [ben]);
  await applyPendingDeputy(null, ben);
  const after = await one<{ regular_hours: { dow: number; break_minutes?: number }[] }>(`SELECT regular_hours FROM time_members WHERE user_id = $1`, [ben]);
  assert.equal(after!.regular_hours.length, 5);
  assert.equal(after!.regular_hours[0].break_minutes, 60);
  assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM deputy_import WHERE hours_applied_at IS NULL`))!.n, 0);
});

test("add-people creates accounts for everyone still waiting, but not shared admin logins", async () => {
  const Fastify = (await import("fastify")).default;
  const { registerDeputyRoutes } = await import("./deputy");
  await q(`INSERT INTO grants (user_id, grant_kind, team) VALUES ($1, 'payroll_admin', '')`, [admin]);
  await q(`INSERT INTO deputy_import (email, deputy_id, name, payload) VALUES ('carla@example.org', 7, 'Carla Diaz', $1), ('software@example.com', 8, 'Admin Account Admin', $1)`,
    [JSON.stringify({ timezone: "America/Los_Angeles", location: "Support Team", startDate: "2026-01-05", regular: null, balances: [{ code: "vacation", days: 3 }], shifts: [], leave: [] })]);
  const app = Fastify();
  registerDeputyRoutes(app, (req) => ({ id: Number(req.headers["x-as"]) }));
  const asMember = await app.inject({ method: "POST", url: "/api/time/deputy/add-people", headers: { "x-as": String(manila) } });
  assert.equal(asMember.statusCode, 403, "a member can't add people");
  const r = await app.inject({ method: "POST", url: "/api/time/deputy/add-people", headers: { "x-as": String(admin) } });
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  assert.equal(j.added, 1);
  assert.deepEqual(j.left.map((l: { name: string }) => l.name), ["Admin Account Admin"]);
  const carla = await one<{ id: number }>(`SELECT id FROM users WHERE email = 'carla@example.org'`);
  assert.ok(carla);
  assert.equal((await one<{ team: string }>(`SELECT team FROM time_members WHERE user_id = $1`, [carla!.id]))!.team, "Support Team");
  assert.equal((await one<{ days: number }>(`SELECT days::float AS days FROM leave_balances WHERE user_id = $1 AND code = 'vacation'`, [carla!.id]))!.days, 3);
  assert.equal(await one(`SELECT 1 FROM users WHERE email = 'software@example.com'`), null);
});

test("the leave-policy file sets entitlements after a preview, and 0 means not on that policy", async () => {
  const Fastify = (await import("fastify")).default;
  const { registerDeputyRoutes } = await import("./deputy");
  const app = Fastify();
  registerDeputyRoutes(app, (req) => ({ id: Number(req.headers["x-as"]) }));
  const file = { source: "deputy-leave-policy", version: 1, readAt: "2026-10-16", people: [
    { email: "ANA@example.org", name: "Ana Reyes", entitlements: { vacation: 12, holiday: 0 } },
    { email: "ghost@example.org", name: "Not Here", entitlements: { vacation: 12, holiday: 5 } },
  ] };
  const post = (as: number, commit: boolean, body: unknown) => app.inject({ method: "POST", url: `/api/time/deputy/leave-policy?commit=${commit ? 1 : 0}`, headers: { "x-as": String(as), "content-type": "application/json" }, payload: JSON.stringify(body) });
  assert.equal((await post(manila, false, file)).statusCode, 403, "a member can't");
  assert.equal((await post(admin, false, { ...file, people: [{ email: "ana@example.org", name: "Ana", entitlements: { sick: 5 } }] })).statusCode, 400);
  const ents = async () => Object.fromEntries((await q<{ code: string; d: number }>(`SELECT code, days_per_year::float AS d FROM leave_entitlements WHERE user_id = $1`, [manila])).map((r) => [r.code, r.d]));
  const before = await ents();
  const pre = await post(admin, false, file);
  assert.equal(pre.statusCode, 200, pre.body);
  assert.equal(pre.json().rows[0].userId, manila);
  assert.deepEqual(await ents(), before, "preview writes nothing");
  const done = (await post(admin, true, file)).json();
  assert.deepEqual(done.notInSpace, ["Not Here"]);
  assert.deepEqual(await ents(), { ...before, vacation: 12, holiday: 0 });
});
