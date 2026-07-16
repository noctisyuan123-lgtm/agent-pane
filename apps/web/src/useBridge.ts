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
  eventsToChatItemsAsync,
  formatDurationSec,
  sliceLastUserTurns,
  sliceMessagesBeforeUserTurn,
  userTextAtTurn,
  userTurnIndexAt,
  type ChatItem,
  type TurnLogLine,
} from "./chatFromEvents";

/**
 * Cap how much of a huge history mounts into the DOM at once. GrokBuild's
 * native list virtualizes for free; our chat has no windowing, so without
 * this a big session mounts thousands of markdown/highlighted-code nodes on
 * every switch — that churn (not the JSON parse) is what piles up memory
 * after repeated clicking. "Load earlier" expands from the full cached array.
 */
const HISTORY_WINDOW_TURNS = 40;

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
  /** Mirror of messages for stash-on-switch without stale closures */
  const messagesRef = useRef<ChatItem[]>([]);
  messagesRef.current = messages;
  /** How many earlier items are hidden by the render window (0 = fully shown) */
  const [hiddenHistoryCount, setHiddenHistoryCount] = useState(0);
  const paintWindowed = useCallback((full: ChatItem[]) => {
    const { visible, hiddenCount } = sliceLastUserTurns(
      full,
      HISTORY_WINDOW_TURNS
    );
    setMessages(visible);
    setHiddenHistoryCount(hiddenCount);
  }, []);
  const loadEarlierHistory = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const full = sessionChatCacheRef.current.get(sid)?.messages;
    if (!full) return;
    setMessages(full);
    setHiddenHistoryCount(0);
  }, []);
  /**
   * In-memory chat cache — avoid re-parsing multi‑MB jsonl on every click.
   * Keep only a few sessions: large ChatItem trees were piling up like a leak
   * after continuous switching.
   */
  const sessionChatCacheRef = useRef<
    Map<string, { messages: ChatItem[]; at: number }>
  >(new Map());
  const stashSessionChat = useCallback((id: string | null | undefined) => {
    if (!id) return;
    const msgs = messagesRef.current;
    if (!msgs.length) return;
    const cache = sessionChatCacheRef.current;
    const existing = cache.get(id)?.messages;
    // Never overwrite a longer full timeline with a windowed paint slice —
    // that corrupted userTurnIndex and made Retry wipe early history.
    let next = msgs.slice();
    if (existing && existing.length > msgs.length) {
      const firstId = msgs[0]?.id;
      const start = firstId
        ? existing.findIndex((m) => m.id === firstId)
        : -1;
      if (start > 0) {
        next = [...existing.slice(0, start), ...msgs];
      } else if (start === 0) {
        next = msgs.slice();
      } else {
        // Can't align — keep the longer cache, only bump mtime
        cache.set(id, { messages: existing.slice(), at: Date.now() });
        while (cache.size > 4) {
          let oldestId: string | null = null;
          let oldestAt = Infinity;
          for (const [k, v] of cache) {
            if (v.at < oldestAt) {
              oldestAt = v.at;
              oldestId = k;
            }
          }
          if (oldestId) cache.delete(oldestId);
          else break;
        }
        return;
      }
    }
    cache.set(id, { messages: next, at: Date.now() });
    while (cache.size > 4) {
      let oldestId: string | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of cache) {
        if (v.at < oldestAt) {
          oldestAt = v.at;
          oldestId = k;
        }
      }
      if (oldestId) cache.delete(oldestId);
      else break;
    }
  }, []);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [diffs, setDiffs] = useState<DiffFileMeta[]>([]);
  const [permissions, setPermissions] = useState<PermissionReq[]>([]);
  const [busy, setBusy] = useState(false);
  // NOTE: do NOT tick busyElapsed in this hook — a 200ms setState here
  // re-rendered the entire App (sidebar + markdown chat) and made rapid
  // session switching feel frozen. Elapsed UI lives in AgentActivityStrip.
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
  /**
   * Active session for event gating. Intentionally NOT synced from `sessionId`
   * state on every render — that race reverted optimistic openHistorySession
   * pins when WS re-rendered with stale state before setSessionId committed,
   * making sidebar clicks feel stuck.
   */
  const sessionIdRef = useRef<string | null>(null);
  /**
   * Message waiting for SessionStarted (create / resume).
   * Flushed inside SessionStarted — NOT via useEffect (effect cleanup was
   * swallowing the pending send and leaving UI on "正在恢复会话…").
   */
  const pendingPromptRef = useRef<{
    text: string;
    attachments?: { path: string; kind: "file" | "folder" }[];
  } | null>(null);
  /**
   * Which session we're attaching to over WS:
   * - {kind:'new', requestId} → waiting for SessionStarted with matching clientRequestId
   * - {kind:'resume', sessionId} → waiting for / applying that sessionId
   * - null → only paint events for sessionIdRef.current
   */
  const pendingAttachRef = useRef<
    | { kind: "new"; requestId: string }
    | { kind: "resume"; sessionId: string }
    | null
  >(null);
  /** Bumps on each openHistorySession; stale async work must not overwrite UI. */
  const openHistGenRef = useRef(0);
  /** While loading history for a session, suppress live paint for that id */
  const suppressPaintRef = useRef<string | null>(null);
  /** sessionId → currently working (turn in flight) */
  const busyBySessionRef = useRef<Record<string, boolean>>({});
  const [busySessionIds, setBusySessionIds] = useState<string[]>([]);
  const busySessionKeyRef = useRef("");
  /** Sessions with a live agent process (from bridge `live` messages) */
  const [liveSessionIds, setLiveSessionIds] = useState<string[]>([]);
  const liveSessionIdsRef = useRef<string[]>([]);
  liveSessionIdsRef.current = liveSessionIds;
  /** Coarse AgentActivity phase for the 3-line strip status row */
  const [activityPhase, setActivityPhase] = useState<
    | "idle"
    | "working"
    | "thinking"
    | "tool"
    | "permission"
    | "compact"
    | "queue"
    | "sleeping"
    | "error"
    | null
  >(null);
  /** Subagent model label when present on AgentActivity (line-1 secondary) */
  const [activitySubagentModel, setActivitySubagentModel] = useState<
    string | null
  >(null);
  /** After SessionRewound: retry resends, edit fills composer, undo just restores */
  const afterRewindRef = useRef<null | {
    kind: "retry" | "edit" | "undo";
    text: string;
    userTurnIndex: number;
  }>(null);

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

  const syncBusyFromMap = useCallback(() => {
    const ids = Object.entries(busyBySessionRef.current)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort();
    const key = ids.join("\0");
    // Avoid re-render storms: every WS event used to setState a fresh array
    // even when the busy set was unchanged, which remounted sidebar rows
    // under the cursor mid-click.
    if (key !== busySessionKeyRef.current) {
      busySessionKeyRef.current = key;
      setBusySessionIds(ids);
    }
    const active = sessionIdRef.current;
    if (active) setBusy(!!busyBySessionRef.current[active]);
    else setBusy(false);
  }, []);

  const flushPendingPrompt = useCallback(
    (sid: string) => {
      const pending = pendingPromptRef.current;
      if (!pending?.text?.trim() && !(pending?.attachments?.length)) return;
      pendingPromptRef.current = null;
      // Per-session busy — never setBusy(true) blindly; user may have switched
      // to an idle session B while A's attach+flush was still pending.
      busyBySessionRef.current[sid] = true;
      syncBusyFromMap();
      setStatusMsg(null);
      send({
        type: "session.prompt",
        sessionId: sid,
        text: (pending?.text || "").trim() || "(attached files)",
        attachments: pending?.attachments,
      });
    },
    [send, syncBusyFromMap]
  );

  const noteSessionBusy = useCallback(
    (event: DomainEvent) => {
      const id = event.sessionId;
      if (!id) return;
      // Only user/tool start a "working" turn — not every residual chunk,
      // or busy sticks forever after MessageDone (sidebar particles).
      if (
        event.type === "UserMessageAppended" ||
        event.type === "ToolStarted"
      ) {
        busyBySessionRef.current[id] = true;
      } else if (
        event.type === "MessageDone" ||
        event.type === "SessionEnded" ||
        event.type === "SessionError"
      ) {
        busyBySessionRef.current[id] = false;
      } else if (
        event.type === "ToolFinished" ||
        event.type === "ToolFailed"
      ) {
        // If no other tools are in flight we still wait for MessageDone;
        // do not clear here (assistant may keep talking after the tool).
      }
      syncBusyFromMap();
    },
    [syncBusyFromMap]
  );

  const applyEvent = useCallback((event: DomainEvent) => {
    // Always track busy for sidebar dots — even when not painting this session
    noteSessionBusy(event);

    // Drop paint for non-active sessions (bridge fans out all live sessions).
    // Replay path is exempt — it intentionally rebuilds one session's timeline.
    // SessionRewound must still run when we initiated undo/retry/edit — otherwise
    // afterRewindRef never fires and Retry looks like a bare re-send (or does nothing).
    if (!replayingRef.current) {
      if (suppressPaintRef.current === event.sessionId) return;

      const pending = pendingAttachRef.current;
      const active = sessionIdRef.current;
      let allow = false;
      if (pending?.kind === "new") {
        allow =
          event.type === "SessionStarted" &&
          (event as { clientRequestId?: string }).clientRequestId ===
            pending.requestId;
      } else if (pending?.kind === "resume") {
        allow = event.sessionId === pending.sessionId;
      } else if (active) {
        allow = event.sessionId === active;
      }
      const forceRewind =
        event.type === "SessionRewound" &&
        afterRewindRef.current != null &&
        event.sessionId === active;
      if (!allow && !forceRewind) return;
    }

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
      case "SessionStarted": {
        const pending = pendingAttachRef.current;
        const expectNew =
          pending?.kind === "new" &&
          (event as { clientRequestId?: string }).clientRequestId ===
            pending.requestId;
        const expectThis =
          pending?.kind === "resume" && pending.sessionId === event.sessionId;
        const alreadyActive = sessionIdRef.current === event.sessionId;
        // Ignore hijack: another session's SessionStarted must not steal the UI
        if (!replayingRef.current && !expectNew && !expectThis && !alreadyActive) {
          break;
        }
        if (expectNew || expectThis) pendingAttachRef.current = null;

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
            busyBySessionRef.current[event.sessionId] = true;
            syncBusyFromMap();
            const sid = event.sessionId;
            window.setTimeout(() => flushPendingPrompt(sid), 30);
          } else {
            syncBusyFromMap();
          }
        }
        if (!event.resumed || replayingRef.current) {
          assistantLiveId.current = `a-${event.sessionId}-live`;
          thoughtLiveId.current = `t-${event.sessionId}-live`;
          toolsGroupId.current = `tools-${event.sessionId}-live`;
        }
        break;
      }

      case "UserMessageAppended": {
        // Global 0-based turn index for Retry/Undo (must match EventStore order)
        const sidU = event.sessionId;
        const cacheU = sessionChatCacheRef.current.get(sidU)?.messages;
        let nextTurn = 0;
        const countUsers = (list: ChatItem[]) => {
          let maxStamp = -1;
          let n = 0;
          for (const x of list) {
            if (x.kind === "user") {
              n++;
              if (typeof x.userTurnIndex === "number" && x.userTurnIndex >= 0) {
                maxStamp = Math.max(maxStamp, x.userTurnIndex);
              }
            }
          }
          // Prefer max stamp+1 so windowed arrays don't renumber from 0
          return maxStamp >= 0 ? maxStamp + 1 : n;
        };
        if (cacheU?.length) {
          nextTurn = countUsers(cacheU);
        } else {
          nextTurn = countUsers(messagesRef.current);
        }
        const userItem: ChatItem = {
          kind: "user",
          text: event.text,
          id: `u-${event.sessionId}-${turnTag}`,
          attachments: event.attachments?.length
            ? event.attachments
            : undefined,
          userTurnIndex: nextTurn,
        };
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
          return [...withoutOpt, userItem];
        });
        // Keep full-timeline cache in sync (windowed paint must not be SoT)
        if (cacheU) {
          sessionChatCacheRef.current.set(sidU, {
            messages: [...cacheU, userItem],
            at: Date.now(),
          });
        } else if (sidU === sessionIdRef.current) {
          const base = messagesRef.current.filter(
            (x) =>
              !(
                x.kind === "user" &&
                x.id.startsWith("u-optimistic-") &&
                x.text === event.text
              )
          );
          sessionChatCacheRef.current.set(sidU, {
            messages: [...base, userItem],
            at: Date.now(),
          });
        }
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
      }

      case "MessageChunk": {
        // Stop / cancel seals the turn — drop residual stream (was "can't stop")
        if (turnDoneRef.current) break;
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
        // Soft status for line-3 while thoughts stream (unless a tool activity owns the strip)
        setActivityPhase((p) => (p === "tool" || p === "permission" ? p : "thinking"));
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
        setActivityPhase(null);
        setActivitySubagentModel(null);
        // noteSessionBusy already cleared the map — sync, don't blanket setBusy(false)
        // (that used to clear busy while viewing another live session after a gate miss).
        syncBusyFromMap();
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
        const phase = event.phase ?? (text ? "working" : null);
        setActivityPhase(text ? phase : null);
        const subagentModel =
          typeof event.subagentModel === "string"
            ? event.subagentModel.trim()
            : event.agentKind === "subagent" && typeof event.model === "string"
              ? event.model.trim()
              : "";
        setActivitySubagentModel(subagentModel || null);
        // Keep busy/isLive aligned while a tool process is reporting
        if (
          event.sessionId &&
          (phase === "tool" ||
            phase === "sleeping" ||
            phase === "permission" ||
            (text != null &&
              /^(Running|Using|Calling|Permission|Queued:)/i.test(text)))
        ) {
          busyBySessionRef.current[event.sessionId] = true;
          syncBusyFromMap();
        }
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
        setActivityPhase(null);
        setActivitySubagentModel(null);
        // Idle agent exit is expected — don't flash a red error, just mark resumable
        if (
          /exited|disconnect|not alive|EPIPE/i.test(event.message) &&
          !/fail|无法|error|崩溃/i.test(event.message)
        ) {
          syncBusyFromMap();
          setStatusMsg(null);
          setHistoryOnly(true);
          break;
        }
        setError(event.message);
        syncBusyFromMap();
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
        setActivityPhase(null);
        setActivitySubagentModel(null);
        syncBusyFromMap();
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
        const action = afterRewindRef.current;
        // Claim the pending action once (retry/edit/undo follow-up)
        if (
          action &&
          (action.userTurnIndex === turnIdx || turnIdx < 0)
        ) {
          afterRewindRef.current = null;
        }

        const sid = sessionIdRef.current;
        setTasks([]);
        setPermissions([]);
        assistantBuf.current = "";
        thoughtBufMap.current.clear();
        postToolsAssistantId.current = null;
        turnDoneRef.current = true;
        turnStartedAtRef.current = null;
        seenSeq.current.clear();

        const text = (action?.text || event.restoredText || "").trim();
        const finishUi = (built: ChatItem[] | null) => {
          if (built) {
            if (sid) {
              sessionChatCacheRef.current.set(sid, {
                messages: built.slice(),
                at: Date.now(),
              });
            }
            paintWindowed(built);
            messagesRef.current = built;
          }
          if (action?.kind === "retry" && text && sid) {
            setRestoredDraft(null);
            setError(null);
            setBusy(true);
            busyBySessionRef.current[sid] = true;
            syncBusyFromMap();
            send({
              type: "session.prompt",
              sessionId: sid,
              text,
            });
          } else if (action?.kind === "edit" && text) {
            setBusy(false);
            setRestoredDraft(text);
            setError(null);
          } else if (action?.kind === "undo") {
            setBusy(false);
            setRestoredDraft(null);
            if (event.note && !event.providerOk) setError(event.note);
            else setError(null);
          } else {
            setBusy(false);
            if (!action) setRestoredDraft(event.restoredText);
            if (event.note && !event.providerOk) setError(event.note);
            else setError(null);
          }
        };

        // Ground truth: rebuild from truncated disk events so we never wipe
        // earlier assistant turns via a bad client-side slice index.
        if (sid) {
          void (async () => {
            try {
              const {
                fetchSessionEvents,
                invalidateHistoryClientCache,
              } = await import("./api");
              invalidateHistoryClientCache(sid);
              const events = (await fetchSessionEvents(
                sid,
                true
              )) as DomainEvent[];
              if (sessionIdRef.current !== sid) return;
              const built = eventsToChatItems(events);
              finishUi(built);
            } catch {
              // Fallback: keep optimistic cache if disk fetch fails
              const cached = sessionChatCacheRef.current.get(sid)?.messages;
              finishUi(cached?.length ? cached : null);
            }
          })();
        } else {
          finishUi(null);
        }
        break;
      }
      default:
        break;
    }
  }, [
    flushPendingPrompt,
    send,
    sealThoughtLogLine,
    pushTurnLog,
    noteSessionBusy,
    syncBusyFromMap,
    paintWindowed,
  ]);

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
            const errSid = (msg as { sessionId?: string }).sessionId;
            const errReq = (msg as { clientRequestId?: string }).clientRequestId;
            const pending = pendingAttachRef.current;
            const forPending =
              (pending?.kind === "new" &&
                errReq != null &&
                errReq === pending.requestId) ||
              (pending?.kind === "resume" &&
                errSid != null &&
                errSid === pending.sessionId);
            const forActive =
              errSid != null && errSid === sessionIdRef.current;
            if (!forPending && !forActive && sessionIdRef.current != null) {
              // Foreign untagged/other-session error — ignore state steal
            } else {
              setError(msg.message);
              if (forPending || forActive || sessionIdRef.current == null) {
                if (errSid) busyBySessionRef.current[errSid] = false;
                syncBusyFromMap();
                setResuming(false);
                setStatusMsg(null);
                if (forPending) pendingAttachRef.current = null;
                const pendingPrompt = pendingPromptRef.current;
                if (pendingPrompt?.text?.trim()) {
                  setRestoredDraft(pendingPrompt.text);
                  pendingPromptRef.current = null;
                  setMessages((m) =>
                    m.filter(
                      (x) =>
                        !(
                          x.kind === "user" &&
                          x.id.startsWith("u-optimistic-") &&
                          x.text === pendingPrompt.text
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
              }
            }
          } else if (msg.type === "status") {
            const stSid = (msg as { sessionId?: string }).sessionId;
            const stReq = (msg as { clientRequestId?: string }).clientRequestId;
            const pending = pendingAttachRef.current;
            const forPending =
              (pending?.kind === "new" &&
                stReq != null &&
                stReq === pending.requestId) ||
              (pending?.kind === "resume" &&
                stSid != null &&
                stSid === pending.sessionId);
            if (forPending) {
              setStatusMsg(msg.message?.trim() ? msg.message : null);
            }
          } else if (msg.type === "live") {
            setLiveSessionIds(
              Array.isArray(msg.sessionIds) ? msg.sessionIds.map(String) : []
            );
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
    sessionIdRef.current = null;
    setActivityPhase(null);
    setActivitySubagentModel(null);
    const requestId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `req-${Date.now()}`;
    pendingAttachRef.current = { kind: "new", requestId };
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
      clientRequestId: requestId,
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
      setStatusMsg("Resuming session…");
      pendingAttachRef.current = { kind: "resume", sessionId: histSessionId };
      sessionIdRef.current = histSessionId;
      setSessionId(histSessionId);
      busyBySessionRef.current[histSessionId] = true;
      syncBusyFromMap();
      // Hard unlock if resume never completes (auth hang / silent stall)
      window.setTimeout(() => {
        // User may have switched sessions — never steal that chat's UI
        if (sessionIdRef.current !== histSessionId) {
          busyBySessionRef.current[histSessionId] = false;
          syncBusyFromMap();
          const p = pendingAttachRef.current;
          if (p?.kind === "resume" && p.sessionId === histSessionId) {
            pendingAttachRef.current = null;
          }
          return;
        }
        setResuming((r) => {
          if (!r) return r;
          const p = pendingAttachRef.current;
          if (p?.kind === "resume" && p.sessionId === histSessionId) {
            pendingAttachRef.current = null;
          }
          busyBySessionRef.current[histSessionId] = false;
          syncBusyFromMap();
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
    [cwd, model, effort, effortFast, effectiveEffort, agentMode, send, syncBusyFromMap]
  );

  /**
   * Open from history: local event replay only (Cursor-style).
   * Does NOT spawn Grok / session/new — that happens lazily on Send via resumeSession.
   * @returns `{ scrubbed: true }` when an empty/zombie session was removed
   */
  const openHistorySession = useCallback(
    async (
      histSessionId: string,
      histCwd: string,
      signal?: AbortSignal
    ): Promise<{ scrubbed?: boolean } | void> => {
      const gen = ++openHistGenRef.current;
      const stillCurrent = () =>
        gen === openHistGenRef.current && !signal?.aborted;
      const prevId = sessionIdRef.current;

      // Stash leaving session so A↔B rapid switches don't re-parse multi‑MB jsonl
      if (prevId && prevId !== histSessionId) {
        stashSessionChat(prevId);
      }

      // Pin active session immediately so in-flight WS from other sessions is ignored
      pendingAttachRef.current = null;
      sessionIdRef.current = histSessionId;
      setSessionId(histSessionId);
      // Drop resume UI lock when leaving an in-flight resume
      setResuming(false);
      setError(null);
      setStatusMsg(null);
      setActivityPhase(null);
      setActivitySubagentModel(null);
      setContextUsage(null);
      setBusy(!!busyBySessionRef.current[histSessionId]);
      pendingPromptRef.current = null;
      setHiddenHistoryCount(0);

      const cached = sessionChatCacheRef.current.get(histSessionId);
      if (cached?.messages?.length) {
        // Instant paint from memory, windowed like a virtualized list —
        // real root cause of "连切卡死" was mounting the WHOLE history's
        // DOM (markdown + syntax highlight) on every switch, not the parse.
        suppressPaintRef.current = null;
        paintWindowed(cached.messages);
        setTasks([]);
        setDiffs([]);
        setPermissions([]);
        const stillLive =
          liveSessionIdsRef.current.includes(histSessionId) ||
          !!busyBySessionRef.current[histSessionId];
        setHistoryOnly(!stillLive);
        setBusy(!!busyBySessionRef.current[histSessionId]);
        turnDoneRef.current = !stillLive;
        seenSeq.current.clear();
        setCwd(histCwd);
        localStorage.setItem("agent-pane-cwd", histCwd);
        if (!stillLive) {
          // History-only: memory is enough. Skip multi‑MB re-parse.
          return;
        }
        // Live: paint cache now. Debounced catch-up — rapid A↔B must not
        // stack concurrent full-history converts (felt like a memory leak).
        const catchGen = gen;
        window.setTimeout(() => {
          if (openHistGenRef.current !== catchGen || signal?.aborted) return;
          void (async () => {
            try {
              const { fetchSessionEvents } = await import("./api");
              if (!stillCurrent()) return;
              const events = (await fetchSessionEvents(
                histSessionId,
                true,
                signal
              )) as DomainEvent[];
              if (!stillCurrent()) return;
              const built = await eventsToChatItemsAsync(events, {
                shouldContinue: stillCurrent,
              });
              if (!built || !stillCurrent()) return;
              sessionChatCacheRef.current.set(histSessionId, {
                messages: built.slice(),
                at: Date.now(),
              });
              paintWindowed(built);
            } catch {
              /* aborted or network — keep cached paint */
            }
          })();
        }, 450);
        return;
      } else if (prevId !== histSessionId) {
        suppressPaintRef.current = histSessionId;
        setMessages([]);
        setTasks([]);
        setDiffs([]);
        setPermissions([]);
      } else {
        suppressPaintRef.current = histSessionId;
      }

      try {
        const {
          fetchSessionEvents,
          deleteSessionApi,
          invalidateHistoryClientCache,
        } = await import("./api");
        if (!stillCurrent()) return;
        // Force disk read + clear dedupe so re-open isn't filtered by seenSeq
        const events = (await fetchSessionEvents(
          histSessionId,
          true,
          signal
        )) as DomainEvent[];
        if (!stillCurrent()) return;
        const hasUser = events.some((e) => e.type === "UserMessageAppended");
        if (!events.length || !hasUser) {
          try {
            await deleteSessionApi(histSessionId);
          } catch {
            /* already gone */
          }
          invalidateHistoryClientCache(histSessionId);
          if (!stillCurrent()) return;
          suppressPaintRef.current = null;
          setBusy(false);
          setError("Session is gone or empty — removed from history");
          return { scrubbed: true };
        }

        const built = await eventsToChatItemsAsync(events, {
          shouldContinue: stillCurrent,
        });
        if (!built || !stillCurrent()) return;
        // Re-check immediately before mutating UI — avoids TOCTOU where a newer
        // click wins the gen counter but this stale load still setMessages().
        if (!stillCurrent()) return;

        setTasks([]);
        setDiffs([]);
        setPermissions([]);
        assistantBuf.current = "";
        thoughtBufMap.current.clear();
        postToolsAssistantId.current = null;
        turnDoneRef.current = true;
        seenSeq.current.clear();
        setCwd(histCwd);
        localStorage.setItem("agent-pane-cwd", histCwd);
        // Fill seenSeq only — provider id for usage comes from bridge live→meta
        // (do not key off last ContextUsage event alone; that is archaeology).
        for (let i = 0; i < events.length; i++) {
          const e = events[i]!;
          const th =
            typeof (e as { text?: string }).text === "string"
              ? (e as { text: string }).text.slice(0, 24)
              : "";
          seenSeq.current.add(
            `${histSessionId}:${e.seq ?? "x"}:${e.at ?? ""}:${e.type}:${th}`
          );
        }

        sessionChatCacheRef.current.set(histSessionId, {
          messages: built.slice(),
          at: Date.now(),
        });
        paintWindowed(built);

        // Paint chat first — usage fetch must NOT retain the events array
        suppressPaintRef.current = null;
        const stillLive =
          liveSessionIdsRef.current.includes(histSessionId) ||
          !!busyBySessionRef.current[histSessionId];
        setHistoryOnly(!stillLive);
        setBusy(!!busyBySessionRef.current[histSessionId]);

        void (async () => {
          if (!stillCurrent()) return;
          const { estimateMessagesTokens } = await import("./contextUsage");
          if (!stillCurrent()) return;
          const estimated = estimateMessagesTokens(built);
          const fallbackSize = 500_000;
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
          try {
            const { fetchContextUsage } = await import("./api");
            // Server resolves: live provider → meta.providerSessionId
            const u = await fetchContextUsage({
              sessionId: histSessionId,
              cwd: histCwd,
            });
            if (!stillCurrent()) return;
            if (u) {
              const signalsTooSmall =
                estimated > 8_000 && u.used + 2_000 < estimated * 0.5;
              if (signalsTooSmall) {
                lastUsage = {
                  used: estimated,
                  size: u.size > 0 ? u.size : fallbackSize,
                  source: "estimate",
                  pct: Math.min(
                    100,
                    Math.round(
                      (estimated / (u.size > 0 ? u.size : fallbackSize)) * 100
                    )
                  ),
                };
              } else {
                lastUsage = {
                  used: u.used,
                  size: u.size,
                  source: u.source,
                  pct: u.pct,
                };
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
          if (!stillCurrent()) return;
          setContextUsage(lastUsage);
        })();
      } catch (e) {
        if (signal?.aborted || !stillCurrent()) return;
        suppressPaintRef.current = null;
        replayingRef.current = false;
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [stashSessionChat]
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
      busyBySessionRef.current[sessionId] = true;
      syncBusyFromMap();
      send({
        type: "session.prompt",
        sessionId,
        text: text.trim() || (attachments?.length ? "(attached files)" : ""),
        attachments: attachments?.length ? attachments : undefined,
        permissionMode: permissionModeFor(agentMode),
      });
    },
    [send, sessionId, agentMode, syncBusyFromMap]
  );

  const cancel = useCallback(() => {
    // Prefer ref — React state can lag one frame behind the live session
    const sid = sessionIdRef.current ?? sessionId;
    if (sid) {
      send({ type: "session.cancel", sessionId: sid });
      busyBySessionRef.current[sid] = false;
    }
    // Always drop local "in flight" UI even if bridge is slow / missing live entry
    setBusy(false);
    setActivityPhase(null);
    setActivitySubagentModel(null);
    setStatusMsg(null);
    turnDoneRef.current = true; // drop residual chunks as late noise
    turnStartedAtRef.current = null;
    syncBusyFromMap();
  }, [send, sessionId, syncBusyFromMap]);

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

  /**
   * Resolve 0-based user-turn index in the **full** Pane timeline.
   * Prefer `user.userTurnIndex` stamped on the bubble; never trust a bare
   * windowed array offset (that made Retry re-send without a real rewind).
   */
  const resolveGlobalUserTurn = useCallback(
    (messageIndex: number): number => {
      const visible = messagesRef.current;
      const item =
        messageIndex >= 0 && messageIndex < visible.length
          ? visible[messageIndex]
          : null;

      // Walk back to owning user bubble
      let userItem: ChatItem | null = null;
      if (item?.kind === "user") userItem = item;
      else if (item) {
        for (let i = Math.min(messageIndex, visible.length - 1); i >= 0; i--) {
          if (visible[i]?.kind === "user") {
            userItem = visible[i]!;
            break;
          }
        }
      }
      if (
        userItem &&
        userItem.kind === "user" &&
        typeof userItem.userTurnIndex === "number" &&
        userItem.userTurnIndex >= 0
      ) {
        return userItem.userTurnIndex;
      }

      const sid = sessionIdRef.current;
      const full =
        (sid && sessionChatCacheRef.current.get(sid)?.messages) || visible;
      if (userItem) {
        const fi = full.findIndex((m) => m.id === userItem!.id);
        if (fi >= 0) return userTurnIndexAt(full, fi);
      }
      if (full.length > visible.length && visible[0]) {
        const start = full.findIndex((m) => m.id === visible[0]!.id);
        if (start > 0) {
          let usersBefore = 0;
          for (let i = 0; i < start; i++) {
            if (full[i]?.kind === "user") usersBefore++;
          }
          const local = userTurnIndexAt(visible, messageIndex);
          if (local >= 0) return usersBefore + local;
        }
      }
      return userTurnIndexAt(visible, messageIndex);
    },
    []
  );

  const rewindToTurn = useCallback(
    (
      userTurnIndex: number,
      kind: "undo" | "retry" | "edit"
    ) => {
      if (!sessionId) {
        setError("Nothing to undo");
        return;
      }
      // Prefer full cache for text so windowed paint doesn't miss the bubble
      const sid = sessionId;
      const full =
        sessionChatCacheRef.current.get(sid)?.messages ?? messagesRef.current;
      const text = userTextAtTurn(full, userTurnIndex);
      if (!text?.trim() && kind !== "undo") {
        setError("No user message at that turn");
        return;
      }

      // Optimistic UI truncate (Claude-style) — don't wait for SessionRewound
      // or Retry looks like a plain re-send when the event is delayed/gated.
      const nextFull = sliceMessagesBeforeUserTurn(full, userTurnIndex);
      sessionChatCacheRef.current.set(sid, {
        messages: nextFull.slice(),
        at: Date.now(),
      });
      paintWindowed(nextFull);
      messagesRef.current = nextFull;
      setTasks([]);
      setPermissions([]);
      assistantBuf.current = "";
      thoughtBufMap.current.clear();
      postToolsAssistantId.current = null;
      turnDoneRef.current = true;
      turnStartedAtRef.current = null;

      if (historyOnly) {
        if (kind === "retry") {
          afterRewindRef.current = null;
          const restored = (text || "").trim();
          send({ type: "session.rewindTo", sessionId, userTurnIndex });
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
      // Live agent path — ALWAYS wait for SessionRewound before retry prompt.
      // Bridge truncates + (if needed) rebinds Core, then emits SessionRewound.
      // Fire-and-forget re-prompt was the "duplicate message + interrupt tip" bug.
      afterRewindRef.current = {
        kind,
        text: text || "",
        userTurnIndex,
      };
      send({ type: "session.rewindTo", sessionId, userTurnIndex });

      // Safety: if SessionRewound never arrives, surface error (don't blind re-send)
      if (kind === "retry") {
        const promptSid = sessionId;
        const expectedTurn = userTurnIndex;
        window.setTimeout(() => {
          const pending = afterRewindRef.current;
          if (
            pending?.kind === "retry" &&
            pending.userTurnIndex === expectedTurn &&
            sessionIdRef.current === promptSid
          ) {
            afterRewindRef.current = null;
            setError(
              "Retry timed out waiting for rewind — message was not re-sent. Try again."
            );
            setBusy(false);
            busyBySessionRef.current[promptSid] = false;
            syncBusyFromMap();
          }
        }, 45_000);
      }
    },
    [
      send,
      sessionId,
      historyOnly,
      paintWindowed,
      cwd,
      model,
      effectiveEffort,
      agentMode,
      syncBusyFromMap,
    ]
  );

  const undoLast = useCallback(() => {
    const idx = resolveGlobalUserTurn(messagesRef.current.length - 1);
    if (idx < 0) {
      setError("Nothing to undo");
      return;
    }
    rewindToTurn(idx, "undo");
  }, [resolveGlobalUserTurn, rewindToTurn]);

  const retryLast = useCallback(() => {
    const idx = resolveGlobalUserTurn(messagesRef.current.length - 1);
    if (idx < 0) {
      setError("Nothing to retry");
      return;
    }
    rewindToTurn(idx, "retry");
  }, [resolveGlobalUserTurn, rewindToTurn]);

  const editLast = useCallback(() => {
    const idx = resolveGlobalUserTurn(messagesRef.current.length - 1);
    if (idx < 0) {
      setError("Nothing to edit");
      return;
    }
    rewindToTurn(idx, "edit");
  }, [resolveGlobalUserTurn, rewindToTurn]);

  const undoAt = useCallback(
    (messageIndex: number) => {
      const idx = resolveGlobalUserTurn(messageIndex);
      if (idx < 0) {
        setError("Nothing to undo");
        return;
      }
      rewindToTurn(idx, "undo");
    },
    [resolveGlobalUserTurn, rewindToTurn]
  );

  const retryAt = useCallback(
    (messageIndex: number) => {
      const idx = resolveGlobalUserTurn(messageIndex);
      if (idx < 0) {
        setError("Nothing to retry");
        return;
      }
      rewindToTurn(idx, "retry");
    },
    [resolveGlobalUserTurn, rewindToTurn]
  );

  const editAt = useCallback(
    (messageIndex: number) => {
      const idx = resolveGlobalUserTurn(messageIndex);
      if (idx < 0) {
        setError("Nothing to edit");
        return;
      }
      rewindToTurn(idx, "edit");
    },
    [resolveGlobalUserTurn, rewindToTurn]
  );

  const clearRestoredDraft = useCallback(() => setRestoredDraft(null), []);

  const respondPermission = useCallback(
    (requestId: string, allow: boolean) => {
      send({
        type: "permission.respond",
        requestId,
        allow,
        sessionId: sessionIdRef.current ?? undefined,
      });
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
    activityPhase,
    activitySubagentModel,
    notice,
    clearNotice: () => setNotice(null),
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
    /** Items older than the render window that "Load earlier" can restore */
    hiddenHistoryCount,
    loadEarlierHistory,
    contextUsage,
    tasks,
    diffs,
    permissions,
    busy,
    /** Session ids currently mid-turn (for sidebar working dots) */
    busySessionIds,
    /** Session ids with a live agent process */
    liveSessionIds,
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
