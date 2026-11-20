// The second set of furniture sprites, beyond the basics in sprites.tsx: laptops and monitors, coloured chairs, the chess board,
// mannequins, cabinets, drinks and snacks, frames, pets... Same rules as
// sprites.tsx: top-down, lit from the top-left, each in its own w×h box.

import type { ReactNode } from "react";
import type { Obj } from "../../../shared/floor";
import { ChairShape, Plant, Shadow, Svg, rand } from "./sprites";

/** Draw `children` (made for a box `bw`×`bh` centred on 0,0) rotated `r`° in a w×h box. */
const Turned = ({ w, h, r = 0, children }: { w: number; h: number; r?: number; children: ReactNode }) => (
  <g transform={`translate(${w / 2} ${h / 2}) rotate(${r})`}>{children}</g>
);
const shade = (hex: string, k: number) => {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
};

function Chair({ w, h, color = "#3b3a40", variant, r = 0 }: { w: number; h: number; color?: string; variant?: string; r?: number }) {
  const s = Math.min(w, h) / 36;
  if (variant === "plastic") {
    // A moulded shell chair: one rounded piece, a darker rim.
    return (
      <Svg w={w} h={h}>
        <Turned w={w} h={h} r={r}>
          <g transform={`scale(${s})`}>
            <ellipse cx={2} cy={4} rx={16} ry={15} fill="#2a1d12" opacity={0.2} filter="url(#es-blur)" />
            <path d="M-15 -8 Q-16 14 0 15 Q16 14 15 -8 Q0 -17 -15 -8 Z" fill={shade(color, 0.82)} />
            <path d="M-11 -4 Q-12 11 0 11.5 Q12 11 11 -4 Q0 -10 -11 -4 Z" fill={color} />
            <ellipse cx={-4} cy={1} rx={4} ry={3} fill="#fff" opacity={0.18} />
          </g>
        </Turned>
      </Svg>
    );
  }
  return (
    <Svg w={w} h={h}>
      <Turned w={w} h={h} r={r}>
        <g transform={`scale(${s})`}>
          <ChairShape cx={0} cy={0} color={color} />
        </g>
      </Turned>
    </Svg>
  );
}

function Ottoman({ w, h, color = "#4f8a5b", variant }: { w: number; h: number; color?: string; variant?: string }) {
  const rx = w / 2, ry = h / 2;
  return (
    <Svg w={w} h={h}>
      <ellipse cx={rx + 3} cy={ry + 5} rx={rx} ry={ry} fill="#2a1d12" opacity={0.2} filter="url(#es-blur)" />
      <ellipse cx={rx} cy={ry} rx={rx} ry={ry} fill={shade(color, 0.85)} />
      <ellipse cx={rx} cy={ry - 1} rx={rx * 0.86} ry={ry * 0.86} fill={color} />
      {variant === "stool"
        ? [0.3, 0.55, 0.78].map((k) => <ellipse key={k} cx={rx} cy={ry} rx={rx * k} ry={ry * k} fill="none" stroke="#000" strokeOpacity={0.08} />)
        : <path d={`M${rx * 0.4} ${ry} L${rx * 1.6} ${ry} M${rx} ${ry * 0.4} L${rx} ${ry * 1.6}`} stroke="#000" strokeOpacity={0.12} strokeWidth={1.5} />}
      <ellipse cx={rx * 0.7} cy={ry * 0.65} rx={rx * 0.3} ry={ry * 0.18} fill="#fff" opacity={0.18} />
    </Svg>
  );
}

const TOPS: Record<string, [string, string]> = {
  wood: ["#d9b98d", "#c69d6b"],
  white: ["#fbfaf7", "#e4dfd6"],
  marble: ["#f4f2ee", "#dcd8d2"],
  dark: ["#4a4f58", "#33373e"],
};

function DeskTable({ w, h, variant = "wood", id }: { w: number; h: number; variant?: string; id: string }) {
  const [a, b] = TOPS[variant] ?? TOPS.wood;
  const g = `dk-${id}`;
  return (
    <Svg w={w} h={h}>
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={a} /><stop offset="1" stopColor={b} /></linearGradient>
      </defs>
      <Shadow x={0} y={0} w={w} h={h} r={4} o={0.26} />
      <rect width={w} height={h} rx={4} fill={`url(#${g})`} stroke="#000" strokeOpacity={0.08} />
      <rect x={1.5} y={1.5} width={w - 3} height={3} rx={1.5} fill="#fff" opacity={0.3} />
      {variant === "marble"
        ? <path d={`M${w * 0.1} ${h * 0.8} Q${w * 0.4} ${h * 0.5} ${w * 0.9} ${h * 0.6}`} stroke="#b8b2aa" strokeOpacity={0.5} fill="none" />
        : variant === "wood"
          ? [0.3, 0.55, 0.8].map((k) => <line key={k} x1={6} x2={w - 6} y1={h * k} y2={h * k + 1} stroke="#7a5532" strokeOpacity={0.08} />)
          : null}
    </Svg>
  );
}

function Laptop({ w, h, r = 0 }: { w: number; h: number; r?: number }) {
  const s = Math.min(w, h) / 40;
  return (
    <Svg w={w} h={h} pad={6}>
      <Turned w={w} h={h} r={r}>
        <g transform={`scale(${s})`}>
          <rect x={-15} y={-12} width={30} height={24} rx={2} fill="#2a1d12" opacity={0.18} filter="url(#es-blur)" />
          {/* screen, tipped back */}
          <rect x={-15} y={-14} width={30} height={11} rx={1.5} fill="#b9c0c8" />
          <rect x={-13.5} y={-12.8} width={27} height={8.6} rx={1} fill="url(#es-screen)" />
          <rect x={-12} y={-11.5} width={9} height={1.6} rx={0.8} fill="#7fb2ff" opacity={0.7} />
          <rect x={-12} y={-9} width={14} height={1.2} rx={0.6} fill="#9fd7a8" opacity={0.6} />
          {/* base + keys + trackpad */}
          <rect x={-15} y={-3} width={30} height={15} rx={1.5} fill="#d5dae0" stroke="#aab1b9" strokeWidth={0.5} />
          <rect x={-12.5} y={-1.2} width={25} height={6} rx={0.8} fill="#9aa3ad" opacity={0.55} />
          <rect x={-4.5} y={6.2} width={9} height={4.5} rx={0.8} fill="#c3c9d0" />
        </g>
      </Turned>
    </Svg>
  );
}

function Monitor({ w, h, r = 0, variant }: { w: number; h: number; r?: number; variant?: string }) {
  const s = Math.min(w * 1.6, h * 3.2) / 52;
  if (variant === "vintage") {
    const v = Math.min(w, h) / 40;
    return (
      <Svg w={w} h={h}>
        <Turned w={w} h={h} r={r}>
          <g transform={`scale(${v})`}>
            <rect x={-16} y={-14} width={32} height={30} rx={4} fill="#2a1d12" opacity={0.2} filter="url(#es-blur)" />
            <rect x={-16} y={-16} width={32} height={28} rx={4} fill="#e8e1cf" stroke="#bfb69f" />
            <rect x={-11} y={-12} width={22} height={14} rx={2} fill="#2f4a3a" />
            <rect x={-9} y={-10} width={10} height={1.5} fill="#7ff0a0" opacity={0.7} />
            <rect x={-12} y={14} width={24} height={6} rx={1.5} fill="#ddd5c2" stroke="#bfb69f" strokeWidth={0.6} />
          </g>
        </Turned>
      </Svg>
    );
  }
  return (
    <Svg w={w} h={h} pad={6}>
      <Turned w={w} h={h} r={r}>
        <g transform={`scale(${s})`}>
          <rect x={-5} y={-2} width={10} height={8} rx={2} fill="#3a3a3e" />
          <rect x={-26} y={-6} width={52} height={7} rx={2} fill="#26272b" />
          <rect x={-24} y={-5} width={48} height={2} fill="#7fb2ff" opacity={0.5} />
        </g>
      </Turned>
    </Svg>
  );
}

