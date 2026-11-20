// Small office sounds, made in the browser (no audio files): a door shutting or opening near
// you, and someone walking into or out of the room you're in (pilot feedback).
// Knocks and nudges keep their chime. Each person can turn the door/arrival sounds off in Help;
// it's remembered in this browser only. They stay quiet while you're in a meeting window.

let ctx: AudioContext | null = null;
/** What this tab played, newest last (the e2e suite reads it; audio itself can't be checked). */
export const soundLog: string[] = [];
const log = (what: string) => { soundLog.push(what); if (soundLog.length > 50) soundLog.shift(); };
const KEY = "es.sounds";

export function soundsOn(): boolean {
  try { return localStorage.getItem(KEY) !== "0"; } catch { return true; }
}
export function setSoundsOn(on: boolean) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private window: on for this visit */ }
}

const ARRIVALS = "es.arrivals";
/** The quiet "Ana is in" notes (no sound). On unless turned off in Help; this browser only. */
export function arrivalsOn(): boolean {
  try { return localStorage.getItem(ARRIVALS) !== "0"; } catch { return true; }
}
export function setArrivalsOn(on: boolean) {
  try { localStorage.setItem(ARRIVALS, on ? "1" : "0"); } catch { /* private window: on for this visit */ }
}

/** True while you're in a GHL/Meet window: the office goes quiet then, so these do too. */
let quiet = () => false;
export function quietWhile(fn: () => boolean) { quiet = fn; }

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    // Browsers start the context suspended until the page has had a click; the office has had one.
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(a: AudioContext, at: number, from: number, to: number, len: number, peak: number, type: OscillatorType = "triangle") {
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, at);
  o.frequency.exponentialRampToValueAtTime(to, at + len);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  o.connect(g).connect(a.destination);
  o.start(at);
  o.stop(at + len + 0.02);
}

function noise(a: AudioContext, at: number, len: number, peak: number, filter: BiquadFilterType, freq: number) {
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * len), a.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length) ** 2;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  const g = a.createGain();
  g.gain.value = peak;
  src.connect(f).connect(g).connect(a.destination);
  src.start(at);
}

/** A soft two-note chime for knocks and nudges (always on: someone wants you). */
export function ding() {
  log("ding");
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  tone(a, t, 660, 660, 0.38, 0.12, "sine");
  tone(a, t + 0.12, 880, 880, 0.38, 0.12, "sine");
}

/** A door near you: a low thud when it shuts, a lighter latch click when it opens. */
export function doorSound(closed: boolean) {
  if (!soundsOn() || quiet()) return;
  log(closed ? "door:closed" : "door:open");
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  if (closed) {
    noise(a, t, 0.14, 0.5, "lowpass", 380);
    tone(a, t, 110, 60, 0.18, 0.22, "sine");
  } else {
    noise(a, t, 0.05, 0.25, "bandpass", 1900);
    tone(a, t + 0.03, 300, 420, 0.09, 0.05, "sine");
  }
}

// A crowd walking in at once makes one sound, not ten.
let lastStep = 0;
function step(up: boolean) {
  if (!soundsOn() || quiet()) return;
  const now = performance.now();
  if (now - lastStep < 1200) return;
  lastStep = now;
  log(up ? "arrive" : "leave");
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const [lo, hi] = [523, 784]; // C5 and G5, quiet
  tone(a, t, up ? lo : hi, up ? lo : hi, 0.16, 0.05);
  tone(a, t + 0.09, up ? hi : lo, up ? hi : lo, 0.2, 0.05);
}
/** Someone came into the room you're in. */
export const arriveSound = () => step(true);
/** Someone left the room you're in. */
export const leaveSound = () => step(false);

/** The win bell (#wins): one soft, high bell. Kept quiet on purpose (Alex: "not too loud"). */
export function winBell() {
  if (!soundsOn() || quiet()) return;
  log("win");
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  tone(a, t, 1568, 1568, 1.2, 0.035, "sine"); // G6
  tone(a, t, 3136, 3136, 0.6, 0.008, "sine"); // its shimmer
  tone(a, t + 0.18, 2093, 2093, 1.4, 0.025, "sine"); // C7
}

/** A high-five: a light clap. */
export function highFiveSound() {
  if (!soundsOn() || quiet()) return;
  log("highfive");
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  noise(a, t, 0.09, 0.35, "bandpass", 2400);
  tone(a, t + 0.02, 880, 1320, 0.12, 0.03, "triangle");
}

/** An unlock: a short, bright rising arpeggio (still soft). */
export function unlockSound() {
  if (!soundsOn() || quiet()) return;
  log("unlock");
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  [523, 659, 784, 1047].forEach((f, i) => tone(a, t + i * 0.09, f, f, 0.35, 0.05, "triangle"));
  tone(a, t + 0.36, 1568, 1568, 0.7, 0.025, "sine");
}
