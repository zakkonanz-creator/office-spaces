// Payroll tables, beside the office's own.
// Money is integer cents; dates are 'YYYY-MM-DD' text so no timezone ever shifts a day.
// People are keyed by email, so a pay profile can exist before they first sign in to the office.

import { q } from "../db";
import { migrateGrants } from "./grants";

export async function migratePayroll() {
  await migrateGrants();
  const statements = [
    `CREATE TABLE IF NOT EXISTS pay_profiles (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      pay_type TEXT NOT NULL CHECK (pay_type IN ('salaried', 'hourly')),
      monthly_salary INTEGER NOT NULL DEFAULT 0,
      hourly_rate INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      pay_method TEXT,
      payout_ref TEXT,
      country TEXT,
      timezone TEXT,
      std_weekly_hours REAL NOT NULL DEFAULT 40,
      start_date TEXT,
      end_date TEXT,
      team TEXT,
      effective_from TEXT NOT NULL,
      note TEXT,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS pay_profiles_email ON pay_profiles (email, effective_from)`,
    `CREATE TABLE IF NOT EXISTS adjustments (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('advance', 'repayment', 'bonus', 'expense', 'raise', 'other')),
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      period TEXT NOT NULL,
      installments INTEGER,
      note TEXT,
      receipt_url TEXT,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at TIMESTAMPTZ,
      deleted_by INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS adjustments_email ON adjustments (email)`,
    `CREATE TABLE IF NOT EXISTS pay_runs (
      id SERIAL PRIMARY KEY,
      period TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      opened_by INTEGER,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      computed_at TIMESTAMPTZ,
      closed_by INTEGER,
      closed_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS pay_lines (
      run_id INTEGER NOT NULL REFERENCES pay_runs(id),
      email TEXT NOT NULL,
      user_id INTEGER,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      pay_type TEXT NOT NULL,
      pay_method TEXT,
      payout_ref TEXT,
      base INTEGER NOT NULL,
      leave_deduction INTEGER NOT NULL,
      proration INTEGER NOT NULL,
      hours_pay INTEGER NOT NULL,
      adjustments_total INTEGER NOT NULL,
      net INTEGER NOT NULL,
      working JSONB NOT NULL,
      PRIMARY KEY (run_id, email)
    )`,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      actor INTEGER,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT,
      before JSONB,
      after JSONB,
      reason TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // Who the last compute couldn't work out pay for ({ email, name, error }). Any at all blocks the close.
    `ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS errors JSONB NOT NULL DEFAULT '[]'::jsonb`,
    // What the last compute wants a reviewer to see but doesn't block the close ({ email, name, warning }).
    `ALTER TABLE pay_runs ADD COLUMN IF NOT EXISTS warnings JSONB NOT NULL DEFAULT '[]'::jsonb`,
    // The close check asks "anything since the compute?" — by time, not a full scan.
    `CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at)`,
  ];
  for (const s of statements) await q(s);
}

export async function audit(actor: number | null, action: string, entity: string, entityId: string | number | null, before: unknown, after: unknown, reason?: string | null) {
  await q(`INSERT INTO audit_log (actor, action, entity, entity_id, before, after, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    actor, action, entity, entityId === null ? null : String(entityId), before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), reason ?? null,
  ]);
}
