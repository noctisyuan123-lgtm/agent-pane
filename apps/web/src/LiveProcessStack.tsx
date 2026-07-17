import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatItem } from "./chatFromEvents";
import { formatDurationSec } from "./chatFromEvents";
import {
  ProcessPackFold,
  segmentTurnBody,
  splitFinalAssistant,
  WorkedForFold,
} from "./TurnBlocks";

const EXIT_MS = 280;

type LiveProcessStackProps = {
  items: ChatItem[];
  renderItem: (item: ChatItem) => ReactNode;
  maxVisible?: number;
};

/**
 * Live turn: show only the last N process cards (thought / tools / …).
 * Older cards slide up and fade; new ones rise from below.
 */
export function LiveProcessStack({
  items,
  renderItem,
  maxVisible = 2,
}: LiveProcessStackProps) {
  const visible = items.slice(-maxVisible);
  const prevVisibleRef = useRef<ChatItem[]>([]);
  const [exiting, setExiting] = useState<ChatItem[]>([]);
  const [enteringIds, setEnteringIds] = useState<Set<string>>(new Set());
  const exitTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  useEffect(() => {
    const prev = prevVisibleRef.current;
    const currentIds = new Set(visible.map((i) => i.id));
    const prevIds = new Set(prev.map((i) => i.id));

    const newlyExiting = prev.filter((p) => !currentIds.has(p.id));
    if (newlyExiting.length > 0) {
      setExiting((ex) => {
        const ids = new Set(ex.map((e) => e.id));
        return [...ex, ...newlyExiting.filter((n) => !ids.has(n.id))];
      });
      for (const item of newlyExiting) {
        if (exitTimersRef.current.has(item.id)) continue;
        exitTimersRef.current.set(
          item.id,
          setTimeout(() => {
            setExiting((ex) => ex.filter((e) => e.id !== item.id));
            exitTimersRef.current.delete(item.id);
          }, EXIT_MS)
        );
      }
    }

    const newlyEntering = visible.filter((v) => !prevIds.has(v.id));
    if (newlyEntering.length > 0) {
      setEnteringIds(new Set(newlyEntering.map((v) => v.id)));
      const t = setTimeout(() => setEnteringIds(new Set()), EXIT_MS);
      prevVisibleRef.current = visible;
      return () => clearTimeout(t);
    }

    prevVisibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    const timers = exitTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  if (visible.length === 0 && exiting.length === 0) return null;

  return (
    <div className="live-process-stack">
      {exiting.map((item) => (
        <div
          key={`exit-${item.id}`}
          className="live-process-item live-process-exit"
        >
          {renderItem(item)}
        </div>
      ))}
      {visible.map((item) => (
        <div
          key={item.id}
          className={`live-process-item${
            enteringIds.has(item.id) ? " live-process-enter" : ""
          }`}
        >
          {renderItem(item)}
        </div>
      ))}
    </div>
  );
}

/**
 * Live turn body: intermediate assistant bubbles always full;
 * sealed process segments → L1 ProcessPackFold; open trailing process →
 * LiveProcessStack (old-hide-new-replace, maxVisible≈2).
 * No L0 Worked-for wrapper while live.
 */
type ProcessRender = (
  m: ChatItem,
  ctx?: { embeddedInPack?: boolean }
) => ReactNode;

export function renderLiveTurnBody(
  body: ChatItem[],
  renderProcessItem: ProcessRender,
  renderReply: (m: Extract<ChatItem, { kind: "assistant" }>) => ReactNode,
  maxProcessVisible = 2
): ReactNode[] {
  const segments = segmentTurnBody(body);
  const out: ReactNode[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isLast = i === segments.length - 1;

    if (seg.type === "assistant") {
      out.push(renderReply(seg.item));
      continue;
    }

    // Trailing open process: sliding window, not sealed pack yet
    if (isLast) {
      out.push(
        <LiveProcessStack
          key={`live-proc-${seg.id}`}
          items={seg.items}
          renderItem={renderProcessItem}
          maxVisible={maxProcessVisible}
        />
      );
      continue;
    }

    // Sealed process between responds → L1 collapsible pack
    out.push(
      <ProcessPackFold
        key={seg.id}
        summary={seg.summary}
        items={seg.items}
        renderItem={renderProcessItem}
      />
    );
  }

  return out;
}

/**
 * Settled turn: L0 Worked-for folds trail (L1 packs + mid assistants);
 * only the final assistant reply sits outside.
 */
export function renderSettledTurnBody(
  body: ChatItem[],
  renderProcessItem: ProcessRender,
  renderReply: (m: Extract<ChatItem, { kind: "assistant" }>) => ReactNode,
  workedMs: number | null = null
): ReactNode[] {
  const { trail, final } = splitFinalAssistant(body);
  const trailSegments = segmentTurnBody(trail);
  const out: ReactNode[] = [];

  if (trailSegments.length > 0) {
    out.push(
      <WorkedForFold
        key="worked-for-l0"
        workedMs={workedMs}
        isLive={false}
      >
        {trailSegments.map((seg) =>
          seg.type === "assistant" ? (
            <div key={seg.item.id} className="worked-for-mid-reply">
              {renderReply(seg.item)}
            </div>
          ) : (
            <ProcessPackFold
              key={seg.id}
              summary={seg.summary}
              items={seg.items}
              renderItem={renderProcessItem}
            />
          )
        )}
      </WorkedForFold>
    );
  } else if (workedMs != null && workedMs > 0) {
    // No process / mid replies — duration chip only when we have a time
    out.push(
      <div key="worked-duration-only" className="worked-for-duration">
        Worked for {formatDurationSec(workedMs)}
      </div>
    );
  }

  if (final) {
    out.push(renderReply(final));
  }

  return out;
}
