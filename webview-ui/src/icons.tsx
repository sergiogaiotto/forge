import React from "react";

// Ícones de linha estilo Tabler inline. Empacotados (sem webfont/CDN) conforme RNF-016.
const PATHS: Record<string, React.ReactNode> = {
  flame: <path d="M12 12c2-2.96 0-7-1-8 0 3.038-1.773 4.741-3 6-1.226 1.26-2 3.24-2 5a6 6 0 1 0 12 0c0-1.532-1.056-3.94-2-5-1.786 3-2.791 3-4 2z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.6 9h16.8M3.6 15h16.8" />
      <path d="M11.5 3a17 17 0 0 0 0 18M12.5 3a17 17 0 0 1 0 18" />
    </>
  ),
  "server-bolt": (
    <>
      <path d="M3 9a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3" />
      <path d="M12 18H6a3 3 0 0 1-3-3 3 3 0 0 1 3-3h12a3 3 0 0 1 1.8.6" />
      <path d="M7 9h.01M7 15h.01" />
      <path d="M19 16l-2 3h4l-2 3" />
    </>
  ),
  key: <path d="M16.5 3.8l3.6 3.6a2.9 2.9 0 0 1 0 4.1l-2.6 2.6a2.9 2.9 0 0 1-4.1 0l-.3-.3-6.6 6.6a2 2 0 0 1-1.2.6H3.7a1 1 0 0 1-1-1v-1.6a2 2 0 0 1 .6-1.4l3.6-3.6v-2h2v-2l2.1-2.1-.3-.3a2.9 2.9 0 0 1 0-4.1l2.6-2.6a2.9 2.9 0 0 1 4.1 0z" />,
  "shield-check": (
    <>
      <path d="M11.5 20.8a12 12 0 0 1-8-14.8 12 12 0 0 0 8.5-3 12 12 0 0 0 8.5 3 12 12 0 0 1-.1 7" />
      <path d="M15 19l2 2 4-4" />
    </>
  ),
  network: (
    <>
      <path d="M6 9a6 6 0 1 0 12 0 6 6 0 0 0-12 0" />
      <path d="M12 3c1.3.3 2 2.3 2 6s-.7 5.7-2 6M12 3c-1.3.3-2 2.3-2 6s.7 5.7 2 6M6 9h12M3 20h7M14 20h7" />
      <path d="M10 20a2 2 0 1 0 4 0 2 2 0 0 0-4 0M12 15v3" />
    </>
  ),
  lock: (
    <>
      <path d="M5 13a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" />
      <path d="M11 16a1 1 0 1 0 2 0 1 1 0 0 0-2 0M8 11V7a4 4 0 1 1 8 0v4" />
    </>
  ),
  users: (
    <>
      <path d="M9 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0" />
      <path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 3.1a4 4 0 0 1 0 7.8M21 21v-2a4 4 0 0 0-3-3.9" />
    </>
  ),
  plug: (
    <>
      <path d="M9.8 6l8.2 8.2-2 2a5.8 5.8 0 0 1-8.2 0l-.3-.3a5.8 5.8 0 0 1 0-8.2l2.3-1.7z" />
      <path d="M4 20l3.5-3.5M15 4l-3.5 3.5M20 9l-3.5 3.5" />
    </>
  ),
  puzzle: <path d="M4 7h3a1 1 0 0 0 1-1V5a2 2 0 0 1 4 0v1a1 1 0 0 0 1 1h3a1 1 0 0 1 1 1v3a1 1 0 0 0 1 1h1a2 2 0 0 1 0 4h-1a1 1 0 0 0-1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-1a2 2 0 0 0-4 0v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a2 2 0 0 0 0-4H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1" />,
  cpu: (
    <>
      <path d="M5 6a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" />
      <path d="M9 9h6v6H9z" />
      <path d="M3 10h2M3 14h2M10 3v2M14 3v2M21 10h-2M21 14h-2M14 21v-2M10 21v-2" />
    </>
  ),
  "arrow-up": <path d="M12 5v14M16 9l-4-4M8 9l4-4" />,
  check: <path d="M5 12l5 5 10-10" />,
  x: <path d="M18 6L6 18M6 6l12 12" />,
  "git-compare": (
    <>
      <path d="M6 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      <path d="M11 6h5a2 2 0 0 1 2 2v4M14 9l-3-3 3-3M13 18H8a2 2 0 0 1-2-2v-4M10 15l3 3-3 3" />
    </>
  ),
  copy: (
    <>
      <path d="M8 10a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2z" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  "list-check": (
    <>
      <path d="M3.5 5.5L5 7l2.5-2.5M3.5 11.5L5 13l2.5-2.5M3.5 17.5L5 19l2.5-2.5" />
      <path d="M11 6h9M11 12h9M11 18h9" />
    </>
  ),
  activity: <path d="M3 12h4l3 8 4-16 3 8h4" />,
  history: <path d="M12 8v4l2 2M3 11a9 9 0 1 1 .5 4m-.5 5v-5h5" />,
  settings: (
    <>
      <path d="M10.3 4.3a1.7 1.7 0 0 1 3.4 0 1.7 1.7 0 0 0 2.5 1 1.7 1.7 0 0 1 2.4 2.4 1.7 1.7 0 0 0 1 2.6 1.7 1.7 0 0 1 0 3.4 1.7 1.7 0 0 0-1 2.5 1.7 1.7 0 0 1-2.4 2.4 1.7 1.7 0 0 0-2.5 1 1.7 1.7 0 0 1-3.4 0 1.7 1.7 0 0 0-2.6-1 1.7 1.7 0 0 1-2.4-2.4 1.7 1.7 0 0 0-1-2.6 1.7 1.7 0 0 1 0-3.4 1.7 1.7 0 0 0 1-2.5 1.7 1.7 0 0 1 2.4-2.4 1.7 1.7 0 0 0 2.6-1z" />
      <path d="M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0" />
    </>
  ),
  "chevron-down": <path d="M6 9l6 6 6-6" />,
  "info-circle": (
    <>
      <path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0" />
      <path d="M12 8h.01M11 12h1v4h1" />
    </>
  ),
  circle: <path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0" />,
  "circle-check": (
    <>
      <path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  refresh: <path d="M20 11a8 8 0 0 0-15.5-2M4 5v4h4M4 13a8 8 0 0 0 15.5 2M20 19v-4h-4" />,
  paperclip: <path d="M15 7l-6.5 6.5a1.5 1.5 0 0 0 3 3L18 10a3 3 0 0 0-6-6l-6.5 6.5a4.5 4.5 0 0 0 9 9L21 13" />,
  code: <path d="M7 8l-4 4 4 4M17 8l4 4-4 4M14 4l-4 16" />,
  eye: (
    <>
      <path d="M10 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0" />
      <path d="M21 12c-2.4 4-5.4 6-9 6s-6.6-2-9-6c2.4-4 5.4-6 9-6s6.6 2 9 6" />
    </>
  ),
  table: (
    <>
      <path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 10h18M10 3v18" />
    </>
  ),
  sparkles: <path d="M16 18a2 2 0 0 1 2 2 2 2 0 0 1 2-2 2 2 0 0 1-2-2 2 2 0 0 1-2 2zm0-12a2 2 0 0 1 2 2 2 2 0 0 1 2-2 2 2 0 0 1-2-2 2 2 0 0 1-2 2zm-7 12a6 6 0 0 1 6-6 6 6 0 0 1-6-6 6 6 0 0 1-6 6 6 6 0 0 1 6 6z" />,
  point: <path d="M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z" />,
  "clipboard-check": (
    <>
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <path d="M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2z" />
      <path d="M9 14l2 2 4-4" />
    </>
  ),
  send: <path d="M10 14l11-11M21 3l-6.5 18a.55.55 0 0 1-1 0L10 14l-7-3.5a.55.55 0 0 1 0-1z" />,
  "alert-triangle": <path d="M12 9v4M12 17h.01M10.2 3.3l-8.1 14a2 2 0 0 0 1.7 3h16.4a2 2 0 0 0 1.7-3l-8.1-14a2 2 0 0 0-3.4 0z" />,
  database: (
    <>
      <path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z" />
      <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </>
  ),
  search: (
    <>
      <path d="M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12z" />
      <path d="M21 21l-6-6" />
    </>
  ),
  "player-play": <path d="M7 4l12 8-12 8z" />,
  dots: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  "file-code": (
    <>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M5 12V5a2 2 0 0 1 2-2h7l5 5v3M9 16l-2 2 2 2M15 16l2 2-2 2" />
    </>
  ),
  terminal: (
    <>
      <path d="M5 7l5 5-5 5" />
      <path d="M12 19h7" />
    </>
  ),
  file: (
    <>
      <path d="M7 3h7l4 4v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M14 3v4h4" />
    </>
  ),
  folder: <path d="M5 4h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />,
};

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  color,
  strokeWidth = 1.7,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? "currentColor"}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-hidden="true"
    >
      {PATHS[name] ?? null}
    </svg>
  );
}