function Keyboard({ w, h, r = 0 }: { w: number; h: number; r?: number }) {
  const long = Math.max(w, h), short = Math.min(w, h);
  const turned = (r % 180 !== 0) !== (h > w);
  return (
    <Svg w={w} h={h} pad={4}>
      <Turned w={w} h={h} r={turned ? 90 : 0}>
        <rect x={-long / 2} y={-short / 2} width={long} height={short} rx={2} fill="#eceef1" stroke="#b9bec6" strokeWidth={0.6} />
        {Array.from({ length: 3 }, (_, i) => (
          <line key={i} x1={-long / 2 + 3} x2={long / 2 - 3} y1={-short / 2 + (short / 4) * (i + 1)} y2={-short / 2 + (short / 4) * (i + 1)} stroke="#9aa1aa" strokeDasharray="2 1.2" strokeWidth={short / 7} opacity={0.6} />
        ))}
      </Turned>
    </Svg>
  );
}

function Chess({ w, h }: { w: number; h: number }) {
  const n = 8, c = Math.min(w, h) - 8, cell = c / n, x0 = (w - c) / 2, y0 = (h - c) / 2;
  const back = ["♜", "♞", "♝", "♛", "♚", "♝", "♞", "♜"];
  return (
    <Svg w={w} h={h}>
      <Shadow x={x0 - 3} y={y0 - 3} w={c + 6} h={c + 6} r={3} o={0.3} />
      <rect x={x0 - 3} y={y0 - 3} width={c + 6} height={c + 6} rx={3} fill="#6b4a33" />
      {Array.from({ length: 64 }, (_, i) => (
        <rect key={i} x={x0 + (i % 8) * cell} y={y0 + Math.floor(i / 8) * cell} width={cell} height={cell} fill={(i + Math.floor(i / 8)) % 2 ? "#8a5a3b" : "#ecd9b6"} />
      ))}
      {back.map((p, i) => (
        <g key={i} fontSize={cell * 0.9} textAnchor="middle" fontFamily="system-ui, sans-serif">
          <text x={x0 + cell * (i + 0.5)} y={y0 + cell * 0.82} fill="#1f1a17">{p}</text>
          <text x={x0 + cell * (i + 0.5)} y={y0 + cell * 1.82} fill="#1f1a17">♟</text>
          <text x={x0 + cell * (i + 0.5)} y={y0 + cell * 6.82} fill="#fffaf0" stroke="#5a4636" strokeWidth={0.4}>♟</text>
          <text x={x0 + cell * (i + 0.5)} y={y0 + cell * 7.82} fill="#fffaf0" stroke="#5a4636" strokeWidth={0.4}>{p}</text>
        </g>
      ))}
    </Svg>
  );
}

function Mannequin({ w, h }: { w: number; h: number }) {
  // A wooden artist's mannequin, seen from above-front: little jointed figure on a stand.
  const s = Math.min(w / 32, h / 64);
  return (
    <Svg w={w} h={h}>
      <g transform={`translate(${w / 2} ${h / 2}) scale(${s})`} fill="#d6a874" stroke="#9a6d43" strokeWidth={0.8}>
        <ellipse cx={2} cy={30} rx={12} ry={4} fill="#2a1d12" stroke="none" opacity={0.25} filter="url(#es-blur)" />
        <ellipse cx={0} cy={28} rx={10} ry={3.5} fill="#8a5a3b" />
        <rect x={-1} y={8} width={2} height={20} fill="#8a5a3b" stroke="none" />
        <circle cx={0} cy={-24} r={6} />
        <rect x={-6} y={-17} width={12} height={16} rx={5} />
        <rect x={-5} y={-1} width={4} height={14} rx={2} transform="rotate(8 -3 -1)" />
        <rect x={1} y={-1} width={4} height={14} rx={2} transform="rotate(-8 3 -1)" />
        <rect x={-11} y={-16} width={4} height={14} rx={2} transform="rotate(20 -9 -16)" />
        <rect x={7} y={-16} width={4} height={14} rx={2} transform="rotate(-35 9 -16)" />
      </g>
    </Svg>
  );
}

function Cabinet({ w, h, id }: { w: number; h: number; id: string }) {
  // A run of kitchen counter: stone top, cabinet fronts along the near edge, and a sink or hob on some.
  const what = Math.floor(rand(id) * 3);
  const top = h * 0.78;
  const doors = Math.max(1, Math.round(w / 32));
  return (
    <Svg w={w} h={h}>
      <Shadow x={0} y={0} w={w} h={h} r={3} o={0.28} />
      <rect width={w} height={h} rx={3} fill="#e9e6e1" stroke="#b9b2a7" />
      <rect x={0} y={top} width={w} height={h - top} rx={2} fill="#7d8a96" />
      {Array.from({ length: doors }, (_, k) => (
        <rect key={k} x={2 + (k * (w - 4)) / doors} y={top + 2} width={(w - 4) / doors - 2} height={h - top - 4} rx={1.5} fill="#8f9ca8" />
      ))}
      <rect x={2} y={2} width={w - 4} height={4} rx={2} fill="#fff" opacity={0.5} />
      {what === 0 ? (
        <g>
          <rect x={w * 0.22} y={h * 0.2} width={w * 0.56} height={h * 0.4} rx={6} fill="#c9d1d8" stroke="#9aa5ae" />
          <rect x={w * 0.27} y={h * 0.25} width={w * 0.46} height={h * 0.3} rx={5} fill="#aeb9c2" />
          <circle cx={w / 2} cy={h * 0.14} r={Math.min(w, h) * 0.04} fill="#7d8a96" />
        </g>
      ) : what === 1 ? (
        <g>
          {[0.3, 0.7].flatMap((kx) => [0.25, 0.55].map((ky) => (
            <g key={`${kx}${ky}`}>
              <circle cx={w * kx} cy={h * ky} r={Math.min(w, h) * 0.12} fill="#2f2f35" />
              <circle cx={w * kx} cy={h * ky} r={Math.min(w, h) * 0.07} fill="none" stroke="#555" />
            </g>
          )))}
        </g>
      ) : (
        <g>
          <rect x={w * 0.15} y={h * 0.18} width={w * 0.32} height={h * 0.3} rx={3} fill="#d9b98d" stroke="#a37c52" strokeWidth={0.6} />
          <circle cx={w * 0.68} cy={h * 0.36} r={Math.min(w, h) * 0.1} fill="#fff" stroke="#c9bfae" />
          <circle cx={w * 0.68} cy={h * 0.36} r={Math.min(w, h) * 0.06} fill="#6b4226" />
        </g>
      )}
    </Svg>
  );
}

function Cup({ w, h, variant = "coffee", id }: { w: number; h: number; variant?: string; id: string }) {
  const r = Math.min(w, h) / 2 - 1, cx = w / 2, cy = h / 2;
  const drink = { coffee: "#6b4226", boba: "#d9b48f", tea: "#c8862f", tropical: "#f2a03d" }[variant] ?? "#6b4226";
  return (
    <Svg w={w} h={h} pad={4}>
      <circle cx={cx + 1.5} cy={cy + 2.5} r={r} fill="#2a1d12" opacity={0.22} filter="url(#es-blur)" />
      <circle cx={cx} cy={cy} r={r} fill={variant === "coffee" ? "#fff" : "#e8f3f6"} stroke="#cbc3b8" strokeWidth={0.8} opacity={0.95} />
      <circle cx={cx} cy={cy} r={r * 0.72} fill={drink} />
      {variant === "coffee" ? <rect x={cx + r - 1} y={cy - 2} width={r * 0.5} height={4} rx={2} fill="#fff" stroke="#cbc3b8" strokeWidth={0.6} /> : null}
      {variant === "boba" ? Array.from({ length: 5 }, (_, i) => <circle key={i} cx={cx + Math.cos(i * 1.3) * r * 0.4} cy={cy + Math.sin(i * 1.3) * r * 0.4} r={r * 0.13} fill="#3a2418" />) : null}
      {variant !== "coffee" ? <line x1={cx} y1={cy} x2={cx + r * 0.9} y2={cy - r * 1.2} stroke={variant === "boba" ? "#e86f50" : "#4a8af4"} strokeWidth={Math.max(1, r * 0.18)} strokeLinecap="round" /> : null}
      {variant === "tropical" ? <circle cx={cx - r * 0.4} cy={cy - r * 0.4} r={r * 0.3} fill="#f6d04d" stroke="#c9a52d" strokeWidth={0.5} /> : null}
    </Svg>
  );
}

