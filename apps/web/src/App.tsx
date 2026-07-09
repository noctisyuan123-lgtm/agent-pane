import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useBridge } from "./useBridge";
import { ToolTimeline } from "./ToolTimeline";
import {
  fetchHistory,
  fetchProjects,
  fetchRecent,
  formatRelTime,
  peekHistoryCache,
  pickFolder,
  rememberPath,
  type HistoryGroup,
  type ProjectEntry,
} from "./api";

function shortPath(p: string): string {
  if (!p) return "未选择项目";
  const parts = p.replace(/\/$/, "").split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return parts.slice(-2).join("/");
}

function useAutoGrow(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
  opts: { min: number; max: number }
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(opts.max, Math.max(opts.min, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [value, ref, opts.min, opts.max]);
}

export function App() {
  const b = useBridge();
  const [input, setInput] = useState("");
  const [recent, setRecent] = useState<ProjectEntry[]>([]);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [history, setHistory] = useState<HistoryGroup[]>(
    () => peekHistoryCache() ?? []
  );
  const [expandedCwd, setExpandedCwd] = useState<Record<string, boolean>>({});
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPath, setManualPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [showJumpBottom, setShowJumpBottom] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const pendingPrompt = useRef<string | null>(null);
  const promptFn = useRef(b.prompt);
  promptFn.current = b.prompt;
  const createFn = useRef(b.createSession);
  createFn.current = b.createSession;

  const inSession = Boolean(b.sessionId);
  // follow-up bar: single-line grow; home hero: taller
  const growMin = inSession ? 22 : 56;
  const growMax = inSession ? 140 : 200;
  useAutoGrow(taRef, input, { min: growMin, max: growMax });

  useEffect(() => {
    if (b.restoredDraft != null) {
      setInput(b.restoredDraft);
      b.clearRestoredDraft();
    }
  }, [b.restoredDraft, b]);

  const refreshLists = useCallback(async (forceHistory = false) => {
    const [r, p, h] = await Promise.all([
      fetchRecent(),
      fetchProjects(),
      fetchHistory(forceHistory),
    ]);
    setRecent(r);
    setProjects(p);
    setHistory(h);
  }, []);

  useEffect(() => {
    // 首屏用 cache 立刻画，后台静默刷新
    void refreshLists(false);
  }, [refreshLists]);

  // 新会话 / 用户消息后刷新历史（带 TTL，不卡）
  useEffect(() => {
    if (!b.sessionId) return;
    const t = setTimeout(() => void refreshLists(true), 800);
    return () => clearTimeout(t);
  }, [b.sessionId, b.messages.length, refreshLists]);

  // auto scroll only when near bottom
  useEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist < 120) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      setShowJumpBottom(false);
    } else {
      setShowJumpBottom(true);
    }
  }, [b.messages, b.diffs, b.tasks]);

  useEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowJumpBottom(dist > 160);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [inSession]);

  const jumpBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    setShowJumpBottom(false);
  };

  const selectCwd = async (path: string) => {
    b.setCwd(path);
    localStorage.setItem("agent-pane-cwd", path);
    await rememberPath(path);
    await refreshLists(false);
    setExpandedCwd((m) => ({ ...m, [path]: true }));
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
    // 历史只读 / 无 live agent → 新开会话再发
    if (!b.sessionId || b.historyOnly) {
      pendingPrompt.current = text.trim();
      setInput("");
      b.createSession();
      return;
    }
    setInput("");
    b.prompt(text.trim());
  };

  useEffect(() => {
    if (b.sessionId && !b.historyOnly && pendingPrompt.current) {
      const t = pendingPrompt.current;
      pendingPrompt.current = null;
      promptFn.current(t);
    }
  }, [b.sessionId, b.historyOnly]);

  const onSubmit = () => {
    if (b.busy) {
      b.cancel();
      return;
    }
    void ensureSessionAndSend(input);
  };

  const openHist = async (sessionId: string, cwd: string) => {
    await b.openHistorySession(sessionId, cwd);
    setExpandedCwd((m) => ({ ...m, [cwd]: true }));
  };

  const composer = (
    <div className={`composer-shell ${inSession ? "followup" : "hero"}`}>
      <textarea
        ref={taRef}
        className="composer-ta"
        placeholder={
          inSession
            ? "Send follow-up…"
            : "Plan, Build, / for skills, @ for context"
        }
        rows={1}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="composer-bar">
        <div className="model-chip">
          <span className="plus">+</span>
          <input
            placeholder="Grok"
            value={b.model}
            onChange={(e) => b.setModel(e.target.value)}
          />
        </div>
        <span className="grow" />
        {inSession && !b.historyOnly && (
          <button
            type="button"
            className="ghost-btn compact"
            title="撤回上一条"
            onClick={() => b.undoLast()}
          >
            撤回
          </button>
        )}
        {b.historyOnly && (
          <span className="hist-hint">历史 · 发送将新开会话</span>
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
          <span>Repositories</span>
          <button
            type="button"
            className="icon-mini"
            title="刷新历史"
            onClick={() => void refreshLists(true)}
          >
            ↻
          </button>
        </div>

        <div className="side-list">
          {history.length === 0 && (
            <div className="hint" style={{ padding: "6px 10px" }}>
              还没有会话历史
            </div>
          )}
          {history.map((g) => {
            const open = expandedCwd[g.cwd] ?? g.cwd === b.cwd;
            return (
              <div key={g.cwd} className="hist-group">
                <button
                  type="button"
                  className={`side-item folder ${b.cwd === g.cwd ? "active" : ""}`}
                  onClick={() => {
                    setExpandedCwd((m) => ({
                      ...m,
                      [g.cwd]: !open,
                    }));
                    void selectCwd(g.cwd);
                  }}
                  title={g.cwd}
                >
                  <span className={`tl-chev ${open ? "open" : ""}`}>▸</span>
                  <span className="name">📁 {g.name}</span>
                  <span className="meta">{g.sessions.length}</span>
                </button>
                {open &&
                  g.sessions.map((s) => (
                    <button
                      key={s.sessionId}
                      type="button"
                      className={`side-item session ${
                        b.sessionId === s.sessionId ? "active" : ""
                      }`}
                      onClick={() => void openHist(s.sessionId, s.cwd)}
                      title={s.title}
                    >
                      <span className="name">{s.title || "Untitled"}</span>
                      <span className="meta">{formatRelTime(s.updatedAt)}</span>
                    </button>
                  ))}
              </div>
            );
          })}

          {recent.length > 0 && (
            <>
              <div className="side-section">
                <span>Recent paths</span>
              </div>
              {recent.slice(0, 8).map((r) => (
                <button
                  key={r.path}
                  type="button"
                  className={`side-item ${b.cwd === r.path ? "active" : ""}`}
                  onClick={() => void selectCwd(r.path)}
                  title={r.path}
                >
                  <span className="name">{r.name}</span>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="side-foot">
          <div className={`status-pill ${b.connected ? "ok" : ""}`}>
            <span className="dot" />
            {b.connected ? "Bridge · Grok ACP" : "Bridge offline"}
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
            <button
              type="button"
              className="ghost-btn"
              onClick={b.createSession}
            >
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
              <button type="button" className="pill" onClick={() => void onBrowse()}>
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
            </div>
            <div className="home-hint">
              历史在左侧 Repositories · 缓存 15s 不重复扫盘
            </div>
          </div>
        ) : (
          <>
            <main
              className="chat"
              ref={(n) => {
                chatRef.current = n;
              }}
            >
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
                        {isLastUser && !b.historyOnly && (
                          <button
                            type="button"
                            className="undo-btn"
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

            {showJumpBottom && (
              <button
                type="button"
                className="jump-bottom"
                onClick={jumpBottom}
                title="滚到底部"
              >
                ↓
              </button>
            )}

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
