// Top-down furniture, drawn by hand as SVG. Every piece is lit from the top-left
// with a soft drop shadow down-right, so the floor reads as one consistent room.
// Each sprite draws in its own w×h box; World positions it.

import type { ReactNode } from "react";

/** Deterministic 0–1 from a string, so a desk always gets the same mug. */
export function rand(seed: string, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

export const Svg = ({ w, h, children, pad = 12 }: { w: number; h: number; children: ReactNode; pad?: number }) => (
  <svg
    width={w + pad * 2}
    height={h + pad * 2}
    viewBox={`${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`}
    style={{ position: "absolute", left: -pad, top: -pad, overflow: "visible", pointerEvents: "none" }}
    aria-hidden
  >
    {children}
  </svg>
);

/** A soft contact shadow under a shape. */
export const Shadow = ({ x, y, w, h, r = 6, o = 0.22 }: { x: number; y: number; w: number; h: number; r?: number; o?: number }) => (
  <rect x={x + 3} y={y + 5} width={w} height={h} rx={r} fill="#2a1d12" opacity={o} filter="url(#es-blur)" />
);

/** Shared SVG defs, rendered once in the world. */
export function SpriteDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
      <defs>
        <filter id="es-blur" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <linearGradient id="es-oak" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#d9b98d" />
          <stop offset="1" stopColor="#c69d6b" />
        </linearGradient>
        <linearGradient id="es-walnut" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6b4a33" />
          <stop offset="1" stopColor="#4c3323" />
        </linearGradient>
        <linearGradient id="es-white-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fbfaf7" />
          <stop offset="1" stopColor="#e7e2d9" />
        </linearGradient>
        <linearGradient id="es-steel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e9ecef" />
          <stop offset="1" stopColor="#b9c0c7" />
        </linearGradient>
        <linearGradient id="es-screen" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#1d2533" />
          <stop offset="1" stopColor="#2c3a52" />
        </linearGradient>
        <radialGradient id="es-leaf" cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#8cc46a" />
          <stop offset="0.6" stopColor="#4f9a45" />
          <stop offset="1" stopColor="#2f6d33" />
        </radialGradient>
        <radialGradient id="es-leaf-dark" cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#5ea35a" />
          <stop offset="1" stopColor="#1f5428" />
        </radialGradient>
        <radialGradient id="es-felt" cx="0.5" cy="0.5" r="0.7">
          <stop offset="0" stopColor="#4caf72" />
          <stop offset="1" stopColor="#1f5a37" />
        </radialGradient>
        {/* A rug's pile: faint cross-hatching laid over the colour. */}
        <pattern id="es-weave" width="6" height="6" patternUnits="userSpaceOnUse">
          <path d="M0 6 L6 0" stroke="#000" strokeOpacity="0.07" strokeWidth="1" />
          <path d="M0 0 L6 6" stroke="#fff" strokeOpacity="0.05" strokeWidth="1" />
        </pattern>
        <radialGradient id="es-pot" cx="0.35" cy="0.3" r="0.75">
          <stop offset="0" stopColor="#d98a5f" />
          <stop offset="1" stopColor="#a5583a" />
        </radialGradient>
      </defs>
    </svg>
  );
}

// ── Seating ─────────────────────────────────────────────────────────────────

/** Office chair seen from above. `rot` 0 = the sitter faces down (south). */
export function ChairShape({ cx, cy, rot = 0, color = "#3b3a40" }: { cx: number; cy: number; rot?: number; color?: string }) {
  return (
    <g transform={`translate(${cx} ${cy}) rotate(${rot})`}>
      <ellipse cx={2} cy={4} rx={17} ry={16} fill="#2a1d12" opacity={0.18} filter="url(#es-blur)" />
      {/* backrest */}
      <path d="M-14 -10 Q0 -20 14 -10 L12 -5 Q0 -12 -12 -5 Z" fill={color} />
      {/* armrests */}
      <rect x={-17} y={-4} width={5} height={15} rx={2.5} fill="#2a292e" />
      <rect x={12} y={-4} width={5} height={15} rx={2.5} fill="#2a292e" />
      {/* seat */}
      <rect x={-12} y={-7} width={24} height={21} rx={8} fill={color} />
      <rect x={-9} y={-4} width={14} height={8} rx={4} fill="#fff" opacity={0.08} />
    </g>
  );
}

