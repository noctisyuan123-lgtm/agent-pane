import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatItem } from "./chatFromEvents";
import { isProcessItem } from "./TurnBlocks";

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

/** Preserve interleaved assistant replies; window process segments to N cards. */
export function renderLiveTurnBody(
  body: ChatItem[],
  renderProcessItem: (m: ChatItem) => ReactNode,
  renderReply: (m: Extract<ChatItem, { kind: "assistant" }>) => ReactNode,
  maxProcessVisible = 2
): ReactNode[] {
  const out: ReactNode[] = [];
  let processSeg: ChatItem[] = [];

  const flushProcess = () => {
    if (processSeg.length === 0) return;
    const anchor = processSeg[processSeg.length - 1]!;
    out.push(
      <LiveProcessStack
        key={`live-proc-${anchor.id}`}
        items={processSeg}
        renderItem={renderProcessItem}
        maxVisible={maxProcessVisible}
      />
    );
    processSeg = [];
  };

  for (const item of body) {
    if (item.kind === "assistant") {
      flushProcess();
      out.push(renderReply(item));
    } else if (isProcessItem(item)) {
      processSeg.push(item);
    }
  }
  flushProcess();
  return out;
}
