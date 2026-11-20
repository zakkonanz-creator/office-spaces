// The screen part of an epic emote (shared/emotes.ts `fx`): plays once, over the whole office view,
// for the person doing it and anyone near them (someone you can hear, or in your room) whose
// avatar is on screen. Plain DOM, removed when it ends. Reduced motion: no shake, no flashing.

import type { ScreenFx } from "../../../shared/emotes";
import { avatarEl } from "./World";

const LAST = new Map<string, number>(); // person → when their last fx played: no strobe from spamming
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const DURATION: Record<ScreenFx, number> = { shake: 1600, flash: 1800, wind: 2600, fireworks: 4200, nova: 3000, spotlight: 4500, launch: 3000, matrix: 3600, rainbow: 3400, vortex: 3600 };

export function playScreenFx(fx: ScreenFx, personId: string) {
  const now = Date.now();
  if (now - (LAST.get(personId) ?? 0) < 4000) return;
  const el = avatarEl(personId);
  const r = el?.getBoundingClientRect();
  if (!r || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return; // off screen
  LAST.set(personId, now);
  // The avatar's head, where the effect centres (the avatar element itself is a point at their feet).
  const head = el!.querySelector(".bubble")?.getBoundingClientRect();
  const cx = head ? head.left + head.width / 2 : r.left, cy = head ? head.top + head.height / 2 : r.top - 80;
  const calm = reduced();

  const layer = document.createElement("div");
  layer.className = `screen-fx fx-${fx}${calm ? " calm" : ""}`;
  layer.setAttribute("aria-hidden", "true");
  layer.style.setProperty("--fx-x", `${cx}px`);
  layer.style.setProperty("--fx-y", `${cy}px`);

  if (fx === "shake") {
    layer.innerHTML = `<i class="ring"></i><i class="ring r2"></i><i class="ring r3"></i>`;
    layer.style.setProperty("--fx-y", `${r.top}px`); // the ground under them
    if (!calm) shake(document.querySelector(".world") as HTMLElement | null, 600);
  } else if (fx === "flash") {
    layer.innerHTML = `<svg class="bolt" viewBox="0 0 60 200" preserveAspectRatio="none"><path d="M38 0 L14 92 L32 92 L8 200 L52 74 L32 74 L50 0 Z"/></svg><i class="glow"></i>`;
    if (!calm) shake(document.querySelector(".world") as HTMLElement | null, 350);
  } else if (fx === "wind") {
    layer.innerHTML = Array.from({ length: 14 }, (_, i) => `<i class="streak" style="top:${(i * 7.3 + 3) % 100}%;animation-delay:${(i % 7) * 0.17}s;width:${90 + (i * 37) % 160}px"></i>`).join("");
  } else if (fx === "fireworks") {
    const colors = ["#ffd23f", "#ff5d73", "#3fd0ff", "#7cff6b", "#c58bff", "#ff9f3f"];
    layer.innerHTML = Array.from({ length: 7 }, (_, i) => {
      const x = 8 + ((i * 41) % 84), y = 12 + ((i * 29) % 46);
      const sparks = Array.from({ length: 12 }, (_, k) => `<b style="--a:${k * 30}deg"></b>`).join("");
      return `<i class="burst" style="left:${x}%;top:${y}%;--c:${colors[i % colors.length]};--d:${i * 0.45}s">${sparks}</i>`;
    }).join("");
  } else if (fx === "nova") {
    layer.innerHTML = `<i class="rays"></i><i class="core"></i>`;
  } else if (fx === "spotlight") {
    layer.innerHTML = `<i class="dim"></i>` + Array.from({ length: 28 }, (_, i) => `<b class="coin" style="left:${(i * 37) % 100}%;animation-delay:${(i % 9) * 0.28}s;--spin:${i % 2 ? 1 : -1}"></b>`).join("");
  } else if (fx === "launch") {
    layer.style.setProperty("--fx-y", `${r.top}px`); // the launch pad under them
    layer.innerHTML = Array.from({ length: 9 }, (_, i) => `<i class="puff" style="--d:${(i % 5) * 0.12}s;--dx:${(i - 4) * 34}px"></i>`).join("")
      + Array.from({ length: 12 }, (_, i) => `<i class="up" style="left:${(i * 8.3 + 4) % 100}%;--d:${0.5 + (i % 4) * 0.12}s"></i>`).join("");
    if (!calm) shake(document.querySelector(".world") as HTMLElement | null, 500);
  } else if (fx === "matrix") {
    const glyphs = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ0123456789ACME";
    layer.innerHTML = Array.from({ length: 26 }, (_, i) => {
      const text = Array.from({ length: 18 + (i * 7) % 14 }, (_, k) => glyphs[(i * 13 + k * 7) % glyphs.length]).join("");
      return `<i class="col" style="left:${(i * 3.85 + 1) % 100}%;--d:${((i * 5) % 9) * 0.12}s">${text}</i>`;
    }).join("");
  } else if (fx === "rainbow") {
    layer.innerHTML = `<i class="arc"></i>` + Array.from({ length: 16 }, (_, i) => `<b class="spark" style="left:${(i * 23 + 5) % 100}%;top:${(i * 37 + 8) % 80}%;--d:${(i % 6) * 0.25}s"></b>`).join("");
  } else if (fx === "vortex") {
    const bits = ["📄", "🍂", "📎", "🧾", "🍃", "☕"];
    layer.innerHTML = `<i class="swirl"></i>` + Array.from({ length: 14 }, (_, i) => `<i class="bit" style="--a:${i * 51}deg;--r:${380 + (i % 4) * 120}px;--d:${(i % 7) * 0.18}s">${bits[i % bits.length]}</i>`).join("");
    if (!calm) shake(document.querySelector(".world") as HTMLElement | null, 900);
  }

  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), DURATION[fx]);
}

function shake(el: HTMLElement | null, ms: number) {
  if (!el || typeof el.animate !== "function") return;
  el.animate(
    [{ translate: "0 0" }, { translate: "-7px 4px" }, { translate: "6px -5px" }, { translate: "-4px -3px" }, { translate: "3px 4px" }, { translate: "0 0" }],
    { duration: ms, easing: "ease-out", composite: "add" },
  );
}
