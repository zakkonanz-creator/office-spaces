// Files each room meeting's Fathom summary into Drive, next to the recordings,
// so a Drive search for the meeting finds it (CLAUDE.md: recordings searches
// check Drive). Layout mirrors the Zoom archive: one dated folder per call.
//
//   <DRIVE_RECORDINGS_FOLDER_ID>/            "Office Spaces Recordings"
//     2026-10-07 1430 · Conference Room/
//       Fathom summary.md                    summary, action items, Fathom + Meet links
//
// The Meet recording itself is written by Google to the organiser's
// "Meet Recordings" folder; this file links to it via the Meet URL.
// The writing account is linked once by an admin (Admin → Drive), and its
// refresh token is stored sealed in settings.

import { config } from "./config";
import { getSetting } from "./db";
import { googleAccessToken, unseal } from "./auth";

export async function driveToken(): Promise<string | null> {
  const sealed = await getSetting<string | null>("driveRefreshToken", null);
  if (!sealed || !config.drive.folderId) return null;
  return googleAccessToken("drive", unseal(sealed));
}

export async function writeSummaryToDrive(rec: any, fathomUrl: string, md: string): Promise<string | null> {
  const token = await driveToken();
  if (!token) return null;
  const h = { authorization: `Bearer ${token}` };
  const created = new Date(rec.created_at);
  const stamp = `${created.toISOString().slice(0, 10)} ${created.toISOString().slice(11, 16).replace(":", "")}`;
  const roomName = String(rec.title).split(" · ")[1] ?? rec.room_id;

  const folder = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id", {
    signal: AbortSignal.timeout(15_000), method: "POST",
    headers: { ...h, "content-type": "application/json" },
    body: JSON.stringify({ name: `${stamp} · ${roomName}`, mimeType: "application/vnd.google-apps.folder", parents: [config.drive.folderId] }),
  });
  if (!folder.ok) throw new Error(`folder create ${folder.status}: ${(await folder.text()).slice(0, 160)}`);
  const folderId = ((await folder.json()) as { id: string }).id;

  const body = [
    `# ${rec.title}`,
    ``,
    `- Room: ${roomName}`,
    `- Started: ${created.toISOString()}`,
    `- Attendees: ${(rec.attendee_emails ?? []).join(", ") || "—"}`,
    fathomUrl ? `- Fathom: ${fathomUrl}` : "",
    rec.meet_url ? `- Meet: ${rec.meet_url}` : "",
    ``,
    md,
  ].filter((l) => l !== "").join("\n");

  const boundary = "es" + Math.random().toString(16).slice(2);
  const multipart =
    `--${boundary}\r\ncontent-type: application/json\r\n\r\n` +
    JSON.stringify({ name: "Fathom summary.md", parents: [folderId], mimeType: "text/markdown" }) +
    `\r\n--${boundary}\r\ncontent-type: text/markdown; charset=utf-8\r\n\r\n${body}\r\n--${boundary}--`;
  const up = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=webViewLink", {
    signal: AbortSignal.timeout(15_000), method: "POST",
    headers: { ...h, "content-type": `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
  if (!up.ok) throw new Error(`upload ${up.status}: ${(await up.text()).slice(0, 160)}`);
  return ((await up.json()) as { webViewLink: string }).webViewLink;
}