export function Armchair({ w, h, color = "#8a6f57" }: { w: number; h: number; color?: string }) {
  return (
    <Svg w={w} h={h}>
      <Shadow x={0} y={0} w={w} h={h} r={14} />
      <rect width={w} height={h} rx={14} fill={color} />
      <rect x={6} y={h * 0.32} width={w - 12} height={h * 0.62} rx={10} fill={color} style={{ filter: "brightness(1.12)" }} />
      <rect x={0} y={0} width={w} height={h * 0.3} rx={12} fill="#000" opacity={0.12} />
      <rect x={10} y={h * 0.4} width={w * 0.35} height={h * 0.18} rx={6} fill="#fff" opacity={0.12} />
    </Svg>
  );
}

export function Sofa({ w, h, color = "#5b6b7a", cushions }: { w: number; h: number; color?: string; cushions?: boolean }) {
  const seats = Math.max(2, Math.round(w / 70));
  const seatW = (w - 24) / seats;
  return (
    <Svg w={w} h={h}>
      <Shadow x={0} y={0} w={w} h={h} r={14} />
      <rect width={w} height={h} rx={14} fill={color} />
      <rect x={0} y={0} width={w} height={h * 0.34} rx={12} fill="#000" opacity={0.14} />
      {Array.from({ length: seats }, (_, i) => (
        <g key={i}>
          <rect x={12 + i * seatW + 2} y={h * 0.36} width={seatW - 4} height={h * 0.56} rx={8} fill={color} style={{ filter: "brightness(1.15)" }} />
          <rect x={12 + i * seatW + 8} y={h * 0.42} width={seatW * 0.4} height={h * 0.14} rx={5} fill="#fff" opacity={0.1} />
        </g>
      ))}
      <rect x={0} y={4} width={12} height={h - 8} rx={6} fill={color} style={{ filter: "brightness(0.9)" }} />
      <rect x={w - 12} y={4} width={12} height={h - 8} rx={6} fill={color} style={{ filter: "brightness(0.9)" }} />
      {cushions ? (
        // Teal and navy scatter cushions along the back, like Customer Success's sofa.
        ["#2f8a85", "#2f4a6e", "#d9d2c4", "#2f4a6e", "#2f8a85"].map((c, i, a) => (
          <rect key={i} x={14 + ((w - 28) * (i + 0.5)) / a.length - 9} y={h * 0.3} width={18} height={14} rx={4} fill={c} transform={`rotate(${i % 2 ? 8 : -8} ${14 + ((w - 28) * (i + 0.5)) / a.length} ${h * 0.3 + 7})`} />
        ))
      ) : (
        // a throw pillow
        <rect x={18} y={h * 0.38} width={20} height={16} rx={5} fill="#e9b949" transform={`rotate(-12 28 ${h * 0.38 + 8})`} />
      )}
    </Svg>
  );
}

export function Beanbag({ w, h, color }: { w: number; h: number; color: string }) {
  return (
    <Svg w={w} h={h}>
      <ellipse cx={w / 2 + 3} cy={h / 2 + 5} rx={w / 2} ry={h / 2} fill="#2a1d12" opacity={0.2} filter="url(#es-blur)" />
      <path
        d={`M${w * 0.5} 0 C${w * 0.95} 0 ${w} ${h * 0.3} ${w} ${h * 0.55} C${w} ${h * 0.95} ${w * 0.7} ${h} ${w * 0.45} ${h} C${w * 0.1} ${h} 0 ${h * 0.75} 0 ${h * 0.5} C0 ${h * 0.15} ${w * 0.2} 0 ${w * 0.5} 0 Z`}
        fill={color}
      />
      <ellipse cx={w * 0.52} cy={h * 0.52} rx={w * 0.26} ry={h * 0.22} fill="#000" opacity={0.12} />
      <ellipse cx={w * 0.35} cy={h * 0.28} rx={w * 0.16} ry={h * 0.1} fill="#fff" opacity={0.25} />
    </Svg>
  );
}

// ── Desks & tables ──────────────────────────────────────────────────────────

