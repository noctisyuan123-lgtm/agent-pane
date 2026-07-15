import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientCommand,
  DiffFileMeta,
  DomainEvent,
  ServerMessage,
  Task,
} from "@agent-pane/shared";
import {
  formatToolFailed,
  formatToolFinished,
  formatToolStarted,
  tidyToolError,
  type ToolRow,
} from "./toolFormat";
import {
  eventsToChatItems,
  formatDurationSec,
  sliceMessagesBeforeUserTurn,
  userTextAtTurn,
  userTurnIndexAt,
  type ChatItem,
  type TurnLogLine,
} from "./chatFromEvents";
import { parseSessionInfoUsage } from "./contextUsage";

export type { ChatItem, TurnLogLine } from "./chatFromEvents";
export {
  eventsToChatItems,
  formatDurationSec,
  sliceMessagesBeforeUserTurn,
  userTextAtTurn,
  userTurnIndexAt,
} from "./chatFromEvents";
export type { ToolRow };

export type PermissionReq = {
  requestId: string;
  tool: string;
  summary: string;
};

import {
  getEffortFor,
  migrateLegacyEffort,
  setEffortFor,
  type EffortLevel,
} from "./modelEffort";

export type AgentMode = "agent" | "auto" | "plan" | "debug" | "multitask";

/** Map UI mode → ACP permissionMode sent to bridge */
export function permissionModeFor(mode: AgentMode): "agent" | "auto" | "plan" {
  if (mode === "plan") return "plan";
  if (mode === "auto") return "auto";
  return "agent";
}

const WS_URL = import.meta.env.VITE_BRIDGE_WS ?? "ws://127.0.0.1:8787";

/** Update live assistant in place — never invent a second sealed id (that duplicates bubbles). */
function upsertAssistant(
  messages: ChatItem[],
  buf: string,
  liveId: string
): ChatItem[] {
  if (!buf.trim()) {
    return messages.filter((m) => !(m.kind === "assistant" && m.id === liveId));
  }
  const next = [...messages];
  const idx = next.findIndex((x) => x.id === liveId && x.kind === "assistant");
  if (idx >= 0) {
    next[idx] = { kind: "assistant", text: buf, id: liveId };
  } else {
    // Drop consecutive exact-duplicate assistant (polluted replay / double stream)
    const last = next[next.length - 1];
    if (last?.kind === "assistant" && last.text === buf) {
      return next;
    }
    next.push({ kind: "assistant", text: buf, id: liveId });
  }
  return next;
}

/** Collapse back-to-back identical assistant bubbles (history load pollution). */
function collapseDuplicateAssistants(messages: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === "assistant" &&
      m.kind === "assistant" &&
      prev.text.trim() === m.text.trim()
    ) {
      continue;
    }
    out.push(m);
  }
  return out;
}

/** Pre-tool chatter → status line (or drop if empty). */
function sealAsStatus(
  messages: ChatItem[],
  buf: string,
  liveId: string
): ChatItem[] {
  const text = buf.trim();
  const without = messages.filter((m) => m.id !== liveId);
  if (!text) return without;
  // Very short tool preambles only — long text stays assistant
  if (text.length > 280 || text.includes("\n\n")) {
    without.push({ kind: "assistant", text, id: `${liveId}-pre` });
  } else {
    without.push({ kind: "status", text, id: `${liveId}-status` });
  }
  return without;
}