function Food({ w, h, variant = "donuts" }: { w: number; h: number; variant?: string }) {
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2;
  if (variant === "pizza") {
    return (
      <Svg w={w} h={h} pad={4}>
        <rect x={cx - r + 2} y={cy - r + 3} width={r * 2} height={r * 2} rx={2} fill="#2a1d12" opacity={0.2} filter="url(#es-blur)" />
        <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={2} fill="#e9d3a8" stroke="#c4a777" />
        <circle cx={cx} cy={cy} r={r * 0.82} fill="#e7a446" />
        <circle cx={cx} cy={cy} r={r * 0.7} fill="#f3cf6a" />
        {Array.from({ length: 7 }, (_, i) => <circle key={i} cx={cx + Math.cos(i * 0.9) * r * 0.42} cy={cy + Math.sin(i * 0.9) * r * 0.42} r={r * 0.1} fill="#b8342b" />)}
        {[0, 60, 120].map((a) => <line key={a} x1={cx} y1={cy} x2={cx + Math.cos((a * Math.PI) / 180) * r * 0.8} y2={cy + Math.sin((a * Math.PI) / 180) * r * 0.8} stroke="#c47c2a" strokeWidth={0.6} />)}
      </Svg>
    );
  }
  const icings = ["#f19bb9", "#6b3f25", "#7cc3ee", "#f4e1b5"];
  return (
    <Svg w={w} h={h} pad={4}>
      <rect x={1} y={2} width={w} height={h} rx={3} fill="#2a1d12" opacity={0.2} filter="url(#es-blur)" />
      <rect width={w} height={h} rx={3} fill="#f6efe2" stroke="#d8ccb6" />
      {icings.map((c, i) => {
        const dx = (i % 2 ? 0.72 : 0.28) * w, dy = (i < 2 ? 0.3 : 0.72) * h, rr = Math.min(w, h) * 0.2;
        return (
          <g key={i}>
            <circle cx={dx} cy={dy} r={rr} fill="#d99a52" />
            <circle cx={dx} cy={dy} r={rr * 0.82} fill={c} />
            <circle cx={dx} cy={dy} r={rr * 0.3} fill="#f6efe2" />
          </g>
        );
      })}
    </Svg>
  );
}

function Tray({ w, h, variant }: { w: number; h: number; variant?: string }) {
  const cups = variant === "drinks" ? ["#c6372e", "#f2b64d", "#7b1f2e", "#c88a3a"] : ["#6b4226", "#6b4226", "#6b4226"];
  const r = Math.min(w, h) * 0.16;
  return (
    <Svg w={w} h={h} pad={4}>
      <rect x={2} y={3} width={w} height={h} rx={6} fill="#2a1d12" opacity={0.2} filter="url(#es-blur)" />
      <rect width={w} height={h} rx={6} fill="#a87a50" stroke="#7a5532" />
      <rect x={3} y={3} width={w - 6} height={h - 6} rx={4} fill="#c49566" />
      {cups.map((c, i) => {
        const a = (i / cups.length) * Math.PI * 2;
        return (
          <g key={i}>
            <circle cx={w / 2 + Math.cos(a) * w * 0.22} cy={h / 2 + Math.sin(a) * h * 0.22} r={r} fill="#fff" stroke="#cbc3b8" strokeWidth={0.6} />
            <circle cx={w / 2 + Math.cos(a) * w * 0.22} cy={h / 2 + Math.sin(a) * h * 0.22} r={r * 0.7} fill={c} />
          </g>
        );
      })}
    </Svg>
  );
}

function Frame({ w, h, id }: { w: number; h: number; id: string }) {
  const hue = Math.floor(rand(id) * 360);
  return (
    <Svg w={w} h={h} pad={4}>
      <rect x={1} y={2} width={w} height={h} rx={1} fill="#2a1d12" opacity={0.25} filter="url(#es-blur)" />
      <rect width={w} height={h} rx={1} fill="#3a2a1e" />
      <rect x={w * 0.1} y={h * 0.1} width={w * 0.8} height={h * 0.8} fill="#f6f1e7" />
      <rect x={w * 0.17} y={h * 0.17} width={w * 0.66} height={h * 0.66} fill={`hsl(${hue} 45% 72%)`} />
      <path d={`M${w * 0.17} ${h * 0.83} L${w * 0.42} ${h * 0.5} L${w * 0.6} ${h * 0.68} L${w * 0.72} ${h * 0.56} L${w * 0.83} ${h * 0.83} Z`} fill={`hsl(${(hue + 140) % 360} 35% 45%)`} opacity={0.75} />
      <circle cx={w * 0.68} cy={h * 0.33} r={Math.min(w, h) * 0.07} fill="#fff6c9" />
    </Svg>
  );
}

const PETALS: Record<string, string> = { calla: "#fbfaf4", peony: "#f3a0b8", sunflower: "#f5c330", chamomile: "#fffdf3", succulent: "#9cc9a0", bonsai: "#6aa35f" };
function Flowers({ w, h, variant = "peony", id }: { w: number; h: number; variant?: string; id: string }) {
  const r = Math.min(w, h) / 2, cx = w / 2, cy = h / 2;
  const petal = PETALS[variant] ?? "#f3a0b8";
  const blooms = variant === "succulent" || variant === "bonsai" ? 0 : 5;
  return (
    <Svg w={w} h={h} pad={6}>
      <circle cx={cx + 2} cy={cy + 3} r={r * 0.75} fill="#2a1d12" opacity={0.22} filter="url(#es-blur)" />
      <circle cx={cx} cy={cy} r={r * 0.55} fill={variant === "bonsai" ? "#3f4d5a" : "#e9e3d8"} stroke="#c9bfae" strokeWidth={0.6} />
      {Array.from({ length: 7 }, (_, i) => (
        <ellipse key={i} cx={cx + Math.cos(i * 0.9 + rand(id)) * r * 0.45} cy={cy + Math.sin(i * 0.9 + rand(id)) * r * 0.45} rx={r * 0.32} ry={r * 0.16} fill={variant === "succulent" ? "#7fb68a" : "url(#es-leaf)"} transform={`rotate(${i * 51} ${cx + Math.cos(i * 0.9) * r * 0.45} ${cy + Math.sin(i * 0.9) * r * 0.45})`} />
      ))}
      {variant === "bonsai" ? <circle cx={cx} cy={cy - r * 0.15} r={r * 0.6} fill="url(#es-leaf-dark)" /> : null}
      {Array.from({ length: blooms }, (_, i) => {
        const bx = cx + Math.cos(i * 1.25 + 0.4) * r * 0.32, by = cy + Math.sin(i * 1.25 + 0.4) * r * 0.32;
        return (
          <g key={i}>
            <circle cx={bx} cy={by} r={r * 0.24} fill={petal} stroke="#000" strokeOpacity={0.08} />
            <circle cx={bx} cy={by} r={r * 0.09} fill={variant === "sunflower" ? "#6b4226" : "#f2c84b"} />
          </g>
        );
      })}
    </Svg>
  );
}

function Planter({ w, h, id }: { w: number; h: number; id: string }) {
  // A long low trough of mixed greenery, often a room divider: many small
  // overlapping leaf clusters, not a row of balls.
  const along = w >= h;
  const len = along ? w : h, dep = along ? h : w;
  const n = Math.max(4, Math.round(len / (dep * 0.42)));
  return (
    <Svg w={w} h={h}>
      <Shadow x={0} y={0} w={w} h={h} r={4} o={0.25} />
      <rect width={w} height={h} rx={4} fill="#3f3b36" />
      <rect x={2} y={2} width={w - 4} height={h - 4} rx={3} fill="#4a3424" />
      {Array.from({ length: n * 2 }, (_, i) => {
        const t = (i % n + 0.5 + (i >= n ? 0.5 : 0)) / (n + 0.5);
        const off = (i >= n ? 0.18 : -0.12) * dep + (rand(id, i) - 0.5) * dep * 0.2;
        const r = dep * (0.3 + rand(id, i + 50) * 0.12);
        const bx = along ? w * t : w / 2 + off, by = along ? h / 2 + off : h * t;
        return <circle key={i} cx={bx} cy={by} r={r} fill={i % 3 === 0 ? "url(#es-leaf-dark)" : "url(#es-leaf)"} />;
      })}
      {Array.from({ length: n }, (_, i) => {
        const t = (i + 0.3) / n;
        return <circle key={`h${i}`} cx={along ? w * t : w / 2 - dep * 0.12} cy={along ? h / 2 - dep * 0.12 : h * t} r={dep * 0.09} fill="#b8dd8f" opacity={0.5} />;
      })}
    </Svg>
  );
}

