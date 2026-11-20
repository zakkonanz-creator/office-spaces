// Left panel: People (who's in, where, status), Recordings (Transcribe notes from
// rooms you were in), Help. No chat — Acme talks in Slack.

import { PointsTab } from "./Points";
import { NextBar } from "./Rewards";
import { useRef, useEffect, useMemo, useState } from "react";
import type { Person } from "../../../shared/protocol";
import { Icon } from "../icons";
import { useOffice, everyone, roomName, toast, slackDmUrl } from "./store";
import { STATUS_LABEL } from "./Toolbar";
import { enableIdleDetection, idleDetectionState } from "./idle";
import { getRoom } from "./media";
import { Designer } from "./Designer";
import { openGettingStarted } from "./Onboarding";
import { arrivalsOn, doorSound, setArrivalsOn, setSoundsOn, soundsOn } from "./sounds";
import { quality, setQualityMode } from "./quality";
import { RowStreak } from "./Streak";
import { useOnboard, restartTrack } from "../onboard";

export type Tab = "people" | "points" | "recordings" | "help" | "designer";

export function SidePanel({ tab, onTab, onPerson }: { tab: Tab | null; onTab: (t: Tab | null) => void; onPerson: (id: string, at: { x: number; y: number }) => void }) {
  const s = useOffice();
  if (!tab) return null;
  return (
    <aside className="side">
      <header className="side-head">
        <div>
          <div className="space-name">Acme</div>
          <div className="floor-name">{s.floor?.name}</div>
        </div>
        <div className="side-head-actions">
          {s.me?.role === "admin" ? <a className="ghost small" href="/admin" target="_blank" rel="noopener" title="Admin (opens in a new tab, so you stay in the office)"><Icon name="settings" size={18} /></a> : null}
          <button className="ghost close-side" onClick={() => onTab(null)} aria-label="Close panel" title="Close panel"><Icon name="close" size={16} /></button>
        </div>
      </header>
      <nav className="tabs">
        {(["people", ...(s.me?.guestRoom ? [] : ["points"]), "recordings", "help", ...(s.me?.role === "admin" ? ["designer"] : [])] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => onTab(t)}>
            {t === "people" ? "People" : t === "points" ? "Points" : t === "recordings" ? "Recordings" : t === "help" ? "Help" : "Design"}
          </button>
        ))}
      </nav>
      <div className="side-body">
        {tab === "people" ? <People onPerson={onPerson} /> : null}
        {tab === "points" ? <PointsTab /> : null}
        {tab === "recordings" ? <Recordings /> : null}
        {tab === "help" ? <Help /> : null}
        {tab === "designer" && s.me?.role === "admin" ? <Designer /> : null}
      </div>
    </aside>
  );
}

function People({ onPerson }: { onPerson: (id: string, at: { x: number; y: number }) => void }) {
  const s = useOffice();
  const [q, setQ] = useState("");
  const all = everyone();
  const groups = useMemo(() => {
    const match = (p: Person) => !q || `${p.name} ${p.title ?? ""} ${roomName(p.roomId) ?? ""}`.toLowerCase().includes(q.toLowerCase());
    const near = all.filter((p) => p.id !== s.me?.id && (s.hearing.get(p.id) ?? 0) > 0 && match(p));
    const nearIds = new Set(near.map((p) => p.id));
    const rest = all.filter((p) => p.id !== s.me?.id && !nearIds.has(p.id) && match(p)).sort((a, b) => a.name.localeCompare(b.name));
    return { near, rest };
  }, [s.version, q]);

  return (
    <div className="people">
      <label className="search">
        <Icon name="search" size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find someone (F)" />
      </label>
      {groups.near.length ? (
        <>
          <h4>Nearby{roomName(s.me?.roomId ?? null) ? ` · ${roomName(s.me!.roomId)}` : ""}</h4>
          {groups.near.map((p) => <PersonRow key={p.id} p={p} onClick={onPerson} />)}
        </>
      ) : null}
      <h4>In the office · {all.length}</h4>
      {s.me ? <PersonRow p={s.me} onClick={onPerson} /> : null}
      {groups.rest.map((p) => <PersonRow key={p.id} p={p} onClick={onPerson} />)}
    </div>
  );
}

