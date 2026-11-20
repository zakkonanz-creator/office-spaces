// The jumbotron: one wall screen with company values, quarterly priorities,
// clients being onboarded, new sales, recent Google reviews and key dates.
//
// Live feeds are pulled here on a timer: Slack (a new-clients channel: new sales
// + onboarding), Notion (rocks), Google Places (reviews). Values and key dates
// are typed in by an admin on the screen, or pushed from a script with
// JUMBOTRON_PUSH_KEY (POST /api/jumbotron/static, see the README).
//
// Every section keeps its last good copy (in the settings table, so a redeploy
// doesn't blank the screen) and says when it last refreshed. A feed that fails
// keeps showing old data with its error, never an empty "all clear".
// Client names are on it, so guests never get it.

import { timingSafeEqual } from "node:crypto";
import { firstName } from "../shared/names";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSetting, one, setSetting } from "./db";

export interface Board {
  values: { name: string; line: string }[];
  priorities: { title: string; owner: string | null; status: string | null }[];
  onboarding: { name: string; company: string | null; product: string | null; state: "waiting" | "in progress"; at: number }[];
  sales: { name: string; company: string | null; product: string | null; at: number }[];
  reviews: { author: string; rating: number; text: string; at: number }[];
  rating: number | null;
  dates: { date: string; label: string }[];
  /** #wins posts (server/wins.ts), newest first, for a week. `img`: its picture in win_images
   * (null = it has none; missing or `pending` = not fetched yet). */
  wins: { name: string; text: string; at: number; img?: number | null; video?: boolean; pending?: boolean }[];
  /** When each section last refreshed, and why it didn't if it failed. */
  updated: Partial<Record<Section, number>>;
  errors: Partial<Record<Section, string>>;
}
type Section = "values" | "priorities" | "onboarding" | "sales" | "reviews" | "dates" | "wins";

const env = (k: string) => (process.env[k] ?? "").trim();
const cfg = {
  slackToken: env("JUMBOTRON_SLACK_TOKEN"),
  slackChannel: env("JUMBOTRON_SLACK_CHANNEL"), // channel id whose posts are "new clients" (✅ reaction = done)
  notionToken: env("NOTION_TOKEN"),
  rocksSource: env("NOTION_ROCKS_DATA_SOURCE"),
  placesKey: env("GOOGLE_PLACES_API_KEY"),
  placeId: env("GOOGLE_PLACE_ID"),
  pushKey: env("JUMBOTRON_PUSH_KEY"),
};

const EMPTY: Board = { values: [], priorities: [], onboarding: [], sales: [], reviews: [], rating: null, dates: [], wins: [], updated: {}, errors: {} };
let board: Board = EMPTY;
const save = () => setSetting("jumbotron", board);

async function refresh(section: Section, run: () => Promise<Partial<Board>>, needs: string) {
  if (!needs) {
    board.errors[section] = "not connected yet";
    return;
  }
  try {
    Object.assign(board, await run());
    board.updated[section] = Date.now();
    delete board.errors[section];
  } catch (e) {
    board.errors[section] = (e as Error).message.slice(0, 200);
    console.warn(`jumbotron ${section}: ${(e as Error).message}`);
  }
}

// ── Slack: a new-clients channel ───────────────────────────────────────────
// One message per new client: the client's name on the first line, then
// (optionally) their email and the product on the next lines. Someone marks 👀
// when they pick it up and ✅ when onboarding is done.

