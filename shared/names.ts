// Slack display names often carry the company ("Alex Admin | Acme"). Screens everyone
// sees (the jumbotron, the win banner) use just the first name.

/** "Alex Admin | Acme" → "Alex"; "" → "Someone". */
export function firstName(name: string | null | undefined): string {
  const clean = (name ?? "").split(/\s[|•·–—-]\s|\s*\(/)[0].trim();
  return clean.split(/\s+/)[0] || "Someone";
}
