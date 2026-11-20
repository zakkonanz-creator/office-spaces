import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeGhlUrl, parsePool, pickRoom } from "./ghlRooms";

test("ghl rooms: accepts a portal meeting link and keeps its password", () => {
  assert.equal(normalizeGhlUrl(" https://crm.example.com/meet/alex?pwd=abc123 "), "https://crm.example.com/meet/alex?pwd=abc123");
});

test("ghl rooms: a link copied from GHL without https:// still works", () => {
  assert.equal(normalizeGhlUrl("crm.example.com/meet/alex?pwd=abc"), "https://crm.example.com/meet/alex?pwd=abc");
  assert.deepEqual(parsePool("Huddle | crm.example.com/meet/a?pwd=1").rooms, [{ label: "Huddle", url: "https://crm.example.com/meet/a?pwd=1" }]);
});

test("ghl rooms: refuses links that aren't a meeting room", () => {
  for (const bad of ["http://crm.example.com/meet/alex", "https://crm.example.com/alex", "https://crm.example.com/meet/a/b", "javascript:alert(1)", "https://u:p@crm.example.com/meet/alex", "", 42]) {
    assert.equal(normalizeGhlUrl(bad), null, String(bad));
  }
});

test("ghl rooms: pool lines take an optional name, skip duplicates and report bad lines", () => {
  const { rooms, bad } = parsePool("Huddle | https://crm.example.com/meet/a?pwd=1\nhttps://crm.example.com/meet/b?pwd=2\nhttps://crm.example.com/meet/a?pwd=1\nnot a link\n");
  assert.deepEqual(rooms.map((r) => r.label), ["Huddle", "Team room 2"]);
  assert.deepEqual(bad, ["not a link"]);
});

test("ghl rooms: your own room wins, then the first free shared room", () => {
  const pool = parsePool("https://crm.example.com/meet/a\nhttps://crm.example.com/meet/b").rooms;
  assert.deepEqual(pickRoom("https://x.test/meet/me", pool, new Set([0, 1])), { ok: true, url: "https://x.test/meet/me", label: "your meeting room", pool: null });
  assert.equal(pickRoom(null, pool, new Set([0])).ok && (pickRoom(null, pool, new Set([0])) as any).pool, 1);
  assert.deepEqual(pickRoom(null, pool, new Set([0, 1])), { ok: false, reason: "all-busy" });
  assert.deepEqual(pickRoom(null, [], new Set()), { ok: false, reason: "no-room" });
});

test("ghl rooms: the admin import maps emails to links and reports bad lines", async () => {
  const { parseRoomLinks } = await import("./ghlRooms");
  const r = parseRoomLinks("Jay@example.com | crm.example.com/meet/jay?pwd=1\nnot an email | https://crm.example.com/meet/x\nann@x.com | https://example.com/nope");
  assert.deepEqual(r.links, { "jay@example.com": "https://crm.example.com/meet/jay?pwd=1" });
  assert.equal(r.bad.length, 2);
});
