import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeClips, slackSafe, stopReason, transcriptText } from "./transcript";

const T0 = 1_800_000_000_000;

test("transcript: two people's clips interleave by time, not by who uploaded first", () => {
  const lines = mergeClips([
    { speaker: "Alex", startedAt: T0, segments: [{ start: 0, end: 3, text: "Morning." }, { start: 20, end: 24, text: "Ship it Thursday." }] },
    { speaker: "sam", startedAt: T0 + 5000, segments: [{ start: 0, end: 4, text: "The A2P campaign got rejected." }] },
  ], T0);
  assert.deepEqual(lines.map((l) => l.speaker), ["Alex", "sam", "Alex"]);
  assert.equal(transcriptText(lines).split("\n")[1], "[00:05] sam: The A2P campaign got rejected.");
});

test("transcript: one speaker's runs across clip boundaries become one turn; long pauses split them", () => {
  const lines = mergeClips([
    { speaker: "Alex", startedAt: T0, segments: [{ start: 25, end: 29.5, text: "So the snapshot" }] },
    { speaker: "Alex", startedAt: T0 + 30_000, segments: [{ start: 0, end: 2, text: "is missing two workflows." }, { start: 20, end: 22, text: "Anyway." }] },
  ], T0);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, "So the snapshot is missing two workflows.");
  assert.equal(transcriptText(lines).split("\n")[1], "[00:50] Alex: Anyway.");
});

test("transcript: empty segments are dropped and long meetings show hours", () => {
  const lines = mergeClips([{ speaker: "A", startedAt: T0 + 3_700_000, segments: [{ start: 0, end: 1, text: "  " }, { start: 1, end: 2, text: "Hi" }] }], T0);
  assert.equal(transcriptText(lines), "[1:01:41] A: Hi");
});

test("transcript: stops when the room empties, at the cap, at two hours, or after ten quiet minutes", () => {
  const base = { startedAt: 0, lastSpeechAt: 0, occupants: 2, badgeOn: true, overCap: false };
  assert.equal(stopReason(base, 60_000), null);
  assert.match(stopReason({ ...base, occupants: 0 }, 1)!, /left/);
  assert.match(stopReason({ ...base, badgeOn: false }, 1)!, /left/);
  assert.match(stopReason({ ...base, overCap: true }, 1)!, /hours/);
  assert.match(stopReason({ ...base, lastSpeechAt: 7_000_000 }, 7_200_000)!, /two-hour/);
  assert.match(stopReason({ ...base, lastSpeechAt: 0 }, 10 * 60e3)!, /10 minutes/);
  assert.equal(stopReason({ ...base, lastSpeechAt: 1 }, 10 * 60e3), null);
});

test("transcript: notes going to Slack can't carry Slack controls or hide where a link goes", () => {
  assert.equal(slackSafe("Ping <!channel> & <@U123>"), "Ping &lt;!channel&gt; &amp; &lt;@U123&gt;");
  assert.equal(slackSafe("[Payroll update](https://evil.example/x)"), "Payroll update (https://evil.example/x)");
  assert.equal(slackSafe("**Decisions**"), "*Decisions*");
});