/** A work desk with monitor, keyboard and a few personal things, plus its chair. */
export function Desk({ id, facing, name }: { id: string; facing: "n" | "s"; name: string | null }) {
  const w = 84, h = 52;
  // The person sits on the `facing` side's opposite: facing south = chair on top.
  const chairTop = facing === "s";
  const monY = chairTop ? h - 9 : 5;
  const kbY = chairTop ? h - 24 : 15;
  const item = Math.floor(rand(id) * 5);
  const accent = ["#e86f50", "#4a8af4", "#2f9e6e", "#e9b949", "#8b5cf6"][Math.floor(rand(id, 7) * 5)];
  return (
    <Svg w={w} h={h} pad={24}>
      <ChairShape cx={w / 2} cy={chairTop ? -14 : h + 14} rot={chairTop ? 180 : 0} />
      <Shadow x={0} y={0} w={w} h={h} r={4} o={0.25} />
      <rect width={w} height={h} rx={4} fill="url(#es-oak)" />
      <rect x={1} y={1} width={w - 2} height={3} rx={1.5} fill="#fff" opacity={0.25} />
      {/* monitor: stand, then the panel edge-on */}
      <rect x={w / 2 - 5} y={chairTop ? monY - 6 : monY + 2} width={10} height={6} rx={2} fill="#3a3a3e" />
      <rect x={w / 2 - 22} y={monY - 2} width={44} height={6} rx={2} fill="url(#es-screen)" />
      <rect x={w / 2 - 20} y={chairTop ? monY - 3 : monY + 3} width={40} height={1.5} fill="#7fb2ff" opacity={0.55} />
      {/* keyboard + mouse */}
      <rect x={w / 2 - 15} y={kbY} width={30} height={9} rx={2} fill="#f1f1f3" stroke="#c9c9cf" strokeWidth={0.6} />
      <rect x={w / 2 + 20} y={kbY + 1} width={5} height={7} rx={2.5} fill="#f1f1f3" stroke="#c9c9cf" strokeWidth={0.6} />
      {/* something personal */}
      {item === 0 ? (
        <g transform={`translate(10 ${chairTop ? 30 : 12})`}>
          <circle r={5} fill="#fff" stroke="#d3cbbf" />
          <circle r={3.3} fill="#5a3a22" />
          <rect x={4} y={-1.5} width={3.5} height={3} rx={1.5} fill="#fff" stroke="#d3cbbf" strokeWidth={0.6} />
        </g>
      ) : item === 1 ? (
        <g transform={`translate(11 ${chairTop ? 30 : 13})`}>
          <circle r={6} fill="url(#es-pot)" />
          {[0, 72, 144, 216, 288].map((a) => (
            <ellipse key={a} rx={2.4} ry={5} fill="#5aa25a" transform={`rotate(${a}) translate(0 -3)`} />
          ))}
        </g>
      ) : item === 2 ? (
        <g transform={`translate(${w - 20} ${chairTop ? 24 : 10})`}>
          <rect width={12} height={15} rx={1} fill="#fffdf4" stroke="#d8d0bf" strokeWidth={0.6} transform="rotate(-8)" />
          <line x1={2} y1={4} x2={9} y2={3} stroke="#9aa" strokeWidth={0.6} />
          <line x1={2} y1={7} x2={9} y2={6} stroke="#9aa" strokeWidth={0.6} />
        </g>
      ) : item === 3 ? (
        <rect x={8} y={chairTop ? 26 : 10} width={7} height={13} rx={2} fill="#222" stroke="#555" strokeWidth={0.6} />
      ) : (
        <circle cx={12} cy={chairTop ? 30 : 13} r={4.5} fill={accent} opacity={0.9} />
      )}
      {name ? (
        <g>
          <rect x={w / 2 - 26} y={chairTop ? 6 : h - 15} width={52} height={10} rx={2} fill="#fffaf2" stroke="#c8baa6" strokeWidth={0.6} />
          <text x={w / 2} y={chairTop ? 13.6 : h - 7.4} textAnchor="middle" fontSize={7} fontWeight={700} fill="#3a332c" fontFamily="Figtree, system-ui, sans-serif">
            {name.length > 12 ? name.slice(0, 11) + "…" : name}
          </text>
        </g>
      ) : null}
    </Svg>
  );
}

