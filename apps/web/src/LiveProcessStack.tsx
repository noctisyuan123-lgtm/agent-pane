import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ChatItem } from "./chatFromEvents";
import { formatDurationSec } from "./chatFromEvents";
import {
  ProcessPackFold,
  packSummary,
  segmentTurnBody,
  splitFinalAssistant,
  thoughtLabel,
  WorkedForFold,
} from "./TurnBlocks";
import type { ToolRow } from "./toolFormat";
import { TextRoll, TEXT_ROLL_MIN_HOLD_MS } from "./TextRoll";

/**
 * Live process stage — Cursor-aligned text-roll:
 * sealed pack for finished seats; one stable live line that rolls
 * (300ms parallel up, minHold 1200ms). No overlapping card enter/exit.
 */

type LiveProcessStackProps = {
  items: ChatItem[];
  renderItem: (item: ChatItem) => ReactNode;
  maxVisible?: number;
};

type SeatUnit = {
  id: string;
  source: ChatItem;
  /** One-line status for TextRoll */
  rollText: string;
  shimmer: boolean;
};

function seatFromTool(tool: ToolRow): SeatUnit {
  return {
    id: `tool-${tool.toolId}`,
    source: {
      kind: "tools",
      id: `tools-seat-${tool.toolId}`,
      tools: [tool],
    },
    rollText: tool.label,
    shimmer: tool.status === "running",
  };
}

function flattenSeats(items: ChatItem[]): SeatUnit[] {
  const out: SeatUnit[] = [];
  for (const item of items) {
    if (
      item.kind !== "thought" &&
      item.kind !== "tools" &&
      item.kind !== "status" &&
      item.kind !== "turn_log"
    ) {
      continue;
    }
    if (item.kind === "tools") {
      for (const tool of item.tools) {
        out.push(seatFromTool(tool));
      }
      continue;
    }
    if (item.kind === "thought") {
      const preview = item.text.trim();
      if (!preview) continue;
      out.push({
        id: item.id,
        source: item,
        rollText: thoughtLabel(preview, item.durationMs),
        shimmer: item.durationMs == null,
      });
      continue;
    }
    if (item.kind === "status") {
      out.push({
        id: item.id,
        source: item,
        rollText: item.text,
        shimmer: false,
      });
      continue;
    }
    // turn_log — packable but not usually live-rolled
    out.push({
      id: item.id,
      source: item,
      rollText: item.lines[0]?.text ?? "…",
      shimmer: false,
    });
  }
  return out;
}

function useHeldSeatId(
  targetId: string | null,
  minHoldMs: number
): string | null {
  const [heldId, setHeldId] = useState<string | null>(targetId);
  const sinceRef = useRef(Date.now());
  const heldRef = useRef(heldId);
  heldRef.current = heldId;

  useEffect(() => {
    if (targetId == null) {
      setHeldId(null);
      return;
    }
    if (heldRef.current == null) {
      sinceRef.current = Date.now();
      setHeldId(targetId);
      return;
    }
    if (heldRef.current === targetId) return;

    const wait = Math.max(0, minHoldMs - (Date.now() - sinceRef.current));
    const t = window.setTimeout(() => {
      sinceRef.current = Date.now();
      setHeldId(targetId);
    }, wait);
    return () => window.clearTimeout(t);
  }, [targetId, minHoldMs]);

  return heldId;
}

export function LiveProcessStack({
  items,
  renderItem,
  maxVisible = 1,
}: LiveProcessStackProps) {
  const seats = flattenSeats(items);
  const n = Math.max(1, maxVisible);
  const latest = seats.slice(-n);
  const targetId = latest[latest.length - 1]?.id ?? null;
  const heldId = useHeldSeatId(targetId, TEXT_ROLL_MIN_HOLD_MS);

  const heldIndex =
    heldId == null ? -1 : seats.findIndex((s) => s.id === heldId);
  const liveSeat =
    heldIndex >= 0
      ? seats[heldIndex]
      : latest[latest.length - 1] ?? null;

  // Prefer freshest roll text for the held id (label updates while running)
  const liveFresh =
    liveSeat == null
      ? null
      : seats.find((s) => s.id === liveSeat.id) ?? liveSeat;

  const visibleIds = new Set(liveSeat ? [liveSeat.id] : []);
  const sealedSeats = seats.filter((s) => !visibleIds.has(s.id));

  if (seats.length === 0) return null;

  const sealedSources = sealedSeats.map((s) => s.source);

  return (
    <div className="live-process-stack" aria-live="polite">
      {sealedSources.length > 0 && (
        <div className="live-process-sealed">
          <ProcessPackFold
            summary={packSummary(sealedSources)}
            items={sealedSources}
            renderItem={renderItem}
            defaultOpen={false}
          />
        </div>
      )}

      {liveFresh ? (
        <div className="live-process-stage">
          <div className="live-process-item live-process-roll-line">
            <TextRoll
              text={liveFresh.rollText}
              textKey={liveFresh.id}
              shimmer={liveFresh.shimmer}
              className="live-process-text-roll"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

type ProcessRender = (
  m: ChatItem,
  ctx?: { embeddedInPack?: boolean }
) => ReactNode;

export function renderLiveTurnBody(
  body: ChatItem[],
  renderProcessItem: ProcessRender,
  renderReply: (m: Extract<ChatItem, { kind: "assistant" }>) => ReactNode,
  maxProcessVisible = 1
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
