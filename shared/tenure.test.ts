import { test } from "node:test";
import assert from "node:assert/strict";
import { daysSince, pinOf, spanLabel } from "./tenure";
import { EMOTES, LEVELS, MAX_LEVEL, levelOf, unlocked } from "./emotes";
import { anniversaryYears, tenurePoints } from "./points";
import { petUnlocked } from "./pets";
import { EGGS, EGG_RADIUS, eggSpots } from "./eggs";
import { blocked, type Floor } from "./floor";
import { readFileSync } from "node:fs";

const NOW = Date.parse("2026-11-05T15:00:00Z");

test("days since a start date; missing or junk is day one", () => {
  assert.equal(daysSince("2026-11-05", NOW), 0);
  assert.equal(daysSince("2026-11-01", NOW), 4);
  assert.equal(daysSince(null, NOW), 0);
  assert.equal(daysSince("nonsense", NOW), 0);
  assert.equal(daysSince("2027-01-01", NOW), 0); // a future date never goes negative
});

test("service pin by tenure", () => {
  assert.deepEqual(pinOf(0), { tier: "new", years: 0 });
  assert.deepEqual(pinOf(29), { tier: "new", years: 0 });
  assert.equal(pinOf(30).tier, "bronze");
  assert.equal(pinOf(180).tier, "silver");
  assert.deepEqual(pinOf(365 * 2 + 10), { tier: "gold", years: 2 });
  assert.deepEqual(pinOf(365 * 5), { tier: "diamond", years: 5 });
});

test("labels", () => {
  assert.equal(spanLabel(1), "1 day");
  assert.equal(spanLabel(20), "2 weeks");
  assert.equal(spanLabel(100), "3 months");
  assert.equal(spanLabel(800), "2 years");
});

test("emote unlocks by points: a few on day one, epic ones later; tenure no longer carries a veteran to the top", () => {
  const open = (pts: number) => EMOTES.filter((e) => unlocked(e.id, pts)).map((e) => e.id);
  assert.deepEqual(open(0), ["dance", "chicken", "robot", "faint"]); // guests and day one
  const tenure = (since: string) => tenurePoints(daysSince(since, NOW), since, NOW);
  assert.equal(tenure("2026-11-05"), 0);
  assert.equal(tenure("2026-10-06"), 30); // a month: a point a day
  assert.equal(tenure("2023-11-05"), 1096 + 750); // three full years: days + 250 a year
  const vet = open(tenure("2021-03-23")); // five and a half years, never in the office
  assert.ok(vet.includes("landing") && !vet.includes("legend"), "a long-timer starts well ahead, not at the top");
  const active = (days: number) => open(20 * days + days); // ~20 points a day in the office + a point a day
  assert.ok(!active(14).includes("tpose") && active(21).includes("tpose"), "Level 5 in about three weeks");
  assert.ok(!active(70).includes("landing") && active(90).includes("landing"), "the first epic in about three months");
  assert.ok(!active(300).includes("legend") && open(21 * 365 + 250).includes("legend"), "Legend in about a year");
  assert.equal(unlocked("not-an-emote", 1e9), false);
  assert.equal(unlocked("legend", null), false);
});

test("anniversaries", () => {
  assert.equal(anniversaryYears("2023-11-05", "2026-11-05"), 3);
  assert.equal(anniversaryYears("2026-11-05", "2026-11-05"), 0); // the first day isn't an anniversary
  assert.equal(anniversaryYears("2023-11-04", "2026-11-05"), 0);
  assert.equal(anniversaryYears("2024-02-29", "2027-02-28"), 3); // leap-day starters
  assert.equal(anniversaryYears(null, "2026-11-05"), 0);
});

test("pets unlock with points; cat and dog from day one", () => {
  assert.ok(petUnlocked("cat", 0) && petUnlocked("dog", 0));
  assert.ok(!petUnlocked("dragon", 6999) && petUnlocked("dragon", 7000));
  assert.equal(petUnlocked("unicorn", 1e9), false);
});

