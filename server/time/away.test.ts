import { test } from "node:test";
import assert from "node:assert/strict";
import { dueForAwayNudge, AWAY_NUDGE_MS } from "./away";

const H = 3600_000;
const now = Date.UTC(2026, 10, 4, 18);
const base = { clockedInAt: now - 5 * H, lastInOffice: now - 3 * H, inOfficeNow: false, lastNudgedAwaySince: null as number | null, now };

test("away nudge: clocked in and out of the office for 2 hours gets one", () => {
  assert.equal(dueForAwayNudge(base), now - 3 * H);
});
test("away nudge: not while they're in the office, or before 2 hours", () => {
  assert.equal(dueForAwayNudge({ ...base, inOfficeNow: true }), null);
  assert.equal(dueForAwayNudge({ ...base, lastInOffice: now - AWAY_NUDGE_MS + 60_000 }), null);
});
test("away nudge: clocked in on a phone and never opened the office counts from the clock-in", () => {
  assert.equal(dueForAwayNudge({ ...base, lastInOffice: null, clockedInAt: now - 2.5 * H }), now - 2.5 * H);
  // …and yesterday's office visit doesn't count against today's clock-in
  assert.equal(dueForAwayNudge({ ...base, lastInOffice: now - 20 * H, clockedInAt: now - H }), null);
});
test("away nudge: once per away stretch; a new stretch after coming back gets a new one", () => {
  assert.equal(dueForAwayNudge({ ...base, lastNudgedAwaySince: now - 3 * H }), null);
  assert.equal(dueForAwayNudge({ ...base, lastNudgedAwaySince: now - 6 * H }), now - 3 * H);
});
