// Errors in people's browsers, sent to the server log (Railway), so a "my avatar stopped moving"
// report comes with the actual error instead of a guess. A few per page at most, each distinct
// message once; never blocks or throws itself.

const sent = new Set<string>();
/** The last few errors on this page, attached to a bug report (office/Report.tsx). */
const recent: string[] = [];
export const recentErrors = () => recent.slice(-5);
export const bundleName = () => bundle;
const MAX = 10;
const bundle = (() => {
  try { return (document.querySelector('script[type="module"][src*="/assets/index-"]') as HTMLScriptElement | null)?.src.split("/").pop() ?? "dev"; } catch { return "?"; }
})();

export function reportError(where: string, err: unknown) {
  try {
    const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : JSON.stringify(err));
    const key = `${where}:${e.message}`;
    if (sent.has(key) || sent.size >= MAX) return;
    sent.add(key);
    recent.push(`${where}: ${e.message}`.slice(0, 300));
    if (recent.length > 5) recent.shift();
    console.error(`[Office Spaces] ${where}:`, err);
    void fetch("/api/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ where, message: e.message.slice(0, 300), stack: (e.stack ?? "").slice(0, 1200), bundle, path: location.pathname, visible: !document.hidden }),
    }).catch(() => {});
  } catch {
    /* reporting must never be the thing that breaks */
  }
}

export function watchErrors() {
  window.addEventListener("error", (ev) => reportError("window", ev.error ?? ev.message));
  window.addEventListener("unhandledrejection", (ev) => reportError("promise", ev.reason));
}
