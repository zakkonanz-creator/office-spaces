import { useEffect, useMemo, useState } from "react";
import { Icon } from "../icons";
import { useOffice, everyone, roomName } from "./store";
import { sock } from "./net";
import { markStep } from "../onboard";

/** F: type a name, Enter takes you to them. */
export function FindPeople({ onClose }: { onClose: () => void }) {
  const s = useOffice();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  useEffect(() => markStep("member", "find"), []);
  const list = useMemo(
    () => everyone().filter((p) => p.id !== s.me?.id && p.name.toLowerCase().includes(q.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 12),
    [q, s.version],
  );
  const go = (id: string) => {
    sock().emit("teleport", { to: id });
    onClose();
  };
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal find" onClick={(e) => e.stopPropagation()}>
        <label className="search big">
          <Icon name="search" />
          <input
            autoFocus
            value={q}
            placeholder="Find people"
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setSel((x) => Math.min(list.length - 1, x + 1));
              if (e.key === "ArrowUp") setSel((x) => Math.max(0, x - 1));
              if (e.key === "Enter" && list[sel]) go(list[sel].id);
              if (e.key === "Escape") onClose();
            }}
          />
        </label>
        <div className="find-list">
          {list.map((p, i) => (
            <button key={p.id} className={`person-row${i === sel ? " sel" : ""}`} onClick={() => go(p.id)} onMouseEnter={() => setSel(i)}>
              <span className={`mini-avatar status-${p.status}`}>{p.avatar ? <img src={p.avatar} alt="" referrerPolicy="no-referrer" /> : <span>{p.name[0]}</span>}</span>
              <span className="person-text">
                <span className="person-name">{p.name}</span>
                <span className="person-sub">{roomName(p.roomId) ?? "Open floor"}</span>
              </span>
              <span className="muted small-text">Go ↵</span>
            </button>
          ))}
          {!list.length ? <p className="muted pad">Nobody by that name is in the office right now.</p> : null}
        </div>
      </div>
    </div>
  );
}
