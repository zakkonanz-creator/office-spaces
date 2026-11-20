import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUDIO_RANGES, blocked, doorPoint, findPath, roomAt, seatOf, step, volumeBetween, type Floor } from "./floor";

const floor: Floor = JSON.parse(readFileSync(new URL("../floor/demo-office.json", import.meta.url), "utf8"));
const open = () => true;
const shut = () => false;
const conf = floor.rooms.find((r) => r.id === "conference")!;
const inside = { x: conf.x + conf.w / 2, y: conf.y + conf.h / 2 };
const door = doorPoint(conf);
const out = { n: [0, -60], s: [0, 60], w: [-60, 0], e: [60, 0] }[conf.door.side];
const outside = { x: door.x + out[0], y: door.y + out[1] };

test("every door and opening can be walked through, both ways", () => {
  for (const r of floor.rooms) {
    for (const g of [r.door, ...(r.openings ?? [])]) {
      const off = { n: [0, -50], s: [0, 50], w: [-50, 0], e: [50, 0] }[g.side];
      // Somewhere along the gap you can walk through (a whole open side may meet a neighbour's door at one end)…
      const n = Math.max(1, Math.floor((g.width - 40) / 40));
      const points = Array.from({ length: n + 1 }, (_, i) => doorPoint(r, { ...g, at: g.at - (g.width - 40) / 2 + ((g.width - 40) * i) / n }));
      const through = points.find((d) => {
        const out = { x: d.x + off[0], y: d.y + off[1] }, inn = { x: d.x - off[0], y: d.y - off[1] };
        return !blocked(floor, d, open) && !blocked(floor, out, open) && findPath(floor, out, inn, open).length > 0;
      });
      assert.ok(through, `${r.name}: can't walk through its ${g.side} gap anywhere`);
      // …and a shut room shuts every way in (rooms without a door, like the kitchen, can't shut).
      if (!r.closable) continue;
      const out = { x: through!.x + off[0], y: through!.y + off[1] }, inn = { x: through!.x - off[0], y: through!.y - off[1] };
      assert.equal(findPath(floor, out, inn, (id) => id !== r.id).length, 0, `${r.name}: its ${g.side} gap ignores a closed door`);
    }
  }
});

test("every desk and the spawn point are reachable from the spawn", () => {
  assert.equal(blocked(floor, floor.spawn, open), false);
  for (const d of floor.desks) {
    const seat = seatOf(d);
    const path = findPath(floor, floor.spawn, seat, open);
    assert.ok(path.length > 0, `desk ${d.id} unreachable`);
  }
});

test("walls stop you; the door lets you through; a closed door doesn't", () => {
  assert.ok(roomAt(floor, inside)?.id === "conference");
  // Outside the door: the hallway, or the next room when the door opens into it (as in Kumospace).
  assert.notEqual(roomAt(floor, outside)?.id, "conference");
  // Straight at a wall without the door in it.
  const wallSide = conf.door.side === "w" ? "e" : "w";
  const throughWall = step(floor, inside, { x: wallSide === "w" ? conf.x - 80 : conf.x + conf.w + 80, y: inside.y }, open);
  assert.equal(roomAt(floor, throughWall)?.id, "conference", "walked through a wall");
  const viaDoor = findPath(floor, outside, inside, open);
  assert.ok(viaDoor.length > 0);
  assert.equal(findPath(floor, outside, inside, (id) => id !== "conference").length, 0, "closed door let us in");
  assert.equal(blocked(floor, door, shut), true);
});

test("hearing: closed rooms are sealed, open rooms are room audio, the floor fades", () => {
  const closed = (id: string) => id === "conference";
  const a = { ...inside, roomId: "conference" };
  const b = { x: inside.x + 200, y: inside.y, roomId: "conference" };
  const c = { ...outside, roomId: null };
  assert.equal(volumeBetween(a, b, closed, 260), 1);
  assert.equal(volumeBetween(a, c, closed, 260), 0);
  assert.equal(volumeBetween(c, a, closed, 260), 0, "not symmetric");
  // Door open: someone at the door hears a bit of the room only if close.
  assert.equal(volumeBetween(a, b, () => false, 260), 1);
  const far = { x: 1000, y: 2000, roomId: null };
  const near = { x: 1100, y: 2000, roomId: null };
  const edge = { x: 1000 + 230, y: 2000, roomId: null };
  assert.equal(volumeBetween(far, near, () => false, 260), 1);
  const v = volumeBetween(far, edge, () => false, 260);
  assert.ok(v > 0 && v < 1, `expected a fade, got ${v}`);
  assert.equal(volumeBetween(far, { x: 1300, y: 2000, roomId: null }, () => false, 260), 0);
  // Two different rooms never hear each other.
  assert.equal(volumeBetween(a, { ...a, roomId: "meeting" }, () => false, 260), 0);
});

