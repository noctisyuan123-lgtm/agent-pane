import type { ReactNode } from "react";
import { useState } from "react";
import type { ChatItem } from "./chatFromEvents";
import { formatDurationSec } from "./chatFromEvents";
import { summarizeToolGroup, type ToolRow } from "./toolFormat";

/** One user message + the agent activity that followed it. */
export type TurnBlock = {
  key: string;
  user: Extract<ChatItem, { kind: "user" }> | null;
  /**
   * Process trail only — thought / status / tools / turn_log.
   * Assistant prose is kept separate so Worked-for never hides the reply.
   */
  process: ChatItem[];
  /** Final / intermediate assistant bubbles — always visible */
  replies: Extract<ChatItem, { kind: "assistant" }>[];
  /** Full body order for live streaming (preserve interleaved layout) */
  body: ChatItem[];
  workedMs: number | null;
  /** Last turn still streaming — keep process open */
  isLive: boolean;
};

/** Assistant bubble or a collapsed process pack between assistants. */
export type BodySegment =
  | {
      type: "assistant";
      item: Extract<ChatItem, { kind: "assistant" }>;
    }
  | {
      type: "pack";
      id: string;
      items: ChatItem[];
      summary: string;
    };

/** Items that belong under the Worked-for fold (not the reply text). */
export function isProcessItem(m: ChatItem): boolean {
  return (
    m.kind === "thought" ||
    m.kind === "status" ||
    m.kind === "tools" ||
    m.kind === "turn_log"
  );
}

/**
 * Group flat chat items into Cursor-style turns:
 * User → Worked for (thought/tools) → assistant body always shown
 */
export function groupChatIntoTurns(
  messages: ChatItem[],
  opts: { busy: boolean }
): TurnBlock[] {
  const turns: TurnBlock[] = [];
  let cur: TurnBlock | null = null;

  const pushCur = () => {
    if (cur) turns.push(cur);
    cur = null;
  };

  for (const m of messages) {
    if (m.kind === "user") {
      pushCur();
      cur = {
        key: m.id,
        user: m,
        process: [],
        replies: [],
        body: [],
        workedMs: null,
        isLive: false,
      };
      continue;
    }
    if (!cur) {
      cur = {
        key: `pre-${m.id}`,
        user: null,
        process: [],
        replies: [],
        body: [],
        workedMs: null,
        isLive: false,
      };
    }
    if (m.kind === "worked") {
      cur.workedMs = m.ms;
      continue;
    }
    cur.body.push(m);
    if (m.kind === "assistant") {
      cur.replies.push(m);
    } else if (isProcessItem(m)) {
      cur.process.push(m);
    }
  }
  pushCur();

  if (turns.length > 0) {
    const last = turns[turns.length - 1]!;
    last.isLive = opts.busy && last.workedMs == null;
  }
  return turns;
}

/** Merge consecutive thought ChatItems into one (scheme A thought chain). */
export function mergeThoughtsInItems(items: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = [];
  for (const item of items) {
    if (item.kind === "thought") {
      const last = out[out.length - 1];
      if (last?.kind === "thought") {
        const joined = [last.text, item.text]
          .map((t) => t.trim())
          .filter(Boolean)
          .join("\n\n");
        out[out.length - 1] = {
          kind: "thought",
          id: last.id,
          text: joined,
        };
        continue;
      }
    }
    out.push(item);
  }
  return out;
}

/** Cursor-style thought label from text length. */
export function thoughtLabel(text: string): string {
  const preview = text.trim();
  if (!preview || preview.length < 40) return "Thought briefly";
  return `Thought for ${Math.max(1, Math.round(preview.length / 48))}s`;
}

/**
 * L1 pack title: tools → Explored/Edited…; thoughts only → Thought…;
 * status / turn_log as fallbacks.
 */
export function packSummary(items: ChatItem[]): string {
  const toolRows: ToolRow[] = [];
  for (const item of items) {
    if (item.kind === "tools") toolRows.push(...item.tools);
  }
  if (toolRows.length > 0) {
    return summarizeToolGroup(toolRows);
  }

  const thoughtTexts: string[] = [];
  for (const item of items) {
    if (item.kind === "thought" && item.text.trim()) {
      thoughtTexts.push(item.text.trim());
    }
  }
  if (thoughtTexts.length > 0) {
    return thoughtLabel(thoughtTexts.join("\n\n"));
  }

  for (const item of items) {
    if (item.kind === "status" && item.text.trim()) {
      const t = item.text.trim();
      return t.length > 72 ? `${t.slice(0, 69)}…` : t;
    }
  }

  for (const item of items) {
    if (item.kind === "turn_log" && item.lines.length > 0) {
      return item.lines[0]!.text;
    }
  }

  return "Process";
}

