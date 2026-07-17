import type { ContextRef, DomainEvent } from "@agent-pane/shared";
import {
  formatToolFailed,
  formatToolFinished,
  formatToolStarted,
  tidyToolError,
  type ToolRow,
} from "./toolFormat";

export type TurnLogLine = {
  /** dim = thought, ok = success, run = tool, fail = error */
  tone: "dim" | "ok" | "run" | "fail";
  text: string;
};

export type ChatItem =
  | {
      kind: "user";
      text: string;
      id: string;
      attachments?: ContextRef[];
      /**
       * 0-based index in the full Pane timeline (not the windowed paint array).
       * Set when building from events / live UserMessageAppended so Retry/Undo
       * never confuse local window indices with global turn indices.
       */
      userTurnIndex?: number;
    }
  | { kind: "assistant"; text: string; id: string }
  /** Short pre-tool narration — muted, not a full reply bubble */
  | { kind: "status"; text: string; id: string }
  /** durationMs = wall-clock thinking time when sealed (not char-count guess). */
  | { kind: "thought"; text: string; id: string; durationMs?: number }
  | { kind: "tools"; id: string; tools: ToolRow[] }
  /** Grok CLI-style end-of-turn step log (◆ Thought / Task / Run) */
  | { kind: "turn_log"; id: string; lines: TurnLogLine[] }
  /** Cursor-style turn duration for "Worked for Xs" fold */
  | { kind: "worked"; id: string; ms: number };

/** 0-based user-turn index that owns chat item at `messageIndex` (Claude Code). */
export function userTurnIndexAt(
  messages: ChatItem[],
  messageIndex: number
): number {
  let turn = -1;
  const end = Math.min(messageIndex, messages.length - 1);
  for (let i = 0; i <= end; i++) {
    if (messages[i]?.kind === "user") turn++;
  }
  return turn;
}

/** Drop the user bubble at `userTurnIndex` and everything after. */
export function sliceMessagesBeforeUserTurn(
  messages: ChatItem[],
  userTurnIndex: number
): ChatItem[] {
  if (!Number.isFinite(userTurnIndex) || userTurnIndex < 0) {
    return messages;
  }

  // Count total users — refuse to wipe everything when index looks bogus
  let totalUsers = 0;
  for (const m of messages) {
    if (m.kind === "user") totalUsers++;
  }
  if (totalUsers === 0) return messages;
  // userTurnIndex must be in [0, totalUsers). If larger, no-op (don't wipe).
  if (userTurnIndex >= totalUsers) return messages;

  // Prefer stamped global index when unique and consistent with count position.
  let stampedHits = 0;
  let stampedAt = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (
      m?.kind === "user" &&
      typeof m.userTurnIndex === "number" &&
      m.userTurnIndex === userTurnIndex
    ) {
      stampedHits++;
      stampedAt = i;
    }
  }
  if (stampedHits === 1 && stampedAt >= 0) {
    // Sanity: stamped cut should leave (userTurnIndex) user bubbles before it
    let before = 0;
    for (let i = 0; i < stampedAt; i++) {
      if (messages[i]?.kind === "user") before++;
    }
    if (before === userTurnIndex) {
      return messages.slice(0, stampedAt);
    }
    // Stamp disagrees with position — fall through to count-based
  }

  let turn = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.kind === "user") {
      turn++;
      if (turn === userTurnIndex) return messages.slice(0, i);
    }
  }
  return messages;
}

/** Text of the user message for a given turn index. */
export function userTextAtTurn(
  messages: ChatItem[],
  userTurnIndex: number
): string | null {
  let turn = -1;
  for (const m of messages) {
    if (m.kind === "user") {
      turn++;
      if (turn === userTurnIndex) return m.text;
    }
  }
  return null;
}

function eventMs(e: { at?: string }): number {
  if (!e.at) return 0;
  const t = Date.parse(e.at);
  return Number.isFinite(t) ? t : 0;
}

