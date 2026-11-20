import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkFloor } from "./floorCheck";
import { fixSeats } from "./seatFix";
import { doorPoint, type Floor } from "./floor";

process.env.SESSION_SECRET ??= "x".repeat(40);
const { applyEdits, EDIT_SCHEMA } = await import("../server/designer");

const floor: Floor = JSON.parse(readFileSync(new URL("../floor/demo-office.json", import.meta.url), "utf8"));
const blank = { id: null, type: null, roomId: null, x: null, y: null, w: null, h: null, facing: null, color: null, label: null, url: null, text: null, youtube: null, name: null, floor: null };

test("the real floor passes every check once its seats are fitted (the server does this at boot)", () => {
  const f = structuredClone(floor);
  fixSeats(f);
  assert.deepEqual(checkFloor(f), []);
});

test("seats: what the pilot saw is caught, then fixed — and fixing twice changes nothing", () => {
  const problems = checkFloor(floor);
  assert.ok(problems.some((p) => p.includes("seat at desk engineering-k18")), "Robin on the table corner");
  assert.ok(problems.some((p) => p.includes("team-north-k3 and team-north-k5 would overlap")), "neighbours overlapping");
  const f = structuredClone(floor);
  const moves = fixSeats(f);
  assert.ok(moves.length > 15);
  // Seats move, people's desks don't.
  assert.deepEqual(f.desks.map((d) => [d.id, d.x, d.y]), floor.desks.map((d) => [d.id, d.x, d.y]));
  // Each moved seat took its own chair along.
  for (const m of moves) {
    const chairs = f.objects.filter((o) => (o.type === "chair" || o.type === "armchair") && Math.abs(o.x + o.w / 2 - m.to.x) <= 1 && Math.abs(o.y + o.h / 2 - m.to.y) <= 1);
    const had = floor.objects.some((o) => (o.type === "chair" || o.type === "armchair") && Math.abs(o.x + o.w / 2 - m.from.x) <= 3 && Math.abs(o.y + o.h / 2 - m.from.y) <= 3);
    assert.equal(chairs.length, had ? 1 : 0, m.id);
  }
  const again = structuredClone(f);
  assert.deepEqual(fixSeats(again), []);
  assert.deepEqual(again, f);
});

test("seats: the fix works on a grown building (every room shifted), like production's", () => {
  const f = structuredClone(floor);
  const dy = 120;
  f.height += dy; f.spawn.y += dy;
  for (const r of f.rooms) r.y += dy;
  for (const d of f.desks) { d.y += dy; if (d.seat) d.seat.y += dy; }
  for (const o of f.objects) o.y += dy;
  const flat = structuredClone(floor);
  const a = fixSeats(f), b = fixSeats(flat);
  assert.deepEqual(checkFloor(f), []);
  assert.deepEqual(a.map((m) => [m.id, m.to.x, m.to.y - dy]), b.map((m) => [m.id, m.to.x, m.to.y]));
});

test("a sofa dropped in a doorway is caught", () => {
  const sales = floor.rooms.find((r) => r.id === "sales")!;
  const d = doorPoint(sales);
  const { floor: f, problems } = applyEdits(floor, [{ ...blank, op: "add_object", type: "sofa", x: d.x - 100, y: d.y + 10, w: 200, h: 70 }]);
  assert.deepEqual(problems, []);
  assert.ok(checkFloor(f).some((p) => p.includes(`doorway of ${sales.name || sales.id}`)), checkFloor(f).join("; "));
});

test("a desk on top of another, furniture outside the building, and junk links are caught", () => {
  const d0 = floor.desks[0];
  const { floor: f } = applyEdits(floor, [
    { ...blank, op: "add_desk", roomId: d0.roomId, x: d0.x + 20, y: d0.y, facing: "s" },
    { ...blank, op: "add_object", type: "plant", x: floor.width + 50, y: 10, w: 40, h: 40 },
    { ...blank, op: "add_object", type: "link", x: 1200, y: 600, w: 100, h: 40, url: "javascript:alert(1)" },
  ]);
  const problems = checkFloor(f);
  assert.ok(problems.some((p) => p.includes("overlap")), "desk overlap");
  assert.ok(problems.some((p) => p.includes("outside the building")), "outside");
  assert.ok(problems.some((p) => p.includes("https")), "bad link");
});

test("edits to things that don't exist are reported, and room renames apply", () => {
  const { floor: f, problems } = applyEdits(floor, [
    { ...blank, op: "remove_object", id: "nope" },
    { ...blank, op: "update_room", id: "breakout", name: "Focus Room", floor: "oak" },
  ]);
  assert.deepEqual(problems, ["no object with id nope"]);
  assert.equal(f.rooms.find((r) => r.id === "breakout")!.name, "Focus Room");
  assert.equal(floor.rooms.find((r) => r.id === "breakout")!.name, "", "the live plan wasn't touched (rooms start unnamed)");
});

test("the Designer's schema stays under the API's 16 union-typed parameter limit", () => {
  // Over the limit, every Designer request fails with a 400 (it happened when variant/r were added).
  let unions = 0;
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n.anyOf) || Array.isArray(n.type)) unions++;
    for (const v of Object.values(n)) walk(v);
  };
  walk(EDIT_SCHEMA);
  assert.ok(unions <= 16, `${unions} union-typed parameters`);
});
