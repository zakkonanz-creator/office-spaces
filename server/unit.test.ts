import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

process.env.SESSION_SECRET ??= "x".repeat(40);
const secret = `whsec_${randomBytes(24).toString("base64")}`;
process.env.FATHOM_WEBHOOK_SECRETS = `whsec_${randomBytes(24).toString("base64")},${secret}`;

const { verifyFathom } = await import("./fathom");
const { nameMatches, sign, verify, seal, unseal, safeNext } = await import("./auth");
const { toCsv } = await import("./analytics");

function signed(body: string, at = Math.floor(Date.now() / 1000), key = secret) {
  const id = "msg_123";
  const mac = createHmac("sha256", Buffer.from(key.replace(/^whsec_/, ""), "base64")).update(`${id}.${at}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": `v1,bogus v1,${mac}` };
}

test("Fathom webhook: a correct signature from any configured secret passes", () => {
  const body = JSON.stringify({ meeting_title: "Office Spaces · Sales · 14:00 UTC" });
  assert.equal(verifyFathom(signed(body), body), true);
});

test("Fathom webhook: tampered body, wrong secret, stale timestamp, missing headers all fail", () => {
  const body = JSON.stringify({ a: 1 });
  assert.equal(verifyFathom(signed(body), body + " "), false);
  assert.equal(verifyFathom(signed(body, undefined, `whsec_${randomBytes(24).toString("base64")}`), body), false);
  assert.equal(verifyFathom(signed(body, Math.floor(Date.now() / 1000) - 3600), body), false);
  assert.equal(verifyFathom({}, body), false);
});

test("roster names match Google display names the way people actually write them", () => {
  assert.ok(nameMatches("Alex Admin", "Alex Admin"));
  assert.ok(nameMatches("Diego Ramós", "Diego Ramos Vidal"));
  assert.ok(nameMatches("Jay Rivers", "Jay (Jason) Rivers"));
  assert.ok(nameMatches("Robin", "Robin"));
  assert.ok(!nameMatches("Robin Khan", "Robin"), "one-word roster names need an exact match");
  assert.ok(!nameMatches("Casey Gray", "Alex Admin"));
  assert.ok(!nameMatches("Omar Aziz", "Owen Aziz"), "same surname, different first name");
});

test("signed tokens: round-trip, tamper, expiry; sealed tokens round-trip", () => {
  const t = sign("session", { u: 7, exp: Date.now() + 1000 });
  assert.equal(verify<{ u: number }>("session", t)?.u, 7);
  assert.equal(verify("session", t.slice(0, -2) + "xx"), null);
  assert.equal(verify("session", sign("session", { u: 7, exp: Date.now() - 1 })), null);
  // An OAuth state carrying u:7 must never work as a session cookie for user 7.
  assert.equal(verify("session", sign("oauth", { u: 7, exp: Date.now() + 1000 })), null);
  assert.equal(verify("session", sign("guest-link", { i: 1 })), null);
  assert.equal(unseal(seal("1//refresh-token")), "1//refresh-token");
});

test("CSV splits a stretch that crosses local midnight into two days", () => {
  // 23:00 → 01:30 in Karachi (UTC+5) on 2026-10-07/08.
  const start = Date.UTC(2026, 9, 7, 18, 0);
  const end = Date.UTC(2026, 9, 7, 20, 30);
  const csv = toCsv([{ id: 1, name: "Test, Person", email: "t@example.org", role: "member", segments: [{ status: "available", start, end }], totals: { available: end - start, focusing: 0, away: 0 } }], "Asia/Karachi");
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[1], `2026-10-07,"Test, Person",t@example.org,member,60,0,0,60`);
  assert.equal(lines[2], `2026-10-08,"Test, Person",t@example.org,member,90,0,0,90`);
});

test("post-sign-in redirects stay on this site", () => {
  assert.equal(safeNext("/admin/members?x=1"), "/admin/members?x=1");
  for (const bad of ["/.//evil.com", "/..//evil.com", "/a/..//evil.com", "/%2e//evil.com", "//evil.com", "/\\evil.com", "/%5Cevil.com", "https://evil.com", "\\\\evil.com", "javascript:alert(1)", 42, undefined]) {
    const out = safeNext(bad);
    assert.ok(out === "/" || (out.startsWith("/") && !out.startsWith("//") && !out.includes("\\")), `${String(bad)} → ${out}`);
    assert.ok(!new URL(out, "https://app.example").host.includes("evil"), `${String(bad)} escapes to ${out}`);
  }
});
