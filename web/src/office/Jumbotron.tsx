// The jumbotron: a wall screen that cycles through company values, quarterly
// priorities, clients being onboarded, new sales, Google reviews and key dates.
// Click it for everything at once. Data comes from /api/jumbotron
// (server/jumbotron.ts); guests get a plain screen, since client names are on it.

import { useEffect, useState, useSyncExternalStore } from "react";
import { firstName } from "../../../shared/names";
import { Icon } from "../icons";
import { useOffice, toast } from "./store";

/** Every item carries its key; admins also see hidden ones (hidden: true) and hand-added ones (manual: true). */
type Item<T> = T & { key: string; hidden?: boolean; manual?: boolean };
type Section = "wins" | "sales" | "onboarding" | "priorities" | "dates" | "reviews" | "values";
interface Board {
  values: Item<{ name: string; line: string }>[];
  priorities: Item<{ title: string; owner: string | null; status: string | null }>[];
  onboarding: Item<{ name: string; company: string | null; product: string | null; state: "waiting" | "in progress"; at: number }>[];
  sales: Item<{ name: string; company: string | null; product: string | null; at: number }>[];
  reviews: Item<{ author: string; rating: number; text: string; at: number }>[];
  rating: number | null;
  dates: Item<{ date: string; label: string }>[];
  wins?: Item<{ name: string; text: string; at: number; img?: number | null; video?: boolean }>[];
  valuesOverridden: boolean;
  off: Section[];
  updated: Partial<Record<string, number>>;
  errors: Partial<Record<string, string>>;
}

// One fetch for every screen on the floor, refreshed every 5 minutes.
let board: Board | null | "guest" = null;
let fetching = false;
const subs = new Set<() => void>();
async function load() {
  if (fetching) return;
  fetching = true;
  try {
    const r = await fetch("/api/jumbotron");
    board = r.status === 401 ? "guest" : r.ok ? await r.json() : board;
  } catch { /* keep the last copy */ }
  fetching = false;
  subs.forEach((f) => f());
}
let timer: ReturnType<typeof setInterval> | null = null;
/** A win just landed in #wins: reload, and every screen jumps to the Wins slide (net.ts calls this). */
let winAt = 0;
export function showWin() {
  winAt = Date.now();
  setTimeout(() => void load(), 1500); // the server has saved it by then
}
function useBoard() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      if (!timer) { void load(); timer = setInterval(load, 5 * 60e3); }
      return () => subs.delete(f);
    },
    () => board,
  );
}

const today = () => new Date().toISOString().slice(0, 10);
const ago = (t: number) => {
  const d = Math.floor((Date.now() - t) / 86400e3);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
};
const dayLabel = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const stars = (n: number) => "★".repeat(Math.round(n));

