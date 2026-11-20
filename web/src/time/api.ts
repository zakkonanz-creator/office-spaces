// Fetch helpers and formatting for Time & Payroll. The time pages must work
// without the office (no sockets, no LiveKit), so they only talk HTTP.

export class NotAvailable extends Error {}

export async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  // Only claim JSON when there is a body: Fastify rejects an empty JSON body with a 400.
  const r = await fetch(url, {
    ...init,
    // The server uses the browser's timezone for people who never open the office.
    headers: { "x-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone, ...(init?.body !== undefined ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
  });
  // 404 means the backend for this page isn't deployed yet; say so instead of erroring.
  if (r.status === 404 && !init?.method) throw new NotAvailable("not available yet");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as any).error ?? `${r.status}`);
  return j as T;
}

export const post = <T = any>(url: string, body?: unknown, method = "POST") =>
  api<T>(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });

/** 125 → "2h 05m". */
export function hm(minutes: number | null | undefined): string {
  const m = Math.max(0, Math.round(minutes ?? 0));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Integer cents → "$1,234.56" (or the currency's code if it isn't USD). */
export function money(cents: number | null | undefined, currency = "USD"): string {
  const v = (cents ?? 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(v);
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
}

/** "12.50" → 1250 cents; null if it isn't a number. */
export function toCents(s: string): number | null {
  const v = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(v) ? Math.round(v * 100) : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayYmd = () => ymd(new Date());

/** "2026-10" → "October 2026". */
export const monthLabel = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};

/** A stable, calm colour per team (hue from the name), for schedule blocks. */
export function teamHue(team: string): number {
  let h = 0;
  for (let i = 0; i < team.length; i++) h = (h * 31 + team.charCodeAt(i)) % 360;
  return [212, 152, 28, 268, 340, 190, 100, 8][h % 8];
}

/** Monday of the week holding `d`, as YYYY-MM-DD. */
export function weekStart(d = new Date()): string {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return ymd(x);
}

export function addDays(day: string, n: number): string {
  const [y, m, dd] = day.split("-").map(Number);
  const x = new Date(y, m - 1, dd);
  x.setDate(x.getDate() + n);
  return ymd(x);
}

export const dayLabel = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
};

export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};

/** Who can see what. Missing backend → member-only. */
export interface Access { payrollAdmin: boolean; managerTeams: string[]; team: string | null }
let accessP: Promise<Access> | null = null;
export function access(): Promise<Access> {
  accessP ??= api<{ payrollAdmin?: boolean; managerOf?: string[]; managerTeams?: string[]; team?: string | null }>("/api/payroll/me")
    .then((r) => ({ payrollAdmin: Boolean(r.payrollAdmin), managerTeams: r.managerOf ?? r.managerTeams ?? [], team: r.team ?? null }))
    .catch(() => ({ payrollAdmin: false, managerTeams: [], team: null }));
  return accessP;
}

export const LEAVE_LABEL: Record<string, string> = { vacation: "Vacation", holiday: "National holiday", sick: "Sick", personal: "Personal", unpaid: "Unpaid" };
export const leaveLabel = (code: string) => LEAVE_LABEL[code] ?? code[0]?.toUpperCase() + code.slice(1);

/** A short, friendly label for a flag code from the server. */
export function flagLabel(f: string | { code?: string; message?: string }): string {
  if (typeof f !== "string") return f.message ?? f.code ?? "Needs a look";
  return ({ "missed-out": "Missed clock-out", "stray-out": "Clock-out without a clock-in", "stray-break": "Break outside a shift", "long-shift": "Very long shift" } as Record<string, string>)[f] ?? f;
}

// ── Shift times across timezones ───────────────────────────────────────────
// Shifts are stored in the employee's own timezone (date + "HH:MM" + tz). The
// office runs 24/7 across Pakistan, the Philippines, Nigeria and the Americas,
// so every view shows them in the viewer's timezone and notes the employee's.

export const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Milliseconds `tz` is ahead of UTC at instant `ms`. */
function tzOffset(tz: string, ms: number): number {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
        .formatToParts(new Date(ms))
        .map((p) => [p.type, p.value]),
    );
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    return asUtc - Math.floor(ms / 1000) * 1000;
  } catch {
    return 0; // unknown timezone name: treat as UTC rather than crash the grid
  }
}

/** The instant of `date` + `hhmm` on the wall clock in `tz`. */
export function wallToInstant(date: string, hhmm: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - tzOffset(tz, guess);
  t = guess - tzOffset(tz, t); // second pass settles DST edges
  return new Date(t);
}

export interface ShiftLike { date: string; start_local: string; end_local: string; timezone: string }

/** A shift as the viewer sees it: start/end instants, crossing midnight when end ≤ start. */
export function shiftSpan(s: ShiftLike) {
  const tz = s.timezone || "UTC";
  const date = String(s.date).slice(0, 10); // Postgres DATE can arrive as a full ISO string
  const start = wallToInstant(date, s.start_local, tz);
  const overnight = s.end_local <= s.start_local;
  const end = wallToInstant(overnight ? addDays(date, 1) : date, s.end_local, tz);
  const localDay = ymd(start); // the viewer's calendar day the shift starts on
  const nextDay = ymd(end) !== localDay;
  const fmt = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const label = `${fmt(start)}–${fmt(end)}${nextDay ? " (+1)" : ""}`;
  const theirs = `${s.start_local}–${s.end_local}${overnight ? " (+1)" : ""} ${shortTz(tz)}`;
  return { start, end, localDay, label, theirs, sameTz: tzOffset(tz, start.getTime()) === tzOffset(viewerTz, start.getTime()), tz };
}

/** "Asia/Karachi" → "Karachi". */
export const shortTz = (tz: string) => tz.split("/").pop()!.replace(/_/g, " ");

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // ISO 1..7

/** A list from a response that's either a bare array or `{ [key]: [...] }` (the backend has used both). */
export function listOf<T>(d: unknown, key: string): T[] {
  if (Array.isArray(d)) return d as T[];
  const v = (d as Record<string, unknown> | null)?.[key];
  return Array.isArray(v) ? (v as T[]) : [];
}
