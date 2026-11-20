import { Flame, streakTitle } from "./Streak";
import { ServicePin } from "./ServicePin";
import { tenureTitle } from "../../../shared/tenure";
import { fmtPoints } from "../../../shared/points";
import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { useOffice, roomName, live, slackDmUrl, toast } from "./store";
import { sock } from "./net";
import { muteLocally } from "./media";
import { Popover } from "./Office";
import { STATUS_LABEL } from "./Toolbar";
import { markStep } from "../onboard";

export function ProfileCard({ id, at, onClose }: { id: string; at: { x: number; y: number }; onClose: () => void }) {
  const s = useOffice();
  const me = s.me!;
  const p = id === me.id ? me : s.people.get(id);
  const [followMenu, setFollowMenu] = useState(false);
  useEffect(() => { if (id !== me.id) markStep("member", "find"); }, [id]);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!p) return null;
  const isMe = p.id === me.id;
  const localTime = p.tz ? new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: p.tz, timeZoneName: "short" }) : null;
  const where = roomName(p.roomId) ?? "Open floor";
  const deskRoom = s.floor!.desks.find((d) => d.id === p.deskId);
  const slackUrl = slackDmUrl(p);
  const muted = s.locallyMuted.has(p.id);
  const following = me.following === p.id;

  return (
    <Popover at={at} onClose={onClose} wide>
      <div className="card-head">
        <span className={`card-avatar status-${p.status}`}>
          {p.avatar ? <img src={p.avatar} alt="" referrerPolicy="no-referrer" /> : <span>{p.name[0]}</span>}
        </span>
        <div>
          <h3>{p.name}</h3>
          <p className="muted">{[p.title, p.role === "admin" ? "Admin" : p.role === "guest" ? "Guest" : null].filter(Boolean).join(" · ")}</p>
        </div>
      </div>
      <dl className="facts">
        <dt>Status</dt>
        <dd><span className={`status-dot status-${p.status}`} /> {STATUS_LABEL[p.status]}{p.statusText ? ` — ${p.statusText}` : ""}</dd>
        {p.role !== "guest" && !me.guestRoom ? (<><dt>Clock</dt><dd>{p.clock === "in" ? "Clocked in" : p.clock === "break" ? "Clocked in · on a break" : "Not clocked in"}</dd></>) : null}
        {localTime ? (<><dt>Local time</dt><dd>{localTime}</dd></>) : null}
        {p.points != null && !me.guestRoom ? (<><dt>Points</dt><dd>⭐ {fmtPoints(p.points)}</dd></>) : null}
        {p.since ? (<><dt>At Acme</dt><dd className="tenure-dd"><ServicePin since={p.since} /> {tenureTitle(p.since)}</dd></>) : null}
        {p.streak?.days ? (<><dt>Streak</dt><dd className="streak-dd"><Flame size={15} lit={p.streak.today} /> {streakTitle(p)}</dd></>) : null}
        <dt>Where</dt>
        <dd>{where}{deskRoom && deskRoom.roomId !== p.roomId ? <span className="muted"> · desk in {roomName(deskRoom.roomId)}</span> : null}</dd>
        {p.following ? (<><dt>Following</dt><dd>{p.following === me.id ? "You" : s.people.get(p.following)?.name ?? "Someone"}</dd></>) : null}
      </dl>
      {!isMe ? (
        <div className="card-actions">
          {slackUrl ? (
            <a className="button primary" href={slackUrl} target="_blank" rel="noreferrer" onClick={onClose}><Icon name="slack" size={16} /> Message on Slack</a>
          ) : p.email ? (
            <a className="button" href={`mailto:${p.email}`} title="Not found in the team's Slack, so this opens email instead">Email</a>
          ) : null}
          <button onClick={() => { sock().emit("nudge", { to: p.id }); onClose(); }}><Icon name="wave" size={16} /> Nudge</button>
          {p.role !== "guest" && !me.guestRoom ? <button onClick={() => { sock().emit("highfive", { to: p.id }); onClose(); }} title="Stand close, then high-five (Y). When they high-five back, you both get points.">✋ High five</button> : null}
          <div className="split-btn">
            <button className={following ? "on" : ""} onClick={() => { sock().emit("follow", { to: following ? null : p.id }); onClose(); }}>
              <Icon name="follow" size={16} /> {following ? "Stop following" : "Follow"}
            </button>
            <button className="caret" onClick={() => setFollowMenu(!followMenu)} aria-label="More follow options"><Icon name="chevron" size={14} /></button>
            {followMenu ? (
              <div className="mini-menu">
                <button onClick={() => { sock().emit("follow", { to: p.id }); onClose(); }}>Follow {p.name.split(" ")[0]}</button>
                <button onClick={() => { sock().emit("requestFollow", { to: p.id }); onClose(); }}>Ask {p.name.split(" ")[0]} to follow you</button>
              </div>
            ) : null}
          </div>
          <button onClick={() => muteLocally(p.id, !muted)} className={muted ? "on" : ""}><Icon name="volumeOff" size={16} /> {muted ? "Unmute for me" : "Mute for me"}</button>
          {!me.guestRoom ? (
            <button onClick={() => { sock().emit("teleport", { to: p.id }); onClose(); }}>Go to {p.name.split(" ")[0]}</button>
          ) : null}
          {me.role === "admin" && p.role !== "guest" ? <a className="button ghost" href={`/admin/members#${p.id}`} target="_blank" rel="noopener">Change role…</a> : null}
        </div>
      ) : (
        <>
          {me.guestRoom ? null : <div className="me-edits"><NameForm name={p.name} /><PhotoForm /></div>}
          <p className="hint">This is you. Set a status message from the bottom bar.</p>
        </>
      )}
    </Popover>
  );
}

