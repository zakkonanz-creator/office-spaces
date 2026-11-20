import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyEdits, fullEdit } from "./floorEdits";
import { checkFloor } from "./floorCheck";
import type { Floor } from "./floor";

process.env.SESSION_SECRET ??= "x".repeat(40);
const { geometryShift } = await import("../server/floorStore");
const seed: Floor = JSON.parse(readFileSync(new URL("../floor/demo-office.json", import.meta.url), "utf8"));

test("growing the building on top moves everything down together and stays valid", () => {
  const { floor, problems } = applyEdits(seed, [fullEdit({ op: "grow_building", side: "n", by: 300 })]);
  assert.deepEqual(problems, []);
  assert.equal(floor.height, seed.height + 300);
  assert.equal(floor.rooms[0].y, seed.rooms[0].y + 300);
  assert.equal(floor.desks[0].y, seed.desks[0].y + 300);
  assert.equal(floor.desks[0].seat!.y, seed.desks[0].seat!.y + 300);
  assert.equal(floor.objects[0].y, seed.objects[0].y + 300);
  assert.equal(floor.spawn.y, seed.spawn.y + 300);
  assert.deepEqual(geometryShift(floor), { dx: 0, dy: 300 });
  assert.deepEqual(checkFloor(floor), checkFloor(seed));
});

test("…and a full-width jumbotron fits in the new strip in the same edit list", () => {
  const { floor, problems } = applyEdits(seed, [
    fullEdit({ op: "grow_building", side: "n", by: 300 }),
    fullEdit({ op: "add_object", type: "jumbotron", x: 600, y: 60, w: 900, h: 200 }),
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(checkFloor(floor), checkFloor(seed));
});

test("growing right or down adds space without moving anything", () => {
  const { floor } = applyEdits(seed, [fullEdit({ op: "grow_building", side: "e", by: 200 })]);
  assert.equal(floor.width, seed.width + 200);
  assert.equal(floor.rooms[0].x, seed.rooms[0].x);
  assert.deepEqual(geometryShift(floor), { dx: 0, dy: 0 });
});

test("bad grows are refused; one room moving on its own isn't a valid layout", () => {
  assert.ok(applyEdits(seed, [fullEdit({ op: "grow_building", side: "n", by: 5000 })]).problems.length);
  assert.ok(applyEdits(seed, [fullEdit({ op: "grow_building", side: null, by: 100 })]).problems.length);
  const moved: Floor = structuredClone(seed);
  moved.rooms[0].y += 40;
  assert.equal(geometryShift(moved), null);
});

test("hand-added pieces keep the id they were given; ids can't collide or be made up", () => {
  const ok = applyEdits(seed, [fullEdit({ op: "add_object", id: "habc12345", type: "plant", x: 40, y: 40, w: 40, h: 40 })]);
  assert.ok(ok.floor.objects.some((o) => o.id === "habc12345"));
  assert.ok(applyEdits(seed, [fullEdit({ op: "add_object", id: seed.objects[0].id, type: "plant", x: 40, y: 40, w: 40, h: 40 })]).problems.length);
  assert.ok(applyEdits(seed, [fullEdit({ op: "add_object", id: "evil<script>", type: "plant", x: 40, y: 40, w: 40, h: 40 })]).problems.length);
});
