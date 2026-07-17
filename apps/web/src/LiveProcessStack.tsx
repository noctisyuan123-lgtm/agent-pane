import type { ReactNode } from "react";
import type { ChatItem } from "./chatFromEvents";
import { formatDurationSec } from "./chatFromEvents";
import {
  ProcessPackFold,
  segmentTurnBody,
  splitFinalAssistant,
  WorkedForFold,
} from "./TurnBlocks";

type LiveProcessStackProps = {
  items: ChatItem[];
  renderItem: (item: ChatItem) => ReactNode;
  maxVisible?: number;
};

/**
 * Live process trail: fixed-height mini window (CSS), last N cards only.
 * Outer height stays constant so assistant text below doesn't thrash when
 * tools/thoughts swap — Cursor-like independent "scroll slot".
 */
export function LiveProcessStack({
  items,
  renderItem,
  maxVisible = 2,
}: LiveProcessStackProps) {
  // Always render the shell so height is reserved even between tool steps
  const visible = items.slice(-maxVisible);

  return (
    <div className="live-process-stack" aria-live="polite">
      {visible.map((item) => (
        <div key={item.id} className="live-process-item">
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
