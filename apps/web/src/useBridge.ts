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

export type ChatItem =
  | { kind: "user"; text: string; id: string }
  | { kind: "assistant"; text: string; id: string }
  | { kind: "thought"; text: string; id: string }
  | { kind: "tools"; id: string; tools: ToolRow[] };

export type { ToolRow };

export type PermissionReq = {
  requestId: string;
  tool: string;
  summary: string;
};

const WS_URL = import.meta.env.VITE_BRIDGE_WS ?? "ws://127.0.0.1:8787";

function sealAssistant(
  messages: ChatItem[],
  buf: string,
  liveId: string
): ChatItem[] {
  if (!buf.trim()) {
    return messages.filter((m) => m.id !== liveId);
  }
  const next = messages.filter((m) => m.id !== liveId);
  next.push({
    kind: "assistant",
    text: buf,
    id: `${liveId}-sealed-${Date.now()}`,
  });
  return next;
}

export function useBridge() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cwd, setCwd] = useState(localStorage.getItem("agent-pane-cwd") || "");
  const [model, setModel] = useState(
    localStorage.getItem("agent-pane-model") || ""
  );
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [diffs, setDiffs] = useState<DiffFileMeta[]>([]);
  const [permissions, setPermissions] = useState<PermissionReq[]>([]);
  const [busy, setBusy] = useState(false);
  const [restoredDraft, setRestoredDraft] = useState<string | null>(null);
  const assistantBuf = useRef("");
  const assistantLiveId = useRef("a-live");
  const thoughtLiveId = useRef("t-live");
  const toolsGroupId = useRef("tools-live");

  const send = useCallback((cmd: ClientCommand) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Bridge 未连接");
      return;
    }
    ws.send(JSON.stringify(cmd));
  }, []);

  const applyEvent = useCallback((event: DomainEvent) => {
    switch (event.type) {
      case "SessionStarted":
        setSessionId(event.sessionId);
        setCwd(event.cwd);
        if (event.model) setModel(event.model);
        setError(null);
        setMessages([]);
        setTasks([]);
        setDiffs([]);
        setBusy(false);
        assistantBuf.current = "";
        assistantLiveId.current = `a-${event.sessionId}-live`;
        thoughtLiveId.current = `t-${event.sessionId}-live`;
        toolsGroupId.current = `tools-${event.sessionId}-live`;
        break;

      case "UserMessageAppended":
        setMessages((m) => [
          ...m,
          { kind: "user", text: event.text, id: `u-${event.seq ?? event.at}` },
        ]);
        setBusy(true);
        assistantBuf.current = "";
        // new live assistant id each user turn
        assistantLiveId.current = `a-${event.sessionId}-${event.seq ?? Date.now()}`;
        thoughtLiveId.current = `t-${event.sessionId}-${event.seq ?? Date.now()}`;
        toolsGroupId.current = `tools-${event.sessionId}-${event.seq ?? Date.now()}`;
        break;

      case "MessageChunk": {
        // 若当前时间线末尾是 tools 组，说明中间插了工具——开新 assistant 气泡
        setMessages((m) => {
          const last = m[m.length - 1];
          if (last?.kind === "tools" && assistantBuf.current === "") {
            assistantLiveId.current = `a-${event.sessionId}-after-tools-${event.seq ?? Date.now()}`;
          }
          assistantBuf.current += event.text;
          const id = assistantLiveId.current;
          const next = [...m];
          const idx = next.findIndex((x) => x.id === id);
          if (idx >= 0) {
            next[idx] = {
              kind: "assistant",
              text: assistantBuf.current,
              id,
            };
          } else {
            next.push({
              kind: "assistant",
              text: assistantBuf.current,
              id,
            });
          }
          return next;
        });
        break;
      }

      case "ThoughtChunk":
        setMessages((m) => {
          const id = thoughtLiveId.current;
          const next = [...m];
          const idx = next.findIndex((x) => x.id === id && x.kind === "thought");
          if (idx >= 0 && next[idx].kind === "thought") {
            next[idx] = {
              kind: "thought",
              text: next[idx].text + event.text,
              id,
            };
          } else {
            next.push({ kind: "thought", text: event.text, id });
          }
          return next;
        });
        break;

      case "MessageDone":
        // seal live assistant
        if (assistantBuf.current.trim()) {
          const sealed = assistantBuf.current;
          const liveId = assistantLiveId.current;
          assistantBuf.current = "";
          setMessages((m) => sealAssistant(m, sealed, liveId));
        }
        setBusy(false);
        break;

      case "ToolStarted": {
        // seal any in-progress assistant text before tools
        const sealedBuf = assistantBuf.current;
        const liveId = assistantLiveId.current;
        if (sealedBuf.trim()) {
          assistantBuf.current = "";
          setMessages((m) => sealAssistant(m, sealedBuf, liveId));
        }

        const row = formatToolStarted({
          toolId: event.toolId,
          title: event.title,
          kind: event.kind,
          inputSummary: event.inputSummary,
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
                // ACP 常在 update 里给人类可读 title：Read `path`
                const human =
                  d &&
                  !d.startsWith("{") &&
                  !d.startsWith("[") &&
                  d.length < 120
                    ? d.replace(/^Read\s+`([^`]+)`/, (_, p) => `Read ${p.split("/").pop()}`)
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
              }),
            };
          })
        );
        break;

      case "ToolFinished":
        setMessages((m) =>
          m.map((item) => {
            if (item.kind !== "tools") return item;
            return {
              ...item,
              tools: item.tools.map((t) =>
                t.toolId === event.toolId
                  ? formatToolFinished(t, event.outputSummary)
                  : t
              ),
            };
          })
        );
        break;

      case "ToolFailed":
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
        break;
      case "SessionEnded":
        setBusy(false);
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
        setRestoredDraft(event.restoredText);
        if (event.note && !event.providerOk) {
          setError(event.note);
        } else {
          setError(null);
        }
        break;
      }
      default:
        break;
    }
  }, []);

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
        setError("WebSocket 错误 — 确认 bridge 已启动 (port 8787)");
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

  const createSession = useCallback(() => {
    if (!cwd.trim()) {
      setError("请填写工作区路径 (cwd)");
      return;
    }
    localStorage.setItem("agent-pane-cwd", cwd.trim());
    if (model) localStorage.setItem("agent-pane-model", model);
    setMessages([]);
    setTasks([]);
    setDiffs([]);
    send({
      type: "session.create",
      cwd: cwd.trim(),
      model: model.trim() || undefined,
    });
  }, [cwd, model, send]);

  const prompt = useCallback(
    (text: string) => {
      if (!sessionId) {
        setError("先点「新会话」连接 Grok");
        return;
      }
      if (!text.trim()) return;
      send({ type: "session.prompt", sessionId, text: text.trim() });
    },
    [send, sessionId]
  );

  const cancel = useCallback(() => {
    if (sessionId) send({ type: "session.cancel", sessionId });
    setBusy(false);
  }, [send, sessionId]);

  const undoLast = useCallback(() => {
    if (!sessionId) {
      setError("没有会话可撤回");
      return;
    }
    send({ type: "session.undoLast", sessionId });
  }, [send, sessionId]);

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
    sessionId,
    cwd,
    setCwd,
    model,
    setModel,
    messages,
    tasks,
    diffs,
    permissions,
    busy,
    restoredDraft,
    clearRestoredDraft,
    createSession,
    prompt,
    cancel,
    undoLast,
    respondPermission,
    acceptDiff,
    rejectDiff,
  };
}
