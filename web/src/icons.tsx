// Small stroke icons, drawn for this app (24px grid, 1.75 stroke).

const P = {
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z M19 11a7 7 0 0 1-14 0 M12 18v3",
  micOff: "M9 9v3a3 3 0 0 0 5.1 2.1 M15 9.3V6a3 3 0 0 0-5.7-1.3 M19 11a7 7 0 0 1-1.2 3.9 M5 11a7 7 0 0 0 10.6 6 M12 18v3 M3 3l18 18",
  cam: "M3 7h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H3z M16 10.5l5-3v9l-5-3",
  camOff: "M3 7h4 M11 7h3a2 2 0 0 1 2 2v3 M16 15a2 2 0 0 1-2 2H3V7 M16 10.5l5-3v9l-5-3 M3 3l18 18",
  screen: "M3 5h18v11H3z M8 20h8 M12 16v4",
  record: "M12 12m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0 M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
  gallery: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  popout: "M14 4h6v6 M20 4l-8 8 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  home: "M4 11l8-7 8 7 M6 9.5V20h12V9.5",
  map: "M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z M9 3v15 M15 6v15",
  plus: "M12 5v14 M5 12h14",
  minus: "M5 12h14",
  target: "M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0 M12 2v4 M12 18v4 M2 12h4 M18 12h4",
  people: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M2 21a7 7 0 0 1 14 0 M16 3.5a4 4 0 0 1 0 7.5 M22 21a7 7 0 0 0-4-6.3",
  bug: "M8 9a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0z M12 10v8 M8 12H4 M20 12h-4 M8 16l-3 2 M16 16l3 2 M8 8L5 6 M16 8l3-2 M10 5.5L9 3 M14 5.5L15 3",
  help: "M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0 M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14 M12 17.5v.01",
  door: "M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17 M3 21h18 M14 12v.01",
  doorOpen: "M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17 M3 21h18 M6 4l6 2v15",
  smile: "M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0 M8.5 14a4.5 4.5 0 0 0 7 0 M9 9.5v.01 M15 9.5v.01",
  search: "M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0 M20 20l-4-4",
  close: "M6 6l12 12 M18 6L6 18",
  slack: "M14.5 3a1.5 1.5 0 0 0 0 3H16V4.5A1.5 1.5 0 0 0 14.5 3Z M9.5 21a1.5 1.5 0 0 0 0-3H8v1.5A1.5 1.5 0 0 0 9.5 21Z M3 9.5A1.5 1.5 0 0 0 6 9.5V8H4.5A1.5 1.5 0 0 0 3 9.5Z M21 14.5a1.5 1.5 0 0 0-3 0V16h1.5a1.5 1.5 0 0 0 1.5-1.5Z M8 3v6 M16 21v-6 M3 16h6 M21 8h-6",
  wave: "M7 11V6.5a1.5 1.5 0 0 1 3 0V11 M10 10V4.5a1.5 1.5 0 0 1 3 0V10 M13 10V5.5a1.5 1.5 0 0 1 3 0V12 M7 11l-1.2-1.6a1.6 1.6 0 0 0-2.6 1.9L7 17a6 6 0 0 0 11-3.3V9.5a1.5 1.5 0 0 0-3 0",
  follow: "M5 12h14 M13 6l6 6-6 6",
  volumeOff: "M4 9h4l5-4v14l-5-4H4z M17 9l4 6 M21 9l-4 6",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 14H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 10h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z",
  chevron: "M6 9l6 6 6-6",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  copy: "M8 8h12v12H8z M16 8V4H4v12h4",
  calendar: "M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4",
  clock: "M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0 M12 7.5V12l3 2",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  chart: "M4 20h16 M7 16v-5 M12 16V7 M17 16v-8",
} as const;

export type IconName = keyof typeof P;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {P[name].split(" M").map((d, i) => (
        <path key={i} d={i ? `M${d}` : d} />
      ))}
    </svg>
  );
}