const FREE_MAIL = /^(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|me|aol|proton|protonmail|msn)\./i;
const PHONE = /^[+(]?[\d\s().-]{7,}$/;
const NOT_PRODUCT = /^(monthly|annually|yearly|quarterly|weekly)$/i;
/** Lines that are a label with nothing useful after it ("Notes:", "ID: 123") are never the product. */
const LABEL = /^[\w ]{1,30}:\s*\S*$/;

export function parseNotice(text: string): { name: string; company: string | null; product: string | null } | null {
  const lines = text.split("\n").map((l) => l.replace(/[*_~]/g, "").trim()).filter(Boolean);
  const name = lines[0];
  if (!name || name.startsWith("<") || name.length > 80 || name.includes("@")) return null;
  const email = (text.match(/mailto:[^|>@\s]+@([^|>\s]+)/) ?? text.match(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/))?.[1]?.toLowerCase() ?? null;
  const company = email && !FREE_MAIL.test(email) ? email : null;
  const product = lines
    .slice(1)
    // Never contact details: some phones and emails arrive as plain text, not <tel:>/<mailto:> links.
    .filter((l) => !l.startsWith("<") && !l.includes("@") && !PHONE.test(l) && !NOT_PRODUCT.test(l) && !LABEL.test(l))
    .slice(0, 1)[0] ?? null;
  return { name, company, product };
}

async function slack(method: string, params: Record<string, string>) {
  const r = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${cfg.slackToken}` } });
  const d = (await r.json()) as any;
  if (!d.ok) throw new Error(`Slack ${method}: ${d.error}`);
  return d;
}

async function pullSlack(): Promise<Partial<Board>> {
  const since = Date.now() / 1000 - 45 * 86400;
  const d = await slack("conversations.history", { channel: cfg.slackChannel, limit: "200", oldest: String(Math.floor(since)) });
  const onboarding: Board["onboarding"] = [];
  const sales: Board["sales"] = [];
  for (const m of d.messages as any[]) {
    if (m.subtype && m.subtype !== "bot_message") continue; // joins, topic changes…
    const n = parseNotice(m.text ?? "");
    if (!n) continue;
    const at = Math.round(Number(m.ts) * 1000);
    const reacts = new Set((m.reactions ?? []).map((r: any) => r.name as string));
    if (Date.now() - at < 7 * 86400e3) sales.push({ ...n, at });
    if (!reacts.has("white_check_mark") && !reacts.has("heavy_check_mark")) onboarding.push({ ...n, at, state: reacts.has("eyes") ? "in progress" : "waiting" });
  }
  sales.sort((a, b) => b.at - a.at);
  onboarding.sort((a, b) => a.at - b.at); // longest waiting first
  return { sales: sales.slice(0, 15), onboarding: onboarding.slice(0, 20) };
}

// ── Notion: the Rocks database ─────────────────────────────────────────────

const plain = (v: any): string | null => {
  if (!v) return null;
  switch (v.type) {
    case "title": case "rich_text": return v[v.type].map((t: any) => t.plain_text).join("") || null;
    case "status": case "select": return v[v.type]?.name ?? null;
    case "people": return v.people.map((p: any) => p.name).filter(Boolean).join(", ") || null;
    case "formula": return v.formula?.string ?? null;
    default: return null;
  }
};

/** "Q4 2026" for a date; rocks are tagged with their quarter in a Quarter property. */
export const quarterOf = (d = new Date()) => `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;

export function pickRocks(pages: any[], now = new Date()): Board["priorities"] {
  const q = quarterOf(now);
  const [qn, qy] = q.split(" ");
  const rows = pages.map((p) => {
    const props: Record<string, any> = p.properties ?? {};
    const find = (re: RegExp, types: string[]) => Object.entries(props).find(([k, v]) => re.test(k) && types.includes(v.type))?.[1];
    const title = plain(Object.values(props).find((v: any) => v.type === "title"));
    const quarter = plain(find(/quarter/i, ["select", "status", "rich_text", "formula"]));
    return {
      title,
      owner: plain(find(/owner|dri|accountable/i, ["people"])),
      status: plain(find(/status/i, ["status", "select"])),
      quarter,
    };
  });
  // With a Quarter property, only this quarter's rocks ("Q4", "Q4 2026", "2026 Q4"…).
  const hasQuarter = rows.some((r) => r.quarter);
  const thisQ = (s: string | null) => !!s && s.includes(qn) && (!/\d{4}/.test(s) || s.includes(qy));
  return rows
    .filter((r) => r.title && (!hasQuarter || thisQ(r.quarter)) && !/^(done|complete|completed|cancel)/i.test(r.status ?? ""))
    .map(({ title, owner, status }) => ({ title: title!, owner, status }))
    .slice(0, 12);
}

async function pullNotion(): Promise<Partial<Board>> {
  const r = await fetch(`https://api.notion.com/v1/data_sources/${cfg.rocksSource}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.notionToken}`, "notion-version": "2025-09-03", "content-type": "application/json" },
    body: JSON.stringify({ page_size: 100 }),
  });
  const d = (await r.json()) as any;
  if (!r.ok) throw new Error(r.status === 404 ? "the Rocks database isn't shared with the Notion integration" : `Notion ${r.status}: ${d.message ?? ""}`);
  return { priorities: pickRocks(d.results ?? []) };
}

