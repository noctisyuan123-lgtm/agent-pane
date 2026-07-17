import { useEffect, useRef, useState } from "react";

/** Cursor `--cursor-duration-slower` — text-roll enter/exit. */
export const TEXT_ROLL_MS = 300;
/** Cursor subagent / activity-row status hold before rolling. */
export const TEXT_ROLL_MIN_HOLD_MS = 1200;

type RollState = {
  currentText: string;
  currentKey: string;
  currentSinceMs: number;
  previousText?: string;
  previousKey?: string;
  sequence: number;
  status: "idle" | "rolling";
};

function initRoll(text: string, key: string, now = Date.now()): RollState {
  return {
    currentText: text,
    currentKey: key,
    currentSinceMs: now,
    sequence: 0,
    status: "idle",
  };
}

type TextRollProps = {
  text: string;
  /** Identity for hold/roll; defaults to text. */
  textKey?: string;
  className?: string;
  minHoldMs?: number;
  /** Optional shimmer while “live”. */
  shimmer?: boolean;
};

/**
 * Cursor-style `ui-text-roll`: previous slides up out, current slides up in,
 * clipped to one line. Parallel 300ms roll; respects minHoldMs before swapping.
 */
export function TextRoll({
  text,
  textKey,
  className,
  minHoldMs = TEXT_ROLL_MIN_HOLD_MS,
  shimmer = false,
}: TextRollProps) {
  const key = textKey ?? text;
  const [state, setState] = useState<RollState>(() => initRoll(text, key));
  const reduceMotion = useRef(
    typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  // After roll animation finishes → idle
  useEffect(() => {
    if (state.status !== "rolling") return;
    if (reduceMotion.current) {
      setState((s) =>
        s.sequence === state.sequence
          ? {
              currentSinceMs: s.currentSinceMs,
              currentKey: s.currentKey,
              currentText: s.currentText,
              sequence: s.sequence,
              status: "idle",
            }
          : s
      );
      return;
    }
    const seq = state.sequence;
    const t = window.setTimeout(() => {
      setState((s) =>
        s.sequence === seq
          ? {
              currentSinceMs: s.currentSinceMs,
              currentKey: s.currentKey,
              currentText: s.currentText,
              sequence: s.sequence,
              status: "idle",
            }
          : s
      );
    }, TEXT_ROLL_MS);
    return () => window.clearTimeout(t);
  }, [state.sequence, state.status]);

  // Chase latest text after minHold
  useEffect(() => {
    if (reduceMotion.current) {
      setState((s) =>
        s.currentKey === key && s.currentText === text
          ? s
          : initRoll(text, key)
      );
      return;
    }
    if (state.currentKey === key && state.currentText === text) return;

    const elapsed = Date.now() - state.currentSinceMs;
    const wait = Math.max(0, minHoldMs - elapsed);

    const t = window.setTimeout(() => {
      setState((s) => {
        if (s.currentKey === key && s.currentText === text) return s;
        return {
          currentSinceMs: Date.now(),
          currentKey: key,
          currentText: text,
          previousKey: s.currentKey,
          previousText: s.currentText,
          sequence: s.sequence + 1,
          status: "rolling",
        };
      });
    }, wait);

    return () => window.clearTimeout(t);
  }, [
    key,
    text,
    minHoldMs,
    state.currentKey,
    state.currentText,
    state.currentSinceMs,
  ]);

  const rolling =
    state.status === "rolling" && state.previousText !== undefined;

  return (
    <span
      className={`text-roll${shimmer ? " text-roll--shimmer" : ""}${
        className ? ` ${className}` : ""
      }`}
      data-status={state.status}
    >
      <span className="text-roll-stage" aria-hidden>
        {rolling ? (
          <span
            key={`prev-${state.sequence}-${state.previousKey}`}
            className="text-roll-item text-roll-item--exit"
          >
            {state.previousText}
          </span>
        ) : null}
        <span
          key={`cur-${state.sequence}-${state.currentKey}`}
          className={`text-roll-item${
            rolling ? " text-roll-item--enter" : ""
          }`}
        >
          {state.currentText}
        </span>
      </span>
      <span className="text-roll-sr">{state.currentText}</span>
    </span>
  );
}