export function useBridge() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    kind: "usage" | "info";
    title: string;
    body: string;
  } | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cwd, setCwd] = useState(localStorage.getItem("agent-pane-cwd") || "");
  const [model, setModelState] = useState(
    () => localStorage.getItem("agent-pane-model") || "grok-4.5"
  );
  const [effort, setEffortState] = useState<EffortLevel>(() => {
    const mid = localStorage.getItem("agent-pane-model") || "grok-4.5";
    migrateLegacyEffort(mid);
    return getEffortFor(mid).effort;
  });
  const [effortFast, setEffortFastState] = useState(() => {
    const mid = localStorage.getItem("agent-pane-model") || "grok-4.5";
    return getEffortFor(mid).fast;
  });

  const setModel = useCallback((id: string) => {
    setModelState(id);
    localStorage.setItem("agent-pane-model", id);
    const pref = getEffortFor(id);
    setEffortState(pref.effort);
    setEffortFastState(pref.fast);
  }, []);

  const setEffort = useCallback(
    (level: EffortLevel) => {
      setEffortState(level);
      setEffortFastState(false);
      setEffortFor(model, { effort: level, fast: false });
    },
    [model]
  );

  const setEffortFast = useCallback(
    (fast: boolean) => {
      setEffortFastState(fast);
      setEffortFor(model, { effort, fast });
    },
    [model, effort]
  );
  const [agentMode, setAgentMode] = useState<AgentMode>(() => {
    const raw = localStorage.getItem("agent-pane-mode") || "agent";
    return raw === "auto" ||
      raw === "plan" ||
      raw === "agent" ||
      raw === "debug" ||
      raw === "multitask"
      ? raw
      : "agent";
  });
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [diffs, setDiffs] = useState<DiffFileMeta[]>([]);
  const [permissions, setPermissions] = useState<PermissionReq[]>([]);
  const [busy, setBusy] = useState(false);
  const [contextUsage, setContextUsage] = useState<{
    used: number;
    size: number;
    source:
      | "acp"
      | "compact"
      | "compact_done"
      | "signals"
      | "session_info"
      | "estimate";
    at?: string;
    pct?: number;
  } | null>(null);
  const [restoredDraft, setRestoredDraft] = useState<string | null>(null);
  /** True while session.resume is in flight — must NOT flip Send→Stop */
  const [resuming, setResuming] = useState(false);
  /** 打开历史回放：尚无 live agent，发消息前会新开会话 */
  const [historyOnly, setHistoryOnly] = useState(false);
  const historyOnlyRef = useRef(false);
  historyOnlyRef.current = historyOnly;
  const assistantBuf = useRef("");
  const assistantLiveId = useRef("a-live");
  const thoughtLiveId = useRef("t-live");
  const toolsGroupId = useRef("tools-live");
  /** After tools in this turn — keep a single post-tool assistant bubble */
  const postToolsAssistantId = useRef<string | null>(null);
  const thoughtBufMap = useRef(new Map<string, string>());
  /** 已应用的 event.seq，防双连接/重放叠字 */
  const seenSeq = useRef(new Set<string>());
  /** 历史回放时不重置时间线 */
  const replayingRef = useRef(false);
  /** Monotonic index while replaying jsonl (seq is NOT unique after bad resumes) */
  const replayIndexRef = useRef(0);
  /** MessageDone already fired this turn — late chunks still merge into same bubble */
  const turnDoneRef = useRef(false);
  /** CLI-style ◆ turn log for the current live turn */
  const turnLogRef = useRef<TurnLogLine[]>([]);
  const thoughtStartRef = useRef<number | null>(null);
  const toolStartRef = useRef(new Map<string, number>());
  /** Wall-clock start of current user turn (Worked for Xs) */
  const turnStartedAtRef = useRef<number | null>(null);
  /** When current busy wait began (for "Waiting for response… 2.2s") */
  const busySinceRef = useRef<number | null>(null);
  const [busyElapsed, setBusyElapsed] = useState(0);
  /**
   * Message waiting for SessionStarted (create / resume).
   * Flushed inside SessionStarted — NOT via useEffect (effect cleanup was
   * swallowing the pending send and leaving UI on "正在恢复会话…").
   */
  const pendingPromptRef = useRef<{
    text: string;
    attachments?: { path: string; kind: "file" | "folder" }[];
  } | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  /** After SessionRewound: retry resends, edit fills composer, undo just restores */
  const afterRewindRef = useRef<null | {
    kind: "retry" | "edit" | "undo";
    text: string;
    userTurnIndex: number;
  }>(null);

  // Tick elapsed while busy for CLI-style "Waiting for response… 1.2s"
  useEffect(() => {
    if (!busy) {
      busySinceRef.current = null;
      setBusyElapsed(0);
      return;
    }
    if (busySinceRef.current == null) busySinceRef.current = Date.now();
    const tick = () => {
      const t0 = busySinceRef.current ?? Date.now();
      setBusyElapsed(Date.now() - t0);
    };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [busy]);

  const sealThoughtLogLine = useCallback(() => {
    if (thoughtStartRef.current == null) return;
    const ms = Date.now() - thoughtStartRef.current;
    thoughtStartRef.current = null;
    turnLogRef.current.push({
      tone: "dim",
      text: `Thought for ${formatDurationSec(ms)}`,
    });
  }, []);

  const pushTurnLog = useCallback(() => {
    const lines = turnLogRef.current;
    if (!lines.length) return;
    const id = `log-${sessionIdRef.current ?? "live"}-${Date.now()}`;
    const snapshot = [...lines];
    turnLogRef.current = [];
    setMessages((m) => [...m, { kind: "turn_log", id, lines: snapshot }]);
  }, []);

  const send = useCallback((cmd: ClientCommand) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Bridge offline — reconnecting, try send again when connected");
      setConnected(false);
      return;
    }
    ws.send(JSON.stringify(cmd));
  }, []);

  const flushPendingPrompt = useCallback(
    (sid: string) => {
      const pending = pendingPromptRef.current;
      if (!pending?.text?.trim() && !(pending?.attachments?.length)) return;
      pendingPromptRef.current = null;
      setBusy(true);
      setStatusMsg(null);
      send({
        type: "session.prompt",
        sessionId: sid,
        text: (pending?.text || "").trim() || "(attached files)",
        attachments: pending?.attachments,
      });
    },
    [send]
  );

  const applyEvent = useCallback((event: DomainEvent) => {
    // 去重：永远带上 at+type。旧 resume 会重复 seq=1..N，只按 seq 去重会把后半段
    //（尤其最后一轮）整段吞掉。真重复事件 at 相同，仍可挡住。
    const ri = replayingRef.current ? replayIndexRef.current : -1;
    const textHint =
      typeof (event as { text?: string }).text === "string"
        ? (event as { text: string }).text.slice(0, 24)
        : "";
    const seqKey = replayingRef.current
      ? `${event.sessionId}:replay:${ri}:${event.type}`
      : event.type === "SessionStarted" &&
          (event as { resumed?: boolean }).resumed
        ? `${event.sessionId}:SessionStarted:resumed:${event.at}`
        : `${event.sessionId}:${event.seq ?? "x"}:${event.at ?? ""}:${event.type}:${textHint}`;
    if (seenSeq.current.has(seqKey)) return;
    seenSeq.current.add(seqKey);
    if (seenSeq.current.size > 50_000) {
      seenSeq.current.clear();
    }

    // Unique turn ids during replay (seq alone is not unique in polluted logs)
    const turnTag = replayingRef.current
      ? `r${ri}`
      : String(event.seq ?? event.at ?? Date.now());

    switch (event.type) {
      case "SessionStarted":
        setSessionId(event.sessionId);
        sessionIdRef.current = event.sessionId;
        setCwd(event.cwd);
        if (event.model) setModel(event.model);
        setError(null);
        setStatusMsg(null);
        setResuming(false);
        // Don't keep a previous chat's usage ring on this session
        if (!replayingRef.current) setContextUsage(null);
        if (!replayingRef.current) {
          // Resume re-attaches without wiping the timeline we just loaded
          if (event.resumed) {
            setHistoryOnly(false);
            // Clear this session's live dedupe keys so post-resume stream paints
            const prefix = `${event.sessionId}:`;
            for (const k of [...seenSeq.current]) {
              if (k.startsWith(prefix) && !k.includes(":replay:")) {
                seenSeq.current.delete(k);
              }
            }
            seenSeq.current.add(seqKey);
            assistantBuf.current = "";
            thoughtBufMap.current.clear();
            postToolsAssistantId.current = null;
            turnDoneRef.current = false;
            assistantLiveId.current = `a-${event.sessionId}-live`;
            thoughtLiveId.current = `t-${event.sessionId}-live`;
            toolsGroupId.current = `tools-${event.sessionId}-live`;
          } else {
            setMessages([]);
            setTasks([]);
            setDiffs([]);
            setContextUsage(null);
            assistantBuf.current = "";
            thoughtBufMap.current.clear();
            postToolsAssistantId.current = null;
            turnDoneRef.current = false;
            seenSeq.current.clear();
            seenSeq.current.add(seqKey);
            setHistoryOnly(false);
          }
          // Flush queued message here (not useEffect) so resume never "eats" Send
          if (pendingPromptRef.current) {
            setBusy(true);
            const sid = event.sessionId;
            window.setTimeout(() => flushPendingPrompt(sid), 30);
          } else {
            setBusy(false);
          }
        }
        if (!event.resumed || replayingRef.current) {
          assistantLiveId.current = `a-${event.sessionId}-live`;
          thoughtLiveId.current = `t-${event.sessionId}-live`;
          toolsGroupId.current = `tools-${event.sessionId}-live`;
        }
        break;

      case "UserMessageAppended":
        setMessages((m) => {
          // Drop optimistic bubble with same text (resume/create queue)
          const withoutOpt = m.filter(
            (x) =>
              !(
                x.kind === "user" &&
                x.id.startsWith("u-optimistic-") &&
                x.text === event.text
              )
          );
          return [
            ...withoutOpt,
            {
              kind: "user",
              text: event.text,
              id: `u-${event.sessionId}-${turnTag}`,
              attachments: event.attachments?.length
                ? event.attachments
                : undefined,
            },
          ];
        });
        if (!replayingRef.current) setBusy(true);
        assistantBuf.current = "";
        thoughtBufMap.current.clear();
        postToolsAssistantId.current = null;
        turnDoneRef.current = false;
        turnLogRef.current = [];
        thoughtStartRef.current = null;
        toolStartRef.current.clear();
        turnStartedAtRef.current = Date.now();
        // new live assistant id each user turn (unique even when seq repeats)
        assistantLiveId.current = `a-${event.sessionId}-${turnTag}`;
        thoughtLiveId.current = `t-${event.sessionId}-${turnTag}`;
        toolsGroupId.current = `tools-${event.sessionId}-${turnTag}`;
        break;

      case "MessageChunk": {
        // 重要：assistantBuf += 必须在 setState 外；StrictMode 会双跑 updater。
        sealThoughtLogLine();
        const wasEmpty = assistantBuf.current === "";
        assistantBuf.current += event.text;
        const textSnapshot = assistantBuf.current;

        setMessages((m) => {
          let id = assistantLiveId.current;
          const last = m[m.length - 1];

          // After tools: one bubble per tools-group (NOT per session — that
          // collapsed every turn into one id and the last reply overwrote
          // earlier ones when replaying history).
          if (wasEmpty && (last?.kind === "tools" || postToolsAssistantId.current)) {
            if (postToolsAssistantId.current) {
              id = postToolsAssistantId.current;
            } else {
              id = `a-${event.sessionId}-after-${toolsGroupId.current}`;
              postToolsAssistantId.current = id;
            }
            assistantLiveId.current = id;
          }

          // Late chunks after MessageDone: keep merging into current live bubble
          // (do NOT open a second bubble — that was the double-hello bug)
          return upsertAssistant(m, textSnapshot, id);
        });
        break;
      }

      case "ThoughtChunk": {
        // After MessageDone, ignore residual thought stream (was spawning extra bubbles)
        if (turnDoneRef.current) break;
        if (thoughtStartRef.current == null) {
          thoughtStartRef.current = Date.now();
        }
        const id = thoughtLiveId.current;
        const prev =
          (thoughtBufMap.current.get(id) ?? "") + event.text;
        thoughtBufMap.current.set(id, prev);
        const textSnapshot = prev;
        setMessages((m) => {
          const next = [...m];
          const idx = next.findIndex((x) => x.id === id && x.kind === "thought");
          if (idx >= 0) {
            next[idx] = { kind: "thought", text: textSnapshot, id };
          } else {
            next.push({ kind: "thought", text: textSnapshot, id });
          }
          return next;
        });
        break;
      }

      case "MessageDone":
        // Finalize in place — keep buffer id so residual chunks still merge.
        // Only clear buffer on next UserMessageAppended.
        sealThoughtLogLine();
        if (assistantBuf.current.trim()) {
          const sealed = assistantBuf.current;
          const liveId = assistantLiveId.current;
          setMessages((m) =>
            collapseDuplicateAssistants(upsertAssistant(m, sealed, liveId))
          );
        } else {
          // Empty done can still leave a trailing twin from a prior seal
          setMessages((m) => collapseDuplicateAssistants(m));
        }
        pushTurnLog();
        {
          const t0 = turnStartedAtRef.current;
          const ms = t0 != null ? Math.max(0, Date.now() - t0) : 0;
          if (ms > 0) {
            const id = `worked-${sessionIdRef.current ?? "live"}-${Date.now()}`;
            setMessages((m) => [
              ...m,
              { kind: "worked" as const, id, ms },
            ]);
          }
          turnStartedAtRef.current = null;
        }
        turnDoneRef.current = true;
        setBusy(false);
        break;

      case "ToolStarted": {
        // CRITICAL: after MessageDone, never re-seal the finished assistant as
        // "pre-tool" — polluted logs / residual tools would delete the last reply.
        if (turnDoneRef.current) {
          break;
        }
        sealThoughtLogLine();
        // Seal this thought bubble; further thinking after tools gets a new id
        thoughtBufMap.current.delete(thoughtLiveId.current);
        thoughtLiveId.current = `t-${event.sessionId}-pretool-${event.seq ?? Date.now()}`;
        thoughtStartRef.current = null;
        // Pre-tool agent chatter → muted status, not a full reply bubble
        const sealedBuf = assistantBuf.current;
        const liveId = assistantLiveId.current;
        if (sealedBuf.trim()) {
          assistantBuf.current = "";
          setMessages((m) => sealAsStatus(m, sealedBuf, liveId));
        }
        // Next message chunks after tools get a dedicated bubble
        postToolsAssistantId.current = null;

        const row = formatToolStarted({
          toolId: event.toolId,
          title: event.title,
          kind: event.kind,
          inputSummary: event.inputSummary,
        });
        toolStartRef.current.set(event.toolId, Date.now());
        turnLogRef.current.push({
          tone: "run",
          text: row.label.startsWith("Ran ") ? row.label : `Run ${row.label}`,
        });

        setMessages((m) => {
          const gid = toolsGroupId.current;
          const next = [...m];
          const idx = next.findIndex((x) => x.id === gid && x.kind === "tools");
          if (idx >= 0 && next[idx].kind === "tools") {
            const tools = [
              ...next[idx].tools.filter((t) => t.toolId !== row.toolId),
              row,
            ];
            next[idx] = { kind: "tools", id: gid, tools };
          } else {
            // new tools group after sealed text
            toolsGroupId.current = `tools-${event.sessionId}-${event.seq ?? Date.now()}`;
            next.push({
              kind: "tools",
              id: toolsGroupId.current,
              tools: [row],
            });
          }
          return next;
        });
        break;
      }

      case "ToolProgress":
        setMessages((m) =>
          m.map((item) => {
            if (item.kind !== "tools") return item;
            return {
              ...item,
              tools: item.tools.map((t) => {
                if (t.toolId !== event.toolId) return t;
                const d = event.detail ?? "";
                // Never promote permission/pending noise into the tool label
                // (was showing "Failed: pending: permission failed")
                if (
                  /^pending:/i.test(d) ||
                  /permission/i.test(d) ||
                  d.startsWith("{") ||
                  d.startsWith("[")
                ) {
                  return t;
                }
                // ACP 常在 update 里给人类可读 title：Read `path`
                const human =
                  d && d.length < 120
                    ? d.replace(/^Read\s+`([^`]+)`/, (_, p) =>
                        `Read ${String(p).split("/").pop()}`
                      )
                    : null;
                return {
                  ...t,
                  label: human || t.label,
                  detailLines: d && d.length < 200 ? [d] : t.detailLines,
                };
              }),
            };
          })
        );
        break;

      case "AgentActivity": {
        const text = event.text?.trim() || null;
        setStatusMsg(text);
        break;
      }

      case "ContextUsage": {
        setContextUsage((prev) => {
          // Don't let a stale signals read overwrite a higher session-info reading
          if (
            prev &&
            event.source === "signals" &&
            prev.source === "session_info" &&
            event.used + 500 < prev.used
          ) {
            return prev;
          }
          // History/import estimate: ignore tiny live signals until a real turn
          // reports comparable usage (resume digest sessions look ~2%).
          if (
            prev &&
            prev.source === "estimate" &&
            historyOnlyRef.current &&
            event.source === "signals" &&
            event.used + 2_000 < prev.used * 0.5
          ) {
            return prev;
          }
          if (
            prev &&
            event.source === "signals" &&
            event.used + 500 < prev.used &&
            prev.source !== "compact_done"
          ) {
            return prev;
          }
          return {
            used: event.used,
            size: event.size,
            source: event.source,
            at: event.at,
            pct: event.pct,
          };
        });
        break;
      }

      case "ToolFinished": {
        const started = toolStartRef.current.get(event.toolId);
        const dur = started
          ? formatDurationSec(Date.now() - started)
          : null;
        setMessages((m) =>
          m.map((item) => {
            if (item.kind !== "tools") return item;
            return {
              ...item,
              tools: item.tools.map((t) => {
                if (t.toolId !== event.toolId) return t;
                const done = formatToolFinished(t, event.outputSummary);
                if (dur && turnLogRef.current.length) {
                  const last = turnLogRef.current[turnLogRef.current.length - 1];
                  if (last?.tone === "run") {
                    last.tone = "ok";
                    last.text = `${done.label} · ${dur}`;
                  }
                }
                return done;
              }),
            };
          })
        );
        break;
      }

      case "ToolFailed":
        turnLogRef.current.push({
          tone: "fail",
          text: `Failed: ${tidyToolError(event.error || "tool").slice(0, 120)}`,
        });
        setMessages((m) =>
          m.map((item) => {
            if (item.kind !== "tools") return item;
            return {
              ...item,
              tools: item.tools.map((t) =>
                t.toolId === event.toolId
                  ? formatToolFailed(t, event.error)
                  : t
              ),
            };
          })
        );
        break;

      case "TasksReplaced":
        setTasks(event.tasks);
        break;
      case "TaskUpserted":
        setTasks((ts) => {
          const i = ts.findIndex((t) => t.id === event.task.id);
          if (i < 0) return [...ts, event.task];
          const next = [...ts];
          next[i] = event.task;
          return next;
        });
        break;
      case "TaskRemoved":
        setTasks((ts) => ts.filter((t) => t.id !== event.taskId));
        break;
      case "PermissionRequested":
        setPermissions((p) => [
          ...p,
          {
            requestId: event.requestId,
            tool: event.tool,
            summary: event.summary,
          },
        ]);
        break;
      case "PermissionResolved":
        setPermissions((p) => p.filter((x) => x.requestId !== event.requestId));
        break;
      case "DiffProposed":
        setDiffs(event.files);
        break;
      case "DiffResolved":
        if (event.filePath === "*") setDiffs([]);
        else setDiffs((d) => d.filter((f) => f.path !== event.filePath));
        break;
      case "SessionError":
        setResuming(false);
        // Idle agent exit is expected — don't flash a red error, just mark resumable
        if (
          /exited|disconnect|not alive|EPIPE/i.test(event.message) &&
          !/fail|无法|error|崩溃/i.test(event.message)
        ) {
          setBusy(false);
          setStatusMsg(null);
          setHistoryOnly(true);
          break;
        }
        setError(event.message);
        setBusy(false);
        setStatusMsg(null);
        // agent 挂了 / 断线：标 historyOnly，下次 Send 会 resume 同一 session
        if (
          /exited|disconnect|Unknown session|not started|ECONN|not running|not alive|resume|timed out|Authentication|认证/i.test(
            event.message
          )
        ) {
          setHistoryOnly(true);
        }
        break;
      case "SessionEnded":
        setBusy(false);
        setResuming(false);
        setStatusMsg(null);
        // Idle death / stop — keep timeline, allow resume on next send
        if (
          event.stopReason &&
          /exited|client_stop|disconnect/i.test(event.stopReason)
        ) {
          setHistoryOnly(true);
        }
        break;
      case "SessionRewound": {
        const turnIdx =
          typeof event.userTurnIndex === "number" ? event.userTurnIndex : -1;
        setMessages((m) => {
          if (turnIdx >= 0) return sliceMessagesBeforeUserTurn(m, turnIdx);
          let lastUser = -1;
          for (let i = m.length - 1; i >= 0; i--) {
            if (m[i]!.kind === "user") {
              lastUser = i;
              break;
            }
          }
          if (lastUser < 0) return m;
          return m.slice(0, lastUser);
        });
        setTasks([]);
        setPermissions([]);
        setBusy(false);
        assistantBuf.current = "";
        thoughtBufMap.current.clear();
        postToolsAssistantId.current = null;
        const action = afterRewindRef.current;
        afterRewindRef.current = null;
        const text = (action?.text || event.restoredText || "").trim();
        if (action?.kind === "retry" && text && sessionIdRef.current) {
          setRestoredDraft(null);
          setError(null);
          const sid = sessionIdRef.current;
          window.setTimeout(() => {
            setBusy(true);
            send({ type: "session.prompt", sessionId: sid, text });
          }, 40);
        } else if (action?.kind === "edit" && text) {
          setRestoredDraft(text);
          setError(null);
        } else {
          setRestoredDraft(event.restoredText);
          if (event.note && !event.providerOk) {
            setError(event.note);
          } else {
            setError(null);
          }
        }
        break;
      }
      default:
        break;
    }
  }, [flushPendingPrompt, send, sealThoughtLogLine, pushTurnLog]);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => {
        if (!closed) {
          setConnected(true);
          setError(null);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) {
          retry = setTimeout(connect, 1500);
        }
      };
      ws.onerror = () => {
        setError("WebSocket error — is the bridge running (port 8787)?");
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as ServerMessage;
          if (msg.type === "event") applyEvent(msg.event);
          else if (msg.type === "replay") {
            for (const e of msg.events) applyEvent(e);
          } else if (msg.type === "error") {
            setError(msg.message);
            setBusy(false);
            setResuming(false);
            setStatusMsg(null);
            // Resume/create failed before SessionStarted — put queued text back
            const pending = pendingPromptRef.current;
            if (pending?.text?.trim()) {
              setRestoredDraft(pending.text);
              pendingPromptRef.current = null;
              setMessages((m) =>
                m.filter(
                  (x) =>
                    !(
                      x.kind === "user" &&
                      x.id.startsWith("u-optimistic-") &&
                      x.text === pending.text
                    )
                )
              );
            }
            if (
              /Unknown session|not found|exited|disconnect|恢复|resume|timeout|Authentication|认证/i.test(
                msg.message
              )
            ) {
              setHistoryOnly(true);
            }
          } else if (msg.type === "status") {
            setStatusMsg(msg.message?.trim() ? msg.message : null);
          } else if (msg.type === "notice") {
            setNotice({
              kind: msg.kind,
              title: msg.title,
              body: msg.body,
            });
          }
        } catch {
          /* ignore */
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [applyEvent]);

  const queuePromptAfterAttach = useCallback(
    (
      text: string,
      attachments?: { path: string; kind: "file" | "folder" }[]
    ) => {
      pendingPromptRef.current = {
        text: text.trim(),
        attachments: attachments?.length ? attachments : undefined,
      };
      // Optimistic user bubble while resume/create runs (removed if real
      // UserMessageAppended arrives with same text, or on resume failure).
      const t = text.trim() || (attachments?.length ? "(attached files)" : "");
      if (t || attachments?.length) {
        const oid = `u-optimistic-${Date.now()}`;
        setMessages((m) => [
          ...m,
          {
            kind: "user",
            text: t || "(attached files)",
            id: oid,
            attachments: attachments?.length ? attachments : undefined,
          },
        ]);
      }
    },
    []
  );

  const effectiveEffort = effortFast ? "minimal" : effort;

  const createSession = useCallback(() => {
    if (!cwd.trim()) {
      setError("Select a project folder first (cwd)");
      return;
    }
    localStorage.setItem("agent-pane-cwd", cwd.trim());
    if (model) localStorage.setItem("agent-pane-model", model);
    localStorage.setItem("agent-pane-effort", effort);
    localStorage.setItem("agent-pane-effort-fast", effortFast ? "1" : "0");
    localStorage.setItem("agent-pane-mode", agentMode);
    setMessages([]);
    setTasks([]);
    setDiffs([]);
    setPermissions([]);
    setContextUsage(null);
    setHistoryOnly(false);
    setSessionId(null); // 清掉旧 id，避免发到死会话
    // Only mark busy (red Stop) when a prompt is queued — bare New Agent is idle
    const willPrompt = Boolean(pendingPromptRef.current);
    setBusy(willPrompt);
    setError(null);
    setStatusMsg(willPrompt ? "Starting Grok agent…" : null);
    assistantBuf.current = "";
    thoughtBufMap.current.clear();
    postToolsAssistantId.current = null;
    turnDoneRef.current = false;
    seenSeq.current.clear();
    send({
      type: "session.create",
      cwd: cwd.trim(),
      model: model.trim() || undefined,
      effort: effectiveEffort,
      permissionMode: permissionModeFor(agentMode),
    });
  }, [cwd, model, effort, effortFast, effectiveEffort, agentMode, send]);

  /** Re-attach live agent to a history session (keep same sessionId + messages). */
  const resumeSession = useCallback(
    (histSessionId: string, histCwd: string) => {
      if (!histSessionId) return;
      localStorage.setItem("agent-pane-cwd", histCwd.trim() || cwd);
      if (model) localStorage.setItem("agent-pane-model", model);
      localStorage.setItem("agent-pane-effort", effort);
      localStorage.setItem("agent-pane-effort-fast", effortFast ? "1" : "0");
      localStorage.setItem("agent-pane-mode", agentMode);
      setResuming(true);
      setBusy(true);
      setError(null);
      setStatusMsg("正在恢复会话…");
      // Hard unlock if resume never completes (auth hang / silent stall)
      window.setTimeout(() => {
        setResuming((r) => {
          if (!r) return r;
          setBusy(false);
          setStatusMsg(null);
          setHistoryOnly(true);
          const pending = pendingPromptRef.current;
          if (pending?.text?.trim()) {
            setRestoredDraft(pending.text);
            pendingPromptRef.current = null;
            setMessages((m) =>
              m.filter(
                (x) =>
                  !(
                    x.kind === "user" &&
                    x.id.startsWith("u-optimistic-") &&
                    x.text === pending.text
                  )
              )
            );
          }
          setError(
            "恢复超时 — 请再点 Send，或终端跑 grok login 后重试"
          );
          return false;
        });
      }, 45_000);
      send({
        type: "session.resume",
        sessionId: histSessionId,
        cwd: (histCwd || cwd).trim(),
        model: model.trim() || undefined,
        effort: effectiveEffort,
        permissionMode: permissionModeFor(agentMode),
      });
    },
    [cwd, model, effort, effortFast, effectiveEffort, agentMode, send]
  );

  /**
   * Open from history: local event replay only (Cursor-style).
   * Does NOT spawn Grok / session/new — that happens lazily on Send via resumeSession.
   */
  const openHistorySession = useCallback(
    async (histSessionId: string, histCwd: string) => {
      try {
        setError(null);
        setStatusMsg(null);
        setBusy(true);
        // Drop any queued prompt from a previous resume attempt
        pendingPromptRef.current = null;
        const { fetchSessionEvents, deleteSessionApi, invalidateHistoryClientCache } =
          await import("./api");
        // Force disk read + clear dedupe so re-open isn't filtered by seenSeq
        const events = (await fetchSessionEvents(
          histSessionId,
          true
        )) as DomainEvent[];
        const hasUser = events.some((e) => e.type === "UserMessageAppended");
        if (!events.length || !hasUser) {
          try {
            await deleteSessionApi(histSessionId);
          } catch {
            /* already gone */
          }
          invalidateHistoryClientCache(histSessionId);
          setBusy(false);
          setError("Session is gone or empty — removed from history");
          return;
        }
        setTasks([]);
        setDiffs([]);
        setPermissions([]);
        assistantBuf.current = "";
        thoughtBufMap.current.clear();
        postToolsAssistantId.current = null;
        turnDoneRef.current = true;
        seenSeq.current.clear();
        setSessionId(histSessionId);
        setCwd(histCwd);
        localStorage.setItem("agent-pane-cwd", histCwd);
        const built = eventsToChatItems(events);
        setMessages(built);
        let lastUsage: {
          used: number;
          size: number;
          source:
            | "acp"
            | "compact"
            | "compact_done"
            | "signals"
            | "session_info"
            | "estimate";
          at?: string;
          pct?: number;
        } | null = null;
        let assistantScan = "";
        let infoProviderId: string | undefined;
        const takeUsage = (
          next: NonNullable<typeof lastUsage>
        ): void => {
          if (
            lastUsage &&
            next.source === "signals" &&
            lastUsage.source === "session_info" &&
            next.used + 500 < lastUsage.used
          ) {
            return;
          }
          if (
            lastUsage &&
            next.source === "signals" &&
            next.used + 500 < lastUsage.used &&
            lastUsage.source !== "compact_done"
          ) {
            return;
          }
          lastUsage = next;
        };
        for (const e of events) {
          if (e.type === "MessageChunk" && typeof e.text === "string") {
            assistantScan += e.text;
          } else if (e.type === "MessageDone") {
            const info = parseSessionInfoUsage(assistantScan);
            assistantScan = "";
            if (info?.providerSessionId) infoProviderId = info.providerSessionId;
            if (info && info.size > 0) {
              takeUsage({
                used: info.used,
                size: info.size,
                source: "session_info",
                pct: info.pct,
              });
            }
          } else if (e.type === "ContextUsage") {
            takeUsage({
              used: e.used,
              size: e.size,
              source: e.source,
              at: e.at,
              pct: e.pct,
            });
            if (e.providerSessionId) infoProviderId = e.providerSessionId;
          }
          const th =
            typeof (e as { text?: string }).text === "string"
              ? (e as { text: string }).text.slice(0, 24)
              : "";
          seenSeq.current.add(
            `${histSessionId}:${e.seq ?? "x"}:${e.at ?? ""}:${e.type}:${th}`
          );
        }
        // Local transcript size — CLI imports / history often lack matching signals
        // (resume creates a fresh Grok id with digest-only context).
        const { estimateMessagesTokens } = await import("./contextUsage");
        const estimated = estimateMessagesTokens(built);
        const fallbackSize = 500_000;
        try {
          const { fetchContextUsage } = await import("./api");
          const u = await fetchContextUsage({
            sessionId: histSessionId,
            cwd: histCwd,
            providerSessionId: infoProviderId,
          });
          if (u) {
            // Tiny signals vs fat transcript → digest resume; prefer estimate
            const signalsTooSmall =
              estimated > 8_000 && u.used + 2_000 < estimated * 0.5;
            if (signalsTooSmall) {
              takeUsage({
                used: estimated,
                size: u.size > 0 ? u.size : fallbackSize,
                source: "estimate",
                pct: Math.min(
                  100,
                  Math.round(
                    (estimated / (u.size > 0 ? u.size : fallbackSize)) * 100
                  )
                ),
              });
            } else {
              takeUsage({
                used: u.used,
                size: u.size,
                source: u.source,
                pct: u.pct,
              });
            }
          }
        } catch {
          /* ignore */
        }
        if (!lastUsage && estimated > 0) {
          lastUsage = {
            used: estimated,
            size: fallbackSize,
            source: "estimate",
            pct: Math.min(100, Math.round((estimated / fallbackSize) * 100)),
          };
        }
        // takeUsage mutates lastUsage outside TS control-flow tracking
        const usageNow = lastUsage;
        if (
          usageNow &&
          usageNow.source !== "session_info" &&
          estimated > 8_000 &&
          usageNow.used + 2_000 < estimated * 0.5
        ) {
          lastUsage = {
            used: estimated,
            size: usageNow.size > 0 ? usageNow.size : fallbackSize,
            source: "estimate",
            pct: Math.min(
              100,
              Math.round(
                (estimated /
                  (usageNow.size > 0 ? usageNow.size : fallbackSize)) *
                  100
              )
            ),
          };
        }
        setContextUsage(lastUsage);
        setHistoryOnly(true);
        setBusy(false);
      } catch (e) {
        replayingRef.current = false;
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    []
  );

  const prompt = useCallback(
    (
      text: string,
      attachments?: { path: string; kind: "file" | "folder" }[]
    ) => {
      if (!sessionId) {
        setError("Start a new session to connect Grok");
        return;
      }
      // Allow slash-only commands (/compact) and attachment-only sends
      if (!text.trim() && !(attachments && attachments.length)) return;
      send({
        type: "session.prompt",
        sessionId,
        text: text.trim() || (attachments?.length ? "(attached files)" : ""),
        attachments: attachments?.length ? attachments : undefined,
        permissionMode: permissionModeFor(agentMode),
      });
    },
    [send, sessionId, agentMode]
  );

  const cancel = useCallback(() => {
    if (sessionId) send({ type: "session.cancel", sessionId });
    setBusy(false);
  }, [send, sessionId]);

  const lastUserText = useCallback((): string | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.kind === "user") return m.text;
    }
    return null;
  }, [messages]);

  /** Slice UI timeline before a given user turn (works offline / historyOnly). */
  const rewindUiToUserTurn = useCallback((userTurnIndex: number) => {
    const text = userTextAtTurn(messages, userTurnIndex) || "";
    setMessages((m) => sliceMessagesBeforeUserTurn(m, userTurnIndex));
    setTasks([]);
    setPermissions([]);
    setBusy(false);
    assistantBuf.current = "";
    thoughtBufMap.current.clear();
    postToolsAssistantId.current = null;
    return text;
  }, [messages]);

  const rewindToTurn = useCallback(
    (
      userTurnIndex: number,
      kind: "undo" | "retry" | "edit"
    ) => {
      if (!sessionId) {
        setError("Nothing to undo");
        return;
      }
      const text = userTextAtTurn(messages, userTurnIndex);
      if (!text?.trim() && kind !== "undo") {
        setError("No user message at that turn");
        return;
      }
      if (historyOnly) {
        if (kind === "retry") {
          // Persist truncate, then resume + re-send (agent not attached)
          afterRewindRef.current = null;
          const restored = text || rewindUiToUserTurn(userTurnIndex);
          send({ type: "session.rewindTo", sessionId, userTurnIndex });
          setMessages((m) => sliceMessagesBeforeUserTurn(m, userTurnIndex));
          setError(null);
          pendingPromptRef.current = { text: restored };
          setBusy(true);
          setStatusMsg("正在恢复会话…");
          send({
            type: "session.resume",
            sessionId,
            cwd: cwd.trim(),
            model: model.trim() || undefined,
            effort: effectiveEffort,
            permissionMode: permissionModeFor(agentMode),
          });
        } else {
          afterRewindRef.current = {
            kind,
            text: text || "",
            userTurnIndex,
          };
          send({ type: "session.rewindTo", sessionId, userTurnIndex });
        }
        return;
      }
      afterRewindRef.current = {
        kind,
        text: text || "",
        userTurnIndex,
      };
      send({ type: "session.rewindTo", sessionId, userTurnIndex });
    },
    [
      send,
      sessionId,
      historyOnly,
      messages,
      rewindUiToUserTurn,
      cwd,
      model,
      effectiveEffort,
      agentMode,
    ]
  );

  const undoLast = useCallback(() => {
    const idx = userTurnIndexAt(messages, messages.length - 1);
    if (idx < 0) {
      setError("Nothing to undo");
      return;
    }
    rewindToTurn(idx, "undo");
  }, [messages, rewindToTurn]);

  const retryLast = useCallback(() => {
    const idx = userTurnIndexAt(messages, messages.length - 1);
    if (idx < 0) {
      setError("Nothing to retry");
      return;
    }
    rewindToTurn(idx, "retry");
  }, [messages, rewindToTurn]);

  const editLast = useCallback(() => {
    const idx = userTurnIndexAt(messages, messages.length - 1);
    if (idx < 0) {
      setError("Nothing to edit");
      return;
    }
    rewindToTurn(idx, "edit");
  }, [messages, rewindToTurn]);

  const undoAt = useCallback(
    (messageIndex: number) => {
      const idx = userTurnIndexAt(messages, messageIndex);
      if (idx < 0) {
        setError("Nothing to undo");
        return;
      }
      rewindToTurn(idx, "undo");
    },
    [messages, rewindToTurn]
  );

  const retryAt = useCallback(
    (messageIndex: number) => {
      const idx = userTurnIndexAt(messages, messageIndex);
      if (idx < 0) {
        setError("Nothing to retry");
        return;
      }
      rewindToTurn(idx, "retry");
    },
    [messages, rewindToTurn]
  );

  const editAt = useCallback(
    (messageIndex: number) => {
      const idx = userTurnIndexAt(messages, messageIndex);
      if (idx < 0) {
        setError("Nothing to edit");
        return;
      }
      rewindToTurn(idx, "edit");
    },
    [messages, rewindToTurn]
  );

  const clearRestoredDraft = useCallback(() => setRestoredDraft(null), []);

  const respondPermission = useCallback(
    (requestId: string, allow: boolean) => {
      send({ type: "permission.respond", requestId, allow });
    },
    [send]
  );

  const acceptDiff = useCallback(
    (filePath: string | "*") => {
      if (!sessionId) return;
      send({ type: "diff.accept", sessionId, filePath });
    },
    [send, sessionId]
  );

  const rejectDiff = useCallback(
    (filePath: string | "*") => {
      if (!sessionId) return;
      send({ type: "diff.reject", sessionId, filePath });
    },
    [send, sessionId]
  );

  return {
    connected,
    error,
    setError,
    statusMsg,
    notice,
    clearNotice: () => setNotice(null),
    /** ms since busy started — for "Waiting for response… 2.2s" */
    busyElapsed,
    sessionId,
    cwd,
    setCwd,
    model,
    setModel,
    effort,
    setEffort,
    effortFast,
    setEffortFast,
    effectiveEffort,
    agentMode,
    setAgentMode,
    messages,
    contextUsage,
    tasks,
    diffs,
    permissions,
    busy,
    /** Resume in flight — Send must stay Send, not Stop */
    resuming,
    historyOnly,
    restoredDraft,
    clearRestoredDraft,
    createSession,
    resumeSession,
    queuePromptAfterAttach,
    openHistorySession,
    prompt,
    cancel,
    undoLast,
    retryLast,
    editLast,
    undoAt,
    retryAt,
    editAt,
    respondPermission,
    acceptDiff,
    rejectDiff,
  };
}
