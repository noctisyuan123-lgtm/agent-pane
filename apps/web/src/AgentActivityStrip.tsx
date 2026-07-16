import { useEffect, useRef, useState } from "react";
import { SessionWorkingDots } from "./SessionWorkingDots";

const SLIDE_MS = 280;

/** Ignore trailing " 2.2s" ticks so the elapsed timer doesn't re-trigger slide. */
function slideIdentity(text: string): string {
  return text.replace(/\s+\d+(\.\d+)?s\s*$/, "").trim();
}

/** Bottom→top slide/fade when a status line's text changes. */
function SlideLine({
  text,
  className,
}: {
  text: string;
  className: string;
}) {
  const [current, setCurrent] = useState(text);
  const [exiting, setExiting] = useState<string | null>(null);
  const [entering, setEntering] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const identityRef = useRef(slideIdentity(text));

  useEffect(() => {
    return () => {
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    };
  }, []);

  useEffect(() => {
    const nextId = slideIdentity(text);
    // Same logical status — update in place (e.g. elapsed seconds) without motion
    if (nextId === identityRef.current) {
      if (text !== current) setCurrent(text);
      return;
    }
    identityRef.current = nextId;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setCurrent(text);
      setExiting(null);
      setEntering(false);
      return;
    }
    setExiting(current);
    setCurrent(text);
    setEntering(true);
    const t1 = setTimeout(() => setExiting(null), SLIDE_MS);
    const t2 = setTimeout(() => setEntering(false), SLIDE_MS);
    timers.current.push(t1, t2);
  }, [text, current]);

  return (
    <span className={`agent-activity-slide-wrap ${className}`.trim()}>
      {exiting != null && (
        <span className="agent-activity-slide agent-activity-slide-exit" aria-hidden>
          {exiting}
        </span>
      )}
      <span
        className={`agent-activity-slide${
          entering ? " agent-activity-slide-enter" : ""
        }`}
      >
        {current}
      </span>
    </span>
  );
}

function useBusyElapsed(busy: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const sinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!busy) {
      sinceRef.current = null;
      setElapsed(0);
      return;
    }
    if (sinceRef.current == null) sinceRef.current = Date.now();
    const tick = () => {
      setElapsed(Date.now() - (sinceRef.current ?? Date.now()));
    };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [busy]);
  return elapsed;
}

export type AgentActivityStripProps = {
  /**
   * External process block (tools / subagents) — NOT the sister herself.
   * When false/omitted with empty outline, only the status row shows.
   */
  showProcess?: boolean;
  /** Line 1 — process / task outline */
  outline?: string | null;
  /** Line 2 — concrete tool / step detail */
  detail?: string | null;
  /**
   * Line 3 status. Prefer `statusForElapsed` so the 200ms timer stays inside
   * this component and does not re-render the whole App/sidebar.
   */
  status?: string | null;
  statusForElapsed?: (elapsedMs: number) => string;
  busy?: boolean;
  /** Line 1 muted secondary — subagent model only */
  secondary?: string | null;
};

/**
 * Cursor-style activity:
 *   (dots) bold outline …  [subagent model]
 *          fine detail …
 *   status …
 *
 * Process rows (dots + outline + detail) only when an external process is
 * running. Sister-only thinking → status line alone.
 */
export function AgentActivityStrip({
  showProcess = false,
  outline,
  detail,
  status,
  statusForElapsed,
  busy = false,
  secondary,
}: AgentActivityStripProps) {
  const elapsed = useBusyElapsed(Boolean(busy && statusForElapsed));
  const processOn = Boolean(showProcess && outline?.trim());
  const statusText = (
    statusForElapsed ? statusForElapsed(elapsed) : status ?? ""
  ).trim();
  if (!processOn && !statusText) return null;

  return (
    <div
      className={`agent-activity${processOn ? "" : " agent-activity--status-only"}`}
      aria-live="polite"
    >
      {processOn ? (
        <div className="agent-activity-process">
          <SessionWorkingDots className="agent-activity-dots" />
          <div className="agent-activity-process-lines">
            <div className="agent-activity-outline-row">
              <SlideLine text={outline!.trim()} className="agent-activity-outline" />
              {secondary ? (
                <span className="agent-activity-secondary">{secondary}</span>
              ) : null}
            </div>
            {detail?.trim() ? (
              <div className="agent-activity-detail-row">
                <SlideLine text={detail.trim()} className="agent-activity-detail" />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {statusText ? (
        <div className="agent-activity-status-row">
          <SlideLine text={statusText} className="agent-activity-status" />
        </div>
      ) : null}
    </div>
  );
}
