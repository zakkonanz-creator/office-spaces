import { test } from "node:test";
import assert from "node:assert/strict";
import { approvedInRange, leaveMonths, expectedMinutesOn, isRegularHours, regularMinutes, availabilityClash, diffShifts, dueForReminder, lateBy, minutesByDay, nextLocalMidnight, pairEvents, shiftInterval, shiftInZone, leaveDays, weekStart, workingDays, zonedTime, localDate, pickTz, isDate, thisWeek, lastFullWeek, type ClockEvent, type Unavailable } from "./time";

const at = (iso: string) => Date.parse(iso);
let id = 0;
const ev = (kind: ClockEvent["kind"], iso: string): ClockEvent => ({ id: ++id, kind, at: at(iso) });

test("a normal day with a break: worked time excludes the break", () => {
  const events = [ev("in", "2026-10-05T09:00:00Z"), ev("break_start", "2026-10-05T12:00:00Z"), ev("break_end", "2026-10-05T12:30:00Z"), ev("out", "2026-10-05T17:00:00Z")];
  const { sessions, flags, state } = pairEvents(events, at("2026-10-06T00:00:00Z"));
  assert.equal(state, "out");
  assert.deepEqual(flags, []);
  assert.deepEqual(minutesByDay(sessions), { "2026-10-05": 7.5 * 60 });
});

test("events are paired by time, not by list order", () => {
  const events = [ev("out", "2026-10-05T17:00:00Z"), ev("in", "2026-10-05T09:00:00Z")];
  const { sessions, flags } = pairEvents(events, at("2026-10-06T00:00:00Z"));
  assert.deepEqual(flags, []);
  assert.deepEqual(minutesByDay(sessions), { "2026-10-05": 480 });
});

test("a missed clock-out is flagged and counts nothing — the next day still pairs correctly", () => {
  const events = [ev("in", "2026-10-05T09:00:00Z"), ev("in", "2026-10-06T09:00:00Z"), ev("out", "2026-10-06T13:00:00Z")];
  const { sessions, flags } = pairEvents(events, at("2026-10-07T00:00:00Z"));
  assert.equal(flags.length, 1);
  assert.equal(flags[0].code, "missed-out");
  assert.deepEqual(minutesByDay(sessions), { "2026-10-06": 240 });
});

test("still clocked in after 16h is a missed clock-out, not a 20-hour day", () => {
  const { sessions, flags, state } = pairEvents([ev("in", "2026-10-05T09:00:00Z")], at("2026-10-06T05:00:00Z"));
  assert.equal(state, "out");
  assert.equal(flags[0].code, "missed-out");
  assert.deepEqual(minutesByDay(sessions), {});
});

test("a live shift counts up to now, and an open break isn't work", () => {
  const events = [ev("in", "2026-10-05T09:00:00Z"), ev("break_start", "2026-10-05T11:00:00Z")];
  const { sessions, state } = pairEvents(events, at("2026-10-05T11:30:00Z"));
  assert.equal(state, "break");
  assert.deepEqual(minutesByDay(sessions), { "2026-10-05": 120 });
});

test("stray clock-out and stray break are flagged", () => {
  const { flags } = pairEvents([ev("out", "2026-10-05T09:00:00Z"), ev("break_end", "2026-10-05T10:00:00Z")], at("2026-10-06T00:00:00Z"));
  assert.deepEqual(flags.map((f) => f.code), ["stray-out", "stray-break"]);
});

test("a night shift splits across local midnight in the person's timezone", () => {
  // 22:00–02:00 Manila (UTC+8) = 14:00–18:00 UTC.
  const events = [ev("in", "2026-10-05T14:00:00Z"), ev("out", "2026-10-05T18:00:00Z")];
  const { sessions } = pairEvents(events, at("2026-10-06T00:00:00Z"), "Asia/Manila");
  assert.deepEqual(minutesByDay(sessions, "Asia/Manila"), { "2026-10-05": 120, "2026-10-06": 120 });
});

