import { test } from "node:test";
import assert from "node:assert/strict";
import { daysFrom, dayIn, streakOf } from "./streaks";

// November 2026: Mon 2, Tue 3, Wed 4, Thu 5, Fri 6, Sat 7, Sun 8, Mon 9, Tue 10.
const set = (...d: string[]) => new Set(d);

test("streak: weekdays in a row, counting today once you're in", () => {
  assert.deepEqual(streakOf(set("2026-11-03", "2026-11-04", "2026-11-05"), "2026-11-05"), { days: 3, today: true });
  // Not in yet today: yesterday's streak still stands (it isn't broken until the day is over).
  assert.deepEqual(streakOf(set("2026-11-03", "2026-11-04"), "2026-11-05"), { days: 2, today: false });
  // A missed weekday breaks it.
  assert.deepEqual(streakOf(set("2026-11-02", "2026-11-04", "2026-11-05"), "2026-11-05"), { days: 2, today: true });
  // Missed yesterday and not in today: gone.
  assert.deepEqual(streakOf(set("2026-11-02", "2026-11-03"), "2026-11-05"), { days: 0, today: false });
  assert.deepEqual(streakOf(set(), "2026-11-05"), { days: 0, today: false });
});

test("streak: a weekend you come in counts; a weekend you don't never breaks it", () => {
  const week = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];
  // Friday → Monday carries straight over the weekend.
  assert.deepEqual(streakOf(set(...week, "2026-11-09"), "2026-11-09"), { days: 6, today: true });
  // Coming in on the weekend adds those days…
  assert.deepEqual(streakOf(set(...week, "2026-11-07", "2026-11-08", "2026-11-09"), "2026-11-09"), { days: 8, today: true });
  assert.deepEqual(streakOf(set(...week, "2026-11-08", "2026-11-09"), "2026-11-09"), { days: 7, today: true }); // just Sunday
  // …and counts the moment you arrive on a Saturday.
  assert.deepEqual(streakOf(set(...week, "2026-11-07"), "2026-11-07"), { days: 6, today: true });
  // Not in on Saturday or Sunday: the streak is Friday's, with nothing owed today.
  assert.deepEqual(streakOf(set(...week), "2026-11-07"), { days: 5, today: false });
  assert.deepEqual(streakOf(set(...week), "2026-11-08"), { days: 5, today: false });
  // Monday before you've come in: still 5. Tuesday without Monday: broken.
  assert.deepEqual(streakOf(set(...week), "2026-11-09"), { days: 5, today: false });
  assert.deepEqual(streakOf(set(...week), "2026-11-10"), { days: 0, today: false });
  // A streak can start on a weekend: Sat + Sun + Mon = 3.
  assert.deepEqual(streakOf(set("2026-11-07", "2026-11-08", "2026-11-09"), "2026-11-09"), { days: 3, today: true });
  // Weekend days don't rescue a missed weekday: in Sat + Sun, missed Mon, in Tue = 1.
  assert.deepEqual(streakOf(set(...week, "2026-11-07", "2026-11-08", "2026-11-10"), "2026-11-10"), { days: 1, today: true });
});

test("streak: days are local to the person, and a stretch past midnight marks both days", () => {
  // 2026-11-05 23:30 → 11-06 00:30 in Los Angeles (UTC-8): both local days count.
  const start = Date.parse("2026-11-06T07:30:00Z"), end = Date.parse("2026-11-06T08:30:00Z");
  assert.deepEqual([...daysFrom([{ start, end }], "America/Los_Angeles")].sort(), ["2026-11-05", "2026-11-06"]);
  // The same hour is a single day in Manila.
  assert.deepEqual([...daysFrom([{ start, end }], "Asia/Manila")], ["2026-11-06"]);
  assert.equal(dayIn(Date.parse("2026-11-06T03:00:00Z"), "America/Los_Angeles"), "2026-11-05");
});