type Slide = { title: string; lines: string[]; img?: string; video?: boolean };
/** A win's screenshot (or a video's still), served to teammates only. */
export const winImg = (id: number) => `/api/jumbotron/win/${id}`;
function slides(all: Board): Slide[] {
  const out: Slide[] = [];
  // What the screen shows: no hidden items, no switched-off sections (admins get both, marked).
  const vis = <T extends { hidden?: boolean }>(k: Section, xs: T[]) => (all.off?.includes(k) ? [] : xs.filter((x) => !x.hidden));
  const b = { ...all, sales: vis("sales", all.sales), onboarding: vis("onboarding", all.onboarding), priorities: vis("priorities", all.priorities), dates: vis("dates", all.dates), reviews: vis("reviews", all.reviews), values: vis("values", all.values) };
  const wins = vis("wins", all.wins ?? []);
  // A win with a picture (most #wins posts are a screenshot) gets its own slide showing it (the owner, 2026-11-16).
  // The newest win's slide comes first, so a fresh one is what the screen jumps to.
  const pics: Slide[] = wins.filter((w) => w.img).slice(0, 4).map((w) => ({ title: `🔔 Wins · ${firstName(w.name)}`, lines: w.text ? [w.text] : [], img: winImg(w.img!), video: w.video }));
  const words = wins.filter((w) => !w.img && w.text);
  const told: Slide[] = words.length ? [{ title: "🔔 Wins this week", lines: words.slice(0, 3).map((w) => `${firstName(w.name)}: ${w.text}`) }] : [];
  out.push(...(wins[0]?.img ? [...pics, ...told] : [...told, ...pics]));
  if (b.sales.length) out.push({ title: "New clients this week 🎉", lines: b.sales.slice(0, 3).map((s) => `${s.name}${s.product ? ` — ${s.product}` : ""}`) });
  if (b.onboarding.length) out.push({ title: "Onboarding now", lines: b.onboarding.slice(0, 3).map((s) => `${s.name} · ${s.state}`) });
  if (b.priorities.length) out.push({ title: "This quarter's priorities", lines: b.priorities.slice(0, 3).map((p) => p.title) });
  const dates = b.dates.filter((d) => d.date >= today());
  if (dates.length) out.push({ title: "Key dates", lines: dates.slice(0, 3).map((d) => `${dayLabel(d.date)} · ${d.label}`) });
  for (const r of b.reviews.slice(0, 2)) out.push({ title: `${stars(r.rating)} Google review`, lines: [`“${r.text.slice(0, 120)}${r.text.length > 120 ? "…" : ""}”`, `— ${r.author}`] });
  for (const v of b.values) out.push({ title: "Our values", lines: [v.name, v.line] });
  return out;
}

/** On the floor: the screen itself, cycling through one section at a time. */
export function JumbotronScreen({ w, h }: { w: number; h: number }) {
  const b = useBoard();
  const [i, setI] = useState(0);
  const all = b && b !== "guest" ? slides(b) : [];
  useEffect(() => {
    if (all.length < 2) return;
    const t = setInterval(() => setI((x) => x + 1), 8000);
    return () => clearInterval(t);
  }, [all.length]);
  // A fresh win: show it now (the Wins slide is first), then carry on cycling.
  const [seenWin, setSeenWin] = useState(0);
  useEffect(() => {
    if (winAt > seenWin && all[0]?.title.includes("Wins")) { setSeenWin(winAt); setI(0); }
  });
  const fresh = Date.now() - winAt < 20_000 && i % Math.max(1, all.length) === 0 && all[0]?.title.includes("Wins");
  const s = all.length ? all[i % all.length] : null;
  // Text grows with the screen: a desk-sized one stays readable, a wall-sized one fills the wall.
  const big = Math.max(9, Math.min(56, h / 6.5, w / 26));
  return (
    <div className={`jumbo-screen${fresh ? " jumbo-win" : ""}`} style={{ width: w, height: h, ["--jf" as any]: `${big}px` }}>
      <div className="jumbo-bar"><span>ACME</span><span>{s?.title ?? ""}</span></div>
      {s?.img ? (
        <div key={i} className="jumbo-body jumbo-pic">
          <img src={s.img} alt={s.lines[0] ?? "A win from #wins"} />
          {s.video ? <span className="jumbo-play" aria-label="Video in #wins">▶</span> : null}
          {s.lines[0] ? <div className="jumbo-cap">{s.lines[0]}</div> : null}
        </div>
      ) : s ? (
        <div key={i} className="jumbo-body">{s.lines.map((l, k) => <div key={k} className={k === 0 ? "jumbo-lead" : ""}>{l}</div>)}</div>
      ) : (
        <div className="jumbo-body jumbo-idle">{b === "guest" ? "" : "Warming up…"}</div>
      )}
      {all.length > 1 ? <div className="jumbo-dots">{all.slice(0, 12).map((_, k) => <i key={k} className={k === i % all.length ? "on" : ""} />)}</div> : null}
    </div>
  );
}