export function formatDurationSec(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m ${r}s`;
}

/**
 * Build the full chat timeline from events.jsonl in file order.
 * Does NOT use seq for identity (old resumes reused seq 1..N).
 * Reliable path for openHistory — avoids setState-loop / seq-dedupe drops
 * that made the last assistant turn vanish.
 */
export function eventsToChatItems(events: DomainEvent[]): ChatItem[] {
  const messages: ChatItem[] = [];
  let assistantBuf = "";
  let assistantId = "";
  let thoughtBuf = "";
  let thoughtId = "";
  let toolsId = "";
  let tools: ToolRow[] = [];
  let postToolsId: string | null = null;
  let turnDone = false;
  let turn = 0;
  let sid = "";
  // CLI-style turn log (◆ Thought / Run)
  let turnLog: TurnLogLine[] = [];
  let thoughtStartMs = 0;
  let thoughtActive = false;
  const toolStartMs = new Map<string, number>();
  /** Wall-clock start of current user turn (for Worked for Xs) */
  let turnStartMs = 0;
  /** Whether current turn already got a `worked` item (MessageDone or seal) */
  let workedSealed = false;
  /** Last event timestamp seen (EOF incomplete-turn seal) */
  let lastEventMs = 0;

  /** Wall-clock seal only — duration lives on thought ChatItem, not turn_log. */
  const sealThoughtLog = (endMs: number) => {
    if (!thoughtActive) return;
    // Attach duration onto the thought bubble (via flushThought) instead of
    // a second ◆ Thought for Xs line (was 1s char-guess vs 12s wall double).
    flushThought(endMs);
    thoughtActive = false;
    thoughtStartMs = 0;
  };

  const flushThought = (endMs?: number) => {
    const t = thoughtBuf.trim();
    if (t && thoughtId) {
      const last = messages[messages.length - 1];
      const durationMs =
        thoughtActive && thoughtStartMs && endMs
          ? Math.max(0, endMs - thoughtStartMs)
          : thoughtActive && thoughtStartMs
            ? Math.max(0, Date.now() - thoughtStartMs)
            : undefined;
      // Avoid stacking identical thought shells from polluted / repeated streams
      if (!(last?.kind === "thought" && last.text.trim() === t)) {
        messages.push({
          kind: "thought",
          text: t,
          id: thoughtId,
          ...(durationMs != null && durationMs > 0 ? { durationMs } : {}),
        });
      } else if (
        last?.kind === "thought" &&
        durationMs != null &&
        durationMs > 0
      ) {
        messages[messages.length - 1] = {
          ...last,
          durationMs,
        };
      }
    }
    thoughtBuf = "";
  };

  const flushTools = () => {
    if (toolsId && tools.length) {
      messages.push({ kind: "tools", id: toolsId, tools: [...tools] });
    }
    tools = [];
    toolsId = "";
  };

  const flushAssistant = () => {
    const t = assistantBuf.trim();
    if (t && assistantId) {
      const last = messages[messages.length - 1];
      if (!(last?.kind === "assistant" && last.text.trim() === t)) {
        messages.push({ kind: "assistant", text: t, id: assistantId });
      }
    }
    assistantBuf = "";
  };

  const flushTurnLog = () => {
    if (!turnLog.length) return;
    messages.push({
      kind: "turn_log",
      id: `log-${sid}-t${turn}`,
      lines: [...turnLog],
    });
    turnLog = [];
  };

  /** Cursor-style fold duration — also for incomplete turns (no MessageDone). */
  const sealWorked = (endMs: number) => {
    if (workedSealed || turn < 1 || turnStartMs <= 0) return;
    const ms = Math.max(0, endMs - turnStartMs);
    messages.push({
      kind: "worked",
      id: `worked-${sid || "s"}-t${turn}`,
      ms,
    });
    workedSealed = true;
  };

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const tag = `r${i}`;
    const at = eventMs(event);
    if (at) lastEventMs = at;
    if (event.sessionId) sid = event.sessionId;

    switch (event.type) {
      case "UserMessageAppended": {
        // Close previous turn (may lack MessageDone — still need Worked-for fold)
        const prevEnd = at || lastEventMs || Date.now();
        sealThoughtLog(prevEnd);
        flushThought();
        flushTools();
        flushAssistant();
        flushTurnLog();
        if (turn >= 1) sealWorked(prevEnd);
        postToolsId = null;
        turnDone = false;
        workedSealed = false;
        turn += 1;
        turnLog = [];
        thoughtActive = false;
        thoughtStartMs = 0;
        toolStartMs.clear();
        turnStartMs = at || Date.now();
        assistantId = `a-${event.sessionId}-t${turn}`;
        thoughtId = `t-${event.sessionId}-t${turn}`;
        toolsId = `tools-${event.sessionId}-t${turn}`;
        messages.push({
          kind: "user",
          text: event.text,
          id: `u-${event.sessionId}-t${turn}`,
          attachments: event.attachments?.length
            ? event.attachments
            : undefined,
          userTurnIndex: turn - 1, // turn is 1-based here
        });
        break;
      }
      case "ThoughtChunk": {
        if (turnDone) break;
        if (!thoughtActive) {
          thoughtActive = true;
          thoughtStartMs = at || Date.now();
        }
        thoughtBuf += event.text;
        break;
      }
      case "MessageChunk": {
        if (turnDone && !assistantBuf) break;
        sealThoughtLog(at || Date.now());
        if (tools.length > 0) flushTools();
        const last = messages[messages.length - 1];
        if (!assistantBuf && (last?.kind === "tools" || postToolsId)) {
          if (!postToolsId) {
            postToolsId = `a-${event.sessionId}-after-t${turn}`;
          }
          assistantId = postToolsId;
        }
        assistantBuf += event.text;
        break;
      }
      case "MessageDone": {
        const endMs = at || Date.now();
        sealThoughtLog(endMs);
        flushThought();
        flushTools();
        flushAssistant();
        flushTurnLog();
        sealWorked(endMs);
        turnDone = true;
        postToolsId = null;
        break;
      }
      case "ToolStarted": {
        if (turnDone) break;
        sealThoughtLog(at || Date.now());
        flushThought();
        // New thought id after tools — reuse would stack duplicate React keys
        thoughtId = `t-${event.sessionId}-t${turn}-${tag}`;
        // Intermediate speech stays a full assistant bubble (never demote to status)
        if (assistantBuf.trim()) {
          const text = assistantBuf.trim();
          const liveId = assistantId || `a-${event.sessionId}-t${turn}-${tag}`;
          messages.push({ kind: "assistant", text, id: `${liveId}-mid` });
          assistantBuf = "";
          assistantId = `a-${event.sessionId}-after-t${turn}-${tag}`;
        }
        postToolsId = null;
        if (!toolsId) toolsId = `tools-${event.sessionId}-t${turn}-${tag}`;
        const row = formatToolStarted({
          toolId: event.toolId,
          title: event.title,
          kind: event.kind,
          inputSummary: event.inputSummary,
        });
        tools = [...tools.filter((t) => t.toolId !== row.toolId), row];
        toolStartMs.set(event.toolId, at || Date.now());
        turnLog.push({
          tone: "run",
          text: row.label.startsWith("Ran ")
            ? row.label
            : `Run ${row.label}`,
        });
        break;
      }
      case "ToolProgress": {
        if (turnDone || !tools.length) break;
        tools = tools.map((t) => {
          if (t.toolId !== event.toolId) return t;
          const d = event.detail ?? "";
          const human =
            d && !d.startsWith("{") && !d.startsWith("[") && d.length < 120
              ? d.replace(/^Read\s+`([^`]+)`/, (_, p) =>
                  `Read ${String(p).split("/").pop()}`
                )
              : null;
          return {
            ...t,
            label: human || t.label,
            detailLines:
              d && d.length < 200 && (d.startsWith("{") || d.startsWith("["))
                ? t.detailLines
                : d
                  ? [d]
                  : t.detailLines,
          };
        });
        break;
      }
      case "ToolFinished": {
        if (turnDone || !tools.length) break;
        tools = tools.map((t) =>
          t.toolId === event.toolId
            ? formatToolFinished(t, event.outputSummary)
            : t
        );
        const started = toolStartMs.get(event.toolId);
        const dur =
          started && at ? formatDurationSec(Math.max(0, at - started)) : null;
        const row = tools.find((t) => t.toolId === event.toolId);
        const name = row?.label ?? "tool";
        // Upgrade last matching "Run …" line to completed if short run
        if (dur && turnLog.length) {
          const last = turnLog[turnLog.length - 1];
          if (last && last.tone === "run") {
            last.tone = "ok";
            last.text = `${name} · ${dur}`;
          }
        }
        break;
      }
      case "ToolFailed": {
        if (turnDone || !tools.length) break;
        tools = tools.map((t) =>
          t.toolId === event.toolId ? formatToolFailed(t, event.error) : t
        );
        turnLog.push({
          tone: "fail",
          text: `Failed: ${tidyToolError(event.error || "tool").slice(0, 120)}`,
        });
        break;
      }
      default:
        break;
    }
  }
  // Incomplete last turn (Stop / disconnect / import cut): still emit worked
  // so history folds process under Worked-for — never leave a naked trail.
  const eofMs = lastEventMs || Date.now();
  sealThoughtLog(eofMs);
  flushThought();
  flushTools();
  flushAssistant();
  flushTurnLog();
  sealWorked(eofMs);
  return messages;
}

