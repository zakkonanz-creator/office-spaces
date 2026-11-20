// Report a bug or suggest an idea. The bug button on the right-hand rail.
// Saved in the office (server/feedback.ts) for admins to read on Admin → Reports.
// Nothing here promises a fix or a date.

import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { useOffice, toast, roomName } from "./store";
import { recentErrors, bundleName } from "../clientErrors";

type Kind = "bug" | "idea";
type Mine = { id: number; kind: Kind; title: string; status: string; created_at: string };

const STATUS: Record<string, string> = {
  new: "Received", filed: "With Alex", fixing: "Fix in progress", fix_ready: "Fix ready for review",
  no_fix: "Needs a person", done: "Done", wont_do: "Not planned",
};

export function Report({ onClose }: { onClose: () => void }) {
  const s = useOffice();
  const [kind, setKind] = useState<Kind>("bug");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [mine, setMine] = useState<Mine[]>([]);

  useEffect(() => {
    fetch("/api/feedback/mine").then((r) => (r.ok ? r.json() : [])).then(setMine).catch(() => {});
  }, []);

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const context = {
        path: location.pathname,
        room: roomName(s.me?.roomId ?? null) ?? "",
        bundle: bundleName(),
        userAgent: navigator.userAgent,
        viewport: `${innerWidth}x${innerHeight}`,
        errors: kind === "bug" ? recentErrors() : [],
      };
      const r = await fetch("/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, title, details, context }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setErr(j.error ?? "Couldn't send it. Try again, or message Alex on Slack.");
      toast(kind === "bug" ? "Thanks! The bug report went to the admins." : "Thanks! Your idea went to the admins.");
      onClose();
    } catch {
      setErr("Couldn't send it. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal report" role="dialog" aria-label="Report a bug or suggest an idea" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onClose(); }}>
        <header className="modal-head">
          <h3>Report a bug or suggest an idea</h3>
          <button className="ghost" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </header>
        <div className="seg report-kind">
          <button className={kind === "bug" ? "on" : ""} onClick={() => setKind("bug")}>🐞 Something's broken</button>
          <button className={kind === "idea" ? "on" : ""} onClick={() => setKind("idea")}>💡 I have an idea</button>
        </div>
        <label className="report-field">
          <span>{kind === "bug" ? "What went wrong?" : "What would you like?"}</span>
          <input autoFocus value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)}
            placeholder={kind === "bug" ? "e.g. My camera turns off when I walk into the Kitchen" : "e.g. A shortcut to wave at the person next to me"} />
        </label>
        <label className="report-field">
          <span>{kind === "bug" ? "What did you do just before? What did you expect instead?" : "Why would it help? (optional)"}</span>
          <textarea value={details} maxLength={4000} rows={5} onChange={(e) => setDetails(e.target.value)}
            placeholder={kind === "bug" ? "Steps help most: where you were, what you clicked, what happened." : ""} />
        </label>
        {kind === "bug" ? <p className="hint">We also send your browser, screen size and any recent error messages from this page, so it can be fixed faster.</p> : null}
        {err ? <p className="error-text">{err}</p> : null}
        <div className="report-actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || title.trim().length < 4} onClick={send}>{busy ? "Sending…" : "Send"}</button>
        </div>
        {mine.length ? (
          <details className="report-mine">
            <summary>Your reports ({mine.length})</summary>
            <ul>
              {mine.map((m) => (
                <li key={m.id}><span>{m.kind === "bug" ? "🐞" : "💡"} {m.title}</span><span className="muted">{STATUS[m.status] ?? m.status}</span></li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  );
}