/** A meeting table with chairs around it and a few laptops and notepads. */
/** `plain`: just the table — imported floors place their own chairs and things. */
export function MeetingTable({ w, h, id, plain, dark }: { w: number; h: number; id: string; plain?: boolean; dark?: boolean }) {
  const along = Math.max(2, Math.floor((w - 40) / 62));
  const step = (w - 40) / along;
  const xs = Array.from({ length: along }, (_, i) => 20 + step * (i + 0.5));
  const ends = h > 120;
  return (
    <Svg w={w} h={h} pad={34}>
      {!plain && xs.map((x, i) => <ChairShape key={`t${i}`} cx={x} cy={-15} rot={180} color="#4a4950" />)}
      {!plain && xs.map((x, i) => <ChairShape key={`b${i}`} cx={x} cy={h + 15} rot={0} color="#4a4950" />)}
      {!plain && ends ? <ChairShape cx={-15} cy={h / 2} rot={90} color="#4a4950" /> : null}
      {!plain && ends ? <ChairShape cx={w + 15} cy={h / 2} rot={-90} color="#4a4950" /> : null}
      <Shadow x={0} y={0} w={w} h={h} r={18} o={0.3} />
      <rect width={w} height={h} rx={18} fill={dark ? "#3a3d42" : "url(#es-walnut)"} />
      {Array.from({ length: 6 }, (_, i) => (
        <path key={i} d={`M12 ${(h / 7) * (i + 1)} Q${w / 2} ${(h / 7) * (i + 1) + (i % 2 ? 4 : -4)} ${w - 12} ${(h / 7) * (i + 1)}`} stroke="#fff" strokeOpacity={0.05} fill="none" />
      ))}
      <rect x={3} y={3} width={w - 6} height={h - 6} rx={15} fill="none" stroke="#fff" strokeOpacity={0.08} />
      {!plain && xs.map((x, i) =>
        rand(id, i) > 0.45 ? (
          <g key={`l${i}`} transform={`translate(${x - 13} 12)`}>
            <rect width={26} height={17} rx={2} fill="#c9ced6" />
            <rect x={2} y={2} width={22} height={11} rx={1} fill="#2c3a52" />
          </g>
        ) : (
          <rect key={`n${i}`} x={x - 7} y={14} width={14} height={18} rx={1} fill="#fffdf4" transform={`rotate(${rand(id, i + 9) * 16 - 8} ${x} 23)`} />
        ),
      )}
      {!plain && xs.map((x, i) =>
        rand(id, i + 40) > 0.5 ? <circle key={`c${i}`} cx={x + 8} cy={h - 18} r={4} fill="#d6eef7" stroke="#a9cfe0" strokeWidth={0.8} /> : null,
      )}
    </Svg>
  );
}

export function CoffeeTable({ w, h }: { w: number; h: number }) {
  return (
    <Svg w={w} h={h}>
      <Shadow x={0} y={0} w={w} h={h} r={h / 2} />
      <rect width={w} height={h} rx={h / 2} fill="url(#es-walnut)" />
      <circle cx={w * 0.3} cy={h / 2} r={6} fill="#fff" stroke="#ccc" />
      <circle cx={w * 0.3} cy={h / 2} r={4} fill="#5a3a22" />
      <rect x={w * 0.5} y={h * 0.25} width={w * 0.3} height={h * 0.5} rx={2} fill="#e86f50" opacity={0.85} />
    </Svg>
  );
}

export function CafeTable({ w, id, plain, tone }: { w: number; id: string; plain?: boolean; tone?: "wood" | "rattan" | "dark" }) {
  const r = w / 2;
  const n = plain ? 0 : rand(id) > 0.5 ? 4 : 3;
  return (
    <Svg w={w} h={w} pad={30}>
      {Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2 + 0.4;
        return <ChairShape key={i} cx={r + Math.cos(a) * (r + 14)} cy={r + Math.sin(a) * (r + 14)} rot={(a * 180) / Math.PI - 90} color="#6b5a4a" />;
      })}
      <circle cx={r + 3} cy={r + 5} r={r} fill="#2a1d12" opacity={0.22} filter="url(#es-blur)" />
      <circle cx={r} cy={r} r={r} fill={tone === "wood" ? "url(#es-walnut)" : tone === "rattan" ? "#d8b77f" : tone === "dark" ? "#4a4d52" : "url(#es-white-top)"} stroke={tone === "dark" ? "#2f3135" : tone ? "#8a6a42" : "#d6cfc3"} />
      {tone === "rattan" ? Array.from({ length: 5 }, (_, i) => <circle key={i} cx={r} cy={r} r={r * (0.2 + i * 0.17)} fill="none" stroke="#a9874f" strokeOpacity={0.35} />) : null}
      {tone === "wood" ? <circle cx={r} cy={r} r={r * 0.82} fill="none" stroke="#fff" strokeOpacity={0.08} /> : null}
      {plain ? null : <circle cx={r - 6} cy={r - 4} r={5} fill="#fff" stroke="#ccc" />}
      {plain ? null : <circle cx={r - 6} cy={r - 4} r={3.4} fill="#5a3a22" />}
    </Svg>
  );
}