function PlantWall({ w, h, id }: { w: number; h: number; id: string }) {
  const cols = Math.max(3, Math.round(w / 14)), rows = Math.max(3, Math.round(h / 14));
  return (
    <Svg w={w} h={h} pad={6}>
      <rect width={w} height={h} rx={4} fill="#2f5a30" />
      {Array.from({ length: cols * rows }, (_, i) => {
        const x = ((i % cols) + 0.5) * (w / cols) + (rand(id, i) - 0.5) * 5;
        const y = (Math.floor(i / cols) + 0.5) * (h / rows) + (rand(id, i + 99) - 0.5) * 5;
        return <circle key={i} cx={x} cy={y} r={Math.min(w / cols, h / rows) * 0.75} fill={i % 3 ? "url(#es-leaf)" : "url(#es-leaf-dark)"} />;
      })}
    </Svg>
  );
}

function PlantShelf({ w, h, id }: { w: number; h: number; id: string }) {
  // A white wall unit of cubbies with small potted plants and ornaments (Customer Success's wall).
  const cubes = Math.max(2, Math.round(w / 26));
  const cw = (w - 4) / cubes;
  return (
    <Svg w={w} h={h} pad={6}>
      <Shadow x={0} y={0} w={w} h={h} r={2} o={0.22} />
      <rect width={w} height={h} rx={2} fill="#f3f1ec" stroke="#cfcac0" />
      {Array.from({ length: cubes }, (_, i) => {
        const x = 2 + i * cw, kind = Math.floor(rand(id, i) * 4);
        return (
          <g key={i}>
            <rect x={x + 1} y={2} width={cw - 2} height={h - 4} rx={1} fill="#e7e3da" />
            {kind < 2 ? (
              <g>
                <circle cx={x + cw / 2} cy={h / 2} r={Math.min(cw, h) * 0.22} fill="url(#es-pot)" />
                {[0, 72, 144, 216, 288].map((a) => <ellipse key={a} cx={x + cw / 2} cy={h / 2 - Math.min(cw, h) * 0.18} rx={Math.min(cw, h) * 0.08} ry={Math.min(cw, h) * 0.2} fill="url(#es-leaf)" transform={`rotate(${a} ${x + cw / 2} ${h / 2})`} />)}
              </g>
            ) : kind === 2 ? (
              <rect x={x + cw * 0.25} y={h * 0.3} width={cw * 0.5} height={h * 0.4} rx={2} fill={["#c9a36b", "#5d7c9a", "#b5774c"][i % 3]} />
            ) : (
              <circle cx={x + cw / 2} cy={h / 2} r={Math.min(cw, h) * 0.18} fill="#d8cfbf" stroke="#b9ae9a" />
            )}
          </g>
        );
      })}
    </Svg>
  );
}

function Tree({ w, h, variant, id }: { w: number; h: number; variant?: string; id: string }) {
  const r = Math.min(w, h) / 2, cx = w / 2, cy = h / 2;
  const fills = variant === "autumn" ? ["#e0812f", "#c95b25", "#f0a940"] : ["#8fa86a", "#6f8a50", "#a9bf86"];
  return (
    <Svg w={w} h={h} pad={10}>
      <circle cx={cx + 4} cy={cy + 7} r={r * 0.9} fill="#2a1d12" opacity={0.25} filter="url(#es-blur)" />
      <circle cx={cx} cy={cy} r={r * 0.35} fill="url(#es-pot)" />
      {Array.from({ length: 11 }, (_, i) => {
        const a = (i / 11) * Math.PI * 2 + rand(id) * 3;
        const d = r * (0.25 + rand(id, i) * 0.45);
        return <circle key={i} cx={cx + Math.cos(a) * d} cy={cy + Math.sin(a) * d} r={r * (0.3 + rand(id, i + 20) * 0.18)} fill={fills[i % 3]} opacity={0.95} />;
      })}
    </Svg>
  );
}

const PLANT_LOOK: Record<string, { leaf: string; shape: "spike" | "round" | "star" }> = {
  spider: { leaf: "#9bc96a", shape: "spike" },
  cactus: { leaf: "#5f9a5a", shape: "round" },
  aloe: { leaf: "#7fae86", shape: "spike" },
  fern: { leaf: "#5f9e4c", shape: "star" },
  tomato: { leaf: "#4f8a3f", shape: "star" },
};
function PlantVariant({ w, h, variant, id, tall }: { w: number; h: number; variant?: string; id: string; tall?: boolean }) {
  const look = variant ? PLANT_LOOK[variant] : undefined;
  if (!look) {
    // Centre a round plant in a non-square footprint.
    const m = Math.min(w, h);
    return <div style={{ position: "absolute", left: (w - m) / 2, top: (h - m) / 2, width: m, height: m }}><Plant w={m} id={id} tall={tall} /></div>;
  }
  const r = Math.min(w, h) / 2, cx = w / 2, cy = h / 2;
  return (
    <Svg w={w} h={h} pad={14}>
      <circle cx={cx + 3} cy={cy + 5} r={r * 0.8} fill="#2a1d12" opacity={0.24} filter="url(#es-blur)" />
      <circle cx={cx} cy={cy} r={r * 0.6} fill={variant === "cactus" ? "#d9d2c3" : "url(#es-pot)"} />
      {look.shape === "round"
        ? <>
            <circle cx={cx} cy={cy} r={r * 0.42} fill={look.leaf} />
            {Array.from({ length: 8 }, (_, i) => <line key={i} x1={cx} y1={cy} x2={cx + Math.cos(i * 0.785) * r * 0.42} y2={cy + Math.sin(i * 0.785) * r * 0.42} stroke="#2f6d33" strokeWidth={0.8} />)}
            <circle cx={cx + r * 0.2} cy={cy - r * 0.2} r={r * 0.08} fill="#f19bb9" />
          </>
        : Array.from({ length: look.shape === "spike" ? 14 : 10 }, (_, i) => {
            const a = (i / (look.shape === "spike" ? 14 : 10)) * 360 + rand(id) * 40;
            const len = r * (look.shape === "spike" ? 1.05 : 0.95) * (0.75 + rand(id, i) * 0.35);
            const wid = look.shape === "spike" ? len * 0.12 : len * 0.3;
            return (
              <g key={i} transform={`translate(${cx} ${cy}) rotate(${a})`}>
                <path d={`M0 0 Q${wid} ${-len * 0.5} 0 ${-len} Q${-wid} ${-len * 0.5} 0 0 Z`} fill={look.leaf} stroke="#2f6d33" strokeWidth={0.4} />
                {variant === "tomato" && i % 3 === 0 ? <circle cx={0} cy={-len * 0.6} r={r * 0.09} fill="#d8402f" /> : null}
              </g>
            );
          })}
    </Svg>
  );
}

