import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientCommand,
  DiffFileMeta,
  DomainEvent,
  ServerMessage,
  Task,
} from "@agent-pane/shared";

export type ChatItem =
  | { kind: "user"; text: string; id: string }
  | { kind: "assistant"; text: string; id: string }
  | { kind: "thought"; text: string; id: string };

export type ToolRow = {
  toolId: string;
  title: string;
  kind: string;
  status: "running" | "done" | "fail";
  detail?: string;
};

export type PermissionReq = {
  requestId: string;
  tool: string;
  summary: string;
};

const WS_URL = import.meta.env.VITE_BRIDGE_WS ?? "ws://127.0.0.1:8787";

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
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [diffs, setDiffs] = useState<DiffFileMeta[]>([]);
  const [permissions, setPermissions] = useState<PermissionReq[]>([]);
  const [busy, setBusy] = useState(false);
  const assistantBuf = useRef("");

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
        setTools([]);
        setTasks([]);
        setDiffs([]);
        setBusy(false);
        break;
      case "UserMessageAppended":
        setMessages((m) => [
          ...m,
          { kind: "user", text: event.text, id: `u-${event.seq ?? event.at}` },
        ]);
        setBusy(true);
        assistantBuf.current = "";
        break;
      case "MessageChunk":
        assistantBuf.current += event.text;
        setMessages((m) => {
          const id = `a-${event.sessionId}-live`;
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
      case "ThoughtChunk":
        setMessages((m) => {
          const id = `t-${event.sessionId}-live`;
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
        setBusy(false);
        break;
      case "ToolStarted":
        setTools((t) => [
          ...t.filter((x) => x.toolId !== event.toolId),
          {
            toolId: event.toolId,
            title: event.title,
            kind: event.kind,
            status: "running",
            detail: event.inputSummary,
          },
        ]);
        break;
      case "ToolProgress":
        setTools((t) =>
          t.map((x) =>
            x.toolId === event.toolId
              ? { ...x, detail: event.detail ?? x.detail }
              : x
          )
        );
        break;
      case "ToolFinished":
        setTools((t) =>
          t.map((x) =>
            x.toolId === event.toolId
              ? {
                  ...x,
                  status: "done",
                  detail: event.outputSummary ?? x.detail,
                }
              : x
          )
        );
        break;
      case "ToolFailed":
        setTools((t) =>
          t.map((x) =>
            x.toolId === event.toolId
              ? { ...x, status: "fail", detail: event.error }
              : x
          )
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
    setTools([]);
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
    tools,
    tasks,
    diffs,
    permissions,
    busy,
    createSession,
    prompt,
    cancel,
    respondPermission,
    acceptDiff,
    rejectDiff,
  };
}
