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
  type ToolRow,
} from "./toolFormat";
import {
  eventsToChatItems,
  formatDurationSec,
  type ChatItem,
  type TurnLogLine,
} from "./chatFromEvents";

export type { ChatItem, TurnLogLine } from "./chatFromEvents";
export { eventsToChatItems, formatDurationSec } from "./chatFromEvents";
export type { ToolRow };

export type PermissionReq = {
  requestId: string;
  tool: string;
  summary: string;
};

export type AgentMode = "agent" | "auto" | "plan";

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
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cwd, setCwd] = useState(localStorage.getItem("agent-pane-cwd") || "");
  const [model, setModel] = useState(
    () => localStorage.getItem("agent-pane-model") || "grok-4.5"
  );
  const [agentMode, setAgentMode] = useState<AgentMode>(() => {
    const raw = localStorage.getItem("agent-pane-mode") || "agent";
    return raw === "auto" || raw === "plan" || raw === "agent" ? raw : "agent";
  });
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [diffs, setDiffs] = useState<DiffFileMeta[]>([]);
  const [permissions, setPermissions] = useState<PermissionReq[]>([]);
  const [busy, setBusy] = useState(false);
  const [restoredDraft, setRestoredDraft] = useState<string | null>(null);
  /** 打开历史回放：尚无 live agent，发消息前会新开会话 */
  const [historyOnly, setHistoryOnly] = useState(false);
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
  const afterRewindRef = useRef<null | { kind: "retry" | "edit" | "undo"; text: string }>(
    null
  );

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
        setMessages((m) => [
          ...m,
          {
            kind: "user",
            text: event.text,
            id: `u-${event.sessionId}-${turnTag}`,
          },
        ]);
        if (!replayingRef.current) setBusy(true);
        assistantBuf.current = "";
        thoughtBufMap.current.clear();
        postToolsAssistantId.current = null;
        turnDoneRef.current = false;
        turnLogRef.current = [];
        thoughtStartRef.current = null;
        toolStartRef.current.clear();
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
        // 用 ref 累加，避免 StrictMode 双跑
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
          text: `Failed: ${(event.error || "tool").slice(0, 80)}`,
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
        setError(event.message);
        setBusy(false);
        setStatusMsg(null);
        // agent 挂了 / 断线：标 historyOnly，下次 Send 会 resume 同一 session
        if (
          /exited|disconnect|Unknown session|not started|ECONN|not running|not alive|resume|timed out/i.test(
            event.message
          )
        ) {
          setHistoryOnly(true);
        }
        break;
      case "SessionEnded":
        setBusy(false);
        // Idle death / stop — keep timeline, allow resume on next send
        if (
          event.stopReason &&
          /exited|client_stop|disconnect/i.test(event.stopReason)
        ) {
          setHistoryOnly(true);
        }
        break;
      case "SessionRewound": {
        setMessages((m) => {
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
          // Re-send same user turn after UI rewind
          const sid = sessionIdRef.current;
          window.setTimeout(() => {
            setBusy(true);
            send({ type: "session.prompt", sessionId: sid, text });
          }, 40);
        } else if (action?.kind === "edit" && text) {
          setRestoredDraft(text);
          setError(null);
        } else {
          // Plain undo — put text back in composer for convenience
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
            setStatusMsg(null);
            if (
              /Unknown session|not found|exited|disconnect|恢复|resume|timeout/i.test(
                msg.message
              )
            ) {
              setHistoryOnly(true);
            }
          } else if (msg.type === "status") {
            setStatusMsg(msg.message?.trim() ? msg.message : null);
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
    },
    []
  );

  const createSession = useCallback(() => {
    if (!cwd.trim()) {
      setError("Select a project folder first (cwd)");
      return;
    }
    localStorage.setItem("agent-pane-cwd", cwd.trim());
    if (model) localStorage.setItem("agent-pane-model", model);
    localStorage.setItem("agent-pane-mode", agentMode);
    setMessages([]);
    setTasks([]);
    setDiffs([]);
    setPermissions([]);
    setHistoryOnly(false);
    setSessionId(null); // 清掉旧 id，避免发到死会话
    setBusy(true);
    setError(null);
    setStatusMsg("Starting Grok agent…");
    assistantBuf.current = "";
    thoughtBufMap.current.clear();
    postToolsAssistantId.current = null;
    turnDoneRef.current = false;
    seenSeq.current.clear();
    send({
      type: "session.create",
      cwd: cwd.trim(),
      model: model.trim() || undefined,
      permissionMode: agentMode,
    });
  }, [cwd, model, agentMode, send]);

  /** Re-attach live agent to a history session (keep same sessionId + messages). */
  const resumeSession = useCallback(
    (histSessionId: string, histCwd: string) => {
      if (!histSessionId) return;
      localStorage.setItem("agent-pane-cwd", histCwd.trim() || cwd);
      if (model) localStorage.setItem("agent-pane-model", model);
      localStorage.setItem("agent-pane-mode", agentMode);
      setBusy(true);
      setError(null);
      setStatusMsg("正在恢复会话…");
      // Safety: if resume never completes, unlock UI
      window.setTimeout(() => {
        setStatusMsg((s) =>
          s && /恢复|Resuming|连接/i.test(s)
            ? null
            : s
        );
      }, 50_000);
      send({
        type: "session.resume",
        sessionId: histSessionId,
        cwd: (histCwd || cwd).trim(),
        model: model.trim() || undefined,
        permissionMode: agentMode,
      });
    },
    [cwd, model, agentMode, send]
  );

  /** 从历史打开：只回放事件到 UI（继续聊请再 Start 新会话或同一 cwd 新 Agent） */
  const openHistorySession = useCallback(
    async (histSessionId: string, histCwd: string) => {
      try {
        setError(null);
        setBusy(true);
        const { fetchSessionEvents, deleteSessionApi, invalidateHistoryClientCache } =
          await import("./api");
        // 强制拉盘 + 清空去重表，否则二次打开会被 seenSeq 全滤掉
        const events = (await fetchSessionEvents(
          histSessionId,
          true
        )) as DomainEvent[];
        const hasUser = events.some((e) => e.type === "UserMessageAppended");
        if (!events.length || !hasUser) {
          // Zombie sidebar entry (deleted / empty) — scrub and leave history
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
        // Pure rebuild from file order — never drop the last turn via seq dedupe
        // or setState-loop replay. This is why every session's last respond must show.
        const built = eventsToChatItems(events);
        setMessages(built);
        // Seed with full unique keys (seq alone collides after old resumes)
        for (const e of events) {
          const th =
            typeof (e as { text?: string }).text === "string"
              ? (e as { text: string }).text.slice(0, 24)
              : "";
          seenSeq.current.add(
            `${histSessionId}:${e.seq ?? "x"}:${e.at ?? ""}:${e.type}:${th}`
          );
        }
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
      });
    },
    [send, sessionId]
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

  /** Slice UI timeline before last user turn (works offline / historyOnly). */
  const rewindUiToBeforeLastUser = useCallback(() => {
    const text = lastUserText() || "";
    setMessages((m) => {
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
    return text;
  }, [lastUserText]);

  const undoLast = useCallback(() => {
    if (!sessionId) {
      setError("Nothing to undo");
      return;
    }
    // History / dead agent: still undo in the UI so ⋯ isn't a dead button
    if (historyOnly) {
      const text = rewindUiToBeforeLastUser();
      setRestoredDraft(text);
      setError(null);
      return;
    }
    afterRewindRef.current = {
      kind: "undo",
      text: lastUserText() || "",
    };
    send({ type: "session.undoLast", sessionId });
  }, [send, sessionId, historyOnly, lastUserText, rewindUiToBeforeLastUser]);

  const retryLast = useCallback(() => {
    if (!sessionId) {
      setError("Nothing to retry");
      return;
    }
    const text = lastUserText();
    if (!text?.trim()) {
      setError("No user message to retry");
      return;
    }
    if (historyOnly) {
      // Offline: rewind UI, then resume + re-send
      rewindUiToBeforeLastUser();
      setError(null);
      pendingPromptRef.current = { text };
      setBusy(true);
      setStatusMsg("正在恢复会话…");
      send({
        type: "session.resume",
        sessionId,
        cwd: cwd.trim(),
        model: model.trim() || undefined,
        permissionMode: agentMode,
      });
      return;
    }
    afterRewindRef.current = { kind: "retry", text };
    send({ type: "session.undoLast", sessionId });
  }, [
    send,
    sessionId,
    historyOnly,
    lastUserText,
    rewindUiToBeforeLastUser,
    cwd,
    model,
    agentMode,
  ]);

  const editLast = useCallback(() => {
    if (!sessionId) {
      setError("Nothing to edit");
      return;
    }
    const text = lastUserText();
    if (!text?.trim()) {
      setError("No user message to edit");
      return;
    }
    if (historyOnly) {
      rewindUiToBeforeLastUser();
      setRestoredDraft(text);
      setError(null);
      return;
    }
    afterRewindRef.current = { kind: "edit", text };
    send({ type: "session.undoLast", sessionId });
  }, [send, sessionId, historyOnly, lastUserText, rewindUiToBeforeLastUser]);

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
    /** ms since busy started — for "Waiting for response… 2.2s" */
    busyElapsed,
    sessionId,
    cwd,
    setCwd,
    model,
    setModel,
    agentMode,
    setAgentMode,
    messages,
    tasks,
    diffs,
    permissions,
    busy,
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
    respondPermission,
    acceptDiff,
    rejectDiff,
  };
}