function Trinket({ w, h, variant }: { w: number; h: number; variant?: string }) {
  const r = Math.min(w, h) / 2, cx = w / 2, cy = h / 2;
  let art: ReactNode;
  switch (variant) {
    case "globe":
      art = <><circle cx={cx} cy={cy} r={r * 0.8} fill="#4a8ac4" stroke="#8a6a3a" strokeWidth={1.5} /><path d={`M${cx - r * 0.4} ${cy - r * 0.3} q${r * 0.3} ${-r * 0.2} ${r * 0.5} ${r * 0.1} q${-r * 0.1} ${r * 0.4} ${-r * 0.4} ${r * 0.5} Z M${cx + r * 0.2} ${cy + r * 0.2} q${r * 0.3} 0 ${r * 0.3} ${r * 0.3} q${-r * 0.3} 0 ${-r * 0.3} ${-r * 0.3} Z`} fill="#7cc37a" /></>;
      break;
    case "phone":
      art = <><rect x={cx - r * 0.8} y={cy - r * 0.6} width={r * 1.6} height={r * 1.2} rx={r * 0.25} fill="#2f2f35" /><rect x={cx - r * 0.7} y={cy - r * 0.85} width={r * 1.4} height={r * 0.4} rx={r * 0.2} fill="#46464e" /><rect x={cx - r * 0.4} y={cy - r * 0.2} width={r * 0.8} height={r * 0.6} rx={1} fill="#9aa1aa" /></>;
      break;
    case "headphones":
      art = <><path d={`M${cx - r * 0.6} ${cy + r * 0.2} A${r * 0.6} ${r * 0.6} 0 0 1 ${cx + r * 0.6} ${cy + r * 0.2}`} fill="none" stroke="#2f2f35" strokeWidth={r * 0.18} /><ellipse cx={cx - r * 0.6} cy={cy + r * 0.3} rx={r * 0.25} ry={r * 0.35} fill="#e86f50" /><ellipse cx={cx + r * 0.6} cy={cy + r * 0.3} rx={r * 0.25} ry={r * 0.35} fill="#e86f50" /></>;
      break;
    case "pens":
      art = <><circle cx={cx} cy={cy} r={r * 0.55} fill="#3a3a3e" />{["#e86f50", "#4a8af4", "#2f9e6e", "#e9b949"].map((c, i) => <circle key={i} cx={cx + Math.cos(i * 1.6) * r * 0.25} cy={cy + Math.sin(i * 1.6) * r * 0.25} r={r * 0.15} fill={c} />)}</>;
      break;
    case "books":
      art = <>{["#5d7c9a", "#b5774c", "#7a9a6a"].map((c, i) => <rect key={i} x={cx - r * 0.75 + i * 1.5} y={cy - r * 0.55 + i * r * 0.32} width={r * 1.5} height={r * 0.36} rx={1} fill={c} transform={`rotate(${i * 6 - 6} ${cx} ${cy})`} />)}</>;
      break;
    case "sailboat":
      art = <><path d={`M${cx - r * 0.7} ${cy + r * 0.4} L${cx + r * 0.7} ${cy + r * 0.4} L${cx + r * 0.45} ${cy + r * 0.7} L${cx - r * 0.45} ${cy + r * 0.7} Z`} fill="#8a5a3b" /><path d={`M${cx} ${cy - r * 0.8} L${cx} ${cy + r * 0.3} L${cx + r * 0.6} ${cy + r * 0.3} Z`} fill="#fff" stroke="#bbb" strokeWidth={0.5} /><path d={`M${cx - 1} ${cy - r * 0.6} L${cx - 1} ${cy + r * 0.3} L${cx - r * 0.45} ${cy + r * 0.3} Z`} fill="#e86f50" /></>;
      break;
    case "tiger":
      art = <><ellipse cx={cx} cy={cy} rx={r * 0.8} ry={r * 0.45} fill="#e8892f" />{[-0.4, 0, 0.4].map((k) => <line key={k} x1={cx + k * r} y1={cy - r * 0.4} x2={cx + k * r + 2} y2={cy + r * 0.4} stroke="#2a1d12" strokeWidth={1.2} />)}<circle cx={cx + r * 0.75} cy={cy - r * 0.15} r={r * 0.3} fill="#e8892f" /></>;
      break;
    default:
      art = <circle cx={cx} cy={cy} r={r * 0.6} fill="#c9b79c" />;
  }
  return (
    <Svg w={w} h={h} pad={4}>
      <ellipse cx={cx + 1.5} cy={cy + 2.5} rx={r * 0.8} ry={r * 0.6} fill="#2a1d12" opacity={0.2} filter="url(#es-blur)" />
      {art}
    </Svg>
  );
}

function DeskLamp({ w, h }: { w: number; h: number }) {
  const r = Math.min(w, h) / 2, cx = w / 2, cy = h / 2;
  return (
    <Svg w={w} h={h} pad={10}>
      <circle cx={cx} cy={cy} r={r * 1.4} fill="#ffe8a8" opacity={0.25} filter="url(#es-blur)" />
      <circle cx={cx - r * 0.35} cy={cy + r * 0.35} r={r * 0.35} fill="#3a3a3e" />
      <line x1={cx - r * 0.35} y1={cy + r * 0.35} x2={cx + r * 0.2} y2={cy - r * 0.2} stroke="#3a3a3e" strokeWidth={r * 0.12} />
      <circle cx={cx + r * 0.25} cy={cy - r * 0.25} r={r * 0.45} fill="#e9b949" stroke="#b88a24" strokeWidth={0.6} />
    </Svg>
  );
}

function SideTable({ w, h }: { w: number; h: number }) {
  const r = Math.min(w, h) / 2;
  return (
    <Svg w={w} h={h}>
      <circle cx={w / 2 + 3} cy={h / 2 + 5} r={r} fill="#2a1d12" opacity={0.22} filter="url(#es-blur)" />
      <circle cx={w / 2} cy={h / 2} r={r} fill="url(#es-walnut)" />
      <circle cx={w / 2} cy={h / 2} r={r * 0.82} fill="none" stroke="#fff" strokeOpacity={0.1} />
    </Svg>
  );
}

function Console({ w, h }: { w: number; h: number }) {
  const n = Math.max(2, Math.round(w / 60));
  return (
    <Svg w={w} h={h}>
      <Shadow x={0} y={0} w={w} h={h} r={3} o={0.25} />
      <rect width={w} height={h} rx={3} fill="url(#es-oak)" stroke="#a37c52" strokeOpacity={0.5} />
      {Array.from({ length: n }, (_, i) => (
        <rect key={i} x={6 + i * ((w - 12) / n)} y={h * 0.25} width={(w - 12) / n - 4} height={h * 0.5} rx={2} fill="#000" opacity={0.06} />
      ))}
    </Svg>
  );
}

function Reception({ w, h }: { w: number; h: number }) {
  // A curved reception counter, opening down-right.
  return (
    <Svg w={w} h={h} pad={14}>
      <path d={`M0 0 L${w * 0.32} 0 L${w * 0.32} ${h * 0.55} Q${w * 0.32} ${h * 0.68} ${w * 0.5} ${h * 0.68} L${w} ${h * 0.68} L${w} ${h} L${w * 0.4} ${h} Q0 ${h} 0 ${h * 0.6} Z`} fill="#2a1d12" opacity={0.22} filter="url(#es-blur)" transform="translate(4 6)" />
      <path d={`M0 0 L${w * 0.32} 0 L${w * 0.32} ${h * 0.55} Q${w * 0.32} ${h * 0.68} ${w * 0.5} ${h * 0.68} L${w} ${h * 0.68} L${w} ${h} L${w * 0.4} ${h} Q0 ${h} 0 ${h * 0.6} Z`} fill="#f6f3ee" stroke="#c9bfae" />
      <path d={`M${w * 0.08} 0 L${w * 0.08} ${h * 0.6} Q${w * 0.08} ${h * 0.92} ${w * 0.4} ${h * 0.92} L${w} ${h * 0.92}`} fill="none" stroke="#c69d6b" strokeWidth={Math.min(w, h) * 0.05} />
    </Svg>
  );
}

function Microwave({ w, h }: { w: number; h: number }) {
  return (
    <Svg w={w} h={h} pad={6}>
      <Shadow x={0} y={0} w={w} h={h} r={3} o={0.25} />
      <rect width={w} height={h} rx={3} fill="#e4e7ea" stroke="#aab1b9" />
      <rect x={w * 0.08} y={h * 0.15} width={w * 0.6} height={h * 0.7} rx={2} fill="#2c3a52" />
      {[0.25, 0.45, 0.65].map((k) => <circle key={k} cx={w * 0.83} cy={h * k} r={Math.min(w, h) * 0.06} fill="#7c838b" />)}
    </Svg>
  );
}

function Stove({ w, h }: { w: number; h: number }) {
  // The cosy wood stove.
  const r = Math.min(w, h) / 2, cx = w / 2, cy = h / 2;
  return (
    <Svg w={w} h={h} pad={12}>
      <circle cx={cx} cy={cy} r={r * 1.5} fill="#ffb15c" opacity={0.22} filter="url(#es-blur)" />
      <rect x={cx - r * 0.75} y={cy - r * 0.7} width={r * 1.5} height={r * 1.5} rx={r * 0.2} fill="#2f2f35" />
      <rect x={cx - r * 0.5} y={cy - r * 0.2} width={r} height={r * 0.75} rx={r * 0.15} fill="#e8722f" />
      <path d={`M${cx - r * 0.3} ${cy + r * 0.5} Q${cx - r * 0.2} ${cy - r * 0.05} ${cx} ${cy + r * 0.1} Q${cx + r * 0.2} ${cy - r * 0.15} ${cx + r * 0.3} ${cy + r * 0.5} Z`} fill="#ffd36a" />
      <circle cx={cx} cy={cy - r * 0.95} r={r * 0.18} fill="#46464e" />
    </Svg>
  );
}