// ── Decor ───────────────────────────────────────────────────────────────────

export function Plant({ w, id, tall }: { w: number; id: string; tall?: boolean }) {
  const r = w / 2;
  const leaves = tall ? 9 : 7;
  const turn = rand(id) * 360;
  return (
    <Svg w={w} h={w} pad={tall ? 22 : 14}>
      <circle cx={r + 3} cy={r + 6} r={r * 0.9} fill="#2a1d12" opacity={0.25} filter="url(#es-blur)" />
      <circle cx={r} cy={r} r={r * 0.62} fill="url(#es-pot)" />
      <circle cx={r} cy={r} r={r * 0.5} fill="#4a3424" />
      <g transform={`translate(${r} ${r}) rotate(${turn})`}>
        {Array.from({ length: leaves }, (_, i) => {
          const a = (i / leaves) * 360;
          const len = r * (tall ? 1.15 : 0.95) * (0.75 + rand(id, i) * 0.4);
          return (
            <g key={i} transform={`rotate(${a})`}>
              <path d={`M0 0 C${len * 0.35} ${-len * 0.25} ${len * 0.35} ${-len * 0.85} 0 ${-len} C${-len * 0.35} ${-len * 0.85} ${-len * 0.35} ${-len * 0.25} 0 0 Z`} fill={i % 3 ? "url(#es-leaf)" : "url(#es-leaf-dark)"} />
              <path d={`M0 -2 L0 ${-len * 0.9}`} stroke="#255c2a" strokeWidth={0.8} opacity={0.6} />
            </g>
          );
        })}
      </g>
    </Svg>
  );
}

export function Rug({ w, h, color = "#c9b79c", id, runner }: { w: number; h: number; color?: string; id: string; runner?: boolean }) {
  const pattern = runner ? 1 : Math.floor(rand(id) * 3);
  return (
    <Svg w={w} h={h} pad={4}>
      <rect width={w} height={h} rx={6} fill={color} />
      <rect x={8} y={8} width={w - 16} height={h - 16} rx={4} fill="none" stroke="#fff" strokeOpacity={0.35} strokeWidth={2} />
      <rect x={14} y={14} width={w - 28} height={h - 28} rx={3} fill="none" stroke="#000" strokeOpacity={0.1} strokeWidth={1} />
      {pattern === 0
        ? Array.from({ length: Math.floor((w - 40) / 26) }, (_, i) => (
            <path key={i} d={`M${26 + i * 26} ${h / 2 - 10} l8 10 l-8 10 l-8 -10 Z`} fill="#000" opacity={0.08} />
          ))
        : pattern === 1
          ? Array.from({ length: 4 }, (_, i) => <line key={i} x1={20} x2={w - 20} y1={22 + ((h - 44) / 3) * i} y2={22 + ((h - 44) / 3) * i} stroke="#fff" strokeOpacity={0.18} strokeWidth={3} />)
          : <ellipse cx={w / 2} cy={h / 2} rx={w * 0.3} ry={h * 0.28} fill="none" stroke="#fff" strokeOpacity={0.25} strokeWidth={3} />}
      {/* fringe */}
      {Array.from({ length: Math.floor(h / 6) }, (_, i) => (
        <g key={i}>
          <line x1={-3} x2={0} y1={4 + i * 6} y2={4 + i * 6} stroke={color} strokeWidth={1.4} />
          <line x1={w} x2={w + 3} y1={4 + i * 6} y2={4 + i * 6} stroke={color} strokeWidth={1.4} />
        </g>
      ))}
    </Svg>
  );
}

