// Every setting the server reads, in one place. On Railway these are service
// Variables; locally, `.env` (see env.example) is loaded by index.ts.

const env = (k: string, d = "") => (process.env[k] ?? d).trim();
const list = (k: string, d = "") => env(k, d).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export const config = {
  port: Number(env("PORT", "8787")),
  production: env("NODE_ENV") === "production",
  /** No trailing slash. Used for OAuth redirects and guest links. */
  publicUrl: env("PUBLIC_BASE_URL", "http://localhost:5173").replace(/\/$/, ""),
  /** Signs session cookies, OAuth state and guest links; also derives the token-encryption key. */
  sessionSecret: env("SESSION_SECRET"),
  databaseUrl: env("DATABASE_URL"),
  /** Local dev without Postgres: an embedded PGlite database lives here. */
  pgliteDir: env("PGLITE_DIR", ".data/pglite"),

  google: {
    // Sign-in: a consent screen asking only openid/email/profile, so it needs no
    // Google verification. Make it External if people sign in from more than one
    // Google Workspace.
    login: { id: env("GOOGLE_LOGIN_CLIENT_ID"), secret: env("GOOGLE_LOGIN_CLIENT_SECRET") },
    // Calendar + Meet settings + Drive: sensitive scopes, so you may want a
    // separate (Internal) client for them. Falls back to the login client.
    workspace: {
      id: env("GOOGLE_WORKSPACE_CLIENT_ID") || env("GOOGLE_LOGIN_CLIENT_ID"),
      secret: env("GOOGLE_WORKSPACE_CLIENT_SECRET") || env("GOOGLE_LOGIN_CLIENT_SECRET"),
    },
  },
  /** Enforced at sign-in: only Google accounts on these domains get in (comma-separated). Required in production; empty locally = any. */
  allowedDomains: list("ALLOWED_EMAIL_DOMAINS"),
  /** First sign-in from these addresses becomes admin. Admins can promote others in the app. */
  adminEmails: list("ADMIN_EMAILS", ""),
  /** Local only: /auth/dev?email=… signs in without Google. Refused in production. */
  devLogin: env("DEV_LOGIN") === "1",

  livekit: {
    /** What browsers connect to. wss:// on Railway. */
    url: env("LIVEKIT_URL", "ws://127.0.0.1:7880"),
    apiKey: env("LIVEKIT_API_KEY", "devkey"),
    apiSecret: env("LIVEKIT_API_SECRET", "secret"),
  },

  /** The Whisper service (transcriber/): the office sends it one person's clip at a time. */
  transcriber: {
    url: env("TRANSCRIBER_URL").replace(/\/$/, ""),
    key: env("TRANSCRIBER_KEY"),
  },

  slack: {
    /** Bot token with users:read, users:read.email, chat:write, im:write. Optional. */
    botToken: env("SLACK_BOT_TOKEN"),
    teamId: env("SLACK_TEAM_ID"),
  },

  /** Who may give (or take back) points by hand. Nobody can give points to themselves.
   *  POINT_GIVERS (comma-separated emails); unset = the people in ADMIN_EMAILS. */
  pointGivers: new Set((env("POINT_GIVERS") || env("ADMIN_EMAILS"))
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)),

  /** Optional: a bot that reads bug/idea reports over /api/agent/feedback (server/feedback.ts). Off under 32 chars. */
  feedbackAgentKey: env("FEEDBACK_AGENT_KEY"),

  fathom: {
    /** One whsec_… per Fathom webhook (each person's webhook has its own), comma-separated. */
    webhookSecrets: env("FATHOM_WEBHOOK_SECRETS").split(",").map((s) => s.trim()).filter(Boolean),
  },

  drive: {
    /** A Drive folder for meeting notes/recordings.
     *  The account that writes to it is linked once by an admin in the app. */
    folderId: env("DRIVE_RECORDINGS_FOLDER_ID"),
    /** A private folder (admins only) for the nightly database export. Time records are in
     *  it, so it must NOT be the shared recordings folder. Unset = no Drive export. */
    backupFolderId: env("DRIVE_BACKUP_FOLDER_ID"),
  },

  /** Minutes of no keyboard/mouse before someone is marked Away automatically. */
  idleMinutes: Number(env("IDLE_MINUTES", "10")),
};

export function assertConfig() {
  const missing: string[] = [];
  if (!config.sessionSecret || config.sessionSecret.length < 32) missing.push("SESSION_SECRET (32+ chars)");
  if (config.production) {
    if (!config.databaseUrl) missing.push("DATABASE_URL");
    if (config.livekit.apiSecret === "secret") missing.push("LIVEKIT_API_KEY / LIVEKIT_API_SECRET");
    if (config.devLogin) missing.push("DEV_LOGIN must be off in production");
    if (!config.allowedDomains.length) missing.push("ALLOWED_EMAIL_DOMAINS (whose Google accounts may sign in)");
  }
  // A second lock: the dev login only ever runs on localhost, whatever NODE_ENV says.
  if (config.devLogin && !/^(localhost|127\.0\.0\.1)$/.test(new URL(config.publicUrl).hostname)) {
    missing.push("DEV_LOGIN only works on localhost");
  }
  if (missing.length) throw new Error(`config: ${missing.join(", ")}`);
  if (!config.google.login.id || !config.google.login.secret) {
    console.warn("GOOGLE_LOGIN_CLIENT_ID / GOOGLE_LOGIN_CLIENT_SECRET not set — the office runs, but nobody can sign in yet.");
  }
}