/**
 * Split turn body into interleaved assistant bubbles and process packs.
 * Consecutive process items (after thought merge) become one L1 pack.
 */
export function segmentTurnBody(body: ChatItem[]): BodySegment[] {
  const segments: BodySegment[] = [];
  let processBuf: ChatItem[] = [];

  const flushProcess = () => {
    if (processBuf.length === 0) return;
    const merged = mergeThoughtsInItems(processBuf);
    const anchor = merged[0]!;
    segments.push({
      type: "pack",
      id: `pack-${anchor.id}`,
      items: merged,
      summary: packSummary(merged),
    });
    processBuf = [];
  };

  for (const item of body) {
    if (item.kind === "assistant") {
      flushProcess();
      segments.push({ type: "assistant", item });
    } else if (isProcessItem(item)) {
      processBuf.push(item);
    }
  }
  flushProcess();
  return segments;
}

/**
 * Final assistant stays outside L0 Worked-for; everything else is the trail.
 * Preserves relative order of non-final items (incl. process after last reply).
 */
export function splitFinalAssistant(body: ChatItem[]): {
  trail: ChatItem[];
  final: Extract<ChatItem, { kind: "assistant" }> | null;
} {
  let lastAssistantIdx = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i]!.kind === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx < 0) {
    return { trail: body.slice(), final: null };
  }
  const final = body[lastAssistantIdx] as Extract<
    ChatItem,
    { kind: "assistant" }
  >;
  const trail = body.filter((_, i) => i !== lastAssistantIdx);
  return { trail, final };
}

/**
 * L1 collapsible process pack (Thought / Explored / Edited summary).
 * Expand reveals L2: thought text (direct) + tool rows (via renderItem).
 */
export function ProcessPackFold({
  summary,
  items,
  renderItem,
  defaultOpen = false,
}: {
  summary: string;
  items: ChatItem[];
  /** Prefer (item, ctx) so tools can skip nested Explored summary under L1. */
  renderItem: (
    m: ChatItem,
    ctx?: { embeddedInPack?: boolean }
  ) => ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const rendered: { id: string; node: ReactNode }[] = [];
  for (const item of items) {
    // Thoughts: L1 already says Thought briefly/for Ns — expand shows body,
    // not a second identical fold header.
    if (item.kind === "thought") {
      const text = item.text.trim();
      if (!text) continue;
      rendered.push({
        id: item.id,
        node: <div className="tl-thought-body process-pack-thought">{text}</div>,
      });
      continue;
    }
    const node = renderItem(item, { embeddedInPack: true });
    if (node == null || node === false) continue;
    rendered.push({ id: item.id, node });
  }

  if (rendered.length === 0) return null;

  return (
    <div className={`process-pack${open ? " open" : ""}`}>
      <button
        type="button"
        className="process-pack-summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="tl-meta-label">{summary}</span>
        <span className={`tl-meta-chev ${open ? "open" : ""}`}>▾</span>
      </button>
      {open ? (
        <div className="process-pack-body">
          {rendered.map(({ id, node }) => (
            <div key={id} className="process-pack-item">
              {node}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Fold for thought / tool trail only.
 * - Historical (incl. incomplete / no duration): default collapsed
 * - Live: no outer fold — stream process as it lands
 * Assistant replies are rendered by the caller OUTSIDE this fold — never here.
 */
export function WorkedForFold({
  workedMs,
  isLive,
  children,
}: {
  workedMs: number | null;
  isLive: boolean;
  children: ReactNode;
}) {
  const childArr = Array.isArray(children)
    ? children.filter((c) => c != null && c !== false)
    : children != null && children !== false
      ? [children]
      : [];
  const hasBody = childArr.length > 0;

  if (!hasBody) return null;

  // Live stream only: process stays open. History always folds (even if ms unknown).
  if (isLive) {
    return <div className="worked-live">{children}</div>;
  }

  return <WorkedForDetails ms={workedMs}>{children}</WorkedForDetails>;
}

function WorkedForDetails({
  ms,
  children,
}: {
  ms: number | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const label =
    ms != null && ms > 0
      ? `Worked for ${formatDurationSec(ms)}`
      : "Worked";

  return (
    <div className={`worked-for${open ? " open" : ""}`}>
      <button
        type="button"
        className="worked-for-summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="worked-for-label">{label}</span>
        <span className={`worked-for-chev ${open ? "open" : ""}`}>▾</span>
      </button>
      {open ? <div className="worked-for-body">{children}</div> : null}
    </div>
  );
}
