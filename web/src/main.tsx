import { Component, StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { reportError, watchErrors } from "./clientErrors";

watchErrors();
import { Office } from "./office/Office";
import { Admin } from "./admin/Admin";
import { TimeApp } from "./time/TimeApp";

interface MeInfo {
  signedIn: boolean;
  guest?: boolean;
  name?: string;
  role?: string;
  email?: string;
  devLogin?: boolean;
}

function App() {
  const [me, setMe] = useState<MeInfo | null>(null);
  const path = location.pathname;
  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then(setMe).catch(() => setMe({ signedIn: false }));
  }, []);

  if (path.startsWith("/g/")) return <GuestJoin token={path.slice(3)} me={me} />;
  if (!me) return <div className="center-screen"><div className="spinner" /></div>;
  if (!me.signedIn) return <SignIn devLogin={Boolean(me.devLogin)} />;
  // Time & Payroll stand alone: no office, no audio/video, so clocking in works even when LiveKit is down.
  if (!me.guest && (path === "/time" || path.startsWith("/time/") || path === "/payroll" || path.startsWith("/payroll/"))) return <TimeApp name={me.name ?? ""} />;
  if (path.startsWith("/admin")) return me.role === "admin" ? <Admin /> : <div className="center-screen"><h2>Admins only</h2><a href="/">Back to the office</a></div>;
  return <Office me={{ name: me.name ?? "" }} />;
}

const SIGNIN_ERRORS: Record<string, string> = {
  domain: "That Google account isn't on an allowed domain. Use your @example.com or @example.org account.",
  removed: "Your access to Office Spaces has been removed. Ask an admin if that's a mistake.",
  unverified: "Google says that email isn't verified.",
  expired: "That sign-in took too long. Try again.",
  failed: "Sign-in failed. Try again.",
  access_denied: "Sign-in was cancelled.",
  "not-configured": "Google sign-in isn't set up on this server yet (GOOGLE_LOGIN_CLIENT_ID).",
};

function SignIn({ devLogin }: { devLogin: boolean }) {
  const params = new URLSearchParams(location.search);
  const err = params.get("signin");
  const next = location.pathname + (location.pathname === "/" ? "" : location.search);
  return (
    <div className="signin">
      <div className="signin-card">
        <img src="/logo.svg" alt="Acme" className="signin-logo" />
        <h1>Office Spaces</h1>
        <p className="muted">The office. Walk up to someone to talk.</p>
        {err ? <p className="error">{SIGNIN_ERRORS[err] ?? err}{params.get("email") ? ` (${params.get("email")})` : ""}</p> : null}
        <a className="button primary big google" href={`/auth/google?next=${encodeURIComponent(next)}`}>
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
          Sign in with Google
        </a>
        <p className="hint">Your work Google account.</p>
        {devLogin ? <DevLogin /> : null}
      </div>
    </div>
  );
}

function DevLogin() {
  const [email, setEmail] = useState("admin@example.com");
  const [name, setName] = useState("Alex Admin");
  return (
    <form className="devlogin" action="/auth/dev" method="get">
      <p className="eyebrow">Local dev sign-in</p>
      <input name="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input name="name" value={name} onChange={(e) => setName(e.target.value)} />
      <button type="submit">Sign in as this person</button>
    </form>
  );
}

function GuestJoin({ token, me }: { token: string; me: MeInfo | null }) {
  const [info, setInfo] = useState<{ label: string; room: string } | { error: string } | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch(`/api/guest/${token}`).then(async (r) => setInfo(await r.json()));
  }, [token]);
  if (me?.signedIn && !me.guest) {
    location.replace("/");
    return null;
  }
  if (!info) return <div className="center-screen"><div className="spinner" /></div>;
  if ("error" in info) return <div className="center-screen"><h2>Link expired</h2><p>{info.error} Ask whoever sent it for a new one.</p></div>;
  return (
    <div className="signin">
      <form
        className="signin-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const r = await fetch(`/api/guest/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
          if (r.ok) location.replace("/");
          else {
            setBusy(false);
            setInfo(await r.json());
          }
        }}
      >
        <img src="/logo.svg" alt="Acme" className="signin-logo" />
        <h1>You're invited</h1>
        <p className="muted">Join Acme in {/^an? room$/i.test(info.room) ? <b>a room</b> : <>the <b>{info.room}</b></>}.</p>
        <label className="field">
          Your name
          <input autoFocus required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="First and last name" />
        </label>
        <button className="primary big" disabled={busy || !name.trim()}>Continue</button>
        <p className="hint">You'll be asked for your camera and microphone next.</p>
      </form>
    </div>
  );
}

/** A crash anywhere shows a way back instead of a blank page. */
class Crashed extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("Office Spaces crashed:", error);
    reportError("react", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="center-screen">
        <h2>Something went wrong</h2>
        <p className="muted">The office hit an error. Reloading usually fixes it — if it keeps happening, post a screenshot in Slack.</p>
        <code className="block">{this.state.error.message}</code>
        <button className="primary" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Crashed>
      <App />
    </Crashed>
  </StrictMode>,
);
