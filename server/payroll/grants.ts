// Who may see pay, and who manages which team. Separate from the office's own
// `users.role` on purpose: an analytics admin must never see pay
//.
//
//   payroll_admin  pay profiles, adjustments, pay runs, exports (and manager of every team)
//   manager        one team per row (team '*' = all teams): schedules, timesheets, leave — hours, never pay

import { one, q } from "../db";

export type Grant = "payroll_admin" | "manager";

export async function migrateGrants() {
  await q(`CREATE TABLE IF NOT EXISTS grants (
    user_id INTEGER NOT NULL REFERENCES users(id),
    grant_kind TEXT NOT NULL CHECK (grant_kind IN ('payroll_admin', 'manager')),
    team TEXT NOT NULL DEFAULT '',
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, grant_kind, team)
  )`);
  // Which team someone works in, for scheduling and manager scope.
  await q(`CREATE TABLE IF NOT EXISTS time_members (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    team TEXT NOT NULL
  )`);
}

/** Emails that are payroll admins without a row (bootstrap: someone has to grant the first one). */
const bootstrapAdmins = () =>
  (process.env.PAYROLL_ADMIN_EMAILS || process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export async function isPayrollAdmin(userId: number): Promise<boolean> {
  const row = await one<{ email: string; removed: boolean; granted: boolean }>(
    `SELECT u.email, u.removed,
            EXISTS (SELECT 1 FROM grants g WHERE g.user_id = u.id AND g.grant_kind = 'payroll_admin') AS granted
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  if (!row || row.removed) return false;
  return row.granted || bootstrapAdmins().includes(row.email.toLowerCase());
}

/** Teams this person manages. ['*'] = every team (payroll admins, or a '*' manager row). */
export async function managedTeams(userId: number): Promise<string[]> {
  if (await isPayrollAdmin(userId)) return ["*"];
  const rows = await q<{ team: string }>(`SELECT team FROM grants WHERE user_id = $1 AND grant_kind = 'manager'`, [userId]);
  const teams = rows.map((r) => r.team).filter(Boolean);
  return teams.includes("*") ? ["*"] : teams;
}

export async function teamOf(userId: number): Promise<string | null> {
  return (await one<{ team: string }>(`SELECT team FROM time_members WHERE user_id = $1`, [userId]))?.team ?? null;
}

/** May `userId` approve/schedule for `targetUserId`? Nobody manages themselves except payroll admins. */
export async function canManage(userId: number, targetUserId: number): Promise<boolean> {
  // Approving your own timesheet, leave or balance needs payroll admin — an
  // all-teams ('*') manager grant isn't enough.
  if (userId === targetUserId) return isPayrollAdmin(userId);
  const teams = await managedTeams(userId);
  if (teams.includes("*")) return true;
  const team = await teamOf(targetUserId);
  return team !== null && teams.includes(team);
}

/**
 * Who should hear about someone's request (leave, say): the managers of their team
 * (including all-team managers). A team with no manager falls to the payroll admins.
 * Never the person themselves, never anyone removed.
 */
export async function approversFor(userId: number): Promise<number[]> {
  const team = await teamOf(userId);
  const managers = await q<{ user_id: number }>(
    `SELECT DISTINCT g.user_id FROM grants g JOIN users u ON u.id = g.user_id
      WHERE g.grant_kind = 'manager' AND NOT u.removed AND g.user_id <> $2 AND (g.team = '*' OR g.team = $1)`,
    [team ?? "", userId],
  );
  if (managers.length) return managers.map((r) => r.user_id);
  const admins = await q<{ id: number }>(
    `SELECT u.id FROM users u
      WHERE NOT u.removed AND u.id <> $1
        AND (EXISTS (SELECT 1 FROM grants g WHERE g.user_id = u.id AND g.grant_kind = 'payroll_admin') OR lower(u.email) = ANY($2::text[]))`,
    [userId, bootstrapAdmins()],
  );
  return admins.map((r) => r.id);
}

export async function listGrants() {
  return q<{ user_id: number; name: string; email: string; grant_kind: Grant; team: string }>(
    `SELECT g.user_id, u.name, u.email, g.grant_kind, g.team FROM grants g JOIN users u ON u.id = g.user_id ORDER BY u.name, g.grant_kind, g.team`,
  );
}
