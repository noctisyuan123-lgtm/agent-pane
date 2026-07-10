import type { DomainEvent } from "@agent-pane/shared";
import {
  formatToolFailed,
  formatToolFinished,
  formatToolStarted,
  type ToolRow,
} from "./toolFormat";

export type TurnLogLine = {
  /** dim = thought, ok = success, run = tool, fail = error */
  tone: "dim" | "ok" | "run" | "fail";
  text: string;
};

export type ChatItem =
  | { kind: "user"; text: string; id: string }
  | { kind: "assistant"; text: string; id: string }
  /** Short pre-tool narration — muted, not a full reply bubble */
  | { kind: "status"; text: string; id: string }
  | { kind: "thought"; text: string; id: string }
  | { kind: "tools"; id: string; tools: ToolRow[] }
  /** Grok CLI-style end-of-turn step log (◆ Thought / Task / Run) */
  | { kind: "turn_log"; id: string; lines: TurnLogLine[] };

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

  const sealThoughtLog = (endMs: number) => {
    if (!thoughtActive) return;
    const ms = thoughtStartMs ? Math.max(0, endMs - thoughtStartMs) : 0;
    turnLog.push({
      tone: "dim",
      text: `Thought for ${formatDurationSec(ms)}`,
    });
    thoughtActive = false;
    thoughtStartMs = 0;
  };

  const flushThought = () => {
    const t = thoughtBuf.trim();
    if (t && thoughtId) {
      messages.push({ kind: "thought", text: t, id: thoughtId });
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

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const tag = `r${i}`;
    const at = eventMs(event);
    if (event.sessionId) sid = event.sessionId;

    switch (event.type) {
      case "UserMessageAppended": {
        flushThought();
        flushTools();
        flushAssistant();
        flushTurnLog();
        postToolsId = null;
        turnDone = false;
        turn += 1;
        turnLog = [];
        thoughtActive = false;
        thoughtStartMs = 0;
        toolStartMs.clear();
        assistantId = `a-${event.sessionId}-t${turn}`;
        thoughtId = `t-${event.sessionId}-t${turn}`;
        toolsId = `tools-${event.sessionId}-t${turn}`;
        messages.push({
          kind: "user",
          text: event.text,
          id: `u-${event.sessionId}-t${turn}`,
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
        sealThoughtLog(at || Date.now());
        flushThought();
        flushTools();
        flushAssistant();
        flushTurnLog();
        turnDone = true;
        postToolsId = null;
        break;
      }
      case "ToolStarted": {
        if (turnDone) break;
        sealThoughtLog(at || Date.now());
        flushThought();
        if (assistantBuf.trim()) {
          const text = assistantBuf.trim();
          const liveId = assistantId;
          if (text.length > 280 || text.includes("\n\n")) {
            messages.push({ kind: "assistant", text, id: `${liveId}-pre` });
          } else {
            messages.push({ kind: "status", text, id: `${liveId}-status` });
          }
          assistantBuf = "";
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
          text: `Failed: ${event.error?.slice(0, 80) || "tool"}`,
        });
        break;
      }
      default:
        break;
    }
  }
  sealThoughtLog(Date.now());
  flushThought();
  flushTools();
  flushAssistant();
  flushTurnLog();
  return messages;
}
