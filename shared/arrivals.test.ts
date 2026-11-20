import test from "node:test";
import assert from "node:assert/strict";
import { arrivalNote, BLIP_MS } from "./arrivals";

const me = { id: "1", role: "member", status: "available" };
const ana = { id: "2", name: "Ana Cruz", role: "member" };

test("arrivals: every time a teammate comes in, a note with their first name", () => {
  assert.equal(arrivalNote(ana, me, undefined, 1e9), "Ana is in");
  // Left an hour ago and back: that's a new arrival, not only the first one.
  assert.equal(arrivalNote(ana, me, 1e9 - 60 * 60e3, 1e9), "Ana is in");
});

test("arrivals: a reload or a blip is not an arrival", () => {
  assert.equal(arrivalNote(ana, me, 1e9 - 5000, 1e9), null);
  assert.equal(arrivalNote(ana, me, 1e9 - BLIP_MS + 1, 1e9), null);
});

test("arrivals: not for guests, not to guests, not while Focusing, not about yourself", () => {
  assert.equal(arrivalNote({ ...ana, role: "guest" }, me, undefined, 1e9), null);
  assert.equal(arrivalNote(ana, { ...me, role: "guest" }, undefined, 1e9), null);
  assert.equal(arrivalNote(ana, { ...me, status: "focusing" }, undefined, 1e9), null);
  assert.equal(arrivalNote({ ...ana, id: "1" }, me, undefined, 1e9), null);
  assert.equal(arrivalNote(ana, null, undefined, 1e9), null);
});
