// Time admins only: who is a time admin and who manages which team. (The pay screens are not
// part of this edition.) The grant is still called payroll_admin in the database.

import { useEffect, useState } from "react";
import { listOf, post } from "./api";
import { Msg, Unavailable, useLoad } from "./TimeApp";
import { announceTab } from "./TimeTour";

export function Payroll() {
  useEffect(() => { announceTab("access"); }, []);
  return <Grants />;
}

interface Grant { user_id: number; name: string; email: string; grant_kind: "payroll_admin" | "manager"; team: string }

/** Any number of time admins and managers. */
function Grants() {
  const [data, reload, err] = useLoad<unknown>("/api/payroll/grants");
  const [f, setF] = useState({ email: "", grant: "manager", team: "" });
  const [msg, setMsg] = useState("");
  if (err === "unavailable") return <Unavailable />;
  if (err) return <p className="error">{err}</p>;
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try { await fn(); setMsg(done); reload(); } catch (e) { setMsg((e as Error).message); }
  };
  const grants = [...listOf<Grant>(data, "grants")].sort((a, b) => (a.grant_kind === b.grant_kind ? a.name.localeCompare(b.name) : a.grant_kind === "payroll_admin" ? -1 : 1));
  return (
    <div className="two-col" data-tour="tab-access">
      <section className="panel">
        <h3>Give access</h3>
        <div className="form-grid">
          <label className="wide">Person (email)<input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="name@yourcompany.com" /></label>
          <label>Access<select value={f.grant} onChange={(e) => setF({ ...f, grant: e.target.value })}><option value="manager">Manager (one team)</option><option value="payroll_admin">Time admin (everything)</option></select></label>
          {f.grant === "manager" ? <label>Team<input value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })} placeholder="Support, or * for all" /></label> : null}
        </div>
        <button className="primary" disabled={!f.email.includes("@") || (f.grant === "manager" && !f.team.trim())} onClick={() => act(() => post("/api/payroll/grants", { email: f.email.trim().toLowerCase(), grant: f.grant, team: f.grant === "manager" ? f.team.trim() : "" }), "Added.")}>Grant</button>
        <p className="hint">They need to have signed in once. A manager sees schedules, timesheets and leave for their team only.</p>
        <Msg text={msg} />
      </section>
      <section>
        {!data ? <p className="muted">Loading…</p> : (
          <table className="grid compact">
            <thead><tr><th>Person</th><th>Access</th><th>Team</th><th /></tr></thead>
            <tbody>
              {grants.map((g) => (
                <tr key={`${g.user_id}-${g.grant_kind}-${g.team}`}>
                  <td>{g.name}<div className="muted small-text">{g.email}</div></td>
                  <td>{g.grant_kind === "payroll_admin" ? "Time admin" : "Manager"}</td>
                  <td>{g.grant_kind === "payroll_admin" ? "" : g.team === "*" ? "All teams" : g.team}</td>
                  <td className="actions"><button className="small ghost danger" onClick={() => act(() => post(`/api/payroll/grants?userId=${g.user_id}&grant=${g.grant_kind}&team=${encodeURIComponent(g.team)}`, undefined, "DELETE"), "Removed.")}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && !grants.length ? <p className="muted">No grants yet. The first time admin comes from PAYROLL_ADMIN_EMAILS.</p> : null}
      </section>
    </div>
  );
}
