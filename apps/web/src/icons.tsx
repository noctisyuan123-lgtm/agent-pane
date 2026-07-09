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

export function IconFolder({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M2 4.5h4l1.2 1.5H14a1 1 0 0 1 1 1V12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12V6a1.5 1.5 0 0 1 1.5-1.5H2z" />
    </Svg>
  );
}

export function IconFolderOpen({ size, className }: P) {
  return (
    <Svg size={size} className={className}>
      <path d="M1.5 6.5V5A1.5 1.5 0 0 1 3 3.5h3l1.2 1.5H13A1.5 1.5 0 0 1 14.5 6.5" />
      <path d="M1.5 6.5h13l-1.2 6.2A1.5 1.5 0 0 1 11.8 14H4.2a1.5 1.5 0 0 1-1.5-1.3L1.5 6.5z" />
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