test("zoned times survive DST", () => {
  // New York: 2026-11-01 is the fall-back day.
  assert.equal(new Date(zonedTime("2026-11-02", "09:00", "America/New_York")).toISOString(), "2026-11-02T14:00:00.000Z");
  assert.equal(new Date(zonedTime("2026-10-30", "09:00", "America/New_York")).toISOString(), "2026-10-30T13:00:00.000Z");
  assert.equal(localDate(at("2026-10-05T23:30:00Z"), "Asia/Karachi"), "2026-10-06");
});

test("working days and week starts", () => {
  assert.equal(workingDays("2026-10-05", "2026-10-11"), 5); // Mon–Sun
  assert.equal(workingDays("2026-10-10", "2026-10-11"), 0); // a weekend
  assert.equal(workingDays("2026-10-09", "2026-10-05"), 0);
  assert.equal(weekStart("2026-10-07"), "2026-10-05");
  assert.equal(weekStart("2026-10-11"), "2026-10-05"); // Sunday belongs to the week that started Monday
});

test("leave days follow each person's own working pattern", () => {
  // Wed–Sun worker, a Mon–Sun week of leave: 5 of their days.
  assert.equal(workingDays("2026-10-05", "2026-10-11", [3, 4, 5, 6, 0]), 5);
  // Weekend-only worker taking Sat–Sun off.
  assert.equal(workingDays("2026-10-10", "2026-10-11", [6, 0]), 2);
  assert.equal(workingDays("2026-10-05", "2026-10-09", [6, 0]), 0);
});

test("an overnight shift ends the next day, in the person's timezone", () => {
  const s = shiftInterval("2026-10-05", "22:00", "06:00", "Asia/Karachi"); // UTC+5
  assert.equal(new Date(s.start).toISOString(), "2026-10-05T17:00:00.000Z");
  assert.equal(new Date(s.end).toISOString(), "2026-10-06T01:00:00.000Z");
  const day = shiftInterval("2026-10-05", "09:00", "17:00", "UTC");
  assert.equal((day.end - day.start) / 3600_000, 8);
});

test("a Sunday-night shift crossing into Monday splits across two weeks' days", () => {
  const events = [ev("in", "2026-10-11T22:00:00Z"), ev("out", "2026-10-12T04:00:00Z")];
  const { sessions } = pairEvents(events, at("2026-10-13T00:00:00Z"));
  assert.deepEqual(minutesByDay(sessions), { "2026-10-11": 120, "2026-10-12": 240 });
  assert.notEqual(weekStart("2026-10-11"), weekStart("2026-10-12"));
});

test("zones whose clocks jump forward at midnight don't stall the day split (regression: server hang)", () => {
  for (const [tz, day] of [["America/Santiago", "2026-09-05"], ["America/Havana", "2026-03-07"], ["America/Sao_Paulo", "2018-11-03"]]) {
    const t = zonedTime(day, "23:30", tz);
    assert.ok(nextLocalMidnight(t, tz) > t, `${tz}: next midnight must be after now`);
    // A night shift across the jump: 23:00 → 03:00 local is 3 real hours.
    const events = [ev("in", new Date(zonedTime(day, "23:00", tz)).toISOString()), ev("out", new Date(t + 3.5 * 3600_000).toISOString())];
    const { sessions } = pairEvents(events, t + 24 * 3600_000, tz);
    const byDay = minutesByDay(sessions, tz);
    assert.equal(Object.values(byDay).reduce((a, b) => a + b, 0), 240, `${tz}: ${JSON.stringify(byDay)}`);
  }
});