async function edit(op: object) {
  const r = await fetch("/api/admin/jumbotron/edit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return toast(j.error ?? "Couldn't save that."), false;
  board = j;
  subs.forEach((f) => f());
  return true;
}

/** Clicked: every section at once. Admins can switch to editing. */
export function JumbotronFull({ onClose }: { onClose: () => void }) {
  const b = useBoard();
  const s = useOffice();
  const isAdmin = s.me?.role === "admin";
  const [editing, setEditing] = useState(false);
  useEffect(() => void load(), []);
  if (b === "guest") return null;
  const upd = (k: string) => {
    const err = b?.errors?.[k];
    const t = b?.updated?.[k];
    if (err) return <span className="jumbo-err" title={err}>{t ? `stale · ${err}` : err}</span>;
    const m = t ? Math.max(1, Math.round((Date.now() - t) / 60e3)) : 0;
    return t ? <span className="muted">updated {m < 60 ? `${m}m` : ago(t)} ago</span> : null;
  };
  const ed = editing && isAdmin;
  /** One item, with Hide/Show (from a feed) or Delete (added here) while editing. */
  const row = (it: { key: string; hidden?: boolean; manual?: boolean }, body: React.ReactNode, Tag: "li" = "li") =>
    !ed && it.hidden ? null : (
      <Tag key={it.key} className={it.hidden ? "jumbo-hidden" : ""}>
        {body}
        {ed ? (
          it.manual
            ? <button className="small ghost jumbo-x" onClick={() => edit({ op: "remove", key: it.key })}>Delete</button>
            : <button className="small ghost jumbo-x" onClick={() => edit({ op: it.hidden ? "unhide" : "hide", key: it.key })}>{it.hidden ? "Show" : "Hide"}</button>
        ) : null}
      </Tag>
    );
  const card = (key: Section, title: string, items: { hidden?: boolean }[], body: React.ReactNode, empty: string, add?: React.ReactNode) => {
    const off = Boolean(b && b.off?.includes(key));
    if (!ed && off) return null;
    return (
      <section className={`jumbo-card${off ? " jumbo-off" : ""}`}>
        <header>
          <h4>{title}</h4>
          {ed ? (
            <label className="check small-text"><input type="checkbox" checked={!off} onChange={(e) => edit({ op: "section", section: key, on: e.target.checked })} /> On screen</label>
          ) : upd(key)}
        </header>
        {items.some((i) => ed || !i.hidden) ? body : <p className="muted">{empty}</p>}
        {ed && add ? add : null}
      </section>
    );
  };
  const dates = b ? b.dates.filter((d) => d.date >= today()) : [];
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal jumbo-full" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>Acme jumbotron</h3>
          <div className="row" style={{ margin: 0 }}>
            {isAdmin ? <button className={`small${ed ? " primary" : ""}`} onClick={() => setEditing(!ed)}>{ed ? "Done" : "Edit"}</button> : null}
            <button className="ghost" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
          </div>
        </header>
        {ed ? <p className="hint">Changes go live on every screen right away. Hiding a client or review only hides it here — Slack and Google aren't touched.</p> : null}
        {!b ? <p className="muted">Loading…</p> : (
          <div className="jumbo-grid">
            {card("wins", "Wins this week", b.wins ?? [], <ul>{(b.wins ?? []).map((x) => row(x, <><b>{firstName(x.name)}</b>{x.video ? <span className="muted small-text"> · video</span> : null}{x.text ? <div className="small-text">{x.text}</div> : null}{x.img ? <img className="jumbo-win-img" src={winImg(x.img)} alt={x.text || `${firstName(x.name)}'s win`} loading="lazy" /> : null}<span className="muted small-text"> {ago(x.at)}</span></>))}</ul>, "No wins posted in #wins this week yet.")}
            {card("sales", "New clients this week", b.sales, <ul>{b.sales.map((x) => row(x, <><b>{x.name}</b>{x.company ? <span className="muted"> · {x.company}</span> : null}{x.product ? <div className="small-text">{x.product}</div> : null}<span className="muted small-text"> {ago(x.at)}</span></>))}</ul>, "No new clients in the last 7 days.")}
            {card("onboarding", "Onboarding now", b.onboarding, <ul>{b.onboarding.map((x) => row(x, <><b>{x.name}</b>{x.company ? <span className="muted"> · {x.company}</span> : null} <span className={`jumbo-pill ${x.state === "waiting" ? "wait" : "go"}`}>{x.state}</span><span className="muted small-text"> since {ago(x.at)}</span></>))}</ul>, "Everyone's welcome call is done.")}
            {card("priorities", "This quarter's priorities", b.priorities, <ol>{b.priorities.map((p) => row(p, <><b>{p.title}</b>{p.owner ? <span className="muted"> · {p.owner}</span> : null}{p.status ? <span className="jumbo-pill">{p.status}</span> : null}</>))}</ol>, "No priorities yet.",
              <AddForm fields={[["title", "Priority", "text"], ["owner", "Owner", "text"], ["status", "Status (e.g. On track)", "text"]]} onAdd={(item) => edit({ op: "add", section: "priorities", item })} />)}
            {card("dates", "Key dates", ed ? b.dates : dates, <ul>{(ed ? b.dates : dates).map((d) => row(d, <><b>{dayLabel(d.date)}</b> · {d.label}{d.date < today() ? <span className="muted small-text"> (past)</span> : null}</>))}</ul>, "No upcoming dates.",
              <AddForm fields={[["date", "Date", "date"], ["label", "What's happening", "text"]]} onAdd={(item) => edit({ op: "add", section: "dates", item })} />)}
            {card("reviews", `Google reviews${b.rating ? ` · ${b.rating.toFixed(1)}★` : ""}`, b.reviews, <ul>{b.reviews.map((r) => row(r, <><span className="jumbo-stars">{stars(r.rating)}</span> “{r.text}” <span className="muted">— {r.author}, {ago(r.at)}</span></>))}</ul>, "No reviews yet.",
              <AddForm fields={[["author", "Reviewer", "text"], ["rating", "Stars (1–5)", "number"], ["text", "Review text", "text"]]} onAdd={(item) => edit({ op: "add", section: "reviews", item })} />)}
            {card("values", "Our values", b.values, ed ? <ValuesEditor values={b.values} overridden={b.valuesOverridden} /> : <ol>{b.values.map((v) => row(v, <><b>{v.name}</b><div className="small-text">{v.line}</div></>))}</ol>, "Values haven't been pushed yet.")}
          </div>
        )}
      </div>
    </div>
  );
}

function AddForm({ fields, onAdd }: { fields: [string, string, string][]; onAdd: (item: Record<string, string>) => Promise<boolean | void> }) {
  const blank = Object.fromEntries(fields.map(([k]) => [k, ""]));
  const [v, setV] = useState<Record<string, string>>(blank);
  return (
    <form className="jumbo-add" onSubmit={async (e) => { e.preventDefault(); if (await onAdd(v)) setV(blank); }}>
      {fields.map(([k, label, type]) => (
        <input key={k} type={type} placeholder={label} aria-label={label} value={v[k]} min={type === "number" ? 1 : undefined} max={type === "number" ? 5 : undefined} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
      ))}
      <button className="small primary">Add</button>
    </form>
  );
}

function ValuesEditor({ values, overridden }: { values: { name: string; line: string }[]; overridden: boolean }) {
  const [v, setV] = useState(values.map(({ name, line }) => ({ name, line })));
  const set = (i: number, k: "name" | "line", x: string) => setV(v.map((r, j) => (j === i ? { ...r, [k]: x } : r)));
  return (
    <div className="jumbo-values">
      <p className="muted small-text">{overridden ? "Edited here — pushed values are no longer used." : "Saving here takes over from any values pushed by a script."}</p>
      {v.map((r, i) => (
        <div key={i} className="jumbo-value">
          <input value={r.name} placeholder="Value" onChange={(e) => set(i, "name", e.target.value)} />
          <input value={r.line} placeholder="One line on what it means" onChange={(e) => set(i, "line", e.target.value)} />
          <button className="small ghost" onClick={() => setV(v.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <div className="row">
        <button className="small" onClick={() => setV([...v, { name: "", line: "" }])}>Add a value</button>
        <button className="small primary" onClick={() => edit({ op: "values", values: v })}>Save values</button>
        {overridden ? <button className="small ghost" onClick={() => edit({ op: "values", values: null })}>Use the file again</button> : null}
      </div>
    </div>
  );
}
