// Roles waiting for someone's first sign-in. An admin adds an email with the
// access it should get — Space admin, manager of a team, payroll admin, and the
// team they work in — and upsertUser applies it the moment that person first
// signs in. Before this, every role could only be given after a first sign-in.
//
// Pay stays separate: only payroll admins can
// pre-assign manager or payroll access, the same rule as /api/payroll/grants.
// Applied rows are kept (claimed_at) as the record of who set what.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { one, q } from "./db";
import { config } from "./config";
import { roleChanged } from "./onboarding";
import { isPayrollAdmin } from "./payroll/grants";
import { audit } from "./payroll/schema";

export interface Preassigned {
  email: string;
  role: "admin" | "member";
  manager_team: string | null;
  payroll_admin: boolean;
  team: string | null;
  created_by: number | null;
  created_at: string;
  claimed_at: string | null;
}

export async function migratePreassign() {
  await q(`CREATE TABLE IF NOT EXISTS preassigned_roles (
    email TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    manager_team TEXT,
    payroll_admin BOOLEAN NOT NULL DEFAULT FALSE,
    team TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_by INTEGER REFERENCES users(id),
    claimed_at TIMESTAMPTZ
  )`);
}

/** First sign-in: give a brand-new user what was set up for their email. Returns their role. */
export async function claimPreassigned(userId: number, email: string): Promise<"admin" | "member" | null> {
  const p = await one<Preassigned>(`SELECT * FROM preassigned_roles WHERE email = $1 AND claimed_at IS NULL`, [email.toLowerCase()]);
  if (!p) return null;
  await q(`UPDATE users SET role = $2 WHERE id = $1`, [userId, p.role]);
  if (p.role === "admin") {
    const by = p.created_by ? await one<{ id: number; name: string }>(`SELECT id, name FROM users WHERE id = $1`, [p.created_by]) : null;
    await roleChanged(userId, "member", "admin", by).catch((e) => console.error("role change", e));
  }
  if (p.payroll_admin) await q(`INSERT INTO grants (user_id, grant_kind, team, created_by) VALUES ($1, 'payroll_admin', '', $2) ON CONFLICT DO NOTHING`, [userId, p.created_by]);
  if (p.manager_team) await q(`INSERT INTO grants (user_id, grant_kind, team, created_by) VALUES ($1, 'manager', $2, $3) ON CONFLICT DO NOTHING`, [userId, p.manager_team, p.created_by]);
  if (p.team) {
    await q(`INSERT INTO time_members (user_id, team) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`, [userId, p.team]);
    await q(`INSERT INTO locations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [p.team]);
  }
  await q(`UPDATE preassigned_roles SET claimed_by = $2, claimed_at = now() WHERE email = $1`, [p.email, userId]);
  if (p.payroll_admin || p.manager_team) {
    await audit(p.created_by ?? userId, "grant", "grant", `${userId}:preassigned`, null, { userId, payrollAdmin: p.payroll_admin, managerTeam: p.manager_team }).catch(() => undefined);
  }
  return p.role;
}

const domainOk = (email: string) => !config.allowedDomains.length || config.allowedDomains.includes(email.split("@")[1] ?? "");

type Need = (req: FastifyRequest, reply: FastifyReply) => { id: number } | null;

export function registerPreassign(app: FastifyInstance, needAdmin: Need) {
  app.get("/api/admin/preassigned", async (req, reply) => {
    const admin = needAdmin(req, reply);
    if (!admin) return;
    const rows = await q(`SELECT p.*, u.name AS created_by_name FROM preassigned_roles p LEFT JOIN users u ON u.id = p.created_by ORDER BY p.claimed_at IS NOT NULL, p.created_at DESC LIMIT 200`);
    const teams = (await q<{ name: string }>(`SELECT name FROM locations ORDER BY name`)).map((r) => r.name);
    return { rows, teams, canGrantPay: await isPayrollAdmin(admin.id), domains: config.allowedDomains };
  });

  app.post("/api/admin/preassigned", async (req, reply) => {
    const admin = needAdmin(req, reply);
    if (!admin) return;
    const b = (req.body ?? {}) as { email?: string; role?: string; managerTeam?: string; payrollAdmin?: boolean; team?: string };
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply.code(400).send({ error: "That isn't an email address." });
    if (!domainOk(email)) return reply.code(400).send({ error: `They couldn't sign in: only ${config.allowedDomains.join(", ")} addresses can.` });
    const role = b.role === "admin" ? "admin" : "member";
    const managerTeam = String(b.managerTeam ?? "").trim().slice(0, 80) || null;
    const team = String(b.team ?? "").trim().slice(0, 80) || null;
    const payrollAdmin = Boolean(b.payrollAdmin);
    if ((managerTeam || payrollAdmin) && !(await isPayrollAdmin(admin.id))) {
      return reply.code(403).send({ error: "Only payroll admins can give manager or payroll access." });
    }
    if (await one(`SELECT 1 FROM users WHERE lower(email) = $1`, [email])) {
      return reply.code(409).send({ error: "They've already signed in — change their access in the Members table (role) or Payroll → Access." });
    }
    // Saving again replaces what was set; an applied row would have meant they'd signed in (caught above).
    await q(
      `INSERT INTO preassigned_roles (email, role, manager_team, payroll_admin, team, created_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE SET role = $2, manager_team = $3, payroll_admin = $4, team = $5, created_by = $6, created_at = now(), claimed_by = NULL, claimed_at = NULL`,
      [email, role, managerTeam, payrollAdmin, team, admin.id],
    );
    return { ok: true };
  });

  app.delete("/api/admin/preassigned/:email", async (req, reply) => {
    const admin = needAdmin(req, reply);
    if (!admin) return;
    const email = decodeURIComponent((req.params as any).email ?? "").toLowerCase();
    const row = await one<Preassigned>(`SELECT * FROM preassigned_roles WHERE email = $1 AND claimed_at IS NULL`, [email]);
    if (!row) return reply.code(404).send({ error: "Nothing waiting for that email." });
    if ((row.manager_team || row.payroll_admin) && !(await isPayrollAdmin(admin.id))) {
      return reply.code(403).send({ error: "Only payroll admins can change manager or payroll access." });
    }
    await q(`DELETE FROM preassigned_roles WHERE email = $1 AND claimed_at IS NULL`, [email]);
    return { ok: true };
  });
}
