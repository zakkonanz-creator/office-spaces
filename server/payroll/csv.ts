// CSV in and out for payroll. Out: every cell is escaped against formula
// injection (a name like "=HYPERLINK(...)" must stay text in Sheets/Excel).


/** RFC-4180-ish: quoted fields, doubled quotes, CRLF or LF. Returns rows of cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

/** Rows as objects keyed by the (lower-cased, trimmed) header row. */
export function csvObjects(text: string): Record<string, string>[] {
  const [head, ...rest] = parseCsv(text);
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return rest.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

export const esc = (raw: unknown) => {
  const s = raw === null || raw === undefined ? "" : String(raw);
  const v = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};
/** Money cells stay numeric (no formula risk): plain decimals, minus sign allowed. */