test("availability: a weekly window, a whole day, and overnight edges", () => {
  // 2026-10-07 is a Wednesday (3).
  const wedEvenings: Unavailable = { kind: "weekly", dow: 3, start_local: "18:00", end_local: "23:00" };
  assert.ok(availabilityClash({ date: "2026-10-07", start_local: "17:00", end_local: "19:00" }, [wedEvenings]), "overlaps the evening");
  assert.equal(availabilityClash({ date: "2026-10-07", start_local: "09:00", end_local: "17:00" }, [wedEvenings]), null, "a day shift is fine");
  assert.equal(availabilityClash({ date: "2026-10-08", start_local: "18:00", end_local: "22:00" }, [wedEvenings]), null, "Thursday is fine");
  const oneOff: Unavailable = { kind: "date", date: "2026-10-09" };
  assert.ok(availabilityClash({ date: "2026-10-09", start_local: "09:00", end_local: "10:00" }, [oneOff]), "a one-off date blocks the whole day");
  // An overnight shift Thu 22:00 → Fri 06:00 runs into the Friday one-off.
  assert.ok(availabilityClash({ date: "2026-10-08", start_local: "22:00", end_local: "06:00" }, [oneOff]), "overnight into a blocked day");
  // Overnight unavailability Tue 22:00 → Wed 02:00 catches a Wed 01:00 start.
  const tueNights: Unavailable = { kind: "weekly", dow: 2, start_local: "22:00", end_local: "02:00" };
  assert.ok(availabilityClash({ date: "2026-10-07", start_local: "01:00", end_local: "05:00" }, [tueNights]), "carried over from the night before");
  assert.equal(availabilityClash({ date: "2026-10-07", start_local: "02:00", end_local: "05:00" }, [tueNights]), null, "…but not once it ends");
  // A weekly item with no times is the whole day.
  assert.ok(availabilityClash({ date: "2026-10-11", start_local: "12:00", end_local: "13:00" }, [{ kind: "weekly", dow: 0 }]), "Sundays off");
});

test("reminders fire 25–35 minutes ahead; lateness after 10 minutes without a clock-in", () => {
  const start = at("2026-10-07T09:00:00Z");
  assert.equal(dueForReminder(start, start - 40 * 60_000), false);
  assert.equal(dueForReminder(start, start - 30 * 60_000), true);
  assert.equal(dueForReminder(start, start - 20 * 60_000), false);
  const shift = { start, end: start + 8 * 3600_000 };
  assert.equal(lateBy(shift, null, false, start + 5 * 60_000), 0, "5 minutes is not late yet");
  assert.equal(lateBy(shift, null, false, start + 15 * 60_000), 15, "15 minutes late");
  assert.equal(lateBy(shift, start - 5 * 60_000, true, start + 15 * 60_000), 0, "clocked in just before the start");
  assert.equal(lateBy(shift, start - 5 * 3600_000, true, start + 15 * 60_000), 15, "still clocked in from a much earlier session doesn't count");
  assert.equal(lateBy(shift, null, false, shift.end + 1), 0, "after the shift ended, not 'late'");
});

test("publishing: added, removed and changed shifts", () => {
  const a = { id: 1, user_id: 7, date: "2026-10-05", start_local: "09:00", end_local: "17:00", timezone: "UTC" };
  const b = { id: 2, user_id: 8, date: "2026-10-06", start_local: "22:00", end_local: "06:00", timezone: "Asia/Karachi" };
  const c = { id: 3, user_id: null, date: "2026-10-07", start_local: "09:00", end_local: "17:00", timezone: "UTC" };
  const d = diffShifts([a, b], [{ ...a, user_id: 9 }, c]);
  assert.deepEqual(d.added.map((x) => x.id), [3]);
  assert.deepEqual(d.removed.map((x) => x.id), [2]);
  assert.deepEqual(d.changed.map((x) => [x.before.user_id, x.after.user_id]), [[7, 9]]);
  assert.equal(diffShifts([a], [a]).any, false);
});

