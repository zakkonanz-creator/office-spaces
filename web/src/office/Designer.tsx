// Office Designer: admins describe a change, Claude drafts it, the server
// checks it, and the admin sees it on the floor (only for them) before Apply.

import { useEffect, useRef, useState } from "react";
import type { Floor } from "../../../shared/floor";
import { useOffice, bump, toast, state } from "./store";
import { lookAt } from "./World";
import { markStep } from "../onboard";
import { hand, useHand, startHand, stopHand, undoHand, selected, rotate, duplicate, remove, resize } from "./handEdit";

interface Turn {
  prompt: string;
  status: "thinking" | "ready" | "error" | "applied" | "discarded";
  draft?: { id: string; summary: string; edits: number; changes: string[]; spots?: ({ x: number; y: number } | null)[]; problems: string[]; floor: Floor };
  stale?: boolean;
  error?: string;
}
interface Version { id: number; summary: string; prompt: string | null; created_at: string; by: string | null }

// Real rooms on the DEMO OFFICE floor, so a click on an example works as written.
const EXAMPLES = [
  "Add two desks for new hires in Tech Support",
  "Put a big plant either side of the Lounge elevator",
  "Make the rug in the Conference Room deep green",
  "Rename the Breakout Room to “Focus Room”",
  "Add 300px of space along the top of the building for a big jumbotron",
];