function PersonRow({ p, onClick }: { p: Person; onClick: (id: string, at: { x: number; y: number }) => void }) {
  const s = useOffice();
  const slack = p.id === s.me?.id ? null : slackDmUrl(p);
  return (
    <div className="person-line">
    <button className="person-row" onClick={(e) => onClick(p.id, { x: e.clientX + 40, y: e.clientY })}>
      <span className={`mini-avatar status-${p.status}`}>
        {p.avatar ? <img src={p.avatar} alt="" referrerPolicy="no-referrer" /> : <span>{p.name[0]}</span>}
      </span>
      <span className="person-text">
        <span className="person-name">{p.id === s.me?.id ? `${p.name} (you)` : p.name}<RowStreak p={p} /></span>
        {p.id === s.me?.id && !s.me?.guestRoom ? <NextBar points={p.points} wide /> : null}
        <span className="person-sub">{p.statusText || (p.status !== "available" ? STATUS_LABEL[p.status] : roomName(p.roomId) ?? "On the floor")}</span>
      </span>
      {p.clock ? <span className={`row-clock ${p.clock}`} title={p.clock === "break" ? "Clocked in · on a break" : "Clocked in"}><Icon name="clock" size={14} /></span> : null}
      {!p.mic ? <Icon name="micOff" size={14} className="muted" /> : null}
    </button>
    {slack ? <a className="row-slack" href={slack} target="_blank" rel="noreferrer" title={`Message ${p.name.split(" ")[0]} on Slack`} aria-label={`Message ${p.name} on Slack`}><Icon name="slack" size={16} /></a> : null}
    </div>
  );
}

interface Rec {
  id: number;
  room_id: string;
  title: string;
  meet_url: string | null;
  fathom_url: string | null;
  summary_md: string | null;
  drive_file_url: string | null;
  created_at: string;
  started_by: string | null;
}

interface Tr {
  id: number;
  room_name: string;
  started_at: string;
  ended_at: string | null;
  ended_reason: string | null;
  status: "recording" | "queued" | "processing" | "done";
  summary_md: string | null;
  started_by: string | null;
}

const TR_STATUS: Record<Tr["status"], string> = { recording: "Transcribing now", queued: "Writing notes…", processing: "Writing notes…", done: "Notes ready" };