test("nothing is stacked: desks don't overlap each other or furniture, and everything is inside its room", () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  const hit = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  // A desk plus its chair (chairs stick out ~30px on the sitting side).
  const deskBox = (d: (typeof floor.desks)[number]) => box(d.x - 42, d.y - 26 - (d.facing === "s" ? 30 : 0), 84, 52 + 30);
  // Imported workstations sit on their own furniture; checkFloor covers their seats.
  const drawn = floor.desks.filter((d) => !d.bare);
  for (const d of floor.desks.filter((x) => x.bare)) {
    const r = floor.rooms.find((x) => x.id === d.roomId)!;
    assert.ok(d.seat && d.seat.x > r.x && d.seat.x < r.x + r.w && d.seat.y > r.y && d.seat.y < r.y + r.h, `desk ${d.id}'s seat is outside ${r.name}`);
  }
  for (const a of drawn) {
    for (const b of drawn) if (a.id < b.id) assert.ok(!hit(box(a.x - 42, a.y - 26, 84, 52), box(b.x - 42, b.y - 26, 84, 52)), `desks ${a.id} and ${b.id} overlap`);
    for (const o of floor.objects) {
      if (["rug", "mat", "link", "note", "sign"].includes(o.type)) continue;
      assert.ok(!hit(deskBox(a), box(o.x, o.y, o.w, o.h)), `desk ${a.id} overlaps ${o.type} ${o.id}`);
    }
    const r = floor.rooms.find((x) => x.id === a.roomId)!;
    assert.ok(a.x - 42 >= r.x && a.x + 42 <= r.x + r.w && a.y - 56 >= r.y && a.y + 56 <= r.y + r.h, `desk ${a.id} pokes out of ${r.name}`);
  }
});

test("hearing: everyone in a room hears everyone in it, at full volume, wherever they stand", () => {
  // Every real room, opposite corners (just inside the walls), door open and shut, every range.
  for (const r of floor.rooms) {
    const a = { x: r.x + 40, y: r.y + 40, roomId: r.id };
    const b = { x: r.x + r.w - 40, y: r.y + r.h - 40, roomId: r.id };
    for (const range of Object.values(AUDIO_RANGES)) {
      assert.equal(volumeBetween(a, b, () => false, range), 1, `${r.id} open, range ${range}`);
      assert.equal(volumeBetween(a, b, (id) => id === r.id, range), 1, `${r.id} shut, range ${range}`);
    }
  }
  // Tech Support is the big one (960 wide): far corners still hear each other.
  const ts = floor.rooms.find((r) => r.id === "engineering")!;
  assert.ok(Math.hypot(ts.w, ts.h) > AUDIO_RANGES.large * 2, "the test room is bigger than any range");
});

test("hearing: on the open floor, voices carry one tile (80px) further than before", () => {
  assert.deepEqual(AUDIO_RANGES, { small: 180 + 80, normal: 260 + 80, large: 380 + 80 });
  const at = (x: number) => ({ x, y: 2000, roomId: null });
  // Normal: full volume out to 204px (~2.5 tiles), fading, silent from 340px.
  assert.equal(volumeBetween(at(1000), at(1000 + 200), () => false, AUDIO_RANGES.normal), 1);
  const v = volumeBetween(at(1000), at(1000 + 300), () => false, AUDIO_RANGES.normal);
  assert.ok(v > 0 && v < 1, `300px away fades (got ${v}); before, 300px was already silent`);
  assert.equal(volumeBetween(at(1000), at(1000 + 340), () => false, AUDIO_RANGES.normal), 0);
});
