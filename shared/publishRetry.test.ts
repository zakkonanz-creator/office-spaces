import { test } from "node:test";
import assert from "node:assert/strict";
import { publishOnceReconnected } from "./publishRetry";

const e408 = () => Object.assign(new Error("publishing rejected as engine not connected within timeout"), { status: 408 });

test("publish retry: a 408 while the signal socket reconnects is retried once the room is back", async () => {
  let calls = 0;
  let connected = false;
  setTimeout(() => (connected = true), 30);
  const r = await publishOnceReconnected(async () => { calls++; if (calls === 1) throw e408(); return "ok"; }, () => connected, { stepMs: 5 });
  assert.equal(r, "ok");
  assert.equal(calls, 2);
  assert.equal(connected, true, "waited for the reconnect before the second try");
});

test("publish retry: only one retry, and the second failure surfaces", async () => {
  let calls = 0;
  await assert.rejects(publishOnceReconnected(async () => { calls++; throw e408(); }, () => true), /engine not connected/);
  assert.equal(calls, 2);
});

test("publish retry: other errors are not retried (a busy mic must still be reported)", async () => {
  let calls = 0;
  await assert.rejects(publishOnceReconnected(async () => { calls++; throw new Error("NotReadableError"); }, () => true), /NotReadableError/);
  assert.equal(calls, 1);
});

test("publish retry: gives up waiting after waitMs and still tries once more", async () => {
  let calls = 0;
  const t0 = Date.now();
  const r = await publishOnceReconnected(async () => { calls++; if (calls === 1) throw e408(); return "late"; }, () => false, { waitMs: 40, stepMs: 5 });
  assert.equal(r, "late");
  assert.ok(Date.now() - t0 >= 35);
});
