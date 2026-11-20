// Time & Payroll — the time side's tables.
// Same style as server/db.ts: CREATE ... IF NOT EXISTS, safe to run every boot.

import { one, q } from "../db";
import { migrateGrants } from "../payroll/grants";
import { migrateDeputy } from "./deputy";
import { migrateAccrual } from "./accrual";
import { migrateProjects } from "./projects";

export async function migrateTime() {
  await migrateGrants();
  for (const sql of [
    // Each person's normal working days (0 = Sunday … 6). Acme runs 24/7, so it's per person; leave counts against it.
    `ALTER TABLE time_members ADD COLUMN IF NOT EXISTS work_days INTEGER[] NOT NULL DEFAULT '{1,2,3,4,5}'`,
    // People: the day they joined, and their regular week —
    // each working day's start, end and break, in their own timezone.
    `ALTER TABLE time_members ADD COLUMN IF NOT EXISTS start_date DATE`,
    `ALTER TABLE time_members ADD COLUMN IF NOT EXISTS regular_hours JSONB`,
    // Locations (departments): the teams people, shifts and manager grants hang off.
    `CREATE TABLE IF NOT EXISTS locations (
      name TEXT PRIMARY KEY,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `INSERT INTO locations (name) SELECT DISTINCT team FROM time_members WHERE team <> '' ON CONFLICT (name) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS clock_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK (kind IN ('in', 'out', 'break_start', 'break_end')),
      at TIMESTAMPTZ NOT NULL,
      shift_id INTEGER,
      source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'manager')),
      created_by INTEGER,
      reason TEXT,
      voided_by INTEGER,
      void_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS clock_events_user_at ON clock_events (user_id, at)`,
    `CREATE TABLE IF NOT EXISTS timesheet_weeks (
      user_id INTEGER NOT NULL REFERENCES users(id),
      week_start DATE NOT NULL,
      approved_by INTEGER,
      approved_at TIMESTAMPTZ,
      minutes_worked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, week_start)
    )`,
    // Each day's minutes as the manager approved them ({ "YYYY-MM-DD": minutes }): hourly pay
    // counts these, never a recount, so an edit next to the week or a timezone change can't move it.
    `ALTER TABLE timesheet_weeks ADD COLUMN IF NOT EXISTS minutes_by_day JSONB`,
    `CREATE TABLE IF NOT EXISTS shift_templates (
      id SERIAL PRIMARY KEY,
      team TEXT NOT NULL,
      name TEXT NOT NULL,
      start_local TEXT NOT NULL,
      end_local TEXT NOT NULL,
      days_of_week INTEGER[] NOT NULL DEFAULT '{1,2,3,4,5}'
    )`,
    `CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      team TEXT NOT NULL,
      date DATE NOT NULL,
      start_local TEXT NOT NULL,
      end_local TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      note TEXT,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS shifts_team_date ON shifts (team, date)`,
    // Shifts are drafts until a manager publishes the week; members only see published ones.
    `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`,
    `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
    // Each publish keeps a snapshot of the team's week, so the next one can say what changed.
    `CREATE TABLE IF NOT EXISTS shift_publications (
      id SERIAL PRIMARY KEY,
      team TEXT NOT NULL,
      week_start DATE NOT NULL,
      published_by INTEGER,
      published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      snapshot JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS shift_publications_team_week ON shift_publications (team, week_start, id)`,
    // One heads-up per shift per kind ("soon"), so a restart never double-sends.
    `CREATE TABLE IF NOT EXISTS shift_reminders (
      shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (shift_id, kind)
    )`,
    // "Clocked in but not in the office for 2 hours" DMs: the away stretch last nudged, per person (time/away.ts).
    `CREATE TABLE IF NOT EXISTS clock_nudges (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      away_since TIMESTAMPTZ NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // When someone can't work, in their own timezone: weekly (day + optional hours) or a one-off date.
    `CREATE TABLE IF NOT EXISTS availability (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK (kind IN ('weekly', 'date')),
      dow INTEGER CHECK (dow BETWEEN 0 AND 6),
      date DATE,
      start_local TEXT,
      end_local TEXT,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS availability_user ON availability (user_id)`,
    `CREATE TABLE IF NOT EXISTS swap_requests (
      id SERIAL PRIMARY KEY,
      shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
      from_user INTEGER NOT NULL REFERENCES users(id),
      to_user INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'approved', 'rejected', 'cancelled')),
      decided_by INTEGER,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS leave_types (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      paid BOOLEAN NOT NULL,
      has_balance BOOLEAN NOT NULL
    )`,
    `INSERT INTO leave_types (code, name, paid, has_balance) VALUES
      ('vacation', 'Vacation', TRUE, TRUE),
      ('sick', 'Sick', TRUE, FALSE),
      ('personal', 'Personal', TRUE, FALSE),
      ('unpaid', 'Unpaid', FALSE, FALSE)
     ON CONFLICT (code) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS leave_balances (
      user_id INTEGER NOT NULL REFERENCES users(id),
      code TEXT NOT NULL REFERENCES leave_types(code),
      days NUMERIC NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, code)
    )`,
    // What someone is entitled to per year, by leave type (the balance is what's left).
    `CREATE TABLE IF NOT EXISTS leave_entitlements (
      user_id INTEGER NOT NULL REFERENCES users(id),
      code TEXT NOT NULL REFERENCES leave_types(code),
      days_per_year NUMERIC NOT NULL,
      PRIMARY KEY (user_id, code)
    )`,
    `CREATE TABLE IF NOT EXISTS leave_requests (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      code TEXT NOT NULL REFERENCES leave_types(code),
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      days NUMERIC NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
      decided_by INTEGER,
      decided_at TIMESTAMPTZ,
      note TEXT,
      decision_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // Every manager change to someone's time: who, when, the old value, the new value, why.
    `CREATE TABLE IF NOT EXISTS time_audit (
      id SERIAL PRIMARY KEY,
      actor INTEGER,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT,
      before JSONB,
      after JSONB,
      reason TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // Closing a pay run asks "any Time change since the compute?" — by time, not a full scan.
    `CREATE INDEX IF NOT EXISTS time_audit_at ON time_audit (at)`,
    // Lookups by person that run on every page load (/me, today, reminders, the close check).
    `CREATE INDEX IF NOT EXISTS shifts_user_date ON shifts (user_id, date)`,
    `CREATE INDEX IF NOT EXISTS leave_requests_user_status ON leave_requests (user_id, status)`,
    `CREATE INDEX IF NOT EXISTS leave_requests_status_dates ON leave_requests (status, start_date, end_date)`,
  ]) await q(sql);
  // 'declined' (the person asked said no) came after the table: widen the check once.
  const check = await one<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'swap_requests_status_check'`);
  if (!check?.def.includes("declined")) {
    await q(`ALTER TABLE swap_requests DROP CONSTRAINT IF EXISTS swap_requests_status_check`);
    await q(`ALTER TABLE swap_requests ADD CONSTRAINT swap_requests_status_check CHECK (status IN ('proposed', 'accepted', 'declined', 'approved', 'rejected', 'cancelled'))`);
  }
  // One open swap per shift: two "Ask" clicks at once can't both land.
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS swap_requests_one_open ON swap_requests (shift_id) WHERE status IN ('proposed', 'accepted')`).catch((e) => console.error("swap index (an existing duplicate open swap?)", e));
  await migrateDeputy();
  await migrateAccrual();
  await migrateProjects();
}

export async function audit(actor: number, action: string, entity: string, entityId: string | number | null, before: unknown, after: unknown, reason?: string | null) {
  await q(`INSERT INTO time_audit (actor, action, entity, entity_id, before, after, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    actor, action, entity, entityId === null ? null : String(entityId),
    before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), reason ?? null,
  ]);
}
