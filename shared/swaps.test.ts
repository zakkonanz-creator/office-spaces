import { test } from "node:test";
import assert from "node:assert/strict";
import { outgoingSwapText, swapForShift, swapOpen } from "./swaps";

test("each swap step reads as a plain sentence, with the first name only", () => {
  assert.equal(outgoingSwapText("proposed", "Sam Rivera"), "Asked Sam — waiting");
  assert.equal(outgoingSwapText("accepted", "Sam Rivera"), "Sam accepted — waiting for your manager");
  assert.match(outgoingSwapText("declined", "Sam"), /^Sam declined/);
  assert.match(outgoingSwapText("approved", "Sam"), /Sam has this shift now/);
  assert.match(outgoingSwapText("rejected", "Sam"), /still yours/);
});

test("only proposed and accepted swaps are open", () => {
  assert.deepEqual(["proposed", "accepted", "declined", "approved", "rejected", "cancelled"].filter(swapOpen), ["proposed", "accepted"]);
});

test("a shift shows its open swap first, else the newest settled one, never a cancelled one", () => {
  const w = (id: number, shift_id: number, status: string, updated_at: string) => ({ id, shift_id, status, updated_at });
  const swaps = [w(1, 10, "declined", "2026-10-20T10:00:00Z"), w(2, 10, "proposed", "2026-10-19T10:00:00Z"), w(3, 11, "cancelled", "2026-10-21T10:00:00Z"), w(4, 12, "declined", "2026-10-18T10:00:00Z"), w(5, 12, "rejected", "2026-10-22T10:00:00Z")];
  assert.equal(swapForShift(swaps, 10)?.id, 2);
  assert.equal(swapForShift(swaps, 11), null);
  assert.equal(swapForShift(swaps, 12)?.id, 5);
  assert.equal(swapForShift(swaps, 99), null);
});
