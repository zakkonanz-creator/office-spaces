import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNotice, pickRocks, quarterOf } from "./jumbotron";
import { checkFloor, svgProblems } from "../shared/floorCheck";
import { readFileSync } from "node:fs";
import type { Floor } from "../shared/floor";

// One message per new client in the channel (names made up).
const notice = (who: string, email: string, ...rest: string[]) =>
  [who, `<mailto:${email}|${email}>`, "<tel:(555)000-0000|(555) 000-0000>", ...rest, "Account ID: abc", "Notes:"].join("\n");

test("a new-client post gives the client, their company domain and the product", () => {
  assert.deepEqual(parseNotice(notice("Pat Example", "pat@acme-agency.com", "Pro Plan", "Monthly")), { name: "Pat Example", company: "acme-agency.com", product: "Pro Plan" });
});

test("free-mail domains aren't a company, and billing periods aren't a product", () => {
  assert.deepEqual(parseNotice(notice("Sam Example", "sam@gmail.com", "Monthly", "Starter")), { name: "Sam Example", company: null, product: "Starter" });
});

test("plain-text phones and emails never become the product", () => {
  const t = ["Jo Example", "jo@example.ceo", "+61 408 000 000", "", "Account ID:"].join("\n");
  assert.deepEqual(parseNotice(t), { name: "Jo Example", company: "example.ceo", product: null });
  const t2 = ["*Jo Example*", "<mailto:jo@example.com|jo@example.com>", "+33 7 69 00 00 00", "Quickstart Package"].join("\n");
  assert.deepEqual(parseNotice(t2), { name: "Jo Example", company: "example.com", product: "Quickstart Package" });
});

test("posts that don't start with a name are ignored", () => {
  assert.equal(parseNotice("<https://example.com|a link>"), null);
  assert.equal(parseNotice("someone@example.com"), null);
  assert.equal(parseNotice(""), null);
});

const page = (title: string, quarter: string | null, status: string) => ({
  properties: {
    Name: { type: "title", title: [{ plain_text: title }] },
    Status: { type: "status", status: { name: status } },
    Owner: { type: "people", people: [{ name: "Alex" }] },
    ...(quarter ? { Quarter: { type: "select", select: { name: quarter } } } : {}),
  },
});

test("rocks: only this quarter's, and not the finished ones", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  assert.equal(quarterOf(now), "Q4 2026");
  const got = pickRocks([page("Launch v2", "Q4 2026", "On Track"), page("Old rock", "Q3 2026", "On Track"), page("Shipped", "Q4", "Done")], now);
  assert.deepEqual(got, [{ title: "Launch v2", owner: "Alex", status: "On Track" }]);
});

test("rocks with no Quarter property are all shown (minus finished)", () => {
  assert.equal(pickRocks([page("A", null, "On Track"), page("B", null, "Complete")]).length, 1);
});

test("a custom drawing must be plain shapes: no script, links, images or outside references", () => {
  const ok = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="60" height="40" fill="url(#g)"/><text x="4" y="20">Hi</text></svg>`;
  assert.deepEqual(svgProblems("x", ok), []);
  for (const bad of [
    `<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>`,
    `<svg viewBox="0 0 1 1"><rect onclick="x()"/></svg>`,
    `<svg viewBox="0 0 1 1"><a href="https://evil.example"><rect/></a></svg>`,
    `<svg viewBox="0 0 1 1"><image href="https://x/y.png"/></svg>`,
    `<svg viewBox="0 0 1 1"><rect fill="url(https://x/y)"/></svg>`,
    `<svg viewBox="0 0 1 1"><foreignObject><div/></foreignObject></svg>`,
    `<div>not svg</div>`,
    `<svg><rect/></svg>`,
  ]) assert.ok(svgProblems("x", bad).length, bad);
  assert.ok(svgProblems("x", undefined).length);
});

test("the floor check accepts a wall-mounted jumbotron and a safe custom piece", () => {
  const floor: Floor = JSON.parse(readFileSync(new URL("../floor/demo-office.json", import.meta.url), "utf8"));
  const before = checkFloor(floor).length;
  const ob = floor.rooms.find((r) => r.id === "team-north")!;
  floor.objects.push({ id: "j1", type: "jumbotron", x: ob.x + 240, y: ob.y + 4, w: 320, h: 110 });
  floor.objects.push({ id: "c1", type: "custom", x: 40, y: 40, w: 40, h: 40, label: "trophy", svg: `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#e2a53a"/></svg>` });
  assert.equal(checkFloor(floor).length, before);
  floor.objects.push({ id: "c2", type: "custom", x: 40, y: 90, w: 40, h: 40 });
  assert.ok(checkFloor(floor).some((p) => p.includes("c2")));
});

test("admin edits: hide an item, add by hand, switch a section off — teammates see the result, admins can undo", async () => {
  const { applyEdit, view } = await import("./jumbotron");
  const board: any = { values: [{ name: "A", line: "a" }], priorities: [], onboarding: [{ name: "Test Person", company: null, product: null, state: "waiting", at: 1 }], sales: [], reviews: [], rating: null, dates: [], updated: {}, errors: {} };
  let e: any = { hidden: [], dates: [], priorities: [], reviews: [], values: null, off: [] };
  e = applyEdit(e, { op: "hide", key: "onboarding:Test Person|1" });
  e = applyEdit(e, { op: "add", section: "dates", item: { date: "2099-01-01", label: "Launch" } });
  e = applyEdit(e, { op: "add", section: "priorities", item: { title: "Ship it", owner: "Alex", status: "" } });
  e = applyEdit(e, { op: "section", section: "values", on: false });
  const team: any = view(board, e, false);
  assert.equal(team.onboarding.length, 0);
  assert.equal(team.dates[0].label, "Launch");
  assert.equal(team.priorities[0].title, "Ship it");
  assert.equal(team.values.length, 0);
  const admin: any = view(board, e, true);
  assert.equal(admin.onboarding[0].hidden, true);
  assert.equal(admin.values.length, 1);
  assert.deepEqual(admin.off, ["values"]);
  e = applyEdit(e, { op: "remove", key: admin.dates[0].key });
  assert.equal(view(board, e, false).dates.length, 0);
  assert.throws(() => applyEdit(e, { op: "add", section: "dates", item: { date: "soon", label: "x" } }));
  assert.throws(() => applyEdit(e, { op: "values", values: [] }));
  e = applyEdit(e, { op: "values", values: [{ name: "New", line: "n" }] });
  assert.equal((view(board, e, false) as any).values.length, 0); // still switched off
  e = applyEdit(e, { op: "section", section: "values", on: true });
  assert.equal((view(board, e, false) as any).values[0].name, "New");
});