function Pet({ w, h, variant = "cat" }: { w: number; h: number; variant?: string }) {
  const s = Math.min(w / 30, h / 30), dog = variant === "dog";
  const fur = dog ? "#c58a4e" : "#5a5a62";
  return (
    <Svg w={w} h={h} pad={6}>
      <g transform={`translate(${w / 2} ${h / 2}) scale(${s})`}>
        <ellipse cx={2} cy={6} rx={12} ry={6} fill="#2a1d12" opacity={0.22} filter="url(#es-blur)" />
        {/* curled up asleep */}
        <ellipse cx={0} cy={2} rx={11} ry={8} fill={fur} />
        <circle cx={-7} cy={-3} r={5.5} fill={fur} />
        {dog
          ? <><ellipse cx={-11} cy={-3} rx={2.2} ry={4} fill="#8a5a33" /><ellipse cx={-3.5} cy={-6} rx={2.2} ry={4} fill="#8a5a33" transform="rotate(30 -3.5 -6)" /></>
          : <><path d="M-11 -6 L-10 -11 L-7 -7 Z" fill={fur} /><path d="M-5 -7 L-2 -10 L-2 -5 Z" fill={fur} /></>}
        <path d="M-9 -3 q1 1 2 0 M-6 -3 q1 1 2 0" stroke="#1f1a17" strokeWidth={0.7} fill="none" />
        <path d="M10 2 Q14 8 6 9" stroke={fur} strokeWidth={3} fill="none" strokeLinecap="round" />
      </g>
    </Svg>
  );
}

function CoatRack({ w, h }: { w: number; h: number }) {
  const r = Math.min(w, h) / 2, cx = w / 2, cy = h / 2;
  return (
    <Svg w={w} h={h} pad={8}>
      <circle cx={cx + 2} cy={cy + 4} r={r * 0.7} fill="#2a1d12" opacity={0.2} filter="url(#es-blur)" />
      {[0, 120, 240].map((a, i) => <ellipse key={a} cx={cx + Math.cos((a * Math.PI) / 180) * r * 0.42} cy={cy + Math.sin((a * Math.PI) / 180) * r * 0.42} rx={r * 0.38} ry={r * 0.22} fill={["#3f5a74", "#a8473b", "#d9c8a9"][i]} transform={`rotate(${a} ${cx + Math.cos((a * Math.PI) / 180) * r * 0.42} ${cy + Math.sin((a * Math.PI) / 180) * r * 0.42})`} />)}
      <circle cx={cx} cy={cy} r={r * 0.16} fill="#6b4a33" />
    </Svg>
  );
}

function Aquarium({ w, h, id }: { w: number; h: number; id: string }) {
  return (
    <Svg w={w} h={h}>
      <Shadow x={0} y={0} w={w} h={h} r={4} o={0.28} />
      <rect width={w} height={h} rx={4} fill="#2f3b47" />
      <rect x={4} y={4} width={w - 8} height={h - 8} rx={2} fill="#4fb0d8" opacity={0.85} />
      <rect x={4} y={h - 14} width={w - 8} height={10} fill="#e3cf9b" />
      {Array.from({ length: 4 }, (_, i) => (
        <path key={i} d={`M${10 + rand(id, i) * (w - 30)} ${10 + rand(id, i + 5) * (h - 30)} l8 -4 l0 8 Z m8 0 l5 -3 l0 6 Z`} fill={["#f2a03d", "#f6d04d", "#e86f50", "#fff"][i]} />
      ))}
      <path d={`M${w * 0.2} ${h - 8} q-3 -14 2 -24 M${w * 0.75} ${h - 8} q4 -10 -1 -20`} stroke="#3f8a4a" strokeWidth={2} fill="none" />
    </Svg>
  );
}

function Bicycle({ w, h }: { w: number; h: number }) {
  // Side view: two spoked wheels, a blue diamond frame, saddle and bars.
  const L = Math.max(w, h), H = L * 0.5, cx = w / 2, cy = h / 2;
  const r = L * 0.2, back = { x: -L * 0.28, y: H * 0.18 }, front = { x: L * 0.28, y: H * 0.18 };
  const crank = { x: -L * 0.02, y: H * 0.18 }, seat = { x: -L * 0.1, y: -H * 0.38 }, head = { x: L * 0.17, y: -H * 0.36 };
  const wheel = (p: { x: number; y: number }) => (
    <g>
      <circle cx={p.x} cy={p.y} r={r} fill="none" stroke="#26262b" strokeWidth={Math.max(2, r * 0.18)} />
      {[0, 45, 90, 135].map((a) => (
        <line key={a} x1={p.x - Math.cos((a * Math.PI) / 180) * r} y1={p.y - Math.sin((a * Math.PI) / 180) * r}
          x2={p.x + Math.cos((a * Math.PI) / 180) * r} y2={p.y + Math.sin((a * Math.PI) / 180) * r} stroke="#9aa1aa" strokeWidth={0.6} />
      ))}
      <circle cx={p.x} cy={p.y} r={r * 0.12} fill="#5c5c66" />
    </g>
  );
  const frame = "#3f6fb5";
  return (
    <Svg w={w} h={h}>
      <g transform={`translate(${cx} ${cy}) ${h > w ? "rotate(90)" : ""}`}>
        <ellipse cx={0} cy={H * 0.18 + r} rx={L * 0.48} ry={4} fill="#2a1d12" opacity={0.2} filter="url(#es-blur)" />
        {wheel(back)}
        {wheel(front)}
        <path d={`M${back.x} ${back.y} L${crank.x} ${crank.y} L${head.x} ${head.y + H * 0.08} L${seat.x} ${seat.y + H * 0.08} Z M${crank.x} ${crank.y} L${seat.x} ${seat.y + H * 0.08} M${head.x} ${head.y} L${front.x} ${front.y}`}
          fill="none" stroke={frame} strokeWidth={Math.max(2.5, L * 0.035)} strokeLinejoin="round" strokeLinecap="round" />
        <rect x={seat.x - L * 0.06} y={seat.y - 2} width={L * 0.12} height={Math.max(3, L * 0.03)} rx={2} fill="#2b2b30" />
        <path d={`M${head.x} ${head.y} l${L * 0.05} ${-H * 0.06} l${L * 0.05} 0`} stroke="#2b2b30" strokeWidth={Math.max(2, L * 0.025)} fill="none" strokeLinecap="round" />
        <circle cx={crank.x} cy={crank.y} r={Math.max(2, L * 0.03)} fill="#5c5c66" />
      </g>
    </Svg>
  );
}

const BOARDS: Record<string, string> = { "01": "#4fb0d8", "02": "#f2a03d", "04": "#e86f50" };
function Surfboard({ w, h, variant = "01" }: { w: number; h: number; variant?: string }) {
  const c = BOARDS[variant] ?? "#4fb0d8";
  return (
    <Svg w={w} h={h}>
      <ellipse cx={w / 2 + 3} cy={h / 2 + 4} rx={w / 2} ry={h / 2} fill="#2a1d12" opacity={0.2} filter="url(#es-blur)" />
      <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} fill="#fffaf0" stroke="#d9cfbd" />
      {w >= h
        ? <rect x={w * 0.1} y={h * 0.38} width={w * 0.8} height={h * 0.24} fill={c} rx={h * 0.1} />
        : <rect x={w * 0.38} y={h * 0.1} width={w * 0.24} height={h * 0.8} fill={c} rx={w * 0.1} />}
    </Svg>
  );
}

function Statue({ w, h }: { w: number; h: number }) {
  const r = Math.min(w, h) / 2, cx = w / 2, cy = h / 2;
  return (
    <Svg w={w} h={h} pad={8}>
      <rect x={cx - r * 0.8 + 3} y={cy - r * 0.8 + 5} width={r * 1.6} height={r * 1.6} rx={3} fill="#2a1d12" opacity={0.22} filter="url(#es-blur)" />
      <rect x={cx - r * 0.8} y={cy - r * 0.8} width={r * 1.6} height={r * 1.6} rx={3} fill="#d6d1c8" stroke="#aaa39a" />
      <ellipse cx={cx} cy={cy + r * 0.05} rx={r * 0.55} ry={r * 0.35} fill="#c9a64a" />
      <circle cx={cx - r * 0.35} cy={cy - r * 0.15} r={r * 0.3} fill="#b88a24" />
      <circle cx={cx - r * 0.35} cy={cy - r * 0.15} r={r * 0.18} fill="#c9a64a" />
    </Svg>
  );
}