export function Bookshelf({ w, h, id }: { w: number; h: number; id: string }) {
  const colors = ["#8a5a3b", "#b5774c", "#5d7c9a", "#c8a24a", "#7a9a6a", "#a8473b", "#3f5a74", "#d9c8a9"];
  const books: ReactNode[] = [];
  let x = 4;
  let i = 0;
  while (x < w - 6) {
    const bw = 4 + Math.floor(rand(id, i) * 5);
    if (rand(id, i + 99) > 0.88) {
      x += bw + 3; // a gap
    } else {
      books.push(<rect key={i} x={x} y={4 + rand(id, i + 3) * 3} width={bw} height={h - 10} rx={1} fill={colors[Math.floor(rand(id, i + 7) * colors.length)]} />);
      x += bw + 1;
    }
    i++;
  }
  return (
    <Svg w={w} h={h}>
      <Shadow x={0} y={0} w={w} h={h} r={3} />
      <rect width={w} height={h} rx={3} fill="#5c3c27" />
      <rect x={2} y={2} width={w - 4} height={h - 4} rx={2} fill="#3e281a" />
      {books}
    </Svg>
  );
}

export function Counter({ w, h }: { w: number; h: number }) {
  const vertical = h > w;
  return (
    <Svg w={w} h={h}>
      <Shadow x={0} y={0} w={w} h={h} r={4} />
      <rect width={w} height={h} rx={4} fill="url(#es-white-top)" stroke="#cfc8bc" />
      {/* sink */}
      <rect x={vertical ? w * 0.2 : w * 0.15} y={vertical ? h * 0.2 : h * 0.2} width={vertical ? w * 0.6 : w * 0.2} height={vertical ? h * 0.14 : h * 0.6} rx={6} fill="url(#es-steel)" stroke="#9aa2aa" />
      {/* coffee machine */}
      <rect x={vertical ? w * 0.22 : w * 0.5} y={vertical ? h * 0.48 : h * 0.18} width={vertical ? w * 0.56 : w * 0.12} height={vertical ? h * 0.1 : h * 0.64} rx={4} fill="#2b2b2f" />
      <circle cx={vertical ? w * 0.5 : w * 0.56} cy={vertical ? h * 0.53 : h * 0.5} r={3} fill="#e86f50" />
      {/* fruit bowl */}
      <circle cx={vertical ? w * 0.5 : w * 0.8} cy={vertical ? h * 0.78 : h * 0.5} r={Math.min(w, h) * 0.22} fill="#fff" stroke="#ddd" />
      {[0, 1, 2].map((k) => (
        <circle key={k} cx={(vertical ? w * 0.5 : w * 0.8) + (k - 1) * 5} cy={(vertical ? h * 0.78 : h * 0.5) + (k % 2) * 3} r={4} fill={["#e86f50", "#e9b949", "#7cb342"][k]} />
      ))}
    </Svg>
  );
}

export function Fridge({ w, h }: { w: number; h: number }) {
  return (
    <Svg w={w} h={h}>
      <Shadow x={0} y={0} w={w} h={h} r={4} />
      <rect width={w} height={h} rx={4} fill="url(#es-steel)" stroke="#9aa2aa" />
      <line x1={4} x2={w - 4} y1={h * 0.4} y2={h * 0.4} stroke="#8d959d" />
      <rect x={w - 9} y={6} width={3} height={h * 0.28} rx={1.5} fill="#7a828a" />
    </Svg>
  );
}

export function Tv({ w, h }: { w: number; h: number }) {
  return (
    <Svg w={w} h={h}>
      <rect x={-4} y={h - 2} width={w + 8} height={6} rx={3} fill="#000" opacity={0.25} filter="url(#es-blur)" />
      <rect width={w} height={h} rx={3} fill="#0f1115" />
      <rect x={4} y={h - 4} width={w - 8} height={2} rx={1} fill="#6aa0ff" opacity={0.6} />
    </Svg>
  );
}

export function Whiteboard({ w, h }: { w: number; h: number }) {
  return (
    <Svg w={w} h={h}>
      <Shadow x={0} y={0} w={w} h={h} r={2} o={0.18} />
      <rect width={w} height={h} rx={2} fill="#fdfdfd" stroke="#9aa2aa" strokeWidth={2} />
      <path d={`M10 ${h * 0.45} q12 -8 24 0 t24 0`} stroke="#2f6fe4" strokeWidth={1.6} fill="none" />
      <path d={`M${w * 0.55} ${h * 0.35} l20 0 M${w * 0.55} ${h * 0.6} l30 0`} stroke="#e86f50" strokeWidth={1.6} />
    </Svg>
  );
}

