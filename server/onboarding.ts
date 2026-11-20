// Getting started: the first-day checklist every teammate gets, and the tour a
// new admin gets. Progress lives on the user row (users.onboarding) so it follows
// them across browsers. Steps tick themselves from what people actually do in
// the office; the server only records them, it never infers them.
//
// Who sees what:
//  - the teammate checklist opens by itself for people new to the office
//    (first arrived in the last 14 days); everyone else can start it from Help.
//  - the admin tour opens by itself for anyone *made* an admin (Members table or
//    set up before sign-in), not for ADMIN_EMAILS admins who were there first.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config";
import { getSetting, one, q, setSetting } from "./db";
import { slackDm, slackProfile } from "./slack";
import type { UserRow } from "./auth";

export const MEMBER_STEPS = ["move", "desk", "status", "talk", "door", "find", "clock"] as const;
export const ADMIN_STEPS = ["members", "guests", "analytics", "settings", "designer", "rules"] as const;
// Time & Payroll (the Deputy replacement): one tour per screen, for whoever can open it.
export const TIME_STEPS = ["clock", "week", "leave", "shifts", "unavailable"] as const;
export const MANAGER_STEPS = ["overview", "approvals", "timesheets", "schedule", "people", "rules"] as const;
export const PAYROLL_STEPS = ["runs", "adjustments", "profiles", "access", "rules"] as const;
export type Track = "member" | "admin" | "time" | "manager" | "payroll";

export interface TrackState {
  /** step → when it was first done (ms) */
  done: Record<string, number>;
  dismissedAt?: number;
  finishedAt?: number;
}
export type Onboarding = Partial<Record<Track, TrackState>>;

const STEPS: Record<Track, readonly string[]> = { member: MEMBER_STEPS, admin: ADMIN_STEPS, time: TIME_STEPS, manager: MANAGER_STEPS, payroll: PAYROLL_STEPS };
const NEW_DAYS = 14;

export interface Change {
  track: Track;
  step?: string;
  dismiss?: boolean;
  /** Start over (from Help): clears the track's progress. */
  reset?: boolean;
}

/** Applies one change to someone's progress. Unknown tracks/steps are refused, never stored. */
export function applyChange(cur: Onboarding, c: Change, now = Date.now()): Onboarding {
  if (!STEPS[c.track]) throw new Error("unknown track");
  if (c.step !== undefined && !STEPS[c.track].includes(c.step)) throw new Error("unknown step");
  const t: TrackState = c.reset ? { done: {} } : { done: { ...(cur[c.track]?.done ?? {}) }, ...pick(cur[c.track]) };
  if (c.step && !t.done[c.step]) t.done[c.step] = now;
  if (c.dismiss) t.dismissedAt = now;
  if (!t.finishedAt && STEPS[c.track].every((s) => t.done[s])) t.finishedAt = now;
  return { ...cur, [c.track]: t };
}
const pick = (t?: TrackState) => (t ? { dismissedAt: t.dismissedAt, finishedAt: t.finishedAt } : {});

/** Should the track open by itself? Never once finished or dismissed. */
export function autoOpen(o: Onboarding, track: Track, eligible: boolean): boolean {
  const t = o[track];
  return eligible && !t?.finishedAt && !t?.dismissedAt;
}

export const progress = (o: Onboarding, track: Track) => {
  const done = STEPS[track].filter((s) => o[track]?.done?.[s]).length;
  return { done, of: STEPS[track].length, finished: Boolean(o[track]?.finishedAt), hidden: Boolean(o[track]?.dismissedAt) };
};