/**
 * Keep only the last `turns` user-turns worth of items.
 *
 * Native chat apps (incl. GrokBuild's Swift/SwiftUI list) never pay for this —
 * virtualized lists only mount what's on screen. Our chat has no virtualization,
 * so a huge session (thousands of markdown bubbles + syntax-highlighted code
 * blocks) mounts its ENTIRE history into the DOM on every switch. That mount/
 * unmount churn — not the JSON parse — is what piles up and stalls the app
 * after repeated clicking. Windowing the initial paint bounds DOM size the
 * same way a virtualized list would.
 */
export function sliceLastUserTurns(
  messages: ChatItem[],
  turns: number
): { visible: ChatItem[]; hiddenCount: number } {
  if (turns <= 0 || messages.length === 0) {
    return { visible: messages, hiddenCount: 0 };
  }
  const userIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.kind === "user") userIdx.push(i);
  }
  if (userIdx.length <= turns) return { visible: messages, hiddenCount: 0 };
  const startIdx = userIdx[userIdx.length - turns]!;
  if (startIdx <= 0) return { visible: messages, hiddenCount: 0 };
  return { visible: messages.slice(startIdx), hiddenCount: startIdx };
}

function yieldToMain(): Promise<void> {
  return new Promise((r) => {
    // Prefer macrotask so input/pointer handlers can run before heavy convert.
    if (typeof MessageChannel !== "undefined") {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => r();
      ch.port2.postMessage(null);
    } else {
      setTimeout(r, 0);
    }
  });
}