export function WaterCooler({ w }: { w: number }) {
  return (
    <Svg w={w} h={w}>
      <Shadow x={0} y={0} w={w} h={w} r={6} />
      <rect width={w} height={w} rx={6} fill="#f2f4f6" stroke="#c4cbd2" />
      <circle cx={w / 2} cy={w / 2} r={w * 0.36} fill="#bfe3f5" stroke="#8cc4e0" />
      <circle cx={w / 2 - 3} cy={w / 2 - 3} r={w * 0.12} fill="#fff" opacity={0.7} />
    </Svg>
  );
}

export function Lamp({ w }: { w: number }) {
  return (
    <Svg w={w} h={w} pad={20}>
      <circle cx={w / 2} cy={w / 2} r={w * 0.9} fill="#ffe7a8" opacity={0.18} />
      <circle cx={w / 2 + 2} cy={w / 2 + 4} r={w / 2} fill="#2a1d12" opacity={0.2} filter="url(#es-blur)" />
      <circle cx={w / 2} cy={w / 2} r={w / 2} fill="#f6efe2" stroke="#d8ccb6" />
      <circle cx={w / 2} cy={w / 2} r={w * 0.12} fill="#c8a24a" />
    </Svg>
  );
}

export function LogoWall({ w, h }: { w: number; h: number }) {
  return (
    <Svg w={w} h={h}>
      <Shadow x={0} y={0} w={w} h={h} r={6} o={0.3} />
      <rect width={w} height={h} rx={6} fill="url(#es-walnut)" />
      {Array.from({ length: Math.floor(w / 18) }, (_, i) => (
        <rect key={i} x={6 + i * 18} y={4} width={12} height={h - 8} rx={2} fill="#000" opacity={0.12} />
      ))}
    </Svg>
  );
}

// ── Play & lounge ──────────────────────────────────────────────────────────

export function PingPong({ w, h }: { w: number; h: number }) {
  const vertical = h > w;
  return (
    <Svg w={w} h={h} pad={20}>
      <Shadow x={0} y={0} w={w} h={h} r={4} o={0.3} />
      <rect width={w} height={h} rx={4} fill="#1f6f8b" stroke="#0f4558" strokeWidth={2} />
      <rect x={3} y={3} width={w - 6} height={h - 6} rx={2} fill="none" stroke="#fff" strokeWidth={2} />
      {vertical ? <line x1={w / 2} y1={3} x2={w / 2} y2={h - 3} stroke="#fff" strokeWidth={1} /> : <line x1={3} y1={h / 2} x2={w - 3} y2={h / 2} stroke="#fff" strokeWidth={1} />}
      {/* the net */}
      {vertical ? <rect x={-6} y={h / 2 - 2} width={w + 12} height={4} rx={1} fill="#f2f2f2" stroke="#999" strokeWidth={0.6} /> : <rect x={w / 2 - 2} y={-6} width={4} height={h + 12} rx={1} fill="#f2f2f2" stroke="#999" strokeWidth={0.6} />}
      {/* paddles + ball */}
      <g transform={vertical ? `translate(${w * 0.25} ${h * 0.16})` : `translate(${w * 0.16} ${h * 0.25})`}>
        <circle r={7} fill="#c8443a" /><rect x={-1.5} y={6} width={3} height={8} rx={1.5} fill="#7a4a2a" />
      </g>
      <g transform={vertical ? `translate(${w * 0.72} ${h * 0.84})` : `translate(${w * 0.84} ${h * 0.72})`}>
        <circle r={7} fill="#1d1d1f" /><rect x={-1.5} y={6} width={3} height={8} rx={1.5} fill="#7a4a2a" />
      </g>
      <circle cx={w * 0.6} cy={h * 0.38} r={2.5} fill="#fff" stroke="#ddd" />
    </Svg>
  );
}