export async function migrateOnboarding() {
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding JSONB NOT NULL DEFAULT '{}'`);
  // Set when someone is *made* an admin; cleared when they stop being one. Drives the admin tour.
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_since TIMESTAMPTZ`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_granted_by INTEGER`);
  // The first time someone walked onto the floor (not signed in: walked in).
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_office_at TIMESTAMPTZ`);
  // Everyone already using the office on the day this shipped has arrived: no welcome broadcast,
  // and the checklist doesn't open by itself for them (it's in Help if they want it).
  if (!(await getSetting("onboarding_backfilled", false))) {
    await q(`UPDATE users SET first_office_at = COALESCE(last_seen, created_at),
                              onboarding = jsonb_set(onboarding, '{member}', jsonb_build_object('done', '{}'::jsonb, 'dismissedAt', $1::bigint))
              WHERE first_office_at IS NULL AND last_seen IS NOT NULL`, [Date.now()]);
    await setSetting("onboarding_backfilled", true);
  }
}

/** Their first time on the floor? Records it, once. True only for that one call. */
export async function firstArrival(userId: number): Promise<boolean> {
  return Boolean(await one(`UPDATE users SET first_office_at = now() WHERE id = $1 AND first_office_at IS NULL RETURNING id`, [userId]));
}

/**
 * A role change from the Members table or a pre-set role. Made admin → start the
 * tour and DM them where it is; no longer admin → clear it.
 */
export async function roleChanged(userId: number, from: string, to: string, by: { id: number; name: string } | null) {
  if (from === to) return;
  if (to !== "admin") {
    await q(`UPDATE users SET admin_since = NULL, admin_granted_by = NULL WHERE id = $1`, [userId]);
    return;
  }
  // A second promotion re-runs the tour: the office may have changed since.
  const u = await one<{ email: string; slack_id: string | null; onboarding: Onboarding }>(
    `UPDATE users SET admin_since = now(), admin_granted_by = $2,
            onboarding = onboarding - 'admin'
      WHERE id = $1 RETURNING email, slack_id, onboarding`,
    [userId, by?.id ?? null],
  );
  // Not awaited: a pre-set admin gets here during sign-in, and Slack must never slow that down.
  if (u) void tellNewAdmin({ id: userId, email: u.email, slack_id: u.slack_id }, by).catch((e) => console.error("admin dm:", e));
}

interface SlackDeps {
  lookup: (email: string) => Promise<{ id: string } | null>;
  dm: (slackId: string, text: string) => Promise<unknown>;
  save: (userId: number, slackId: string) => Promise<unknown>;
}
const slackDeps: SlackDeps = {
  lookup: slackProfile,
  dm: slackDm,
  save: (userId, slackId) => q(`UPDATE users SET slack_id = $1 WHERE id = $2 AND slack_id IS NULL`, [slackId, userId]),
};

/**
 * DM a new admin where the tour is. Someone set up before their first sign-in has
 * no Slack id yet (sign-in looks it up after this), so look it up by email here.
 */
export async function tellNewAdmin(u: { id: number; email: string; slack_id: string | null }, by: { name: string } | null, deps: SlackDeps = slackDeps): Promise<boolean> {
  let slackId = u.slack_id;
  if (!slackId) {
    slackId = (await deps.lookup(u.email))?.id ?? null;
    if (!slackId) return false;
    await deps.save(u.id, slackId);
  }
  const who = by ? `${by.name.split(" ")[0]} made you` : "You're now";
  await deps.dm(
    slackId,
    `${who} an admin of Proximity Office. That means Members, guest links, analytics and the Office Designer. ` +
      `Here's the 3-minute admin tour: ${config.publicUrl}/admin/members?tour=1`,
  );
  return true;
}