// ── Google reviews (Places API, New) ───────────────────────────────────────
// Google returns at most 5 reviews, chosen by "relevance", not date — so this
// shows the latest of those 5, good ones first. It can't list every new review.

async function pullReviews(): Promise<Partial<Board>> {
  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(cfg.placeId)}?languageCode=en`, {
    headers: { "x-goog-api-key": cfg.placesKey, "x-goog-fieldmask": "rating,reviews" },
  });
  const d = (await r.json()) as any;
  if (!r.ok) throw new Error(`Google ${r.status}: ${d.error?.message ?? ""}`);
  const reviews = (d.reviews ?? [])
    .map((x: any) => ({
      author: x.authorAttribution?.displayName ?? "A customer",
      rating: x.rating ?? 0,
      text: (x.originalText?.text ?? x.text?.text ?? "").slice(0, 400),
      at: Date.parse(x.publishTime ?? "") || 0,
    }))
    .filter((x: Board["reviews"][number]) => x.rating >= 4 && x.text)
    .sort((a: Board["reviews"][number], b: Board["reviews"][number]) => b.at - a.at);
  return { reviews, rating: typeof d.rating === "number" ? d.rating : null };
}

// ── #wins (server/wins.ts) ─────────────────────────────────────────────────

const WIN_DAYS = 7;
/** A new #wins post goes on the screen (kept a week, newest first). */
export async function addWin(name: string, text: string, at = Date.now(), media: { img?: number | null; video?: boolean; pending?: boolean } = { img: null }) {
  const win: Board["wins"][number] = { name: firstName(name), text, at, img: media.img ?? null };
  if (media.video) win.video = true;
  if (media.pending) win.pending = true;
  board.wins = [win, ...(board.wins ?? []).filter((w) => at - w.at < WIN_DAYS * 864e5)].slice(0, 20);
  board.updated.wins = at;
  await save();
}

/** This week's wins whose picture hasn't been looked for yet, or couldn't be fetched (by their `at`). */
export function winsMissingImages(now = Date.now()): number[] {
  return (board.wins ?? []).filter((w) => now - w.at < WIN_DAYS * 864e5 && (w.img === undefined || w.pending)).map((w) => w.at);
}

/** The picture for a win already on the screen (null: it has none). */
export async function attachWinImage(at: number, img: number | null, video: boolean) {
  const w = (board.wins ?? []).find((x) => x.at === at);
  if (!w) return;
  w.img = img;
  delete w.pending;
  if (video) w.video = true;
  board.updated.wins = Date.now();
  await save();
}

// ── Wiring ─────────────────────────────────────────────────────────────────

let started = false;
export async function startJumbotron() {
  if (started) return;
  started = true;
  board = { ...EMPTY, ...(await getSetting<Board>("jumbotron", EMPTY)) };
  edits = { ...NO_EDITS, ...(await getSetting<Edits>("jumbotron_edits", NO_EDITS)) };
  board.updated ??= {};
  board.errors ??= {};
  const live = async () => {
    await refresh("sales", pullSlack, cfg.slackToken && cfg.slackChannel);
    if (cfg.slackToken && cfg.slackChannel) { board.updated.onboarding = board.updated.sales; if (board.errors.sales) board.errors.onboarding = board.errors.sales; else delete board.errors.onboarding; }
    else board.errors.onboarding = "not connected yet";
    await save();
  };
  const slow = async () => {
    await refresh("priorities", pullNotion, cfg.notionToken && cfg.rocksSource);
    await refresh("reviews", pullReviews, cfg.placesKey && cfg.placeId);
    await save();
  };
  void live();
  void slow();
  setInterval(() => void live(), 10 * 60e3);
  setInterval(() => void slow(), 60 * 60e3);
}

const keyOk = (got: unknown) => {
  if (!cfg.pushKey || typeof got !== "string") return false;
  const a = Buffer.from(got), b = Buffer.from(cfg.pushKey);
  return a.length === b.length && timingSafeEqual(a, b);
};

const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

// ── Admin edits ────────────────────────────────────────────────────────────
// A layer on top of the feeds, so a refresh or the daily push never undoes it:
// hide any item, add dates/priorities/reviews by hand, override the values,
// switch whole sections off the screen.

export interface Edits {
  hidden: string[];
  dates: Board["dates"];
  priorities: Board["priorities"];
  reviews: Board["reviews"];
  values: Board["values"] | null;
  off: Section[];
}
const NO_EDITS: Edits = { hidden: [], dates: [], priorities: [], reviews: [], values: null, off: [] };
let edits: Edits = NO_EDITS;
const SECTIONS: Section[] = ["wins", "sales", "onboarding", "priorities", "dates", "reviews", "values"];

/** A stable key per item, for hiding it. */
export const itemKey = (section: Section, i: any): string =>
  section === "sales" || section === "onboarding" || section === "wins" ? `${section}:${i.name}|${i.at}`
  : section === "reviews" ? `reviews:${i.author}|${i.at}`
  : section === "priorities" ? `priorities:${i.title}`
  : section === "dates" ? `dates:${i.date}|${i.label}`
  : `values:${i.name}`;

/** The board as people see it. Admins also get hidden items (marked) and switched-off sections, to undo them. */
export function view(b: Board, e: Edits, admin: boolean) {
  const mark = <T,>(section: Section, live: T[], manual: T[] = []) =>
    [...live.map((i) => ({ ...i, key: itemKey(section, i) })), ...manual.map((i) => ({ ...i, key: itemKey(section, i), manual: true }))]
      .map((i) => (e.hidden.includes(i.key) ? { ...i, hidden: true } : i))
      .filter((i: any) => admin || !i.hidden);
  const out = {
    ...b,
    sales: mark("sales", b.sales),
    wins: mark("wins", (b.wins ?? []).filter((w) => Date.now() - w.at < WIN_DAYS * 864e5)),
    onboarding: mark("onboarding", b.onboarding),
    priorities: mark("priorities", b.priorities, e.priorities),
    dates: mark("dates", b.dates, e.dates).sort((x: any, y: any) => x.date.localeCompare(y.date)),
    reviews: mark("reviews", b.reviews, e.reviews).sort((x: any, y: any) => y.at - x.at),
    values: mark("values", e.values ?? b.values),
    valuesOverridden: Boolean(e.values),
    off: e.off,
  };
  if (!admin) for (const k of e.off) (out as any)[k] = [];
  return out;
}

type EditOp =
  | { op: "hide" | "unhide"; key: string }
  | { op: "add"; section: "dates" | "priorities" | "reviews"; item: any }
  | { op: "remove"; key: string }
  | { op: "values"; values: { name: string; line: string }[] | null }
  | { op: "section"; section: Section; on: boolean };

/** Apply one admin edit; throws with a plain message when it's not valid. */
export function applyEdit(e: Edits, o: EditOp): Edits {
  const n: Edits = structuredClone(e);
  switch (o?.op) {
    case "hide": if (!n.hidden.includes(o.key)) n.hidden = [...n.hidden, str(o.key, 300)].slice(-500); return n;
    case "unhide": n.hidden = n.hidden.filter((k) => k !== o.key); return n;
    case "add": {
      const it = o.item ?? {};
      if (o.section === "dates") {
        const d = { date: str(it.date, 10), label: str(it.label, 120) };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !d.label) throw new Error("A date needs a day and a label.");
        n.dates.push(d);
      } else if (o.section === "priorities") {
        const p = { title: str(it.title, 140), owner: str(it.owner, 80) || null, status: str(it.status, 40) || null };
        if (!p.title) throw new Error("A priority needs a title.");
        n.priorities.push(p);
      } else if (o.section === "reviews") {
        const r = { author: str(it.author, 80) || "A customer", rating: Math.max(1, Math.min(5, Math.round(Number(it.rating) || 5))), text: str(it.text, 400), at: Date.now() };
        if (!r.text) throw new Error("A review needs its text.");
        n.reviews.push(r);
      } else throw new Error("Only dates, priorities and reviews can be added by hand.");
      return n;
    }
    case "remove": {
      const keep = (section: Section) => (i: any) => itemKey(section, i) !== o.key;
      n.dates = n.dates.filter(keep("dates"));
      n.priorities = n.priorities.filter(keep("priorities"));
      n.reviews = n.reviews.filter(keep("reviews"));
      return n;
    }
    case "values": {
      if (o.values === null) { n.values = null; return n; }
      const v = (Array.isArray(o.values) ? o.values : []).slice(0, 12).map((x: any) => ({ name: str(x?.name, 80), line: str(x?.line, 240) })).filter((x) => x.name);
      if (!v.length) throw new Error("Keep at least one value, or switch back to the file.");
      n.values = v;
      return n;
    }
    case "section": {
      if (!SECTIONS.includes(o.section)) throw new Error("No such section.");
      n.off = o.on ? n.off.filter((x) => x !== o.section) : [...new Set([...n.off, o.section])];
      return n;
    }
    default: throw new Error("Unknown edit.");
  }
}

type Who = { id: number; role: string } | null;
export function registerJumbotron(app: FastifyInstance, needUser: (req: FastifyRequest, reply: FastifyReply) => Who, needAdmin: (req: FastifyRequest, reply: FastifyReply) => Who) {
  /** Teammates only: it lists clients by name. */
  app.get("/api/jumbotron", async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return;
    return view(board, edits, u.role === "admin");
  });

  /** A win's screenshot (server/wins.ts). Teammates only, like the screen: customers' words are on them. */
  app.get("/api/jumbotron/win/:id", async (req, reply) => {
    if (!needUser(req, reply)) return;
    const row = await one<{ mime: string; bytes: Buffer }>(`SELECT mime, bytes FROM win_images WHERE id = $1`, [Number((req.params as { id: string }).id) || 0]);
    if (!row) return reply.code(404).send({ error: "no such picture" });
    return reply.header("content-type", row.mime).header("cache-control", "private, max-age=86400").header("x-content-type-options", "nosniff").send(row.bytes);
  });

  /** Admins edit what's on the screen. One change per call, so two admins can't overwrite each other's lists. */
  app.post("/api/admin/jumbotron/edit", async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    try {
      edits = applyEdit(edits, req.body as EditOp);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    await setSetting("jumbotron_edits", edits);
    return view(board, edits, true);
  });
  /** Values + key dates, pushed from a script of your own (header x-api-key: JUMBOTRON_PUSH_KEY). */
  app.post("/api/jumbotron/static", async (req, reply) => {
    if (!keyOk(req.headers["x-api-key"])) return reply.code(401).send({ error: "bad key" });
    const b = (req.body ?? {}) as { values?: unknown; dates?: unknown };
    if (Array.isArray(b.values)) {
      board.values = b.values.slice(0, 12).map((v: any) => ({ name: str(v?.name, 80), line: str(v?.line, 240) })).filter((v) => v.name);
      board.updated.values = Date.now();
      delete board.errors.values;
    }
    if (Array.isArray(b.dates)) {
      board.dates = b.dates
        .slice(0, 40)
        .map((d: any) => ({ date: str(d?.date, 10), label: str(d?.label, 120) }))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.label)
        .sort((a, b) => a.date.localeCompare(b.date));
      board.updated.dates = Date.now();
      delete board.errors.dates;
    }
    await save();
    return { ok: true, values: board.values.length, dates: board.dates.length };
  });
}