test("every easter egg on the office floor is somewhere you can stand", () => {
  const floor = JSON.parse(readFileSync(new URL("../floor/demo-office.json", import.meta.url), "utf8")) as Floor;
  const spots = eggSpots(floor);
  assert.equal(spots.length, EGGS.length, "every egg's room is on the floor");
  for (const s of spots) {
    // Some point within reach of the egg must be walkable.
    let ok = false;
    for (let dx = -EGG_RADIUS + 6; dx <= EGG_RADIUS - 6 && !ok; dx += 8) for (let dy = -EGG_RADIUS + 6; dy <= EGG_RADIUS - 6 && !ok; dy += 8) if (Math.hypot(dx, dy) < EGG_RADIUS - 4 && !blocked(floor, { x: s.at.x + dx, y: s.at.y + dy }, () => true)) ok = true;
    assert.ok(ok, `${s.id} can be reached`);
  }
});

test("every emote unlock is in order and every epic one has a screen effect", () => {
  for (let i = 1; i < EMOTES.length; i++) assert.ok(EMOTES[i].points >= EMOTES[i - 1].points || "epic" in EMOTES[i], EMOTES[i].id);
  for (const e of EMOTES) if ("epic" in e) assert.ok("fx" in e && e.fx, e.id);
});

test("next reward and what a jump in points unlocks", async () => {
  const { nextReward, newlyUnlocked, REWARDS } = await import("./rewards");
  const n0 = nextReward(0)!;
  assert.equal(n0.reward.id, "jacks");
  assert.equal(n0.progress, 0);
  const mid = nextReward(87.5)!; // between jacks (50) and moonwalk (125)
  assert.equal(mid.reward.id, "moonwalk");
  assert.equal(mid.progress, 0.5);
  assert.deepEqual(newlyUnlocked(40, 160).map((r) => r.id), ["jacks", "moonwalk", "bunny"]);
  assert.deepEqual(newlyUnlocked(160, 40), [], "going down unlocks nothing");
  assert.equal(nextReward(REWARDS[REWARDS.length - 1].points), null, "nothing left at the top");
});

import { firstName } from "./names";
test("firstName strips the company from Slack names", () => {
  assert.equal(firstName("Alex Admin | Acme"), "Alex");
  assert.equal(firstName("Morgan Lee - Acme"), "Morgan");
  assert.equal(firstName("Jo (she/her)"), "Jo");
  assert.equal(firstName("Mary-Jane Smith"), "Mary-Jane");
  assert.equal(firstName(""), "Someone");
  assert.equal(firstName(null), "Someone");
});

test("twenty levels, one emote each", () => {
  assert.equal(MAX_LEVEL, 20);
  assert.equal(levelOf(0), 1);
  assert.equal(levelOf(null), 1);
  assert.equal(levelOf(49), 1);
  assert.equal(levelOf(50), 2);
  assert.equal(levelOf(1e9), 20);
  for (let i = 1; i < LEVELS.length; i++) assert.ok(LEVELS[i] > LEVELS[i - 1], `level ${i + 1} costs more than ${i}`);
  assert.equal(EMOTES.filter((e) => "epic" in e).length, 10);
});

test("outfits: Fortnite rarities, in order, the first one free, all in the rewards", async () => {
  const { OUTFITS, outfitUnlocked } = await import("./outfits");
  const { REWARDS } = await import("./rewards");
  assert.equal(OUTFITS[0].points, 0);
  for (let i = 1; i < OUTFITS.length; i++) assert.ok(OUTFITS[i].points > OUTFITS[i - 1].points, OUTFITS[i].id);
  assert.ok(outfitUnlocked("tee", 0) && !outfitUnlocked("galaxy", 8999) && outfitUnlocked("galaxy", 9000));
  assert.equal(outfitUnlocked("nope", 1e9), false);
  assert.equal(REWARDS.filter((r) => r.kind === "outfit").length, OUTFITS.length - 1); // the free tee isn't a reward
});

test("the year bonus lands on the anniversary, not before (QA 2026-11-06)", async () => {
  const { fullYears } = await import("./points");
  const at = (d: string) => Date.parse(`${d}T15:00:00Z`);
  assert.equal(fullYears("2023-11-07", at("2026-11-06")), 2); // the day before: still 2
  assert.equal(fullYears("2023-11-07", at("2026-11-07")), 3); // on the day: 3
  assert.equal(fullYears("2025-11-07", at("2026-11-06")), 0);
  assert.equal(fullYears("2024-02-29", at("2025-02-28")), 0);
  assert.equal(fullYears("2024-02-29", at("2025-03-01")), 1);
  assert.equal(tenurePoints(1095, "2023-11-07", at("2026-11-06")), 1095 + 2 * 250);
});
