import type { ReactNode } from "react";
import { useState } from "react";
import type { ChatItem } from "./chatFromEvents";
import { formatDurationSec } from "./chatFromEvents";

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
