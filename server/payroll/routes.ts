// Access for time tracking: who is a time admin and who manages which team. The pay screens
// (profiles, adjustments, pay runs, exports) are not part of this edition; the paths keep the
// /api/payroll prefix so the time screens and grants stay as they were.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { one, q } from "../db";
import { isPayrollAdmin, listGrants, managedTeams, teamOf } from "./grants";
import { audit } from "./schema";


function signedIn(req: FastifyRequest, reply: FastifyReply) {
  const v = (req as any).viewer;
  if (v?.kind !== "user") {
    reply.code(401).send({ error: "sign in" });
    return null;
  }
  return v.user as { id: number; email: string; name: string };
}

async function payrollAdmin(req: FastifyRequest, reply: FastifyReply) {
  const u = signedIn(req, reply);
  if (!u) return null;
  if (!(await isPayrollAdmin(u.id))) {
    reply.code(403).send({ error: "payroll admins only" });
    return null;
  }
  return u;
}

export async function registerPayroll(app: FastifyInstance) {
  await app.register(async (scope) => {
    scope.get("/api/payroll/me", async (req, reply) => {
      const u = signedIn(req, reply);
      if (!u) return;
      const admin = await isPayrollAdmin(u.id);
      return { payrollAdmin: admin, managerOf: await managedTeams(u.id), team: await teamOf(u.id) };
    });


    // ── Grants ────────────────────────────────────────────────────────────
    scope.get("/api/payroll/grants", async (req, reply) => {
      if (!(await payrollAdmin(req, reply))) return;
      return (await listGrants()).map((g) => ({ ...g, grant: g.grant_kind }));
    });

    scope.post("/api/payroll/grants", async (req, reply) => {
      const actor = await payrollAdmin(req, reply);
      if (!actor) return;
      const b = (req.body ?? {}) as Record<string, any>;
      const uid = b.userId ?? b.user_id;
      const user = uid ? await one<{ id: number }>(`SELECT id FROM users WHERE id = $1`, [Number(uid)]) : await one<{ id: number }>(`SELECT id FROM users WHERE lower(email) = $1`, [String(b.email ?? "").toLowerCase()]);
      if (!user) return reply.code(400).send({ error: "they need to have signed in to Space once" });
      b.grant = b.grant ?? b.grant_kind;
      if (b.grant !== "payroll_admin" && b.grant !== "manager") return reply.code(400).send({ error: "grant must be payroll_admin or manager" });
      const team = b.grant === "manager" ? String(b.team ?? "").trim() : "";
      if (b.grant === "manager" && !team) return reply.code(400).send({ error: "a manager grant needs a team (or * for all)" });
      await q(`INSERT INTO grants (user_id, grant_kind, team, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [user.id, b.grant, team, actor.id]);
      await audit(actor.id, "grant", "grant", `${user.id}:${b.grant}:${team}`, null, { userId: user.id, grant: b.grant, team });
      return { ok: true };
    });

    scope.delete("/api/payroll/grants", async (req, reply) => {
      const actor = await payrollAdmin(req, reply);
      if (!actor) return;
      const src = { ...((req.body as any) ?? {}), ...((req.query as any) ?? {}) };
      const userId = src.userId ?? src.user_id;
      const grant = src.grant ?? src.grant_kind;
      const team = src.team;
      if (Number(userId) === actor.id && grant === "payroll_admin") return reply.code(400).send({ error: "you can't remove your own payroll access" });
      const gone = await q(`DELETE FROM grants WHERE user_id = $1 AND grant_kind = $2 AND team = $3 RETURNING user_id`, [Number(userId), grant, String(team ?? "")]);
      if (!gone.length) return reply.code(404).send({ error: "no such grant" });
      await audit(actor.id, "revoke", "grant", `${userId}:${grant}:${team ?? ""}`, { userId, grant, team }, null);
      return { ok: true };
    });

    scope.get("/api/payroll/audit", async (req, reply) => {
      if (!(await payrollAdmin(req, reply))) return;
      return { entries: await q(`SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor ORDER BY a.id DESC LIMIT 200`) };
    });
  });
}