export function Designer() {
  const s = useOffice();
  useEffect(() => markStep("admin", "designer"), []);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState("");
  const [versions, setVersions] = useState<Version[]>([]);
  const [live, setLive] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  // The office changed under a ready draft (someone else applied or restored): it can't be applied any more.
  const floorSeen = useRef(s.floor);
  useEffect(() => {
    if (s.floor === floorSeen.current) return;
    floorSeen.current = s.floor;
    setTurns((ts) => ts.map((t) => (t.status === "ready" ? { ...t, status: "discarded" as const, stale: true } : t)));
  }, [s.floor]);
  const busy = turns.some((t) => t.status === "thinking");

  const loadVersions = () =>
    fetch("/api/admin/floor/versions")
      .then((r) => (r.ok ? r.json() : { live: null, versions: [] }))
      .then((j: { live: number | null; versions: Version[] }) => {
        setVersions(j.versions);
        setLive(j.live);
      });
  useEffect(() => {
    loadVersions();
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the tab ends any preview, hand editing included.
      if (hand.on) stopHand();
      if (state.previewFloor) {
        state.previewFloor = null;
        bump();
      }
    };
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" }); // braces: newer browsers return a Promise here, which React would call as cleanup
  }, [turns.length, turns[turns.length - 1]?.status]);

  const update = (i: number, patch: Partial<Turn>) => setTurns((ts) => ts.map((t, k) => (k === i ? { ...t, ...patch } : t)));

  const ask = async (text: string) => {
    const p = text.trim();
    if (!p || busy) return;
    setPrompt("");
    const i = turns.length;
    setTurns((ts) => [...ts.map((t) => (t.status === "ready" ? { ...t, status: "discarded" as const } : t)), { prompt: p, status: "thinking" }]);
    s.previewFloor = null;
    bump();
    try {
      const r = await fetch("/api/admin/designer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: p }) });
      const j = await r.json();
      if (!r.ok) return update(i, { status: "error", error: j.error ?? "Something went wrong." });
      if (!mounted.current) return; // left the tab while Claude was working: don't leave a preview behind
      update(i, { status: "ready", draft: j });
      if (j.edits && !j.problems.length) {
        s.previewFloor = j.floor;
        bump();
      }
    } catch {
      update(i, { status: "error", error: "Couldn't reach the server." });
    }
  };

  const apply = async (i: number) => {
    const d = turns[i].draft!;
    const r = await fetch(`/api/admin/designer/${d.id}/apply`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast(j.error ?? "Couldn't apply that.");
    update(i, { status: "applied", stale: false }); // our own apply also changes the floor: this turn isn't stale
    loadVersions();
  };

  const discard = (i: number) => {
    update(i, { status: "discarded" });
    s.previewFloor = null;
    bump();
  };

  const revert = async (v: number, label: string) => {
    if (!window.confirm(`Put the office back to: ${label}? Everyone sees it change.`)) return;
    const r = await fetch("/api/admin/floor/revert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: v }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast(j.error ?? "Couldn't revert.");
    loadVersions();
  };

  if (hand.on) return <HandPanel onDone={loadVersions} />;
  return (
    <div className="designer">
      <div className="pad row" style={{ marginTop: 8 }}>
        <button className="small" disabled={busy} onClick={() => { setTurns((ts) => ts.map((t) => (t.status === "ready" ? { ...t, status: "discarded" as const } : t))); startHand(); }}>✋ Edit by hand</button>
        <span className="muted small-text">drag, resize, rotate, duplicate, delete</span>
      </div>
      <p className="hint pad">Or describe a change to the office. Claude drafts it, it's checked so nobody gets walled in, and you see it here first — only you — before it goes live for everyone.</p>
      {!turns.length ? (
        <div className="examples pad">
          {EXAMPLES.map((e) => (
            <button key={e} className="example" onClick={() => ask(e)}>{e}</button>
          ))}
        </div>
      ) : null}
      <div className="turns">
        {turns.map((t, i) => (
          <div key={i} className="turn">
            <div className="bubble-me">{t.prompt}</div>
            {t.status === "thinking" ? (
              <div className="bubble-ai"><span className="dots"><i /><i /><i /></span> Designing… this takes about a minute.</div>
            ) : t.status === "error" ? (
              <div className="bubble-ai error-text">{t.error}</div>
            ) : t.draft ? (
              <div className={`bubble-ai${t.status === "discarded" ? " faded" : ""}`}>
                <p>{t.draft.summary}</p>
                {t.draft.changes?.length ? (
                  <ul className="change-list">
                    {t.draft.changes.map((c, k) => {
                      const spot = t.draft!.spots?.[k];
                      return (
                        <li key={k} className={`${/^⚠|link now goes|linking to/.test(c) ? "attention" : ""}${spot ? " can-show" : ""}`}
                          title={spot ? "Show me on the floor" : undefined}
                          onClick={spot ? () => lookAt(spot) : undefined}>{c}</li>
                      );
                    })}
                  </ul>
                ) : null}
                {t.stale ? <p className="muted small-text">The office changed since this was designed — ask again.</p> : null}
                {t.draft.problems.length ? (
                  <div className="problems">
                    <b>Couldn't make this work:</b>
                    <ul>{t.draft.problems.slice(0, 5).map((p) => <li key={p}>{p}</li>)}</ul>
                    <p className="muted small-text">Try rephrasing, or ask for something smaller.</p>
                  </div>
                ) : t.status === "ready" && t.draft.edits ? (
                  <>
                    <p className="preview-note">Previewing on the floor — only you can see it.</p>
                    <div className="row">
                      <button className="primary small" onClick={() => apply(i)}>Apply for everyone</button>
                      <button className="small" onClick={() => discard(i)}>Discard</button>
                    </div>
                  </>
                ) : t.status === "applied" ? (
                  <p className="ok-line small-text">Live for everyone.</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="designer-input" onSubmit={(e) => { e.preventDefault(); ask(prompt); }}>
        <textarea
          value={prompt}
          disabled={busy}
          maxLength={1500}
          rows={3}
          placeholder="e.g. Add a cosy reading corner with two armchairs in the Knowledge Base room"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask(prompt);
            }
          }}
        />
        <button className="primary small" disabled={busy || !prompt.trim()}>Design it</button>
      </form>
      {versions.length ? (
        <details className="versions pad">
          <summary>History · undo</summary>
          <ul>
            {versions.map((v) => (
              <li key={v.id} data-version={v.id}>
                <span>
                  <b>{v.summary}</b>
                  <span className="muted small-text"> · {v.by ?? "—"} · {new Date(v.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                </span>
                {v.id === live ? <span className="pill ok">Live</span> : <button className="small" onClick={() => revert(v.id, v.summary)}>Restore</button>}
              </li>
            ))}
            <li data-version="0">
              <span><b>The original layout</b></span>
              {live === 0 ? <span className="pill ok">Live</span> : <button className="small" onClick={() => revert(0, "the original layout")}>Restore</button>}
            </li>
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** Hand editing: what's selected, the change count, and Check → Apply. */
function HandPanel({ onDone }: { onDone: () => void }) {
  const h = useHand();
  useOffice();
  const [check, setCheck] = useState<{ id: string; problems: string[]; changes: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  // Any new edit invalidates a check.
  const seen = useRef(h.ops.length);
  useEffect(() => {
    if (h.ops.length !== seen.current) { seen.current = h.ops.length; setCheck(null); }
  }, [h.ops.length]);
  const { obj, desk } = selected();
  const n = h.ops.length;

  const runCheck = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/designer/hand", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ edits: h.ops }) });
      const j = await r.json();
      if (!r.ok) return toast(j.error ?? "Couldn't check that.");
      setCheck({ id: j.id, problems: j.problems, changes: j.changes });
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!check) return;
    setBusy(true);
    hand.applying = true;
    const r = await fetch(`/api/admin/designer/${check.id}/apply`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    hand.applying = false;
    setBusy(false);
    if (!r.ok) return toast(j.error ?? "Couldn't apply that.");
    stopHand();
    toast("Live for everyone.");
    onDone();
  };
  const cancel = () => {
    if (n && !window.confirm(`Throw away ${n} change${n === 1 ? "" : "s"}?`)) return;
    stopHand();
  };

  return (
    <div className="designer hand-panel pad">
      <p className="hint">Drag furniture to move it, or a desk's nameplate to move the whole workstation. Only you see this until you apply.</p>
      <p className="muted small-text"><kbd>←↑↓→</kbd> nudge (<kbd>Shift</kbd> ×10) · <kbd>R</kbd> rotate · <kbd>⌘D</kbd> duplicate · <kbd>Delete</kbd> remove · <kbd>⌘Z</kbd> undo · hold <kbd>Alt</kbd> while dragging for exact pixels · <kbd>Esc</kbd> deselect</p>
      {obj ? (
        <div className="sel-card">
          <b>{obj.label || obj.type.replace(/([A-Z])/g, " $1").toLowerCase()}</b>
          <div className="size-row">
            <label>W <input type="number" min={8} value={obj.w} onChange={(e) => resize(Number(e.target.value), obj.h)} /></label>
            <label>H <input type="number" min={8} value={obj.h} onChange={(e) => resize(obj.w, Number(e.target.value))} /></label>
          </div>
          <div className="row" style={{ margin: 0 }}>
            <button className="small" onClick={rotate}>Rotate</button>
            <button className="small" onClick={duplicate}>Duplicate</button>
            <button className="small danger" onClick={remove}>Delete</button>
          </div>
        </div>
      ) : desk ? (
        <div className="sel-card">
          <b>{desk.owner ? `${desk.owner}'s desk` : "A free desk"}</b>
          <span className="muted small-text">Its table, chair and what's on it move with it. To add or remove desks, ask the Designer.</span>
        </div>
      ) : <p className="muted small-text">Click something on the floor to select it.</p>}
      <div className="row" style={{ margin: 0, justifyContent: "space-between" }}>
        <span className="muted small-text">{n ? `${n} change${n === 1 ? "" : "s"}` : "No changes yet"}</span>
        <button className="small ghost" disabled={!n} onClick={undoHand}>Undo last</button>
      </div>
      {h.problems.length ? <p className="error-text small-text">{h.problems[0]}</p> : null}
      {check?.problems.length ? (
        <div className="problems">
          <b>Can't go live yet:</b>
          <ul>{check.problems.slice(0, 5).map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      ) : null}
      <div className="row" style={{ margin: 0 }}>
        {check && !check.problems.length ? (
          <button className="primary small" disabled={busy} onClick={apply}>Apply for everyone</button>
        ) : (
          <button className="primary small" disabled={busy || !n} onClick={runCheck}>{busy ? "Checking…" : "Check it"}</button>
        )}
        <button className="small" onClick={cancel}>{n ? "Discard" : "Done"}</button>
      </div>
      {check && !check.problems.length ? <p className="ok-line small-text">Checked: nobody's walled in and every desk is reachable.</p> : null}
    </div>
  );
}
