// "Record with Fathom": Fathom only joins live Zoom / Meet / Teams calls and
// has no upload API, so a room hands its conversation to a Google Meet that
// Fathom can see. Three steps:
//
//  1. Calendar events.insert with a Meet link, on the clicker's calendar, with
//     everyone in the room invited. Fathom joins what is on the calendar.
//  2. Meet spaces.get to resolve the meeting code to a space.
//  3. Meet spaces.patch to turn on Google's own recording + transcript, walking
//     down a ladder because each artifact needs a different licence.
//
// When Fathom finishes, its webhook (fathom.ts) brings the summary back here.

import { randomUUID } from "node:crypto";
import { googleAccessToken, unseal, type UserRow } from "./auth";
import { one } from "./db";

const CALENDAR_EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MEET_SPACES = "https://meet.googleapis.com/v2/spaces";

export class MeetingError extends Error {}

export async function startFathomMeeting(user: UserRow, roomId: string, roomName: string, attendees: string[]) {
  if (!user.google_refresh_token) throw new MeetingError("calendar-not-linked");
  const token = await googleAccessToken("calendar", unseal(user.google_refresh_token));

  // The title is also how the Fathom webhook finds this row again.
  const stamp = new Date().toISOString().slice(11, 16);
  const title = `Proximity Office · ${roomName} · ${stamp} UTC`;
  const now = new Date();
  now.setMilliseconds(0);
  const end = new Date(now.getTime() + 30 * 60e3);
  const r = await fetch(`${CALENDAR_EVENTS}?conferenceDataVersion=1&sendUpdates=none`, {
    signal: AbortSignal.timeout(15_000), method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      summary: title,
      description: `Started from the ${roomName} room in Proximity Office. Recorded by Fathom.`,
      start: { dateTime: now.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: attendees.filter((e) => e !== user.email).map((email) => ({ email })),
      conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
      // An ad-hoc room call shouldn't blank out half an hour of everyone's calendar.
      transparency: "transparent",
      reminders: { useDefault: false, overrides: [] },
      guestsCanModify: false,
    }),
  });
  if (r.status === 401) throw new MeetingError("calendar-not-linked");
  if (!r.ok) throw new MeetingError(explainGoogle(r.status, await r.text(), "create the calendar event"));
  const ev = (await r.json()) as any;
  const meetUrl: string = ev.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === "video")?.uri ?? "";
  const conferenceId: string = ev.conferenceData?.conferenceId ?? "";
  if (!meetUrl) throw new MeetingError("Google created the event but attached no Meet link — is Meet enabled for this account?");

  const autoRecord = await enableAutoArtifacts(token, conferenceId);

  const row = await one<{ id: number }>(
    `INSERT INTO recordings (room_id, title, started_by, attendee_emails, meet_url, event_id, conference_id, auto_record)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [roomId, title, user.id, attendees, meetUrl, ev.id ?? null, conferenceId, autoRecord.enabled || null],
  );
  return { id: row!.id, title, meetUrl, autoRecord };
}

const LADDER: [string, Record<string, unknown>][] = [
  ["recording + transcript + notes", {
    recordingConfig: { autoRecordingGeneration: "ON" },
    transcriptionConfig: { autoTranscriptionGeneration: "ON" },
    smartNotesConfig: { autoSmartNotesGeneration: "ON" },
  }],
  ["recording + transcript", {
    recordingConfig: { autoRecordingGeneration: "ON" },
    transcriptionConfig: { autoTranscriptionGeneration: "ON" },
  }],
  ["recording", { recordingConfig: { autoRecordingGeneration: "ON" } }],
];
const MASK: Record<string, string> = {
  recordingConfig: "config.artifactConfig.recordingConfig.autoRecordingGeneration",
  transcriptionConfig: "config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration",
  smartNotesConfig: "config.artifactConfig.smartNotesConfig.autoSmartNotesGeneration",
};

/** Best effort. Losing Google's own recording must not lose the meeting: Fathom is still on the invite. */
async function enableAutoArtifacts(token: string, conferenceId: string): Promise<{ enabled: string; note: string }> {
  if (!conferenceId) return { enabled: "", note: "no meeting code came back from Calendar" };
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    const g = await fetch(`${MEET_SPACES}/${conferenceId}`, { headers: h, signal: AbortSignal.timeout(15_000) });
    if (!g.ok) return { enabled: "", note: `Meet spaces.get ${g.status}` };
    const name = ((await g.json()) as any).name;
    let last = "";
    for (const [label, artifact] of LADDER) {
      const mask = Object.keys(artifact).map((k) => MASK[k]).join(",");
      const p = await fetch(`https://meet.googleapis.com/v2/${name}?updateMask=${encodeURIComponent(mask)}`, {
        signal: AbortSignal.timeout(15_000), method: "PATCH",
        headers: h,
        body: JSON.stringify({ config: { artifactConfig: artifact } }),
      });
      if (p.ok) return { enabled: label, note: "" };
      last = `Meet refused ${label} (${p.status})`;
    }
    return { enabled: "", note: last };
  } catch (e) {
    return { enabled: "", note: `Meet API unreachable (${(e as Error).message})` };
  }
}

/** Google's errors are JSON for developers; turn the common ones into a sentence a person can act on. */
export function explainGoogle(status: number, body: string, doing: string): string {
  let reason = "";
  let message = "";
  try {
    const j = JSON.parse(body);
    reason = j?.error?.errors?.[0]?.reason ?? j?.error?.status ?? "";
    message = j?.error?.message ?? "";
  } catch {
    message = body.slice(0, 160);
  }
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used in project/i.test(reason + message)) {
    return `Google couldn't ${doing}: the Calendar/Meet API isn't switched on for this app yet. An admin needs to enable it in Google Cloud (it can take a few minutes after enabling).`;
  }
  if (status === 403 && /insufficient|scope/i.test(reason + message)) return `Google couldn't ${doing}: your calendar link is missing a permission. Link your calendar again.`;
  if (status === 429 || /rateLimit/i.test(reason)) return `Google is rate-limiting right now. Try again in a minute.`;
  return `Google couldn't ${doing} (${status}). ${message.slice(0, 140)}`;
}