function Banjo({ w, h }: { w: number; h: number }) {
  // Lying flat: a round drum head with a tension ring, a long fretted neck and a peghead.
  const along = w >= h, L = along ? w : h, T = along ? h : w;
  const r = Math.min(T * 0.48, L * 0.3);
  const neckW = Math.max(3, r * 0.28);
  return (
    <Svg w={w} h={h} pad={6}>
      <g transform={along ? "" : `translate(${w} 0) rotate(90)`}>
        <ellipse cx={r + 2} cy={T / 2 + 3} rx={r} ry={r * 0.9} fill="#2a1d12" opacity={0.2} filter="url(#es-blur)" />
        <rect x={r * 1.6} y={T / 2 - neckW / 2} width={L - r * 2.1} height={neckW} rx={1} fill="#6b4a33" />
        {Array.from({ length: 6 }, (_, i) => <line key={i} x1={r * 1.9 + i * ((L - r * 2.6) / 6)} y1={T / 2 - neckW / 2} x2={r * 1.9 + i * ((L - r * 2.6) / 6)} y2={T / 2 + neckW / 2} stroke="#d8c39a" strokeWidth={0.6} />)}
        <rect x={L - r * 0.6} y={T / 2 - neckW} width={r * 0.55} height={neckW * 2} rx={2} fill="#4c3323" />
        {[-1, 1].map((k) => <circle key={k} cx={L - r * 0.35} cy={T / 2 + k * neckW * 1.2} r={1.4} fill="#c9b79c" />)}
        <circle cx={r} cy={T / 2} r={r} fill="#8a6a42" />
        <circle cx={r} cy={T / 2} r={r * 0.86} fill="#f3ead8" stroke="#b9a37c" strokeWidth={1} />
        {Array.from({ length: 12 }, (_, i) => { const a = (i / 12) * Math.PI * 2; return <circle key={i} cx={r + Math.cos(a) * r * 0.93} cy={T / 2 + Math.sin(a) * r * 0.93} r={0.9} fill="#d9d2c4" />; })}
        {[-1.5, -0.5, 0.5, 1.5].map((k) => <line key={k} x1={r * 0.6} y1={T / 2 + k * neckW * 0.18} x2={L - r * 0.5} y2={T / 2 + k * neckW * 0.18} stroke="#9aa1aa" strokeWidth={0.4} />)}
        <rect x={r * 0.75} y={T / 2 - neckW * 0.5} width={r * 0.12} height={neckW} fill="#6b4a33" />
      </g>
    </Svg>
  );
}

function Elevator({ w, h }: { w: number; h: number }) {
  return (
    <Svg w={w} h={h}>
      <Shadow x={0} y={0} w={w} h={h} r={3} o={0.25} />
      <rect width={w} height={h} rx={3} fill="url(#es-steel)" stroke="#8d949b" />
      <rect x={w * 0.12} y={h * 0.12} width={w * 0.37} height={h * 0.76} fill="#cfd5db" stroke="#9aa1aa" />
      <rect x={w * 0.51} y={h * 0.12} width={w * 0.37} height={h * 0.76} fill="#cfd5db" stroke="#9aa1aa" />
      <path d={`M${w / 2 - 5} ${h * 0.06} l5 -4 l5 4 Z`} fill="#2f9e6e" />
    </Svg>
  );
}

function Basket({ w, h }: { w: number; h: number }) {
  const r = Math.min(w, h) / 2;
  return (
    <Svg w={w} h={h} pad={4}>
      <circle cx={w / 2 + 2} cy={h / 2 + 3} r={r} fill="#2a1d12" opacity={0.2} filter="url(#es-blur)" />
      <circle cx={w / 2} cy={h / 2} r={r} fill="#2f2f35" />
      <circle cx={w / 2} cy={h / 2} r={r * 0.78} fill="#46464e" />
      <path d={`M${w / 2 - r * 0.3} ${h / 2} l${r * 0.25} ${-r * 0.2} l${r * 0.2} ${r * 0.25} Z`} fill="#fffdf4" />
    </Svg>
  );
}