test("regular hours: a day's expected minutes net of the break, overnight included", () => {
  assert.equal(regularMinutes({ dow: 1, start: "09:00", end: "17:00", break_start: "13:00", break_end: "13:30" }), 450);
  assert.equal(regularMinutes({ dow: 5, start: "22:00", end: "06:00", break_start: "02:00", break_end: "02:30" }), 450);
  assert.equal(regularMinutes({ dow: 2, start: "08:00", end: "12:00" }), 240);
  const week = [{ dow: 1, start: "09:00", end: "17:00", break_start: "13:00", break_end: "14:00" }, { dow: 6, start: "10:00", end: "14:00" }];
  assert.equal(expectedMinutesOn("2026-10-05", week), 420); // Monday
  assert.equal(expectedMinutesOn("2026-10-10", week), 240); // Saturday: a weekend worker
  assert.equal(expectedMinutesOn("2026-10-06", week), 0); // Tuesday: not a working day for them
  // No regular hours yet: an 8-hour day on their working days.
  assert.equal(expectedMinutesOn("2026-10-05", null), 480);
  assert.equal(expectedMinutesOn("2026-10-10", null), 0);
  assert.equal(expectedMinutesOn("2026-10-10", null, [6, 0]), 480);
  assert.ok(isRegularHours(week));
  assert.ok(!isRegularHours([{ dow: 1, start: "09:00", end: "17:00" }, { dow: 1, start: "10:00", end: "12:00" }]), "one entry per day");
  assert.ok(!isRegularHours([{ dow: 1, start: "25:00", end: "17:00" }]));
  assert.ok(!isRegularHours([{ dow: 1, start: "09:00", end: "17:00", break_start: "12:00" }]), "a break needs both ends");
});

test("a clock-out pressed the next morning is counted but flagged", () => {
  const { sessions, flags } = pairEvents([ev("in", "2026-10-05T17:00:00Z"), ev("out", "2026-10-06T08:00:00Z")], at("2026-10-06T09:00:00Z"));
  assert.equal(sessions.length, 1);
  assert.deepEqual(flags.map((f) => f.code), ["long-shift"]);
  // A normal long day isn't.
  assert.deepEqual(pairEvents([ev("in", "2026-10-05T08:00:00Z"), ev("out", "2026-10-05T19:00:00Z")], at("2026-10-06T09:00:00Z")).flags, []);
});

test("a shift clicked on the manager's clock is saved on the person's clock, at the same instant", () => {
  // LA manager, Karachi agent: Tue 09:00–17:00 PDT is Tue 21:00–05:00 in Karachi.
  const k = shiftInZone("2026-10-20", "09:00", "17:00", "America/Los_Angeles", "Asia/Karachi");
  assert.deepEqual(k, { date: "2026-10-20", start_local: "21:00", end_local: "05:00" });
  assert.deepEqual(shiftInterval(k.date, k.start_local, k.end_local, "Asia/Karachi"), shiftInterval("2026-10-20", "09:00", "17:00", "America/Los_Angeles"));
  // The other way, the date moves back: Karachi Tue 09:00 is Mon 21:00 in LA.
  assert.deepEqual(shiftInZone("2026-10-20", "09:00", "17:00", "Asia/Karachi", "America/Los_Angeles"), { date: "2026-10-19", start_local: "21:00", end_local: "05:00" });
  // Overnight stays overnight, and the same zone changes nothing.
  assert.deepEqual(shiftInZone("2026-10-20", "22:00", "06:00", "UTC", "UTC"), { date: "2026-10-20", start_local: "22:00", end_local: "06:00" });
  assert.deepEqual(shiftInZone("2026-10-20", "22:00", "06:00", "UTC", "Asia/Manila"), { date: "2026-10-21", start_local: "06:00", end_local: "14:00" });
});

test("leave days: whole working days, or a half day on one working date", () => {
  assert.equal(leaveDays("2026-10-19", "2026-10-23"), 5);
  assert.equal(leaveDays("2026-10-20", "2026-10-20", undefined, true), 0.5);
  assert.ok(Number.isNaN(leaveDays("2026-10-20", "2026-10-21", undefined, true)), "a half day is one date");
  assert.ok(Number.isNaN(leaveDays("2026-10-24", "2026-10-24", undefined, true)), "a Saturday isn't a working day");
  assert.equal(leaveDays("2026-10-24", "2026-10-24", [6], true), 0.5, "unless it's theirs");
});

