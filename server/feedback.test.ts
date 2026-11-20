import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReport, cleanContext } from "./feedback";

test("feedback: a report needs a kind and a few words", () => {
  assert.deepEqual(parseReport({ kind: "bug", title: "  Camera turns off  ", details: "in the kitchen" }), { kind: "bug", title: "Camera turns off", details: "in the kitchen" });
  assert.ok("error" in parseReport({ kind: "rant", title: "something" }));
  assert.ok("error" in parseReport({ kind: "idea", title: "no" }));
  assert.ok("error" in parseReport(null));
});

test("feedback: text is capped and control characters are stripped", () => {
  const r = parseReport({ kind: "idea", title: "x".repeat(500), details: "a\u0000b\nc" });
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.equal(r.title.length, 140);
  assert.equal(r.details, "a b\nc"); // newlines survive, NULs don't
});

test("feedback: browser context keeps only known fields, five errors at most", () => {
  const c = cleanContext({ path: "/", room: "Kitchen", errors: Array(9).fill("boom"), cookie: "secret", userAgent: 42 });
  assert.equal((c.errors as string[]).length, 5);
  assert.equal(c.room, "Kitchen");
  assert.equal(c.userAgent, "42");
  assert.ok(!("cookie" in c));
  assert.deepEqual(cleanContext("junk").errors, []);
});
