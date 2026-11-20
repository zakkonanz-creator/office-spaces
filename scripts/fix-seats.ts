// Shows (or applies, with --write) what shared/seatFix.ts does to a floor file:
//   npx tsx scripts/fix-seats.ts [floor.json] [--dy 120] [--write]
// The server applies the same fix to the live floor by itself (server/floorStore.ts), so the
// layout file in this repo stays as it is: changing it would set aside every Designer version.
// --dy shifts the building first, the way "grow the building" does, to test a grown floor.

import { readFileSync, writeFileSync } from "node:fs";
import type { Floor } from "../shared/floor";
import { checkFloor } from "../shared/floorCheck";
import { fixSeats } from "../shared/seatFix";

const args = process.argv.slice(2);
const FILE = args.find((a) => a.endsWith(".json")) ?? "floor/demo-office.json";
const dy = Number(args[args.indexOf("--dy") + 1]) || 0;
const floor: Floor = JSON.parse(readFileSync(FILE, "utf8"));
if (dy && args.includes("--dy")) {
  floor.height += dy;
  floor.spawn.y += dy;
  for (const r of floor.rooms) r.y += dy;
  for (const d of floor.desks) { d.y += dy; if (d.seat) d.seat.y += dy; }
  for (const o of floor.objects) o.y += dy;
}

const before = checkFloor(floor).length;
for (const m of fixSeats(floor)) console.log(`${m.id.padEnd(18)} ${(m.owner ?? "").padEnd(26)} ${m.from.x},${m.from.y} → ${m.to.x},${m.to.y} (${m.side})`);
const problems = checkFloor(floor);
console.log(`\nproblems: ${before} before, ${problems.length} after`);
if (problems.length) console.log(`  ${problems.join("\n  ")}`);
if (args.includes("--write") && !problems.length) writeFileSync(FILE, JSON.stringify(floor, null, 1) + "\n");
process.exit(problems.length ? 1 : 0);