test("this week / last full week are the viewer's, not UTC's (regression)", () => {
  // Monday 06:00 in Manila is still Sunday 22:00 in UTC.
  const manilaMonday = at("2026-10-25T22:00:00Z");
  assert.equal(thisWeek(manilaMonday, "Asia/Manila"), "2026-10-26");
  assert.equal(lastFullWeek(manilaMonday, "Asia/Manila"), "2026-10-19");
  assert.equal(thisWeek(manilaMonday, "UTC"), "2026-10-19");
  // Sunday 20:00 in Chicago is already Monday in UTC: their week isn't over.
  const chicagoSunday = at("2026-10-26T01:00:00Z");
  assert.equal(thisWeek(chicagoSunday, "America/Chicago"), "2026-10-19");
  assert.equal(lastFullWeek(chicagoSunday, "America/Chicago"), "2026-10-12");
  assert.equal(lastFullWeek(chicagoSunday, "UTC"), "2026-10-19");
});

test("isDate: only real calendar dates (regression: 2026-02-30 rolled into March)", () => {
  for (const ok of ["2026-02-28", "2028-02-29", "2026-12-31", "2026-01-01"]) assert.equal(isDate(ok), true, ok);
  for (const no of ["2026-02-30", "2026-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "2026-4-01", "2026-04-01T00:00", "", null, 20260401]) assert.equal(isDate(no), false, String(no));
});

test("pickTz: the first real timezone wins, junk is skipped, UTC if none", () => {
  assert.equal(pickTz("Asia/Karachi", "America/Chicago"), "Asia/Karachi", "pay profile over browser");
  assert.equal(pickTz(null, "", "Mars/Olympus", "America/Chicago"), "America/Chicago");
  assert.equal(pickTz(undefined, 42, "not a zone"), "UTC");
});

test("approvedInRange: pay counts the days as approved, and says when the clock events moved (regression)", () => {
  const week = { weekStart: "2026-09-28", minutes: 600, byDay: { "2026-09-28": 480, "2026-10-04": 120 } };
  // Live now says Sunday has nothing (its overnight clock-out was voided): pay is unchanged.
  const live = { "2026-09-28": 480 };
  assert.deepEqual(approvedInRange([week], live, "2026-09-01", "2026-09-30"), { minutes: 480, drift: [{ weekStart: "2026-09-28", approved: 600, live: 480 }], legacy: [] });
  assert.equal(approvedInRange([week], live, "2026-10-01", "2026-10-31").minutes, 120, "October gets the Sunday it was approved with");
  // Nothing moved: no drift.
  assert.deepEqual(approvedInRange([week], { "2026-09-28": 480, "2026-10-04": 120 }, "2026-09-01", "2026-10-31").drift, []);
  // Approved before days were kept: a whole week pays its total; a split week counts live days and says so.
  const old = { weekStart: "2026-09-28", minutes: 600, byDay: null };
  assert.equal(approvedInRange([old], live, "2026-09-28", "2026-10-04").minutes, 600);
  assert.deepEqual(approvedInRange([old], live, "2026-09-01", "2026-09-30"), { minutes: 480, drift: [{ weekStart: "2026-09-28", approved: 600, live: 480 }], legacy: ["2026-09-28"] });
  // A week outside the range counts nothing.
  assert.equal(approvedInRange([week], live, "2026-11-01", "2026-11-30").minutes, 0);
});

test("leaveMonths: only months the leave has working days in", () => {
  assert.deepEqual(leaveMonths("2026-10-29", "2026-11-03"), ["2026-10", "2026-11"]);
  // Sat Oct 31 → Mon Nov 2 for Mon–Fri: October has none of their days.
  assert.deepEqual(leaveMonths("2026-10-31", "2026-11-02"), ["2026-11"]);
  assert.deepEqual(leaveMonths("2026-10-31", "2026-11-02", [6]), ["2026-10"], "a Saturday worker");
  assert.deepEqual(leaveMonths("2026-12-30", "2027-01-04"), ["2026-12", "2027-01"]);
});