const RUG_STYLES = new Set(["border", "terrazzo", "kilim", "medallion", "dots", "cowhide", "confetti", "triangles", "leaves"]);
/** Patterned rugs: richer colours and real patterns, round or rectangular. */
function FurnitureRug({ w, h, color, variant, id }: { w: number; h: number; color: string; variant: string; id: string }) {
  const dark = shade(color, 0.62), light = shade(color, 1.22);
  const cx = w / 2, cy = h / 2;
  if (variant === "leaves") {
    const rx = w / 2, ry = h / 2;
    return (
      <Svg w={w} h={h} pad={4}>
        <defs><clipPath id={`rc-${id}`}><ellipse cx={cx} cy={cy} rx={rx} ry={ry} /></clipPath></defs>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={color} />
        <g clipPath={`url(#rc-${id})`}>
          {Array.from({ length: 16 }, (_, i) => {
            const x = cx + (rand(id, i) - 0.5) * w, y = cy + (rand(id, i + 30) - 0.5) * h, len = Math.min(rx, ry) * (0.35 + rand(id, i + 60) * 0.3);
            const rot = rand(id, i + 90) * 360;
            return (
              <g key={i} transform={`rotate(${rot} ${x} ${y})`}>
                <path d={`M${x} ${y} C${x + len * 0.35} ${y - len * 0.25} ${x + len * 0.35} ${y - len * 0.85} ${x} ${y - len} C${x - len * 0.35} ${y - len * 0.85} ${x - len * 0.35} ${y - len * 0.25} ${x} ${y} Z`} fill={["#1f4d43", "#2f6b5b", "#3f8070"][i % 3]} opacity={0.85} />
                <line x1={x} y1={y} x2={x} y2={y - len * 0.95} stroke="#eef3ef" strokeOpacity={0.4} strokeWidth={0.8} />
              </g>
            );
          })}
        </g>
        <ellipse cx={cx} cy={cy} rx={rx - 1} ry={ry - 1} fill="none" stroke="#000" strokeOpacity={0.1} />
      </Svg>
    );
  }
  if (variant === "confetti" || variant === "triangles") {
    const rx = w / 2, ry = h / 2;
    const palette = variant === "confetti" ? ["#e5483b", "#f2b13a", "#3f8fd2", "#2fa36b", "#c3529a", "#f07a2b", "#5b4fb8", "#e9e1d3"] : ["#2f8a85", "#2f4a6e", "#e3b23c", "#9ad0c9", "#2f4a6e"];
    const n = variant === "confetti" ? 260 : 26;
    return (
      <Svg w={w} h={h} pad={4}>
        <defs><clipPath id={`rc-${id}`}><ellipse cx={cx} cy={cy} rx={rx} ry={ry} /></clipPath></defs>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={color} />
        <g clipPath={`url(#rc-${id})`}>
          {variant === "confetti"
            ? Array.from({ length: n }, (_, i) => {
                const a = rand(id, i) * Math.PI * 2, d = Math.sqrt(rand(id, i + 900)) * 0.98;
                return <circle key={i} cx={cx + Math.cos(a) * rx * d} cy={cy + Math.sin(a) * ry * d} r={Math.min(rx, ry) * 0.045} fill={palette[i % palette.length]} />;
              })
            : Array.from({ length: n }, (_, i) => {
                const x = cx + (rand(id, i) - 0.5) * w * 1.1, y = cy + (rand(id, i + 40) - 0.5) * h * 1.1, sz = Math.min(rx, ry) * (0.25 + rand(id, i + 80) * 0.3);
                const rot = rand(id, i + 120) * 360;
                return <path key={i} d={`M${x} ${y - sz} L${x + sz * 0.9} ${y + sz * 0.6} L${x - sz * 0.9} ${y + sz * 0.6} Z`} fill={palette[i % palette.length]} opacity={0.85} transform={`rotate(${rot} ${x} ${y})`} />;
              })}
        </g>
        <ellipse cx={cx} cy={cy} rx={rx - 1} ry={ry - 1} fill="none" stroke="#000" strokeOpacity={0.12} />
      </Svg>
    );
  }
  if (variant === "medallion" || variant === "dots") {
    const rx = w / 2, ry = h / 2;
    return (
      <Svg w={w} h={h} pad={4}>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={color} />
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="url(#es-weave)" />
        <ellipse cx={cx} cy={cy} rx={rx - 4} ry={ry - 4} fill="none" stroke={variant === "dots" ? "#c8b89c" : light} strokeWidth={2} strokeDasharray="1 3" />
        {variant === "medallion" ? (
          <>
            <ellipse cx={cx} cy={cy} rx={rx * 0.72} ry={ry * 0.72} fill="none" stroke={dark} strokeWidth={Math.max(2, rx * 0.06)} />
            <ellipse cx={cx} cy={cy} rx={rx * 0.42} ry={ry * 0.42} fill={dark} opacity={0.55} />
            {Array.from({ length: 12 }, (_, i) => {
              const a = (i / 12) * Math.PI * 2;
              return <ellipse key={i} cx={cx + Math.cos(a) * rx * 0.58} cy={cy + Math.sin(a) * ry * 0.58} rx={rx * 0.07} ry={ry * 0.07} fill={light} opacity={0.8} />;
            })}
            <ellipse cx={cx} cy={cy} rx={rx * 0.16} ry={ry * 0.16} fill={light} />
          </>
        ) : (
          Array.from({ length: 40 }, (_, i) => {
            const a = rand(id, i) * Math.PI * 2, d = Math.sqrt(rand(id, i + 50)) * 0.82;
            const dot = ["#e86f50", "#4a8af4", "#2f9e6e", "#e9b949", "#c3529a", "#57b6c9"][i % 6];
            return <circle key={i} cx={cx + Math.cos(a) * rx * d} cy={cy + Math.sin(a) * ry * d} r={Math.min(rx, ry) * 0.07} fill={dot} opacity={0.85} />;
          })
        )}
      </Svg>
    );
  }
  if (variant === "cowhide") {
    return (
      <Svg w={w} h={h} pad={4}>
        <path d={`M${w * 0.12} ${h * 0.05} Q${cx} ${-h * 0.02} ${w * 0.88} ${h * 0.05} Q${w * 1.02} ${cy} ${w * 0.88} ${h * 0.95} Q${cx} ${h * 1.03} ${w * 0.12} ${h * 0.95} Q${-w * 0.02} ${cy} ${w * 0.12} ${h * 0.05} Z`} fill={color} stroke="#d9cfc0" />
        {Array.from({ length: 7 }, (_, i) => (
          <ellipse key={i} cx={w * (0.2 + rand(id, i) * 0.6)} cy={h * (0.15 + rand(id, i + 9) * 0.7)} rx={w * (0.06 + rand(id, i + 3) * 0.1)} ry={h * (0.04 + rand(id, i + 4) * 0.07)} fill="#4a3a2e" opacity={0.85} transform={`rotate(${rand(id, i + 7) * 90 - 45} ${w * 0.5} ${h * 0.5})`} />
        ))}
      </Svg>
    );
  }
  const band = Math.max(6, Math.min(w, h) * 0.09);
  return (
    <Svg w={w} h={h} pad={4}>
      <rect width={w} height={h} rx={3} fill={variant === "border" ? dark : color} />
      <rect x={band} y={band} width={w - band * 2} height={h - band * 2} rx={2} fill={color} />
      {variant === "terrazzo"
        ? Array.from({ length: Math.round((w * h) / 260) }, (_, i) => (
            <circle key={i} cx={band + rand(id, i) * (w - band * 2)} cy={band + rand(id, i + 999) * (h - band * 2)} r={0.8 + rand(id, i + 3) * 1.6} fill={["#9aa1a8", "#c9b79c", "#7f8a93", "#d8cfc0"][i % 4]} />
          ))
        : null}
      {variant === "kilim"
        ? Array.from({ length: Math.max(2, Math.floor((w - band * 2) / 34)) }, (_, i) => {
            const n = Math.max(2, Math.floor((w - band * 2) / 34));
            const step = (w - band * 2) / n, x = band + step * (i + 0.5);
            return (
              <g key={i}>
                <path d={`M${x} ${band + 6} l${step * 0.32} ${(h - band * 2) / 2 - 6} l${-step * 0.32} ${(h - band * 2) / 2 - 6} l${-step * 0.32} ${-((h - band * 2) / 2 - 6)} Z`} fill="none" stroke={light} strokeWidth={2} opacity={0.75} />
                <path d={`M${x} ${cy - 6} l6 6 l-6 6 l-6 -6 Z`} fill={dark} opacity={0.8} />
              </g>
            );
          })
        : null}
      <rect width={w} height={h} rx={3} fill="url(#es-weave)" />
      {variant === "border" ? <rect x={band + 4} y={band + 4} width={w - band * 2 - 8} height={h - band * 2 - 8} rx={2} fill="none" stroke={light} strokeOpacity={0.35} /> : null}
      {variant !== "terrazzo" ? <rect x={band - 3} y={band - 3} width={w - band * 2 + 6} height={h - band * 2 + 6} rx={2} fill="none" stroke={variant === "kilim" ? light : "#000"} strokeOpacity={0.18} strokeDasharray={variant === "kilim" ? "4 3" : undefined} /> : null}
    </Svg>
  );
}

/** Art for the imported piece types; null if `o` isn't one of them. */
export function furnitureArt(o: Obj): ReactNode | null {
  const { w, h, id } = o;
  switch (o.type) {
    case "rug": return o.variant && RUG_STYLES.has(o.variant) ? <FurnitureRug w={w} h={h} color={o.color ?? "#c9b79c"} variant={o.variant} id={id} /> : null;
    case "chair": return <Chair w={w} h={h} color={o.color} variant={o.variant} r={o.r} />;
    case "ottoman": return <Ottoman w={w} h={h} color={o.color} variant={o.variant} />;
    case "desk": return <DeskTable w={w} h={h} variant={o.variant} id={id} />;
    case "laptop": return <Laptop w={w} h={h} r={o.r} />;
    case "monitor": return <Monitor w={w} h={h} r={o.r} variant={o.variant} />;
    case "keyboard": return <Keyboard w={w} h={h} r={o.r} />;
    case "chess": return <Chess w={w} h={h} />;
    case "mannequin": return <Mannequin w={w} h={h} />;
    case "cabinet": return <Cabinet w={w} h={h} id={id} />;
    case "cup": return <Cup w={w} h={h} variant={o.variant} id={id} />;
    case "food": return <Food w={w} h={h} variant={o.variant} />;
    case "tray": return <Tray w={w} h={h} variant={o.variant} />;
    case "frame": return <Frame w={w} h={h} id={id} />;
    case "flowers": return <Flowers w={w} h={h} variant={o.variant} id={id} />;
    case "planter": return <Planter w={w} h={h} id={id} />;
    case "plantWall": return o.variant === "shelf" ? <PlantShelf w={w} h={h} id={id} /> : <PlantWall w={w} h={h} id={id} />;
    case "tree": return <Tree w={w} h={h} variant={o.variant} id={id} />;
    case "trinket": return <Trinket w={w} h={h} variant={o.variant} />;
    case "deskLamp": return <DeskLamp w={w} h={h} />;
    case "sideTable": return <SideTable w={w} h={h} />;
    case "console": return <Console w={w} h={h} />;
    case "reception": return <Reception w={w} h={h} />;
    case "microwave": return <Microwave w={w} h={h} />;
    case "stove": return <Stove w={w} h={h} />;
    case "pet": return <Pet w={w} h={h} variant={o.variant} />;
    case "coatRack": return <CoatRack w={w} h={h} />;
    case "aquarium": return <Aquarium w={w} h={h} id={id} />;
    case "bicycle": return <Bicycle w={w} h={h} />;
    case "surfboard": return <Surfboard w={w} h={h} variant={o.variant} />;
    case "statue": return <Statue w={w} h={h} />;
    case "banjo": return <Banjo w={w} h={h} />;
    case "elevator": return <Elevator w={w} h={h} />;
    case "basket": return <Basket w={w} h={h} />;
    case "plant": case "plantTall": return o.variant || o.w !== o.h ? <PlantVariant w={w} h={h} variant={o.variant} id={id} tall={o.type === "plantTall"} /> : null;
    default: return null;
  }
}