/** The first-day checklist, as a Slack message. Same steps as the in-office checklist (Onboarding.tsx). */
export function memberTourText(name: string, url = config.publicUrl): string {
  return [
    `👋 Welcome to Proximity Office, ${name.split(" ")[0]}! It works like a real office: walk up to someone and you can hear each other, walk away and the sound fades.`,
    ``,
    `*Your first-day checklist* (it's also in the office, under Help → Getting started, and it ticks itself as you go):`,
    `1. *Walk around.* Arrow keys or WASD, or double-click anywhere on the floor.`,
    `2. *Go to your desk.* Press H to walk back to it from anywhere. No desk yet? Click a desk without a name and choose Make this my desk.`,
    `3. *Say if you can be interrupted.* Press 3 for Available, 4 for Away, 5 for Focusing (Focusing and Away mute your mic, turn your camera off and silence the office for you; unmute to talk to someone who walks up). Add a note like "On a call till 2".`,
    `4. *Say hi to someone.* Walk up to a teammate until you can hear them.`,
    `5. *Have a private conversation.* Walk into a room and press O to close the door. People outside can't hear you; they knock and you let them in.`,
    `6. *Find a teammate.* Press F, type a name, press Enter, and you're next to them.`,
    `7. *Clock in for your shift.* Being in the office never clocks you in: use the clock in the bottom bar, or ${url}/time on your phone.`,
    ``,
    `Press ? in the office for every shortcut. Open the office: ${url}`,
  ].join("\n");
}

/** DM a teammate the tour on their first time in the office. Not on Slack → nothing sent. */
export async function tellNewMember(u: { id: number; email: string; slack_id: string | null; name: string }, deps: SlackDeps = slackDeps): Promise<boolean> {
  let slackId = u.slack_id;
  if (!slackId) {
    slackId = (await deps.lookup(u.email))?.id ?? null;
    if (!slackId) return false;
    await deps.save(u.id, slackId);
  }
  await deps.dm(slackId, memberTourText(u.name));
  return true;
}

type Need = (req: FastifyRequest, reply: FastifyReply) => UserRow | null;

export function registerOnboarding(app: FastifyInstance, needUser: Need) {
  app.get("/api/onboarding", async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return;
    const r = await one<{ onboarding: Onboarding; first_office_at: string | null; admin_since: string | null; granted_by: string | null }>(
      `SELECT u.onboarding, u.first_office_at, u.admin_since, g.name AS granted_by
         FROM users u LEFT JOIN users g ON g.id = u.admin_granted_by WHERE u.id = $1`,
      [u.id],
    );
    const o = r?.onboarding ?? {};
    const isNew = !r?.first_office_at || Date.now() - new Date(r.first_office_at).getTime() < NEW_DAYS * 864e5;
    return {
      member: { ...progress(o, "member"), done: o.member?.done ?? {}, autoOpen: autoOpen(o, "member", isNew) },
      admin: u.role === "admin"
        ? { ...progress(o, "admin"), done: o.admin?.done ?? {}, autoOpen: autoOpen(o, "admin", Boolean(r?.admin_since)), since: r?.admin_since ?? null, grantedBy: r?.granted_by ?? null }
        : null,
      // Whoever opens Time, Team or Payroll for the first time gets that screen's tour; the client
      // only shows the ones the person can open (Team for managers, Payroll for payroll admins).
      ...Object.fromEntries((["time", "manager", "payroll"] as const).map((t) => [t, { ...progress(o, t), done: o[t]?.done ?? {}, autoOpen: autoOpen(o, t, true) }])),
    };
  });

  app.post("/api/onboarding", async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return;
    const b = (req.body ?? {}) as Change;
    if (typeof b.track !== "string" || !Object.hasOwn(STEPS, b.track)) return reply.code(400).send({ error: "unknown track" });
    if (b.step !== undefined && typeof b.step !== "string") return reply.code(400).send({ error: "unknown step" });
    if (b.track === "admin" && u.role !== "admin") return reply.code(403).send({ error: "admins only" });
    // Read-modify-write in one statement's transaction would need a lock; steps only
    // ever add, so a lost race costs at most one tick that the next action re-sends.
    const cur = (await one<{ onboarding: Onboarding }>(`SELECT onboarding FROM users WHERE id = $1`, [u.id]))?.onboarding ?? {};
    let next: Onboarding;
    try {
      next = applyChange(cur, { track: b.track, step: b.step, dismiss: Boolean(b.dismiss), reset: Boolean(b.reset) });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    await q(`UPDATE users SET onboarding = $2 WHERE id = $1`, [u.id, JSON.stringify(next)]);
    return { ...progress(next, b.track), done: next[b.track]?.done ?? {} };
  });
}
