// Socket.IO messages between the browser and the office server.

export type Status = "available" | "away" | "focusing";
export type Role = "admin" | "member" | "guest";

export interface Person {
  id: string; // user id, or "g:<invite>:<n>" for guests
  /** Opaque LiveKit identity. LiveKit shows every participant on the floor to every
   *  other, so it gets no names or user ids; only the office server maps it back. */
  lk: string;
  name: string;
  email: string | null;
  title: string | null;
  avatar: string | null;
  role: Role;
  slackId: string | null;
  deskId: string | null;
  tz: string | null;
  x: number;
  y: number;
  roomId: string | null;
  status: Status;
  statusText: string;
  statusSince: number;
  /** Status was set by idle detection, not by the person. */
  autoAway: boolean;
  mic: boolean;
  cam: boolean;
  sharing: boolean;
  /** Clocked in on /time ("in" or on a "break"); null when not, and always for guests. */
  clock: "in" | "break" | null;
  /** In a Fathom-recorded Meet that started from their room. */
  inMeeting: boolean;
  mobile: boolean;
  /** Weekdays in a row they've been in the office (server/streaks.ts); teammates only. */
  streak?: { days: number; today: boolean } | null;
  /** Started at Acme, "YYYY-MM-DD" (shared/tenure.ts): unlocks emotes and sets their service pin. Teammates only. */
  since?: string | null;
  /** Points (shared/points.ts): unlock emotes and pets. Teammates only. */
  points?: number;
  /** Their pet (shared/pets.ts), trotting after them. */
  pet?: string | null;
  /** Their outfit (shared/outfits.ts), or their own colours. */
  outfit?: string | null;
  /** The person this one is following, if any. */
  following: string | null;
  /** Guests are confined to one room. */
  guestRoom: string | null;
}

export interface Me extends Person {
  livekitUrl: string;
  floorId: string;
  slackTeamId: string | null;
  calendarLinked: boolean;
}

export interface RoomState {
  closed: boolean;
  /** People let in through a closed door (by knock), keyed by room. */
  admitted: string[];
  /** A meeting that moved out of the office: a Fathom Meet (old) or a GHL Meeting Room ("Start meeting"). */
  recording: null | { by: string; byName: string; meetUrl: string; startedAt: number; kind?: "fathom" | "ghl"; label?: string; pool?: number | null; joined?: boolean };
  /** "Transcribe this room" is on: each teammate's browser in the room sends its own mic. */
  transcribing: null | { id: number; by: string; byName: string; startedAt: number };
}

export interface Snapshot {
  me: Me;
  people: Person[];
  rooms: Record<string, RoomState>;
  audioRange: number;
  /** The web build the server is serving now; a tab on an older one is asked to refresh. */
  build?: string | null;
}

// Client → server
export interface C2S {
  move: (p: { x: number; y: number }) => void;
  status: (p: { status: Status; text?: string; auto?: boolean }) => void;
  media: (p: { mic?: boolean; cam?: boolean; sharing?: boolean; inMeeting?: boolean }) => void;
  door: (p: { roomId: string; closed: boolean }) => void;
  knock: (p: { roomId: string }) => void;
  admit: (p: { roomId: string; personId: string }) => void;
  react: (p: { emoji: string }) => void;
  /** Start an emote (shared/emotes.ts), or null to stop one. */
  emote: (p: { name: string | null }) => void;
  nudge: (p: { to: string }) => void;
  follow: (p: { to: string | null }) => void;
  requestFollow: (p: { to: string }) => void;
  teleport: (p: { to: string }) => void;
  /** Offer a high-five to `to`, or to whoever's closest. Both offering = it happens. */
  highfive: (p: { to?: string }) => void;
  /** Pet someone's pet. */
  pat: (p: { to: string }) => void;
  /** Pick a pet (shared/pets.ts), or none. */
  setPet: (p: { pet: string | null }) => void;
  /** Wear an outfit (shared/outfits.ts), or none. */
  setOutfit: (p: { outfit: string | null }) => void;
  /** "Say hi" on a newcomer's welcome: brings them over to you (with a notice to both). */
  sayHi: (p: { to: string }) => void;
}

// Server → client
export interface S2C {
  snapshot: (s: Snapshot) => void;
  join: (p: Person) => void;
  leave: (p: { id: string }) => void;
  /** Batched position updates at ~10 Hz: [id, x, y, roomId][] */
  moves: (m: [string, number, number, string | null][]) => void;
  person: (p: Partial<Person> & { id: string }) => void;
  room: (p: { roomId: string } & RoomState) => void;
  knock: (p: { roomId: string; from: { id: string; name: string } }) => void;
  admitted: (p: { roomId: string }) => void;
  react: (p: { id: string; emoji: string }) => void;
  emote: (p: { id: string; name: string | null }) => void;
  nudge: (p: { from: { id: string; name: string } }) => void;
  followRequest: (p: { from: { id: string; name: string } }) => void;
  /** Server-corrected position (e.g. a guest walking out of their room). */
  place: (p: { x: number; y: number }) => void;
  /** You're being moved somewhere on purpose (a teammate's "Say hi"): go there and say why. */
  bring: (p: { x: number; y: number; text: string }) => void;
  toast: (p: { text: string }) => void;
  recordingNote: (p: { roomId: string; title: string; summary: string; url: string }) => void;
  /** Someone in your room started a Fathom-recorded Meet: join it. */
  meetingStarted: (p: { roomId: string; meetUrl: string; byName: string; kind?: "fathom" | "ghl"; label?: string; auto?: boolean }) => void;
  kicked: (p: { reason: string }) => void;
  /** A high-five: offered (`done` false: a's hand is up for b) or landed. */
  highfive: (p: { a: string; b: string; done: boolean }) => void;
  /** Someone petted someone's pet. */
  pat: (p: { from: string; to: string }) => void;
  /** Someone posted in #wins: a quiet bell and a banner. */
  win: (p: { name: string; text: string; img?: number | null }) => void;
  /** A work anniversary today: confetti around them. */
  celebrate: (p: { id: string; years: number }) => void;
  /** A bonus worth celebrating (your first time in the office): the big card and fireworks. */
  bonus: (p: { points: number; title: string; text: string }) => void;
  /** You found an easter egg (shared/eggs.ts). */
  egg: (p: { id: string; first: boolean }) => void;
  /** A teammate walked into the office for the very first time. */
  welcome: (p: { id: string; name: string; title: string | null }) => void;
  /** The office was redesigned; redraw from this plan. */
  floor: (f: import("./floor").Floor) => void;
}
