// Auto-away. A browser tab can't see that you're busy in Slack, so mouse
// activity on *this* page is the wrong signal. Chrome/Edge's IdleDetector sees
// whole-computer idleness (and a locked screen); it needs one permission click.
// Without it, nobody is ever auto-marked away — better than marking everyone
// away all day while they work in other windows.

import { useEffect } from "react";
import { state } from "./store";
import { sock } from "./net";

declare global {
  interface Window {
    IdleDetector?: any;
  }
}

const IDLE_MS = 10 * 60e3;
let detector: any = null;

export function idleDetectionState(): "on" | "off" | "unsupported" {
  if (!window.IdleDetector) return "unsupported";
  return detector ? "on" : "off";
}

export async function enableIdleDetection(): Promise<"on" | "off" | "unsupported"> {
  if (!window.IdleDetector) return "unsupported";
  try {
    const perm = await window.IdleDetector.requestPermission();
    if (perm !== "granted") return "off";
    await start();
    try { localStorage.setItem("es.idle", "1"); } catch { /* */ }
    return "on";
  } catch {
    return "off";
  }
}

async function start() {
  if (detector) return;
  detector = new window.IdleDetector();
  detector.addEventListener("change", () => {
    const idle = detector.userState === "idle" || detector.screenState === "locked";
    const me = state.me;
    if (!me) return;
    if (idle && me.status === "available") sock().emit("status", { status: "away", auto: true });
    if (!idle && me.status === "away" && me.autoAway) sock().emit("status", { status: "available" });
  });
  await detector.start({ threshold: IDLE_MS });
}

/** Restart detection on load if the person turned it on before (permission persists). */
export function useIdleAway() {
  useEffect(() => {
    let on = false;
    try { on = localStorage.getItem("es.idle") === "1"; } catch { /* */ }
    if (on && window.IdleDetector) {
      navigator.permissions
        ?.query({ name: "idle-detection" as PermissionName })
        .then((p) => { if (p.state === "granted") void start(); })
        .catch(() => {});
    }
  }, []);
}
