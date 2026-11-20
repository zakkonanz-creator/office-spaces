import { useEffect, useRef } from "react";
import { Icon } from "../icons";
import { useOffice, everyone, live } from "./store";
import { walkTo, jumpTo } from "./World";

/** The whole floor at a glance, with everyone's initials. Click to walk there. */
export function Minimap({ onClose }: { onClose: () => void }) {
  const s = useOffice();
  const floor = s.floor!;
  const W = Math.min(720, window.innerWidth - 40);
  const scale = W / floor.width;
  const H = floor.height * scale;
  const dots = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      dots.current?.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => {
        const p = live.get(el.dataset.id!);
        if (p) el.style.transform = `translate(${p.x * scale}px, ${p.y * scale}px)`;
      });
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [scale]);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal minimap" onClick={(e) => e.stopPropagation()} style={{ width: W + 32 }}>
        <header className="modal-head">
          <h3>Map</h3>
          <button className="ghost" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </header>
        <div
          className="minimap-floor"
          style={{ width: W, height: H }}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const p = { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
            if (!walkTo(p)) jumpTo(p);
            onClose();
          }}
        >
          {floor.rooms.map((r) => (
            <div key={r.id} className={`mm-room floor-${r.floor}${s.rooms[r.id]?.closed ? " closed" : ""}`} style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale }}>
              {r.w * scale > 60 ? <span>{r.name}</span> : null}
            </div>
          ))}
          <div ref={dots}>
            {everyone().map((p) => (
              <div key={p.id} data-id={p.id} className={`mm-dot status-${p.status}${p.id === s.me?.id ? " me" : ""}`} title={p.name}>
                {p.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
              </div>
            ))}
          </div>
        </div>
        <p className="hint">{typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? "Tap" : "Click"} anywhere to walk there.</p>
      </div>
    </div>
  );
}
