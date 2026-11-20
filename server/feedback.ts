// Report a bug or an idea: the Report button in the office → this table.
//
// Teammates only (never guests). Nothing here posts anywhere. Admins read reports on
// Admin → Reports. Optionally, a bot of your own can poll /api/agent/feedback with
// FEEDBACK_AGENT_KEY (e.g. to file them in a Slack channel or try a fix on a branch) and
// write a status back, which shows on Admin → Reports.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { q, one } from "./db";
import { config } from "./config";

type User = { id: number; name: string; email: string; role: string };
type NeedUser = (req: FastifyRequest, reply: FastifyReply) => User | null;

export const FEEDBACK_KINDS = ["bug", "idea"] as const;
// The table is created in db.ts (migrate).
/** new → (agent) filed → fixing → fix_ready | no_fix; an admin can mark done / wont_do. */
export const FEEDBACK_STATUSES = ["new", "filed", "fixing", "fix_ready", "no_fix", "done", "wont_do"] as const;

const clean = (x: unknown, n: number) => String(x ?? "").replace(/[\u0000-\u0008\u000b-\u001f]+/g, " ").trim().slice(0, n);

/** What the browser sends along (all optional, all capped): where it happened and what broke. */
export function cleanContext(raw: unknown): Record<string, unknown> {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors = Array.isArray(c.errors) ? c.errors.slice(0, 5).map((e) => clean(e, 600)) : [];
  return {
    path: clean(c.path, 120),
    room: clean(c.room, 80),
    bundle: clean(c.bundle, 60),
    userAgent: clean(c.userAgent, 300),
    viewport: clean(c.viewport, 20),
    errors,
  };
}

/** A report from the form, or an error message for the person. */
export function parseReport(b: unknown): { kind: (typeof FEEDBACK_KINDS)[number]; title: string; details: string } | { error: string } {
  const o = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
  const kind = FEEDBACK_KINDS.find((k) => k === o.kind);
  if (!kind) return { error: "Pick Bug or Idea." };
  const title = clean(o.title, 140);
  const details = clean(o.details, 4000);
  if (title.length < 4) return { error: kind === "bug" ? "Say in a few words what went wrong." : "Say in a few words what you'd like." };
  return { kind, title, details };
}

function agentAuthorized(req: FastifyRequest): boolean {
  const key = config.feedbackAgentKey;
  if (key.length < 32) return false;
  const got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(key);
  return got.length === want.length && timingSafeEqual(got, want);
}

const perHour = new Map<number, number[]>();
const LIMIT = 10;

export function registerFeedback(app: FastifyInstance, needUser: NeedUser, needAdmin: NeedUser) {
  app.post("/api/feedback", async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return;
    const now = Date.now();
    const recent = (perHour.get(u.id) ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= LIMIT) return reply.code(429).send({ error: "That's a lot of reports in an hour. Message Alex on Slack if it's urgent." });
    const r = parseReport(req.body);
    if ("error" in r) return reply.code(400).send(r);
    recent.push(now);
    perHour.set(u.id, recent);
    const row = await one<{ id: number }>(
      `INSERT INTO feedback (kind, title, details, context, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [r.kind, r.title, r.details, JSON.stringify(cleanContext((req.body as any)?.context)), u.id],
    );
    req.log.info({ id: row?.id, kind: r.kind, by: u.name }, "feedback");
    return { ok: true, id: row?.id };
  });

  /** Your own reports and where they've got to. */
  app.get("/api/feedback/mine", async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return;
    return q(`SELECT id, kind, title, status, created_at FROM feedback WHERE user_id = $1 ORDER BY id DESC LIMIT 20`, [u.id]);
  });

  app.get("/api/admin/feedback", async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    return q(
      `SELECT f.id, f.kind, f.title, f.details, f.context, f.status, f.fix_branch, f.fix_pr_url, f.agent_note, f.created_at, f.updated_at, u.name AS by
         FROM feedback f LEFT JOIN users u ON u.id = f.user_id ORDER BY f.id DESC LIMIT 200`,
    );
  });

  app.patch("/api/admin/feedback/:id", async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const status = String((req.body as any)?.status ?? "");
    if (!["done", "wont_do", "new"].includes(status)) return reply.code(400).send({ error: "status must be done, wont_do or new" });
    const r = await one(`UPDATE feedback SET status = $1, updated_at = now() WHERE id = $2 RETURNING id`, [status, Number((req.params as any).id)]);
    return r ? { ok: true } : reply.code(404).send({ error: "no such report" });
  });

  // ── An optional bot (Bearer FEEDBACK_AGENT_KEY). Off until the key is set. ──

  app.get("/api/agent/feedback", async (req, reply) => {
    if (!agentAuthorized(req)) return reply.code(401).send({ error: "agent key" });
    const status = String((req.query as any)?.status ?? "new");
    if (!(FEEDBACK_STATUSES as readonly string[]).includes(status)) return reply.code(400).send({ error: "bad status" });
    return q(
      `SELECT f.id, f.kind, f.title, f.details, f.context, f.status, f.created_at, u.name AS by, u.email AS by_email
         FROM feedback f LEFT JOIN users u ON u.id = f.user_id WHERE f.status = $1 ORDER BY f.id LIMIT 20`,
      [status],
    );
  });

  app.post("/api/agent/feedback/:id", async (req, reply) => {
    if (!agentAuthorized(req)) return reply.code(401).send({ error: "agent key" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const status = String(b.status ?? "");
    if (!["filed", "fixing", "fix_ready", "no_fix"].includes(status)) return reply.code(400).send({ error: "bad status" });
    // `from` makes the claim atomic: two runs can't both pick up the same bug.
    const from = b.from ? String(b.from) : null;
    const r = await one(
      `UPDATE feedback SET status = $1, fix_branch = COALESCE($2, fix_branch), fix_pr_url = COALESCE($3, fix_pr_url),
              agent_note = COALESCE($4, agent_note), updated_at = now()
        WHERE id = $5 AND ($6::text IS NULL OR status = $6) RETURNING id`,
      [status, b.fix_branch ? clean(b.fix_branch, 120) : null, b.fix_pr_url ? clean(b.fix_pr_url, 300) : null,
       b.agent_note ? clean(b.agent_note, 2000) : null, Number((req.params as any).id), from],
    );
    return r ? { ok: true } : reply.code(409).send({ error: "not in that state" });
  });
}
