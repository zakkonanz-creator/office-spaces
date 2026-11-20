// Adds up the crowd slices' per-phase counters (CROWD {"result": …} log lines on
// stdin) into one row per phase: what the media server sent (egress, the bill),
// per person, and call quality. Prints a table and the JSON.
//   railway logs … | npx tsx aggregate.ts

const lines = (await new Promise<string>((res) => { let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => res(s)); })).split("\n");
const rows = lines.flatMap((l) => {
  const i = l.indexOf("CROWD {");
  if (i < 0) return [];
  try { const o = JSON.parse(l.slice(i + 6)); return o.result ? [o] : []; } catch { return []; }
});

const byPhase = new Map<string, any[]>();
for (const r of rows) byPhase.set(r.result, [...(byPhase.get(r.result) ?? []), r]);

const out = [...byPhase.entries()].map(([phase, rs]) => {
  const sum = (k: string) => rs.reduce((n, r) => n + (r[k] ?? 0), 0);
  const secs = rs.reduce((n, r) => n + r.seconds, 0) / rs.length;
  const bots = sum("bots");
  const mbps = (b: number) => +((b * 8) / secs / 1e6).toFixed(2);
  const w = (k: string) => rs.reduce((n, r) => n + (r[k] ?? 0) * r.bots, 0) / Math.max(1, bots);
  return {
    phase, slices: rs.length, bots, ...Object.fromEntries(Object.entries(rs[0]).filter(([k]) => ["camerasOn", "room", "rooms", "atItsDesks", "perRoom", "inRoom"].includes(k))),
    egressMbps: mbps(sum("rxBytes")), videoMbps: mbps(sum("rxVideoBytes")), audioMbps: mbps(sum("rxAudioBytes")), ingressMbps: mbps(sum("txBytes")),
    egressGBperHour: +((sum("rxBytes") / secs) * 3600 / 1e9).toFixed(3),
    perPersonKbps: Math.round((sum("rxBytes") * 8) / secs / 1000 / Math.max(1, bots)),
    videoStreamsWatched: Math.round(sum("videoTracksAvg")),
    avgVideoHeight: Math.round(w("heightAvg")),
    lossPct: +((100 * sum("lost")) / Math.max(1, sum("recv") + sum("lost"))).toFixed(2),
    jitterMs: +w("jitterAvgMs").toFixed(1),
    freezes: sum("freezes"),
    crashedBots: sum("crashed"),
    from: rs.map((r) => r.from).sort()[0],
  };
});

console.table(out.map(({ rooms, from, ...r }) => r));
console.log(JSON.stringify(out));
