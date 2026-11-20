// The tours run one into the next, by what each person can open:
//   office welcome + checklist → My time → Team (managers) → Payroll (payroll admins) → Admin (office admins)
// Each tour's last step asks nextTour() for the following one and offers it as "Next".

import { access } from "./time/api";

export type TourId = "office" | "time" | "manager" | "payroll" | "admin";

const ORDER: { id: TourId; label: string; href: string; can: (a: { admin: boolean; manager: boolean; payroll: boolean }) => boolean }[] = [
  { id: "office", label: "The office", href: "/?welcome=1", can: () => true },
  { id: "time", label: "My time: clocking in, leave and shifts", href: "/time?tour=1", can: () => true },
  { id: "manager", label: "Team: approvals, timesheets and the schedule", href: "/time/team?tour=1", can: (a) => a.manager },
  { id: "payroll", label: "Payroll: the monthly pay run", href: "/payroll?tour=1", can: (a) => a.payroll },
  { id: "admin", label: "Admin: members, guests and settings", href: "/admin/members?tour=1", can: (a) => a.admin },
];

let who: Promise<{ admin: boolean; manager: boolean; payroll: boolean }> | null = null;
const whoAmI = () =>
  (who ??= Promise.all([fetch("/api/me").then((r) => r.json()).catch(() => ({})), access()]).then(([me, acc]) => ({
    admin: me.role === "admin",
    manager: acc.managerTeams.length > 0 || acc.payrollAdmin,
    payroll: acc.payrollAdmin,
  })));

/** The tour after this one for the person signed in, or null if this was their last. */
export async function nextTour(after: TourId): Promise<{ label: string; href: string } | null> {
  const a = await whoAmI();
  const from = ORDER.findIndex((t) => t.id === after);
  return ORDER.slice(from + 1).find((t) => t.can(a)) ?? null;
}
