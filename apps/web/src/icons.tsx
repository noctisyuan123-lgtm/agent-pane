/** Cursor-style monochrome stroke icons (16×16, currentColor) */

import type { ReactNode } from "react";

type P = { size?: number; className?: string };

const defaults = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Svg({
  size = 16,
  className,
  children,
}: P & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      aria-hidden
      {...defaults}
    >
      {children}
    </svg>
  );
}

/** New Agent — spark / burst */
export function IconSpark({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M8 1.5l1.2 3.8L13 6.5l-3.8 1.2L8 11.5 6.8 7.7 3 6.5l3.8-1.2L8 1.5z" />
      <path d="M12.5 10.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6.6-1.9z" />
    </Svg>
  );
}

/**
 * Cursor Agents “New Agent” — paper plane (codicon-style send).
 * Matches the filled-wing plane in Cursor sidebar better than a spark.
 */
export function IconPaperPlane({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path
        d="M2 3.2l12.5 4.8L2 12.8V8.6l7.2-.6L2 7.4V3.2z"
        fill="currentColor"
        stroke="none"
      />
    </Svg>
  );
}

/**
 * Closed folder — flat tab + body outline (collapsed repo row).
 */
export function IconFolder({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M1.5 3.75c0-.69.56-1.25 1.25-1.25h3.38c.3 0 .59.11.81.31L8.1 4h5.15c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25h-10c-.69 0-1.25-.56-1.25-1.25v-8z" />
    </Svg>
  );
}

/**
 * Open folder — expanded repo (matches Cursor / user ref: tab + open pocket).
 */
export function IconFolderOpen({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      {/* back / tab rim */}
      <path d="M1.5 4.2c0-.66.54-1.2 1.2-1.2h3.15l1.15 1.25h5.3c.66 0 1.2.54 1.2 1.2V6" />
      {/* open front pocket (deeper body) */}
      <path d="M1.65 6.35h12.7l-1.4 6.05c-.12.5-.56.85-1.08.85H4.13c-.52 0-.96-.35-1.08-.85L1.65 6.35z" />
    </Svg>
  );
}

/** Copy — two overlapping squares (Cursor style) */
export function IconCopy({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
      <path d="M3.5 10.5V3.8A1.3 1.3 0 0 1 4.8 2.5h6.7" />
    </Svg>
  );
}

export function IconTerminal({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4 6.5l2 2-2 2M8 10.5h4" />
    </Svg>
  );
}

export function IconSearch({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </Svg>
  );
}

export function IconRefresh({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M13.5 8A5.5 5.5 0 1 1 11 3.2" />
      <path d="M13.5 2.5v3.5H10" />
    </Svg>
  );
}

export function IconPin({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M6 2.5h4l.5 4 2 1.5V9H3.5V8l2-1.5L6 2.5z" />
      <path d="M8 9v5" />
    </Svg>
  );
}

export function IconPencil({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M9.5 3.5l3 3L5 14H2v-3L9.5 3.5z" />
      <path d="M8 5l3 3" />
    </Svg>
  );
}

export function IconBell({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M4 7a4 4 0 0 1 8 0c0 3 1 4 1 4H3s1-1 1-4" />
      <path d="M6.5 13a1.5 1.5 0 0 0 3 0" />
    </Svg>
  );
}

export function IconFork({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="12" cy="3.5" r="1.5" />
      <circle cx="8" cy="12.5" r="1.5" />
      <path d="M4 5v1.5A2.5 2.5 0 0 0 6.5 9H8M12 5v1.5A2.5 2.5 0 0 1 9.5 9H8M8 9v2" />
    </Svg>
  );
}

export function IconArchive({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <rect x="2" y="2.5" width="12" height="3" rx="0.5" />
      <path d="M3 5.5h10v7A1.5 1.5 0 0 1 11.5 14h-7A1.5 1.5 0 0 1 3 12.5v-7z" />
      <path d="M6.5 9h3" />
    </Svg>
  );
}

export function IconMoreVertical({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <circle cx="8" cy="3.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="12.5" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconChevron({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M6 3.5L10.5 8 6 12.5" />
    </Svg>
  );
}

export function IconBook({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 2.5h4.5A2.5 2.5 0 0 1 10 5v9.5H5A2 2 0 0 1 3 12.5v-10z" />
      <path d="M13 2.5H8.5A2.5 2.5 0 0 0 6 5v9.5h5A2 2 0 0 0 13 12.5v-10z" />
    </Svg>
  );
}

export function IconBug({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M8 5.5a3 3 0 0 1 3 3v3.5a3 3 0 0 1-6 0V8.5a3 3 0 0 1 3-3z" />
      <path d="M5 8.5H2.5M13.5 8.5H11M5 12H3M13 12h-2M5.5 5.5L3.5 3.5M10.5 5.5l2-2" />
    </Svg>
  );
}

export function IconList({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M5 4h9M5 8h9M5 12h9" />
      <circle cx="2.5" cy="4" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="8" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="12" r="0.8" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconQuestion({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.2 6.2a1.8 1.8 0 1 1 2.5 1.6c-.6.3-1 .8-1 1.5V10" />
      <circle cx="8" cy="12.2" r="0.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Undo / rewind */
export function IconUndo({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M4 7H11a3 3 0 0 1 0 6H8" />
      <path d="M4 7l2.5-2.5M4 7l2.5 2.5" />
    </Svg>
  );
}

export function IconPlus({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  );
}

export function IconArrowDown({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M8 3v10M4 9l4 4 4-4" />
    </Svg>
  );
}

/** Send — up arrow (Cursor-style circular control, no mic) */
export function IconArrowUp({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M8 13V3M4 7l4-4 4 4" />
    </Svg>
  );
}

/** Stop generation — filled square */
export function IconStop({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <rect
        x="4"
        y="4"
        width="8"
        height="8"
        rx="1.2"
        fill="currentColor"
        stroke="none"
      />
    </Svg>
  );
}

export function IconTrash({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 4.5h10" />
      <path d="M6 4.5V3h4v1.5" />
      <path d="M4.5 4.5l.7 9h5.6l.7-9" />
      <path d="M6.5 7v4.5M9.5 7v4.5" />
    </Svg>
  );
}