export function personPos(id: string) {
  return live.get(id);
}

/** Change the name everyone sees. Google sets it on your first sign-in; after that it's yours. */
function NameForm({ name }: { name: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!editing) return <button className="small ghost name-edit" onClick={() => { setValue(name); setErr(""); setEditing(true); }}>Change my name</button>;
  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/me/name", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: value }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setErr(j.error || "That didn't save. Try again.");
      setEditing(false);
      toast(`Everyone now sees you as ${j.name}.`, { ttl: 4000 });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="name-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className="small-text muted" htmlFor="my-name">The name everyone sees</label>
      <div className="row">
        <input id="my-name" value={value} maxLength={60} autoFocus onChange={(e) => setValue(e.target.value)} />
        <button className="small primary" disabled={busy || !value.trim() || value.trim() === name}>Save</button>
        <button type="button" className="small ghost" onClick={() => setEditing(false)}>Cancel</button>
      </div>
      {err ? <p className="hint error">{err}</p> : null}
    </form>
  );
}

/** Shrink a picked image to a centred square JPEG (small enough to send and show everywhere). */
async function squarePhoto(file: File, size = 256): Promise<string> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, size, size);
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.86);
}

/** Change the photo everyone sees. Upload one, or go back to (or pick up a newer) Slack photo. */
function PhotoForm() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const send = async (url: string, init: RequestInit, done: string) => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(url, init);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setErr(j.error || "That didn't save. Try again.");
      toast(done, { ttl: 4000 });
    } catch {
      setErr("That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return setErr("Pick a picture (JPG or PNG).");
    let image: string;
    try { image = await squarePhoto(file); } catch { return setErr("We couldn't read that picture. Try a JPG or PNG."); }
    await send("/api/me/photo", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ image }) }, "Your new photo is up.");
  };
  return (
    <div className="photo-form">
      <div className="row">
        <label className={`button small ghost${busy ? " disabled" : ""}`}>
          Change my photo
          <input type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={busy} onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        <button className="small ghost" disabled={busy} onClick={() => void send("/api/me/photo/slack", { method: "POST" }, "Now showing your Slack photo.")}>Use my Slack photo</button>
      </div>
      {err ? <p className="hint error">{err}</p> : null}
    </div>
  );
}
