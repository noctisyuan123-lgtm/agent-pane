import { useEffect, useState } from "react";

/**
 * Sidebar "working" indicator — 3×3 dots with unordered flicker
 * (not a fixed clockwise/CCW orbit).
 */

const DIM = 3;
const CELL = DIM * DIM; // 9
const FRAME_MS = 220;

function randomBits(): boolean[] {
  // Keep ~2–4 dots lit so it reads as activity, not noise
  const n = 2 + Math.floor(Math.random() * 3);
  const idxs = Array.from({ length: CELL }, (_, i) => i);
  for (let i = idxs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = idxs[i]!;
    idxs[i] = idxs[j]!;
    idxs[j] = tmp;
  }
  const on = new Set(idxs.slice(0, n));
  return Array.from({ length: CELL }, (_, i) => on.has(i));
}

export function SessionWorkingDots({ className = "" }: { className?: string }) {
  const [bits, setBits] = useState<boolean[]>(() => randomBits());

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const id = window.setInterval(() => {
      setBits(randomBits());
    }, FRAME_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <span
      className={`session-working-dots ${className}`.trim()}
      aria-hidden
      role="presentation"
      title="Working"
    >
      <svg
        aria-hidden
        focusable="false"
        height={11}
        width={11}
        viewBox="0 0 10 10"
        role="presentation"
        className="session-working-dots__svg"
      >
        {bits.map((on, i) => {
          if (!on) return null;
          const row = Math.floor(i / DIM);
          const col = i % DIM;
          return (
            <circle
              key={i}
              className="session-working-dots__on"
              cx={1 + col * 4}
              cy={1 + row * 4}
              r={1}
            />
          );
        })}
      </svg>
    </span>
  );
}