/**
 * Index of the UserMessageAppended that starts the last `turns` user turns.
 * Used for fast first-paint of long histories (window first, full cache later).
 */
export function lastUserTurnEventStart(
  events: DomainEvent[],
  turns: number
): number {
  if (turns <= 0 || events.length === 0) return 0;
  let n = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "UserMessageAppended") {
      n++;
      if (n >= turns) return i;
    }
  }
  return 0;
}

/**
 * Same as eventsToChatItems, but yields so rapid sidebar clicks stay responsive.
 * Large histories: convert the visible tail first (returned immediately via
 * onPartial), then full timeline for cache / "Load earlier".
 */
export async function eventsToChatItemsAsync(
  events: DomainEvent[],
  opts?: {
    chunkSize?: number;
    shouldContinue?: () => boolean;
    /** Prefer last N user turns for first paint (default 40). */
    windowTurns?: number;
    /** Called with windowed items before full convert finishes. */
    onPartial?: (items: ChatItem[]) => void;
  }
): Promise<ChatItem[] | null> {
  const shouldContinue = opts?.shouldContinue ?? (() => true);
  const windowTurns = opts?.windowTurns ?? 40;
  if (!shouldContinue()) return null;

  await yieldToMain();
  if (!shouldContinue()) return null;

  // Fast path: small histories convert once.
  if (events.length <= 500) {
    const built = eventsToChatItems(events);
    return shouldContinue() ? built : null;
  }

  // Large: paint the last windowTurns first (Codex/Claude-style windowing),
  // then full convert after another yield so the sidebar click isn't frozen.
  const start = lastUserTurnEventStart(events, windowTurns);
  if (start > 0 && opts?.onPartial) {
    const partial = eventsToChatItems(events.slice(start));
    if (!shouldContinue()) return null;
    opts.onPartial(partial);
  }

  await yieldToMain();
  if (!shouldContinue()) return null;
  await new Promise<void>((r) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(() => r())
      : setTimeout(r, 0)
  );
  if (!shouldContinue()) return null;

  // Full convert — still sync, but selection + partial chat already painted.
  const built = eventsToChatItems(events);
  if (!shouldContinue()) return null;
  return built;
}

