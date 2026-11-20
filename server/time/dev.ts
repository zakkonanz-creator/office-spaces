// Local testing only (DEV_LOGIN=1, never production): wipe what a time-tracking test run
// creates, so it can run again from a clean slate. Only touches people whose
// email starts with "qa." and the test pay periods it's given.

import type { FastifyInstance } from "fastify";
import { config } from "../config";
import { q } from "../db";

export function registerTimeDevRoutes(app: FastifyInstance) {
  app.post("/api/dev/time-reset", async (req, reply) => {
    if (!config.devLogin || config.production) return reply.code(404).send();
    const periods = (((req.body ?? {}) as any).periods ?? []) as string[];
    if (!Array.isArray(periods) || !periods.every((p) => /^\d{4}-\d{2}$/.test(String(p)))) return reply.code(400).send({ error: "periods" });
    const ids = (await q<{ id: number }>(`SELECT id FROM users WHERE email LIKE 'qa.%'`)).map((r) => r.id);
    const emails = `email LIKE 'qa.%'`;
    for (const t of ["clock_events", "timesheet_weeks", "leave_requests", "leave_balances", "time_members", "grants", "swap_requests", "project_time", "leave_accruals"]) {
      const col = t === "swap_requests" ? "from_user" : "user_id";
      await q(`DELETE FROM ${t} WHERE ${col} = ANY($1::int[])`, [ids]);
    }
    await q(`DELETE FROM availability WHERE user_id = ANY($1::int[])`, [ids]);
    await q(`DELETE FROM leave_entitlements WHERE user_id = ANY($1::int[])`, [ids]);
    await q(`DELETE FROM locations WHERE name LIKE 'QA %'`);
    await q(`DELETE FROM shift_publications WHERE team LIKE 'QA %'`);
    await q(`DELETE FROM shifts WHERE team LIKE 'QA %' OR user_id = ANY($1::int[])`, [ids]);
    await q(`DELETE FROM adjustments WHERE ${emails}`);
    await q(`DELETE FROM pay_profiles WHERE ${emails}`);
    await q(`DELETE FROM pay_lines WHERE run_id IN (SELECT id FROM pay_runs WHERE period = ANY($1::text[]))`, [periods]);
    await q(`DELETE FROM pay_runs WHERE period = ANY($1::text[])`, [periods]);
    await q(`UPDATE users SET tz = NULL, role = 'member' WHERE email LIKE 'qa.%'`);
    return { ok: true, users: ids.length };
  });
}
