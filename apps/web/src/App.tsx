import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useBridge } from "./useBridge";

export function App() {
  const b = useBridge();
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [b.messages, b.tools, b.diffs, b.tasks]);

  const onSubmit = () => {
    if (b.busy) {
      b.cancel();
      return;
    }
    const text = input;
    setInput("");
    b.prompt(text);
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Agent Pane</h1>
        <span className={`badge ${b.connected ? "ok" : "err"}`}>
          {b.connected ? "bridge" : "offline"}
        </span>
        {b.sessionId && <span className="badge ok">session</span>}
        <input
          className="cwd"
          placeholder="/path/to/project"
          value={b.cwd}
          onChange={(e) => b.setCwd(e.target.value)}
        />
        <input
          className="cwd"
          style={{ flex: 0.7 }}
          placeholder="model (optional)"
          value={b.model}
          onChange={(e) => b.setModel(e.target.value)}
        />
        <button className="primary" type="button" onClick={b.createSession}>
          新会话
        </button>
      </header>

      {b.error && (
        <div className="error-banner" onClick={() => b.setError(null)}>
          {b.error}
        </div>
      )}

      <main className="main">
        {!b.sessionId && b.messages.length === 0 && (
          <div className="empty">
            <strong>你的整窗 Agent</strong>
            填工作区路径 → 新会话 → 开聊。后端是 Grok ACP；工具流 / To-dos /
            Diff 都会画在这里。
          </div>
        )}

        {b.messages.map((m) => {
          if (m.kind === "user") {
            return (
              <div className="msg user" key={m.id}>
                <div className="label">You</div>
                <div className="bubble">{m.text}</div>
              </div>
            );
          }
          if (m.kind === "thought") {
            return (
              <div className="thought" key={m.id}>
                {m.text}
              </div>
            );
          }
          return (
            <div className="msg assistant" key={m.id}>
              <div className="label">Agent</div>
              <div className="bubble">
                <ReactMarkdown>{m.text}</ReactMarkdown>
              </div>
            </div>
          );
        })}

        {b.tools.length > 0 && (
          <div className="tools">
            {b.tools.map((t) => (
              <div
                key={t.toolId}
                className={`tool ${t.status === "done" ? "done" : ""} ${
                  t.status === "fail" ? "fail" : ""
                }`}
              >
                <span className="dot" />
                <span className="title">{t.title}</span>
                <span className="meta">{t.detail}</span>
              </div>
            ))}
          </div>
        )}

        {b.tasks.length > 0 && (
          <div className="todos">
            <h3>To-dos</h3>
            {b.tasks.map((t) => (
              <div key={t.id} className={`todo ${t.status}`}>
                <div className="check" />
                <span>{t.content}</span>
              </div>
            ))}
          </div>
        )}

        {b.permissions.map((p) => (
          <div className="perm" key={p.requestId}>
            <div>
              <strong>Permission</strong> · {p.tool}
              <div className="hint">{p.summary.slice(0, 200)}</div>
            </div>
            <div className="actions">
              <button type="button" onClick={() => b.respondPermission(p.requestId, true)}>
                Allow
              </button>
              <button type="button" onClick={() => b.respondPermission(p.requestId, false)}>
                Deny
              </button>
            </div>
          </div>
        ))}

        {b.diffs.length > 0 && (
          <div className="diffs">
            <div className="diff-bar">
              <span className="hint">{b.diffs.length} file(s) changed</span>
              <button
                type="button"
                className="accept"
                onClick={() => b.acceptDiff("*")}
              >
                Keep All
              </button>
              <button
                type="button"
                className="reject"
                onClick={() => b.rejectDiff("*")}
              >
                Undo All
              </button>
            </div>
            {b.diffs.map((f) => (
              <div className="diff-card" key={f.path}>
                <header>
                  <span className="path">{f.path}</span>
                  <span className="stats">
                    <span className="add">+{f.additions}</span>{" "}
                    <span className="del">−{f.deletions}</span>
                  </span>
                </header>
                {f.patch && <pre>{f.patch}</pre>}
                <div className="actions">
                  <button
                    type="button"
                    className="accept"
                    onClick={() => b.acceptDiff(f.path)}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="reject"
                    onClick={() => b.rejectDiff(f.path)}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div ref={bottomRef} />
      </main>

      <div className="composer-wrap">
        <div className="mode-bar">
          <select defaultValue="agent" aria-label="mode">
            <option value="agent">Agent</option>
          </select>
          <select defaultValue="auto" aria-label="permission">
            <option value="auto">Auto</option>
            <option value="default">Ask</option>
          </select>
          <span className="hint">
            {b.sessionId ? b.sessionId.slice(0, 8) : "no session"} · Grok ACP
          </span>
        </div>
        <div className="composer">
          <textarea
            placeholder="Plan, @ for context, / for commands — 先新会话再发"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
          />
          <div className="composer-footer">
            <span className="hint">Enter 发送 · Shift+Enter 换行</span>
            <button
              type="button"
              className={b.busy ? "stop" : ""}
              onClick={onSubmit}
              disabled={!b.connected || (!b.busy && !input.trim())}
            >
              {b.busy ? "Stop" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
