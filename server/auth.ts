// Sessions, Google sign-in, guest links, and encryption for stored Google tokens.
//
// Sessions are a signed cookie, not a server-side table: the payload is tiny
// (a user id or a guest invite) and every request re-reads the user row, so a
// removed user is locked out on their next request regardless of the cookie.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { one, q } from "./db";
import { slackProfile } from "./slack";
import type { Role } from "../shared/protocol";
import { floor } from "./floorStore";
import { claimPreassigned } from "./preassign";
import { applyPendingDeputy } from "./time/deputy";
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

// ── Signing ────────────────────────────────────────────────────────────────

/** Every signed token says what it is, so one kind can never be replayed as another
 *  (an OAuth state is not a session cookie; a guest link is not a session). */
export type TokenType = "session" | "oauth" | "guest-link";

export function sign(typ: TokenType, payload: object): string {
  const body = b64u(JSON.stringify({ ...payload, typ }));
  const mac = createHmac("sha256", config.sessionSecret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verify<T extends object>(typ: TokenType, token: string | undefined): T | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", config.sessionSecret).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as T & { exp?: number; typ?: string };
    if (p.typ !== typ) return null;
    if (p.exp && p.exp < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

// ── Encrypting refresh tokens at rest ─────────────────────────────────────

const key = () => createHash("sha256").update(`token-key:${config.sessionSecret}`).digest();

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function unseal(sealed: string): string {
  const [iv, tag, enc] = sealed.split(".").map((s) => Buffer.from(s, "base64url"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

// ── Who is this request? ───────────────────────────────────────────────────

export const COOKIE = "es_session";
const SESSION_DAYS = 30;

export interface UserRow {
  id: number;
  email: string;
  name: string;
  title: string | null;
  avatar_url: string | null;
  slack_id: string | null;
  role: Role;
  desk_id: string | null;
  tz: string | null;
  removed: boolean;
  google_refresh_token: string | null;
  started_on?: Date | string | null;
  created_at?: Date | string;
}

export type Viewer =
  | { kind: "user"; user: UserRow }
  | { kind: "guest"; inviteId: number; name: string; key: string; roomId: string; canPresent: boolean };

interface SessionPayload {
  u?: number;
  /** users.session_version when issued; signing out bumps it, which ends every session. */
  v?: number;
  g?: number;
  n?: string;
  k?: string;
  exp: number;
}

export function sessionCookie(p: Omit<SessionPayload, "exp">, days = SESSION_DAYS) {
  return {
    value: sign("session", { ...p, exp: Date.now() + days * 864e5 }),
    options: {
      path: "/",
      httpOnly: true,
      sameSite: "lax" as const,
      secure: config.production,
      maxAge: days * 86400,
    },
  };
}

export async function viewerFrom(cookie: string | undefined): Promise<Viewer | null> {
  const s = verify<SessionPayload>("session", cookie);
  if (!s) return null;
  if (s.u) {
    const user = await one<UserRow & { session_version?: number }>(`SELECT * FROM users WHERE id = $1`, [s.u]);
    if (!user || user.removed) return null;
    if ((user.session_version ?? 0) !== (s.v ?? 0)) return null;
    return { kind: "user", user };
  }
  if (s.g && s.n && s.k) {
    const inv = await one(`SELECT * FROM guest_invites WHERE id = $1`, [s.g]);
    if (!inv || inv.revoked || (inv.expires_at && new Date(inv.expires_at) < new Date())) return null;
    return { kind: "guest", inviteId: inv.id, name: s.n, key: s.k, roomId: inv.room_id, canPresent: inv.can_present };
  }
  return null;
}

/** Reads the session cookie out of a raw Cookie header (for the socket handshake). */
export function cookieFromHeader(header: string | undefined): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

// ── Google ─────────────────────────────────────────────────────────────────

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

export type GoogleFlow = "login" | "calendar" | "drive";

const FLOWS: Record<GoogleFlow, { scopes: string[]; client: () => { id: string; secret: string }; offline: boolean }> = {
  login: { scopes: ["openid", "email", "profile"], client: () => config.google.login, offline: false },
  // The same scopes /meet asks for: create the event + Meet link, then turn on
  // Google's auto-recording for a space Calendar created.
  calendar: {
    scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/meetings.space.settings"],
    client: () => config.google.workspace,
    offline: true,
  },
  drive: { scopes: ["openid", "email", "https://www.googleapis.com/auth/drive"], client: () => config.google.workspace, offline: true },
};

export const redirectUri = () => `${config.publicUrl}/auth/google/callback`;

/** The OAuth state is bound to the browser that started sign-in via this cookie's nonce
 *  (login CSRF: an attacker's code+state pasted into your browser must not sign you in as them). */
export const OAUTH_COOKIE = "es_oauth";

export function googleAuthUrl(flow: GoogleFlow, next: string, nonce: string, uid?: number): string {
  const f = FLOWS[flow];
  const params = new URLSearchParams({
    client_id: f.client().id,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: f.scopes.join(" "),
    state: sign("oauth", { f: flow, n: next, u: uid, nonce, exp: Date.now() + 10 * 60e3 }),
    prompt: f.offline ? "consent" : "select_account",
    ...(f.offline ? { access_type: "offline", include_granted_scopes: "true" } : {}),
  });
  return `${AUTH}?${params}`;
}

export interface GoogleState { f: GoogleFlow; n: string; u?: number; nonce: string }

export async function exchange(flow: GoogleFlow, code: string) {
  const c = FLOWS[flow].client();
  const r = await fetch(TOKEN, {
    signal: AbortSignal.timeout(15_000), method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: c.id, client_secret: c.secret, redirect_uri: redirectUri(), grant_type: "authorization_code" }),
  });
  if (!r.ok) throw new Error(`Google token exchange failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const tok = (await r.json()) as { access_token: string; refresh_token?: string };
  const ui = await fetch(USERINFO, { headers: { authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(15_000) });
  if (!ui.ok) throw new Error(`Google userinfo failed (${ui.status})`);
  const info = (await ui.json()) as { email: string; email_verified?: boolean; name?: string; picture?: string };
  return { ...tok, info };
}

export async function googleAccessToken(flow: "calendar" | "drive", refreshToken: string): Promise<string> {
  const c = FLOWS[flow].client();
  const r = await fetch(TOKEN, {
    signal: AbortSignal.timeout(15_000), method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: c.id, client_secret: c.secret, grant_type: "refresh_token" }),
  });
  if (r.status === 400 && (await r.clone().text()).includes("invalid_grant")) throw new LinkExpired();
  if (!r.ok) throw new Error(`Google token refresh failed (${r.status})`);
  return ((await r.json()) as { access_token: string }).access_token;
}

export class LinkExpired extends Error {
  constructor() {
    super("Google link expired — link your calendar again");
  }
}

export function domainAllowed(email: string): boolean {
  const domain = email.toLowerCase().split("@")[1] ?? "";
  return config.allowedDomains.length === 0 || config.allowedDomains.includes(domain);
}

// ── First sign-in: create the person, seat them at their desk ─────────────

const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\(.*?\)/g, " ").replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);

/** Does a Google display name plausibly belong to a roster name? First name + any other token. */
export function nameMatches(google: string, roster: string): boolean {
  const g = norm(google);
  const r = norm(roster);
  if (!g.length || !r.length) return false;
  if (g[0] !== r[0]) return false;
  if (g.length === 1 || r.length === 1) return g.length === r.length; // "Robin" ↔ "Robin"
  return g.slice(1).some((t) => r.slice(1).includes(t));
}

/**
 * Slack id, photo and title for everyone who hasn't got them yet — people added
 * before the office had a Slack token, or before they joined Slack. Paced well under
 * Slack's lookup limit. Returns how many were filled.
 */
export async function fillSlackProfiles(): Promise<number> {
  if (!config.slack.botToken) return 0;
  const rows = await q<{ id: number; email: string }>(`SELECT id, email FROM users WHERE slack_id IS NULL AND NOT removed ORDER BY id`);
  let n = 0;
  for (const r of rows) {
    const s = await slackProfile(r.email);
    if (s) {
      await q(`UPDATE users SET slack_id = $1, avatar_url = CASE WHEN avatar_url LIKE '/api/photos/%' THEN avatar_url ELSE COALESCE($2, avatar_url) END, title = COALESCE(title, $3) WHERE id = $4`, [s.id, s.avatar, s.title, r.id]);
      n++;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return n;
}

export async function upsertUser(email: string, name: string, picture?: string): Promise<UserRow> {
  email = email.toLowerCase();
  let user = await one<UserRow>(`SELECT * FROM users WHERE email = $1`, [email]);
  if (!user) {
    const role: Role = config.adminEmails.includes(email) ? "admin" : "member";
    // Two first sign-ins at once (two tabs): the second finds the row the first made.
    const made = await one<UserRow>(`INSERT INTO users (email, name, avatar_url, role) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING RETURNING *`, [email, name, picture ?? null, role]);
    if (!made) return upsertUser(email, name, picture);
    user = made;
    // An admin may have set up their access before this first sign-in (Admin → Members).
    const pre = await claimPreassigned(user.id, email);
    // ADMIN_EMAILS stays admin whatever was pre-set; otherwise the pre-set role wins.
    if (pre && role !== "admin") user.role = pre;
    else if (pre && pre !== role) await q(`UPDATE users SET role = $2 WHERE id = $1`, [user.id, role]);
    // Their Deputy profile, schedule and leave may be waiting for this first sign-in (Team → People → Import from Deputy).
    await applyPendingDeputy(null, user.id).catch((e) => console.error("deputy apply", e));
  }
  // Seat them: the roster-seeded desk whose owner name matches, if still free.
  if (!user.desk_id) {
    const taken = new Set((await q<{ desk_id: string }>(`SELECT desk_id FROM users WHERE desk_id IS NOT NULL`)).map((r) => r.desk_id));
    const desk = floor.desks.find((d) => d.owner && !taken.has(d.id) && nameMatches(name, d.owner));
    if (desk) {
      user = (await one<UserRow>(`UPDATE users SET desk_id = $1, title = COALESCE(title, $2) WHERE id = $3 RETURNING *`, [desk.id, desk.title ?? null, user.id]))!;
    }
  }
  // Slack: the id (for "Message on Slack") and the profile photo everyone recognises.
  if (!user.slack_id) {
    const s = await slackProfile(email);
    if (s) {
      user = (await one<UserRow>(
        `UPDATE users SET slack_id = $1, avatar_url = CASE WHEN avatar_url LIKE '/api/photos/%' THEN avatar_url ELSE COALESCE($2, avatar_url) END, title = COALESCE(title, $3) WHERE id = $4 RETURNING *`,
        [s.id, s.avatar, s.title, user.id],
      ))!;
    }
  }
  if (!user.avatar_url && picture) {
    user = (await one<UserRow>(`UPDATE users SET avatar_url = $1 WHERE id = $2 RETURNING *`, [picture, user.id]))!;
  }
  return user;
}

// ── Guest links ────────────────────────────────────────────────────────────

/** The link token carries only the invite id; expiry and revocation live in the DB. */
export const guestToken = (inviteId: number) => sign("guest-link", { i: inviteId });
export const guestLink = (inviteId: number) => `${config.publicUrl}/g/${guestToken(inviteId)}`;
export const newGuestKey = () => b64u(randomBytes(9));
export const newNonce = () => b64u(randomBytes(16));
export const lkId = (personId: string) => "p" + createHmac("sha256", config.sessionSecret).update(`livekit:${personId}`).digest("base64url").slice(0, 14);

/** Only same-site paths survive as a post-sign-in destination. "/\\evil.com" and friends don't. */
export function safeNext(n: unknown): string {
  if (typeof n !== "string" || !n.startsWith("/") || n.startsWith("//") || n.includes("\\")) return "/";
  try {
    const u = new URL(n, "https://x.invalid");
    // Check the *normalised* path: "/.//evil.com" collapses to "//evil.com".
    if (u.host !== "x.invalid" || u.pathname.startsWith("//") || u.pathname.includes("\\")) return "/";
    return u.pathname + u.search;
  } catch {
    return "/";
  }
}
