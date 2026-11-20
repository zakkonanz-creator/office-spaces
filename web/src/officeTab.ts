// One office per person. Time & Payroll opens in its own tab, so "Back to the
// office" must return you to the office tab you already have, not load a
// second office (which asks for your camera again and fights the first one
// for your audio). Tabs find each other over a BroadcastChannel.

const CHANNEL = "es-office";

/** The office tab answers "is anyone here?" while you're in the office. Returns a stop function. */
export function answerOfficePings(): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e) => { if (e.data?.type === "ping") ch.postMessage({ type: "here" }); };
  return () => ch.close();
}

/** Is an office already open in another tab of this browser? */
export function officeIsOpen(waitMs = 300): Promise<boolean> {
  if (typeof BroadcastChannel === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    const ch = new BroadcastChannel(CHANNEL);
    const done = (v: boolean) => { ch.close(); resolve(v); };
    const t = setTimeout(() => done(false), waitMs);
    ch.onmessage = (e) => { if (e.data?.type === "here") { clearTimeout(t); done(true); } };
    ch.postMessage({ type: "ping" });
  });
}

/**
 * "Back to the office" from another tab: if the office is open, close this tab so
 * you land back in it (or say where it is if the browser won't close the tab);
 * otherwise open the office here.
 */
export async function backToOffice(onStillOpen: () => void) {
  if (!(await officeIsOpen())) {
    location.href = "/";
    return;
  }
  window.close();
  // Browsers only let a page close tabs it opened; if we're still here, point the way.
  setTimeout(() => { if (!window.closed) onStillOpen(); }, 250);
}
