// Give points by hand: only the givers in server config (POINT_GIVERS, or ADMIN_EMAILS when unset),
// never to yourself. In the office's Points tab and in Admin → Points.

import { useEffect, useState } from "react";

export function GivePoints({ onDone }: { onDone?: () => void }) {
  const [people, setPeople] = useState<{ id: number; name: string }[] | null>(null);
  const [who, setWho] = useState("");
  const [pts, setPts] = useState("50");
  const [why, setWhy] = useState("");
  const [post, setPost] = useState(true);
  const [busy, setBusy] = useState(false); // a double-click must not award (and post in #wins) twice
  const [msg, setMsg] = useState("");
  useEffect(() => { fetch("/api/points/people").then((r) => (r.ok ? r.json() : [])).then(setPeople).catch(() => setPeople([])); }, []);
  const give = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/points/award", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: Number(who), points: Number(pts), reason: why, post }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setMsg(j.error ?? "Couldn't give the points.");
      const name = people?.find((u) => String(u.id) === who)?.name ?? "They";
      setMsg(`Done: ${name} got ${pts} points.${Number(pts) > 0 && post ? (j.posted ? " Posted in #wins." : " Couldn't post in #wins; it's on the jumbotron.") : ""}`);
      setWhy("");
      onDone?.();
    } finally { setBusy(false); }
  };
  if (!people) return <p className="muted">Loading…</p>;
  return (
    <div className="give-points">
      <div className="give-row">
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Who">
          <option value="">Who…</option>
          {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <input type="number" value={pts} onChange={(e) => setPts(e.target.value)} step={10} aria-label="Points" className="give-pts" />
      </div>
      <input value={why} onChange={(e) => setWhy(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="What for (they'll see this)" maxLength={200} aria-label="Reason" className="give-why" />
      <div className="give-row">
        <label className="inline-check" title="Posts it in #wins, rings the office bell and puts it on the jumbotron. Never for a deduction."><input type="checkbox" checked={post} onChange={(e) => setPost(e.target.checked)} /> Post in #wins</label>
        <button className="primary small" disabled={busy || !who || !why.trim() || !Number(pts)} onClick={give}>{busy ? "Giving…" : "Give points"}</button>
      </div>
      {msg ? <p className="small-text muted">{msg}</p> : null}
    </div>
  );
}
