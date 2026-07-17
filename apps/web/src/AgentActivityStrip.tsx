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

export type RunningProcessItem = {
  id: string;
  /** One-line label: subagent model, script, tool name */
  label: string;
  /** Optional kind chip: subagent | script | tool | search */
  kind?: string;
  detail?: string;
};

export type RunningDockProps = {
  /** Line 1 — process / task outline (required for display) */
  outline: string;
  /** Line 2 — concrete tool / step detail */
  detail?: string | null;
  /** Muted secondary — subagent model only */
  secondary?: string | null;
  /**
   * Live running subagents / scripts / tools — click the particle outline
   * to expand and inspect.
   */
  runningItems?: RunningProcessItem[];
};

/**
 * Compact running subagent / long-work bar — sits above the composer, left-aligned.
 * Particles + outline (+ optional expand list). Hidden by parent when idle.
 */
export type WorkingPillProps = {
  /** Active nested subagents only */
  count: number;
  /** Optional expand list (click pill) */
  runningItems?: RunningProcessItem[];
};

/**
 * Cursor Glass Agents Tray parity — compact `{n} Working` pill above composer.
 */
export function WorkingPill({ count, runningItems = [] }: WorkingPillProps) {
  const [listOpen, setListOpen] = useState(false);
  if (count <= 0) return null;

  const label = `${count} Working`;
  const canExpand = runningItems.length > 0;

  return (
    <div
      className={`working-pill-wrap${listOpen ? " working-pill-wrap--expanded" : ""}`}
      aria-live="polite"
    >
      {canExpand ? (
        <button
          type="button"
          className="working-pill"
          onClick={() => setListOpen((v) => !v)}
          aria-expanded={listOpen}
          title={listOpen ? "Hide agents" : "Show running agents"}
        >
          <SessionWorkingDots className="working-pill-dots" />
          <span className="working-pill-label">{label}</span>
          <span className={`working-pill-chev ${listOpen ? "open" : ""}`}>▾</span>
        </button>
      ) : (
        <div className="working-pill" aria-label={label}>
          <SessionWorkingDots className="working-pill-dots" />
          <span className="working-pill-label">{label}</span>
        </div>
      )}
      {listOpen && canExpand ? (
        <ul className="working-pill-list">
          {runningItems.map((item) => (
            <li key={item.id} className="working-pill-item">
              {item.kind ? (
                <span className="working-pill-kind">{item.kind}</span>
              ) : null}
              <span className="working-pill-item-label">{item.label}</span>
              {item.detail?.trim() ? (
                <span className="working-pill-item-detail">
                  {item.detail.trim()}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function RunningDock({
  outline,
  detail,
  secondary,
  runningItems = [],
}: RunningDockProps) {
  const [listOpen, setListOpen] = useState(false);
  const title = outline.trim();
  if (!title) return null;

  const canExpand = runningItems.length > 0;

  return (
    <div
      className={`running-dock${listOpen ? " running-dock--expanded" : ""}`}
      aria-live="polite"
    >
      <SessionWorkingDots className="running-dock-dots" />
      <div className="running-dock-lines">
        <div className="running-dock-outline-row">
          {canExpand ? (
            <button
              type="button"
              className="running-dock-outline-btn"
              onClick={() => setListOpen((v) => !v)}
              aria-expanded={listOpen}
              title={
                listOpen
                  ? "Hide running processes"
                  : "Show running subagents / scripts"
              }
            >
              <SlideLine text={title} className="running-dock-outline" />
              <span
                className={`running-dock-expand-chev ${listOpen ? "open" : ""}`}
              >
                ▾
              </span>
            </button>
          ) : (
            <SlideLine text={title} className="running-dock-outline" />
          )}
          {secondary ? (
            <span className="running-dock-secondary">{secondary}</span>
          ) : null}
        </div>
        {detail?.trim() ? (
          <div className="running-dock-detail-row">
            <SlideLine text={detail.trim()} className="running-dock-detail" />
          </div>
        ) : null}
        {listOpen && canExpand ? (
          <ul className="running-dock-list">
            {runningItems.map((item) => (
              <li key={item.id} className="running-dock-item">
                {item.kind ? (
                  <span className="running-dock-kind">{item.kind}</span>
                ) : null}
                <span className="running-dock-label">{item.label}</span>
                {item.detail?.trim() ? (
                  <span className="running-dock-item-detail">
                    {item.detail.trim()}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export type AgentActivityStripProps = {
  /**
   * Soft status only (Thinking… / Waiting…). Process outline lives in
   * {@link RunningDock} above the composer.
   */
  status?: string | null;
  statusForElapsed?: (elapsedMs: number) => string;
  busy?: boolean;
};

/**
 * Chat-bottom soft status strip (Thinking… / Waiting for model…).
 * External process outline is rendered by RunningDock at the composer.
 */
export function AgentActivityStrip({
  status,
  statusForElapsed,
  busy = false,
}: AgentActivityStripProps) {
  const elapsed = useBusyElapsed(Boolean(busy && statusForElapsed));
  const statusText = (
    statusForElapsed ? statusForElapsed(elapsed) : status ?? ""
  ).trim();
  if (!statusText) return null;

  return (
    <div className="agent-activity agent-activity--status-only" aria-live="polite">
      <div className="agent-activity-status-row">
        <SlideLine text={statusText} className="agent-activity-status" />
      </div>
    </div>
  );
}