export function PoolTable({ w, h }: { w: number; h: number }) {
  const r = 7;
  const pockets = [[0, 0], [w / 2, 0], [w, 0], [0, h], [w / 2, h], [w, h]];
  const balls = ["#e9b949", "#3c6fd8", "#c8443a", "#6b3fa0", "#f08a24", "#2f9e6e", "#7a1f1f", "#111"];
  return (
    <Svg w={w} h={h} pad={20}>
      <Shadow x={-6} y={-6} w={w + 12} h={h + 12} r={8} o={0.32} />
      <rect x={-8} y={-8} width={w + 16} height={h + 16} rx={8} fill="url(#es-walnut)" />
      <rect width={w} height={h} rx={3} fill="#2e7d4f" />
      <rect width={w} height={h} rx={3} fill="url(#es-felt)" opacity={0.5} />
      {pockets.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={r} fill="#111" />)}
      {balls.map((c, i) => <circle key={i} cx={w * 0.62 + (i % 4) * 9} cy={h * 0.4 + Math.floor(i / 4) * 9 + (i % 2) * 4} r={4.2} fill={c} stroke="#000" strokeOpacity={0.25} />)}
      <circle cx={w * 0.25} cy={h / 2} r={4.2} fill="#fafafa" stroke="#bbb" />
      <line x1={w * 0.05} y1={h * 0.9} x2={w * 0.24} y2={h * 0.55} stroke="#c8a24a" strokeWidth={3} strokeLinecap="round" />
    </Svg>
  );
}

export function Piano({ w, h }: { w: number; h: number }) {
  const keys = Math.floor((w - 16) / 7);
  return (
    <Svg w={w} h={h} pad={22}>
      <Shadow x={0} y={0} w={w} h={h} r={6} o={0.3} />
      <path d={`M0 ${h * 0.3} L0 ${h} L${w} ${h} L${w} ${h * 0.55} C${w} ${h * 0.15} ${w * 0.55} 0 ${w * 0.3} 0 L${w * 0.12} 0 C${w * 0.04} 0 0 ${h * 0.1} 0 ${h * 0.3} Z`} fill="#141416" />
      <path d={`M${w * 0.1} ${h * 0.22} C${w * 0.3} ${h * 0.06} ${w * 0.7} ${h * 0.2} ${w * 0.86} ${h * 0.5}`} stroke="#fff" strokeOpacity={0.12} strokeWidth={6} fill="none" />
      <rect x={6} y={h - 22} width={w - 12} height={16} rx={2} fill="#fafafa" />
      {Array.from({ length: keys }, (_, i) => <line key={i} x1={8 + i * 7} x2={8 + i * 7} y1={h - 22} y2={h - 6} stroke="#bbb" strokeWidth={0.6} />)}
      {Array.from({ length: keys }, (_, i) => ([1, 2, 4, 5, 6].includes(i % 7) ? <rect key={`b${i}`} x={6 + i * 7} y={h - 22} width={4} height={9} fill="#111" /> : null))}
      {/* bench */}
      <rect x={w / 2 - 24} y={h + 6} width={48} height={14} rx={3} fill="#141416" />
    </Svg>
  );
}

export function Arcade({ w, h, color = "#8b5cf6" }: { w: number; h: number; color?: string }) {
  return (
    <Svg w={w} h={h} pad={14}>
      <Shadow x={0} y={0} w={w} h={h} r={4} o={0.3} />
      <rect width={w} height={h} rx={4} fill={color} />
      <rect x={4} y={4} width={w - 8} height={h * 0.45} rx={3} fill="#111" />
      <rect x={7} y={7} width={w - 14} height={h * 0.45 - 6} rx={2} fill="#1d3b6e" />
      <circle cx={w * 0.35} cy={h * 0.7} r={4} fill="#c8443a" />
      <circle cx={w * 0.62} cy={h * 0.66} r={3} fill="#e9b949" />
      <circle cx={w * 0.75} cy={h * 0.74} r={3} fill="#2f9e6e" />
      <rect x={4} y={h - 8} width={w - 8} height={4} rx={2} fill="#000" opacity={0.25} />
    </Svg>
  );
}

export function Bench({ w, h, color = "#8a6a4a" }: { w: number; h: number; color?: string }) {
  const slats = Math.max(3, Math.floor(h / 8));
  return (
    <Svg w={w} h={h}>
      <Shadow x={0} y={0} w={w} h={h} r={4} />
      {Array.from({ length: slats }, (_, i) => (
        <rect key={i} x={0} y={(h / slats) * i + 1} width={w} height={h / slats - 2} rx={2} fill={color} style={{ filter: `brightness(${1 + (i % 2) * 0.08})` }} />
      ))}
    </Svg>
  );
}
