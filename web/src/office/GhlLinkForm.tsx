// Paste your own GHL Meeting Room link once; "Start meeting" uses it from then on.

import { useEffect, useState } from "react";
import { toast } from "./store";

export function GhlLinkForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  // Changing your room: start from the one Space uses now.
  useEffect(() => { fetch("/api/me/ghl-room").then((r) => (r.ok ? r.json() : null)).then((j) => { if (j?.url) setUrl((u) => u || j.url); }).catch(() => {}); }, []);
  const save = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/me/ghl-room", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return toast(j.error ?? "Couldn't save that link.", { ttl: 8000 });
      toast(url.trim() ? "Saved. Start meeting will use your own room from now on." : "Removed. Start meeting will use a shared room.");
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ghl-link-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onCancel(); }}
        placeholder="https://crm.example.com/meet/your-name?pwd=…" aria-label="Your GHL Meeting Room link" />
      <button className="primary small" disabled={busy}>Save</button>
      <button type="button" className="small ghost" onClick={onCancel}>Cancel</button>
    </form>
  );
}