function Transcripts({ rows }: { rows: Tr[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const [full, setFull] = useState<Record<number, string>>({});
  if (!rows.length) return null;
  const showFull = async (id: number) => {
    const r = await fetch(`/api/transcripts/${id}`);
    if (r.ok) setFull({ ...full, [id]: (await r.json()).transcript_md ?? "" });
  };
  return (
    <>
      <h4 className="pad">Room transcripts</h4>
      {rows.map((r) => (
        <div key={r.id} className="rec">
          <button className="rec-head" onClick={() => setOpen(open === r.id ? null : r.id)}>
            <span className="rec-title">{r.room_name || "Room"} · transcript</span>
            <span className="rec-meta">{new Date(r.started_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {r.started_by ?? "—"}</span>
            <span className={`pill ${r.status === "done" ? "ok" : "wait"}`}>{TR_STATUS[r.status]}</span>
          </button>
          {open === r.id ? (
            <div className="rec-body">
              {r.summary_md ? <Markdown md={r.summary_md} /> : <p className="muted">{r.status === "recording" ? "Still going. The notes come when it stops." : "Transcribing and writing the notes. This can take a few minutes after a long meeting."}</p>}
              {r.ended_reason ? <p className="hint">Stopped because {r.ended_reason}.</p> : null}
              {r.status === "done" ? (
                full[r.id] !== undefined
                  ? <pre className="transcript-full">{full[r.id] || "Nothing was picked up."}</pre>
                  : <button className="small" onClick={() => showFull(r.id)}>Show the full transcript</button>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

function Recordings() {
  const s = useOffice();
  const [rows, setRows] = useState<Rec[] | null>(null);
  const [trs, setTrs] = useState<Tr[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (s.me?.guestRoom) { setRows([]); setTrs([]); return; }
    fetch("/api/recordings").then((r) => (r.ok ? r.json() : [])).then(setRows);
    const load = () => fetch("/api/transcripts").then((r) => (r.ok ? r.json() : [])).then(setTrs);
    void load();
    const t = setInterval(load, 30_000); // notes land while the panel is open
    return () => clearInterval(t);
  }, []);
  if (!rows || !trs) return <p className="muted pad">Loading…</p>;
  // Meetings recorded with Fathom (optional): only the ones with notes are worth showing.
  const older = rows.filter((r) => r.summary_md);
  return (
    <div className="recordings">
      <h4 className="pad">Room notes</h4>
      <p className="hint pad">Notes from rooms you were in. Press <b>Transcribe</b> in a room and they land here and in a Slack DM to everyone who was there. For audio and video, use <b>Start meeting</b> and record in the GHL meeting.</p>
      {!older.length && !trs.length ? <p className="muted pad">No notes yet. Walk into a room and press <b>Transcribe</b>.</p> : null}
      <Transcripts rows={trs} />
      {older.length ? <h4 className="pad">Meeting notes (Fathom)</h4> : null}
      {older.map((r) => (
        <div key={r.id} className="rec">
          <button className="rec-head" onClick={() => setOpen(open === r.id ? null : r.id)}>
            <span className="rec-title">{r.title.replace(/^Proximity Office · /, "")}</span>
            <span className="rec-meta">{new Date(r.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {r.started_by ?? "—"}</span>
            <span className="pill ok">Notes ready</span>
          </button>
          {open === r.id ? (
            <div className="rec-body">
              <Markdown md={r.summary_md ?? ""} />
              <div className="row wrap">
                {r.fathom_url ? <a className="button small" href={r.fathom_url} target="_blank" rel="noreferrer">Fathom</a> : null}
                {r.meet_url ? <a className="button small" href={r.meet_url} target="_blank" rel="noreferrer">Meet link</a> : null}
                {r.drive_file_url ? <a className="button small" href={r.drive_file_url} target="_blank" rel="noreferrer">In Drive</a> : null}
              </div>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Just enough Markdown for meeting notes: headings, bullets, bold, links. */
export function Markdown({ md }: { md: string }) {
  const html = useMemo(() => {
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const inline = (t: string) =>
      esc(t)
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/\[(.+?)\]\((https?:\/\/[^)\s"<>]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    const out: string[] = [];
    let list = false;
    for (const line of md.split("\n")) {
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) {
        if (!list) out.push("<ul>");
        list = true;
        out.push(`<li>${inline(li[1])}</li>`);
        continue;
      }
      if (list) out.push("</ul>");
      list = false;
      const h = line.match(/^#{1,6}\s+(.*)$/);
      if (h) out.push(`<h5>${inline(h[1])}</h5>`);
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push("</ul>");
    return out.join("");
  }, [md]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Help() {
  const s = useOffice();
  const o = useOnboard();
  const [checks, setChecks] = useState<{ label: string; ok: boolean; note?: string }[] | null>(null);
  const [idle, setIdle] = useState(idleDetectionState());
  const [sounds, setSounds] = useState(soundsOn());
  const [arrivals, setArrivals] = useState(arrivalsOn());
  const run = async () => {
    setChecks(null);
    const out: { label: string; ok: boolean; note?: string }[] = [];
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: true });
      st.getTracks().forEach((t) => t.stop());
      out.push({ label: "Microphone", ok: true });
    } catch {
      out.push({ label: "Microphone", ok: false, note: "Blocked — allow it in the address bar." });
    }
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: true });
      st.getTracks().forEach((t) => t.stop());
      out.push({ label: "Camera", ok: true });
    } catch {
      out.push({ label: "Camera", ok: false, note: "Blocked or in use by another app." });
    }
    const t0 = performance.now();
    const h = await fetch("/health").then((r) => r.ok).catch(() => false);
    out.push({ label: "Office server", ok: h, note: h ? `${Math.round(performance.now() - t0)} ms` : "Unreachable" });
    const r = getRoom();
    out.push({ label: "Audio/video server", ok: r?.state === "connected", note: r?.state === "connected" ? undefined : "Not connected — reload the page." });
    setChecks(out);
  };
  useEffect(() => {
    run();
  }, []);
  return (
    <div className="help pad">
      {o.member ? (
        <div className="help-start">
          <h4>Getting started</h4>
          <p className="hint">{o.member.finished ? "You've done the whole checklist." : `${Object.keys(o.member.done).length} of ${o.member.of} done. The rest tick themselves as you go.`}</p>
          <div className="row">
            {o.member.finished
              ? <button className="small" onClick={async () => { await restartTrack("member"); openGettingStarted(); }}>Go through it again</button>
              : <button className="small primary" onClick={openGettingStarted}>Open the checklist</button>}
            {s.me?.role === "admin" ? <a className="button small" href="/admin/members?tour=1" target="_blank" rel="noopener">Admin tour</a> : null}
          </div>
        </div>
      ) : null}

      <h4>Your setup</h4>
      {checks ? (
        checks.every((c) => c.ok) ? <p className="ok-line">Everything looks good.</p> : <p className="bad-line">Something needs attention:</p>
      ) : <p className="muted">Checking your setup…</p>}
      <ul className="checks">
        {checks?.map((c) => (
          <li key={c.label} className={c.ok ? "ok" : "bad"}>{c.ok ? "✓" : "✕"} {c.label}{c.note ? <span className="muted"> — {c.note}</span> : null}</li>
        ))}
      </ul>
      <button className="small" onClick={run}>Run the check again</button>

      <h4>Auto-away</h4>
      <p className="hint">Marks you Away when your computer has been idle for a while, even if you're working in Slack. Uses your browser's idle detection (Chrome/Edge).</p>
      {idle === "on" ? <p className="ok-line">On</p> : idle === "unsupported" ? <p className="muted">This browser doesn't support it.</p> : (
        <button className="small" onClick={async () => { const r = await enableIdleDetection(); setIdle(r); if (r !== "on") toast("Idle detection wasn't allowed."); }}>Turn on auto-away</button>
      )}

      <h4>Sounds</h4>
      <p className="hint">A door shutting or opening near you, and someone walking into or out of your room. Knocks and nudges always chime.</p>
      <label className="check">
        <input type="checkbox" checked={sounds} onChange={(e) => { setSoundsOn(e.target.checked); setSounds(e.target.checked); if (e.target.checked) doorSound(true); }} />
        Door and arrival sounds
      </label>
      <p className="hint">A small note in the corner (no sound) each time a teammate comes into the office. Not while you're Focusing.</p>
      <label className="check">
        <input type="checkbox" checked={arrivals} onChange={(e) => { setArrivalsOn(e.target.checked); setArrivals(e.target.checked); }} />
        Tell me when someone comes in
      </label>

      <h4>Video quality</h4>
      <p className="hint">If your computer or connection struggles, video gets lighter by itself (smaller and smoother) so audio stays clear, and goes back up when things improve.</p>
      <label className="check">
        <input type="radio" name="vq" checked={quality.mode === "auto"} onChange={() => setQualityMode("auto")} />
        Automatic
      </label>
      <label className="check">
        <input type="radio" name="vq" checked={quality.mode === "lighter"} onChange={() => setQualityMode("lighter")} />
        Always lighter (an older computer or a slow connection)
      </label>
      {quality.mode === "auto" && quality.auto ? <p className="muted">Lighter right now: your {quality.why === "connection" ? "connection" : "computer"} was struggling.</p> : null}

      <h4>Shortcuts</h4>
      <p className="hint">Press <kbd>?</kbd> on the floor for the full list. Arrow keys move, double-click walks you somewhere.</p>

      <h4>Something broken?</h4>
      <p className="hint">Post in Slack with a screenshot of this panel.</p>
    </div>
  );
}
