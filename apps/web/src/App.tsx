import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useBridge } from "./useBridge";
import { ToolTimeline } from "./ToolTimeline";
import {
  fetchProjects,
  fetchRecent,
  pickFolder,
  rememberPath,
  type ProjectEntry,
} from "./api";

function shortPath(p: string): string {
  if (!p) return "未选择项目";
  const home = "/Users/";
  // show last 2 segments
  const parts = p.replace(/\/$/, "").split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return parts.slice(-2).join("/");
}

export function App() {
  const b = useBridge();
  const [input, setInput] = useState("");
  const [recent, setRecent] = useState<ProjectEntry[]>([]);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPath, setManualPath] = useState("");
  const [picking, setPicking] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pendingPrompt = useRef<string | null>(null);
  const promptFn = useRef(b.prompt);
  promptFn.current = b.prompt;

  // 撤回后把原文塞回输入框
  useEffect(() => {
    if (b.restoredDraft != null) {
      setInput(b.restoredDraft);
      b.clearRestoredDraft();
    }
  }, [b.restoredDraft, b]);

  const refreshLists = useCallback(async () => {
    const [r, p] = await Promise.all([fetchRecent(), fetchProjects()]);
    setRecent(r);
    setProjects(p);
  }, []);

  useEffect(() => {
    void refreshLists();
  }, [refreshLists]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [b.messages, b.diffs, b.tasks]);

  const selectCwd = async (path: string) => {
    b.setCwd(path);
    localStorage.setItem("agent-pane-cwd", path);
    await rememberPath(path);
    await refreshLists();
  };

  const onBrowse = async () => {
    setPicking(true);
    try {
      const path = await pickFolder();
      if (path) await selectCwd(path);
    } catch (e) {
      b.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  };

  const ensureSessionAndSend = async (text: string) => {
    if (!text.trim()) return;
    if (!b.cwd.trim()) {
      b.setError("先选择项目文件夹");
      return;
    }
    if (!b.sessionId) {
      pendingPrompt.current = text.trim();
      setInput("");
      b.createSession();
      return;
    }
    setInput("");
    b.prompt(text.trim());
  };

  useEffect(() => {
    if (b.sessionId && pendingPrompt.current) {
      const t = pendingPrompt.current;
      pendingPrompt.current = null;
      promptFn.current(t);
    }
  }, [b.sessionId]);

  const onSubmit = () => {
    if (b.busy) {
      b.cancel();
      return;
    }
    void ensureSessionAndSend(input);
  };

  const inSession = Boolean(b.sessionId);

  const composer = (
    <div className="hero-card">
      <textarea
        placeholder="Plan, Build, / for skills, @ for context"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="hero-row">
        <div className="model-chip">
          <span>+</span>
          <input
            placeholder="Grok (default)"
            value={b.model}
            onChange={(e) => b.setModel(e.target.value)}
          />
        </div>
        <span className="grow" />
        {inSession && (
          <button
            type="button"
            className="ghost-btn"
            title="撤回上一条用户消息，原文回填输入框"
            onClick={() => b.undoLast()}
          >
            撤回
          </button>
        )}
        <button
          type="button"
          className={`send-btn ${b.busy ? "stop" : ""}`}
          onClick={onSubmit}
          disabled={!b.connected || (!b.busy && !input.trim())}
        >
          {b.busy ? "Stop" : inSession ? "Send" : "Start"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <button
          type="button"
          className="side-btn primary"
          onClick={() => {
            if (!b.cwd) {
              void onBrowse();
              return;
            }
            b.createSession();
          }}
        >
          <span className="ico">✦</span>
          New Agent
        </button>
        <button type="button" className="side-btn" onClick={() => void onBrowse()}>
          <span className="ico">📁</span>
          {picking ? "选择中…" : "打开项目…"}
        </button>
        <button
          type="button"
          className="side-btn"
          onClick={() => {
            setManualPath(b.cwd);
            setManualOpen(true);
          }}
        >
          <span className="ico">⌘</span>
          输入路径…
        </button>

        <div className="side-section">
          <span>Recent</span>
        </div>
        <div className="side-list">
          {recent.length === 0 && (
            <div className="hint" style={{ padding: "6px 10px" }}>
              还没有最近项目
            </div>
          )}
          {recent.map((r) => (
            <button
              key={r.path}
              type="button"
              className={`side-item ${b.cwd === r.path ? "active" : ""}`}
              onClick={() => void selectCwd(r.path)}
              title={r.path}
            >
              <span>📂</span>
              <span className="name">{r.name}</span>
            </button>
          ))}

          <div className="side-section">
            <span>Projects</span>
          </div>
          {projects.map((p) => (
            <button
              key={p.path}
              type="button"
              className={`side-item ${b.cwd === p.path ? "active" : ""}`}
              onClick={() => void selectCwd(p.path)}
              title={p.path}
            >
              <span>📁</span>
              <span className="name">{p.name}</span>
            </button>
          ))}
        </div>

        <div className="side-foot">
          <div className={`status-pill ${b.connected ? "ok" : ""}`}>
            <span className="dot" />
            {b.connected ? "Bridge · Grok ACP" : "Bridge offline"}
          </div>
          <div className="hint" style={{ paddingLeft: 8 }}>
            不依赖 Grok Build UI
          </div>
        </div>
      </aside>

      <div className="stage">
        <div className="stage-top">
          <div className="workspace-chip">
            <span>This Mac</span>
            <span style={{ opacity: 0.35 }}>·</span>
            <strong title={b.cwd || undefined}>{shortPath(b.cwd)}</strong>
            <button type="button" onClick={() => void onBrowse()}>
              {picking ? "…" : "选择"}
            </button>
          </div>
          <div className="spacer" />
          {b.sessionId && (
            <button type="button" className="ghost-btn" onClick={b.createSession}>
              新会话
            </button>
          )}
        </div>

        {b.error && (
          <div className="error-banner" onClick={() => b.setError(null)}>
            {b.error}
          </div>
        )}

        {!inSession ? (
          <div className="home">
            <div className="home-label">
              <span>Home</span>
              <span style={{ opacity: 0.35 }}>▾</span>
              <span>This Mac</span>
            </div>
            {composer}
            <div className="pills">
              <button
                type="button"
                className="pill"
                onClick={() => void onBrowse()}
              >
                选择项目文件夹
              </button>
              <button
                type="button"
                className="pill"
                onClick={() => {
                  if (b.cwd) b.createSession();
                  else void onBrowse();
                }}
              >
                New Agent
              </button>
              <button
                type="button"
                className="pill"
                onClick={() => setInput("总结这个仓库的结构和主要入口文件")}
              >
                探索代码库
              </button>
            </div>
            <div className="home-hint">
              后端是 <code>grok agent stdio</code>（ACP），和 Grok Build TUI
              菜单无关 · Enter 发送
            </div>
          </div>
        ) : (
          <>
            <main className="chat">
              {b.messages.map((m, idx) => {
                if (m.kind === "user") {
                  let lastUserIdx = -1;
                  for (let i = b.messages.length - 1; i >= 0; i--) {
                    if (b.messages[i]!.kind === "user") {
                      lastUserIdx = i;
                      break;
                    }
                  }
                  const isLastUser = lastUserIdx === idx;
                  return (
                    <div className="msg user" key={m.id}>
                      <div className="label-row">
                        <div className="label">You</div>
                        {isLastUser && (
                          <button
                            type="button"
                            className="undo-btn"
                            title="撤回这条并填回输入框"
                            onClick={() => b.undoLast()}
                          >
                            撤回
                          </button>
                        )}
                      </div>
                      <div className="bubble">{m.text}</div>
                    </div>
                  );
                }
                if (m.kind === "thought") {
                  return (
                    <details className="tl-thought" key={m.id}>
                      <summary>
                        <span className="tl-chev">▸</span>
                        Thought briefly
                      </summary>
                      <div className="tl-thought-body">{m.text}</div>
                    </details>
                  );
                }
                if (m.kind === "tools") {
                  return <ToolTimeline key={m.id} tools={m.tools} />;
                }
                return (
                  <div className="msg assistant" key={m.id}>
                    <div className="assistant-text">
                      <ReactMarkdown>{m.text}</ReactMarkdown>
                    </div>
                  </div>
                );
              })}

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
                    <button
                      type="button"
                      onClick={() => b.respondPermission(p.requestId, true)}
                    >
                      Allow
                    </button>
                    <button
                      type="button"
                      onClick={() => b.respondPermission(p.requestId, false)}
                    >
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
            <div className="composer-dock">{composer}</div>
          </>
        )}
      </div>

      {manualOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setManualOpen(false)}
          onKeyDown={() => undefined}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={() => undefined}
          >
            <h3>手动输入路径</h3>
            <input
              autoFocus
              placeholder="/Users/you/projects/foo"
              value={manualPath}
              onChange={(e) => setManualPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && manualPath.trim()) {
                  void selectCwd(manualPath.trim());
                  setManualOpen(false);
                }
              }}
            />
            <div className="modal-actions">
              <button type="button" onClick={() => setManualOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  if (manualPath.trim()) {
                    void selectCwd(manualPath.trim());
                    setManualOpen(false);
                  }
                }}
              >
                使用此路径
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
