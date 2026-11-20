import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ??= "x".repeat(40);
const { applyChange, autoOpen, progress, tellNewAdmin, tellNewMember, memberTourText, MEMBER_STEPS, ADMIN_STEPS, PAYROLL_STEPS } = await import("./onboarding");

test("onboarding: a step is recorded once, with the first time it happened", () => {
  const a = applyChange({}, { track: "member", step: "move" }, 100);
  const b = applyChange(a, { track: "member", step: "move" }, 200);
  assert.equal(b.member!.done.move, 100);
  assert.deepEqual(progress(b, "member"), { done: 1, of: MEMBER_STEPS.length, finished: false, hidden: false });
});

test("onboarding: unknown tracks and steps are refused, not stored", () => {
  assert.throws(() => applyChange({}, { track: "member", step: "payroll" }));
  assert.throws(() => applyChange({}, { track: "member", step: "__proto__" }));
  assert.throws(() => applyChange({}, { track: "boss" as any }));
  // A member step is not an admin step, and each Time tour has its own.
  assert.throws(() => applyChange({}, { track: "admin", step: "move" }));
  assert.throws(() => applyChange({}, { track: "payroll", step: "approvals" }));
  let p = {};
  for (const s of PAYROLL_STEPS) p = applyChange(p, { track: "payroll", step: s });
  assert.equal(progress(p, "payroll").finished, true);
});

test("onboarding: the last step finishes the track, and finishing sticks", () => {
  let o = {};
  for (const s of ADMIN_STEPS) o = applyChange(o, { track: "admin", step: s }, 5);
  assert.equal(progress(o, "admin").finished, true);
  assert.equal(autoOpen(o, "admin", true), false);
  // Tracks are independent.
  assert.equal(progress(o, "member").done, 0);
});

test("onboarding: auto-opens only for eligible people who haven't finished or hidden it", () => {
  assert.equal(autoOpen({}, "member", true), true);
  assert.equal(autoOpen({}, "member", false), false);
  const hidden = applyChange({}, { track: "member", dismiss: true });
  assert.equal(autoOpen(hidden, "member", true), false);
  // Starting over from Help clears progress and the hide.
  const again = applyChange(applyChange(hidden, { track: "member", step: "desk" }), { track: "member", reset: true });
  assert.deepEqual(again.member, { done: {} });
  assert.equal(autoOpen(again, "member", true), true);
});

test("onboarding: an admin set up before their first sign-in still gets the Slack DM", async () => {
  const calls: string[] = [];
  const deps = {
    lookup: async (email: string) => { calls.push(`lookup ${email}`); return { id: "U123" }; },
    save: async (id: number, sid: string) => { calls.push(`save ${id} ${sid}`); },
    dm: async (sid: string, text: string) => { calls.push(`dm ${sid}`); assert.match(text, /^Alex made you an admin/); assert.match(text, /\/admin\/members\?tour=1/); },
  };
  // No Slack id yet: looked up by email, stored, then DM'd.
  assert.equal(await tellNewAdmin({ id: 7, email: "new@example.com", slack_id: null }, { name: "Alex Admin" }, deps), true);
  assert.deepEqual(calls, ["lookup new@example.com", "save 7 U123", "dm U123"]);
  // Already known: no lookup.
  calls.length = 0;
  assert.equal(await tellNewAdmin({ id: 7, email: "new@example.com", slack_id: "U9" }, { name: "Alex" }, deps), true);
  assert.deepEqual(calls, ["dm U9"]);
  // Not on Slack: nothing sent, nothing stored.
  calls.length = 0;
  assert.equal(await tellNewAdmin({ id: 8, email: "x@example.com", slack_id: null }, null, { ...deps, lookup: async () => null }), false);
  assert.deepEqual(calls, []);
});

test("onboarding: a newcomer gets the first-day tour on Slack, with every checklist step", async () => {
  const sent: [string, string][] = [];
  const deps = {
    lookup: async () => ({ id: "U77" }),
    save: async () => {},
    dm: async (sid: string, text: string) => { sent.push([sid, text]); },
  };
  assert.equal(await tellNewMember({ id: 3, email: "noor@example.org", slack_id: null, name: "Noor Haddad" }, deps), true);
  assert.equal(sent.length, 1);
  const [sid, text] = sent[0];
  assert.equal(sid, "U77");
  assert.match(text, /Welcome to Proximity Office, Noor!/);
  // One numbered line per checklist step, in the checklist's order.
  assert.equal((text.match(/^\d\. \*/gm) ?? []).length, MEMBER_STEPS.length);
  for (const w of ["Walk around", "Go to your desk", "interrupted", "Say hi", "private conversation", "Find a teammate", "Clock in"]) assert.ok(text.includes(w), w);
  assert.ok(text.includes("silence the office for you"));
  // Not on Slack: nothing sent.
  sent.length = 0;
  assert.equal(await tellNewMember({ id: 4, email: "x@example.com", slack_id: null, name: "X" }, { ...deps, lookup: async () => null }), false);
  assert.equal(sent.length, 0);
  assert.equal(memberTourText("Alex Admin", "https://space.example").includes("https://space.example/time"), true);
});
