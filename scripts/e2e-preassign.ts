// Access set up for an email before its first sign-in (server/preassign.ts):
//   npm run dev   (in another terminal)
//   npx tsx scripts/e2e-preassign.ts
// An admin pre-assigns Admin + manager + payroll admin + a team to an email
// nobody has used; that person signs in for the first time and has all of it.

import { request } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:8787";
let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};
const login = async (email: string, name: string) => {
  const ctx = await request.newContext({ baseURL: BASE });
  await ctx.get(`/auth/dev?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`, { maxRedirects: 0 });
  return ctx;
};

const alex = await login("admin@example.com", "Alex Admin");
const fresh = `pre-${Date.now()}@example.com`;
const team = "Preassign Test Team";
await alex.post("/api/time/locations", { data: { name: team } });

let r = await alex.post("/api/admin/preassigned", { data: { email: fresh, role: "admin", managerTeam: team, payrollAdmin: true, team } });
ok(r.ok(), `Alex sets up ${fresh} before they've ever signed in (${r.status()})`);
r = await alex.post("/api/admin/preassigned", { data: { email: "someone@gmail.com", role: "admin" } });
ok(r.status() === 400 && /couldn't sign in/.test((await r.json()).error), "An email that can't sign in is refused, with the reason");
r = await alex.post("/api/admin/preassigned", { data: { email: "admin@example.com", role: "member" } });
ok(r.status() === 409, "Someone who has already signed in is sent to the Members table instead");
let list = await (await alex.get("/api/admin/preassigned")).json();
ok(list.rows.some((x: any) => x.email === fresh && !x.claimed_at), "They're listed as waiting for first sign-in");

const them = await login(fresh, "Pre Assigned");
const me = await (await them.get("/api/me")).json();
ok(me.role === "admin", `First sign-in: they're an Admin (${me.role})`);
const grants = await (await alex.get("/api/payroll/grants")).json();
const mine = (Array.isArray(grants) ? grants : grants.grants ?? []).filter((g: any) => g.email === fresh);
ok(mine.some((g: any) => g.grant_kind === "manager" && g.team === team), "…a manager of their team");
ok(mine.some((g: any) => g.grant_kind === "payroll_admin"), "…and a payroll admin");
ok((await them.get("/api/admin/members")).ok(), "…so the admin pages open for them");
list = await (await alex.get("/api/admin/preassigned")).json();
ok(list.rows.some((x: any) => x.email === fresh && x.claimed_at), "The row is kept, marked applied");

// An office admin who isn't a payroll admin can't hand out manager or pay access.
const plainAdminEmail = `pre-admin-${Date.now()}@example.com`;
await alex.post("/api/admin/preassigned", { data: { email: plainAdminEmail, role: "admin" } });
const plainAdmin = await login(plainAdminEmail, "Plain Admin");
r = await plainAdmin.post("/api/admin/preassigned", { data: { email: `x-${Date.now()}@example.com`, role: "member", payrollAdmin: true } });
ok(r.status() === 403, "An office admin without payroll access can't pre-assign payroll admin");
r = await plainAdmin.post("/api/admin/preassigned", { data: { email: `y-${Date.now()}@example.com`, role: "admin" } });
ok(r.ok(), "…but can pre-assign Admin");

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
