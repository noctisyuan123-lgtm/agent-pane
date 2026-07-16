import { useEffect, useState } from "react";
import {
  deleteCustomizeHook,
  fetchCustomizeFiles,
  fetchCustomizeHooks,
  fetchCustomizeMcp,
  fetchSkills,
  revealInFinder,
  saveCustomizeFile,
  saveCustomizeHook,
  saveCustomizeMcp,
  type CustomizeFile,
  type CustomizeHookFile,
  type CustomizeMcpState,
  type GrokMcpServer,
  type SkillEntry,
} from "./api";
import {
  IconBook,
  IconCheck,
  IconCustomize,
  IconLayers,
  IconList,
  IconPencil,
  IconPlus,
  IconSpark,
  IconTerminal,
  IconTrash,
} from "./icons";

const MEMORY_INDEX = "/Users/maybach/.grok/memory/MEMORY.md";
const MEMORY_STICKY = "/Users/maybach/.grok/rules/00-automemory-sticky.md";
const MEMORY_ENTRIES = "/Users/maybach/.grok/memory/entries";

type Props = {
  connected: boolean;
  bridgeLabel: string;
  model: string;
  effortLabel: string;
  agentMode: string;
  onClose: () => void;
};

export function CustomizePanel({
  connected,
  bridgeLabel,
  model,
  effortLabel,
  agentMode,
  onClose,
}: Props) {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const [files, setFiles] = useState<CustomizeFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileSaved, setFileSaved] = useState<string | null>(null);

  const [mcp, setMcp] = useState<CustomizeMcpState | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [grokDraft, setGrokDraft] = useState<GrokMcpServer[]>([]);
  const [cursorDraft, setCursorDraft] = useState("");
  const [showCursorEditor, setShowCursorEditor] = useState(false);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpSaved, setMcpSaved] = useState(false);

  const [hooksDir, setHooksDir] = useState("");
  const [hookFiles, setHookFiles] = useState<CustomizeHookFile[]>([]);
  const [hooksLoading, setHooksLoading] = useState(false);
  const [hookEditing, setHookEditing] = useState<string | null>(null);
  const [hookDraft, setHookDraft] = useState("");
  const [hookBusy, setHookBusy] = useState(false);
  const [hookError, setHookError] = useState<string | null>(null);
  const [hookSaved, setHookSaved] = useState<string | null>(null);
  const [newHookName, setNewHookName] = useState("");
  const [showNewHook, setShowNewHook] = useState(false);

  const reloadFiles = async () => {
    setFilesLoading(true);
    try {
      setFiles(await fetchCustomizeFiles());
    } catch {
      setFiles([]);
    } finally {
      setFilesLoading(false);
    }
  };

  const reloadMcp = async () => {
    setMcpLoading(true);
    try {
      const state = await fetchCustomizeMcp();
      setMcp(state);
      setGrokDraft(state?.grok ?? []);
      setCursorDraft(state?.cursorJson ?? "");
    } catch {
      setMcp(null);
    } finally {
      setMcpLoading(false);
    }
  };

  const reloadHooks = async () => {
    setHooksLoading(true);
    try {
      const state = await fetchCustomizeHooks();
      setHooksDir(state.hooksDir || "");
      setHookFiles(state.files ?? []);
    } catch {
      setHooksDir("");
      setHookFiles([]);
    } finally {
      setHooksLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setSkillsLoading(true);
    void fetchSkills()
      .then((list) => {
        if (!cancelled) setSkills(list);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    void reloadFiles();
    void reloadMcp();
    void reloadHooks();
    return () => {
      cancelled = true;
    };
  }, []);

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(path);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      /* ignore */
    }
  };

  const openEdit = (file: CustomizeFile) => {
    setEditingId(file.id);
    setDraft(file.content);
    setFileError(null);
    setFileSaved(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft("");
    setFileError(null);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setFileBusy(true);
    setFileError(null);
    try {
      const saved = await saveCustomizeFile(editingId, draft);
      setFiles((prev) =>
        prev.map((f) => (f.id === saved.id ? saved : f))
      );
      setFileSaved(saved.id);
      setEditingId(null);
      setDraft("");
      window.setTimeout(() => setFileSaved(null), 2000);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setFileBusy(false);
    }
  };

  const toggleGrok = (name: string) => {
    setGrokDraft((prev) =>
      prev.map((s) =>
        s.name === name ? { ...s, enabled: !s.enabled } : s
      )
    );
    setMcpSaved(false);
  };

  const setGrokUserId = (name: string, userId: string) => {
    setGrokDraft((prev) =>
      prev.map((s) =>
        s.name === name
          ? { ...s, env: { ...s.env, MEM0_USER_ID: userId } }
          : s
      )
    );
    setMcpSaved(false);
  };

  const saveGrokMcp = async () => {
    setMcpBusy(true);
    setMcpError(null);
    try {
      const patches = grokDraft.map((s) => {
        const env: Record<string, string> = {};
        if (typeof s.env.MEM0_USER_ID === "string") {
          env.MEM0_USER_ID = s.env.MEM0_USER_ID;
        }
        return { name: s.name, enabled: s.enabled, env };
      });
      const state = await saveCustomizeMcp({ grok: patches });
      setMcp(state);
      setGrokDraft(state.grok);
      setCursorDraft(state.cursorJson);
      setMcpSaved(true);
      window.setTimeout(() => setMcpSaved(false), 2000);
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : String(e));
    } finally {
      setMcpBusy(false);
    }
  };

  const saveCursorMcp = async () => {
    setMcpBusy(true);
    setMcpError(null);
    try {
      const state = await saveCustomizeMcp({ cursorJson: cursorDraft });
      setMcp(state);
      setGrokDraft(state.grok);
      setCursorDraft(state.cursorJson);
      setMcpSaved(true);
      window.setTimeout(() => setMcpSaved(false), 2000);
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : String(e));
    } finally {
      setMcpBusy(false);
    }
  };

  const openHookEdit = (f: CustomizeHookFile) => {
    setHookEditing(f.name);
    setHookDraft(f.content);
    setHookError(null);
    setHookSaved(null);
    setShowNewHook(false);
  };

  const cancelHookEdit = () => {
    setHookEditing(null);
    setHookDraft("");
    setHookError(null);
    setShowNewHook(false);
    setNewHookName("");
  };

  const saveHookEdit = async () => {
    if (!hookEditing) return;
    setHookBusy(true);
    setHookError(null);
    try {
      const state = await saveCustomizeHook(hookEditing, hookDraft, false);
      setHooksDir(state.hooksDir);
      setHookFiles(state.files);
      setHookSaved(state.file.name);
      setHookEditing(null);
      setHookDraft("");
      window.setTimeout(() => setHookSaved(null), 2000);
    } catch (e) {
      setHookError(e instanceof Error ? e.message : String(e));
    } finally {
      setHookBusy(false);
    }
  };

  const createHook = async () => {
    let name = newHookName.trim();
    if (!name) {
      setHookError("给 hook 起个名字");
      return;
    }
    if (!/\.(json|sh|py|js|mjs|cjs|ts)$/i.test(name)) {
      name = `${name}.json`;
    }
    setHookBusy(true);
    setHookError(null);
    try {
      const state = await saveCustomizeHook(name, "", true);
      setHooksDir(state.hooksDir);
      setHookFiles(state.files);
      setShowNewHook(false);
      setNewHookName("");
      openHookEdit(state.file);
      setHookSaved(state.file.name);
      window.setTimeout(() => setHookSaved(null), 2000);
    } catch (e) {
      setHookError(e instanceof Error ? e.message : String(e));
    } finally {
      setHookBusy(false);
    }
  };

  const removeHook = async (name: string) => {
    if (!window.confirm(`删除 hook「${name}」？此操作不可撤销。`)) return;
    setHookBusy(true);
    setHookError(null);
    try {
      const state = await deleteCustomizeHook(name);
      setHooksDir(state.hooksDir);
      setHookFiles(state.files);
      if (hookEditing === name) cancelHookEdit();
    } catch (e) {
      setHookError(e instanceof Error ? e.message : String(e));
    } finally {
      setHookBusy(false);
    }
  };

  const modeLabel =
    agentMode === "plan"
      ? "Plan"
      : agentMode === "debug"
        ? "Debug"
        : agentMode === "multitask"
          ? "Multitask"
          : agentMode === "auto"
            ? "Ask"
            : "Agent";

  const rules = files.filter((f) => f.kind === "rule");
  const memoryFiles = files.filter((f) => f.kind === "memory");

  return (
    <div className="customize">
      <div className="customize-head">
        <div className="customize-title">
          <IconCustomize size={16} />
          <span>Customize</span>
        </div>
        <button type="button" className="customize-close" onClick={onClose}>
          Done
        </button>
      </div>

      <div className="customize-body">
        <section className="customize-section">
          <h3>
            <IconList size={14} /> Memory
          </h3>
          <p className="customize-hint">
            Sticky 协议进 harness；索引按需 Read（compact 后协议仍在）。mem0
            user_id 用小写 <code>noctis</code>。
          </p>
          <div className="customize-rows">
            <div className="customize-row">
              <span className="customize-row-label">Index</span>
              <code className="customize-path">{MEMORY_INDEX}</code>
              <button
                type="button"
                className="customize-mini"
                onClick={() => void copyPath(MEMORY_INDEX)}
              >
                {copied === MEMORY_INDEX ? <IconCheck size={12} /> : "Copy"}
              </button>
              <button
                type="button"
                className="customize-mini"
                onClick={() => void revealInFinder(MEMORY_INDEX)}
              >
                Reveal
              </button>
              {memoryFiles[0] && (
                <button
                  type="button"
                  className="customize-mini"
                  onClick={() => openEdit(memoryFiles[0]!)}
                >
                  <IconPencil size={11} /> Edit
                </button>
              )}
            </div>
            <div className="customize-row">
              <span className="customize-row-label">Sticky</span>
              <code className="customize-path">{MEMORY_STICKY}</code>
              <button
                type="button"
                className="customize-mini"
                onClick={() => void copyPath(MEMORY_STICKY)}
              >
                {copied === MEMORY_STICKY ? <IconCheck size={12} /> : "Copy"}
              </button>
              {(() => {
                const sticky = rules.find(
                  (f) => f.name === "00-automemory-sticky.md"
                );
                return sticky ? (
                  <button
                    type="button"
                    className="customize-mini"
                    onClick={() => openEdit(sticky)}
                  >
                    <IconPencil size={11} /> Edit
                  </button>
                ) : null;
              })()}
            </div>
            <div className="customize-row">
              <span className="customize-row-label">Entries</span>
              <code className="customize-path">{MEMORY_ENTRIES}</code>
              <button
                type="button"
                className="customize-mini"
                onClick={() => void revealInFinder(MEMORY_ENTRIES)}
              >
                Reveal
              </button>
            </div>
          </div>
        </section>

        <section className="customize-section">
          <h3>
            <IconPencil size={14} /> Rules
          </h3>
          <p className="customize-hint">
            编辑 <code>~/.grok/rules/*.md</code>
            。改完下次新会话生效；当前会话不会热重载。
          </p>
          {filesLoading && (
            <div className="customize-empty">Loading rules…</div>
          )}
          {!filesLoading && rules.length === 0 && (
            <div className="customize-empty">No rule files found</div>
          )}
          {!filesLoading && rules.length > 0 && (
            <div className="customize-rows">
              {rules.map((f) => (
                <div key={f.id} className="customize-row">
                  <span className="customize-row-label">Rule</span>
                  <code className="customize-path">{f.name}</code>
                  {fileSaved === f.id && (
                    <span className="customize-saved">Saved</span>
                  )}
                  <button
                    type="button"
                    className="customize-mini"
                    onClick={() => openEdit(f)}
                  >
                    <IconPencil size={11} /> Edit
                  </button>
                </div>
              ))}
            </div>
          )}

          {editingId && (
            <div className="customize-editor">
              <div className="customize-editor-head">
                <span>
                  Editing{" "}
                  <code>
                    {files.find((f) => f.id === editingId)?.name ?? editingId}
                  </code>
                </span>
                <div className="customize-editor-actions">
                  <button
                    type="button"
                    className="customize-mini"
                    disabled={fileBusy}
                    onClick={cancelEdit}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="customize-mini customize-mini-primary"
                    disabled={fileBusy}
                    onClick={() => void saveEdit()}
                  >
                    {fileBusy ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
              <textarea
                className="customize-textarea"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                rows={16}
              />
              {fileError && (
                <div className="customize-error">{fileError}</div>
              )}
            </div>
          )}
        </section>

        <section className="customize-section">
          <h3>
            <IconSpark size={14} /> Hooks
          </h3>
          <p className="customize-hint">
            读写 <code>~/.grok/hooks/*.json</code>
            （及同目录脚本）。改完<strong>新会话</strong>生效；可挂
            SessionStart / PreToolUse / UserPromptSubmit 等。
          </p>

          <div className="customize-editor-actions" style={{ marginBottom: 8 }}>
            {hooksDir && (
              <button
                type="button"
                className="customize-mini"
                onClick={() => void revealInFinder(hooksDir)}
              >
                Reveal hooks/
              </button>
            )}
            <button
              type="button"
              className="customize-mini"
              onClick={() => void reloadHooks()}
              disabled={hooksLoading || hookBusy}
            >
              Refresh
            </button>
            <button
              type="button"
              className="customize-mini customize-mini-primary"
              onClick={() => {
                setShowNewHook(true);
                setHookEditing(null);
                setHookDraft("");
                setHookError(null);
              }}
              disabled={hookBusy}
            >
              <IconPlus size={11} /> New hook
            </button>
          </div>

          {hooksLoading && (
            <div className="customize-empty">Loading hooks…</div>
          )}
          {!hooksLoading && hookFiles.length === 0 && !showNewHook && (
            <div className="customize-empty">
              还没有 hook。点 New hook 在{" "}
              <code>~/.grok/hooks/</code> 建一个。
            </div>
          )}
          {!hooksLoading && hookFiles.length > 0 && (
            <div className="customize-rows">
              {hookFiles.map((f) => (
                <div key={f.id} className="customize-row">
                  <span className="customize-row-label">
                    {f.kind === "json" ? "Hook" : "Script"}
                  </span>
                  <code className="customize-path">{f.name}</code>
                  {f.events.length > 0 && (
                    <span className="customize-hook-events">
                      {f.events.join(" · ")}
                    </span>
                  )}
                  {hookSaved === f.name && (
                    <span className="customize-saved">Saved</span>
                  )}
                  <button
                    type="button"
                    className="customize-mini"
                    onClick={() => openHookEdit(f)}
                    disabled={hookBusy}
                  >
                    <IconPencil size={11} /> Edit
                  </button>
                  <button
                    type="button"
                    className="customize-mini"
                    onClick={() => void removeHook(f.name)}
                    disabled={hookBusy}
                    title="Delete"
                  >
                    <IconTrash size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {showNewHook && (
            <div className="customize-editor">
              <div className="customize-editor-head">
                <span>New hook file</span>
                <div className="customize-editor-actions">
                  <button
                    type="button"
                    className="customize-mini"
                    disabled={hookBusy}
                    onClick={cancelHookEdit}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="customize-mini customize-mini-primary"
                    disabled={hookBusy}
                    onClick={() => void createHook()}
                  >
                    {hookBusy ? "Creating…" : "Create"}
                  </button>
                </div>
              </div>
              <label className="customize-field">
                <span>Filename（默认补 .json）</span>
                <input
                  type="text"
                  value={newHookName}
                  onChange={(e) => setNewHookName(e.target.value)}
                  placeholder="my-session-start.json"
                  spellCheck={false}
                />
              </label>
              {hookError && (
                <div className="customize-error">{hookError}</div>
              )}
            </div>
          )}

          {hookEditing && (
            <div className="customize-editor">
              <div className="customize-editor-head">
                <span>
                  Editing <code>{hookEditing}</code>
                </span>
                <div className="customize-editor-actions">
                  <button
                    type="button"
                    className="customize-mini"
                    disabled={hookBusy}
                    onClick={cancelHookEdit}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="customize-mini customize-mini-primary"
                    disabled={hookBusy}
                    onClick={() => void saveHookEdit()}
                  >
                    {hookBusy ? "Saving…" : "Save to disk"}
                  </button>
                </div>
              </div>
              <textarea
                className="customize-textarea customize-textarea-json"
                value={hookDraft}
                onChange={(e) => setHookDraft(e.target.value)}
                spellCheck={false}
                rows={16}
              />
              {hookError && (
                <div className="customize-error">{hookError}</div>
              )}
            </div>
          )}
        </section>

        <section className="customize-section">
          <h3>
            <IconBook size={14} /> Skills
          </h3>
          <p className="customize-hint">
            Composer <code>+</code> 菜单也可打开。此处只读浏览。
          </p>
          {skillsLoading && (
            <div className="customize-empty">Loading skills…</div>
          )}
          {!skillsLoading && skills.length === 0 && (
            <div className="customize-empty">No skills found</div>
          )}
          {!skillsLoading && skills.length > 0 && (
            <ul className="customize-skills">
              {skills.slice(0, 40).map((s) => (
                <li key={s.name}>
                  <span className="customize-skill-name">{s.name}</span>
                  {s.description && (
                    <span className="customize-skill-desc">{s.description}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="customize-section">
          <h3>
            <IconLayers size={14} /> Agent defaults
          </h3>
          <div className="customize-kv">
            <div>
              <span>Model</span>
              <strong>
                {model} · {effortLabel}
              </strong>
            </div>
            <div>
              <span>Mode</span>
              <strong>{modeLabel}</strong>
            </div>
          </div>
          <p className="customize-hint">
            在输入框模型 chip / ⇧Tab / + 菜单里改；会按模型分别记住
            effort。
          </p>
        </section>

        <section className="customize-section">
          <h3>
            <IconTerminal size={14} /> Bridge & MCP
          </h3>
          <div className="customize-kv">
            <div>
              <span>Bridge</span>
              <strong className={connected ? "ok" : "bad"}>
                {connected ? `● ${bridgeLabel}` : "○ disconnected"}
              </strong>
            </div>
          </div>

          <p className="customize-hint">
            Grok MCP 写在 <code>~/.grok/config.toml</code>；Cursor MCP 写在{" "}
            <code>~/.cursor/mcp.json</code>。密钥不会明文回显。
          </p>

          {mcpLoading && (
            <div className="customize-empty">Loading MCP…</div>
          )}

          {!mcpLoading && grokDraft.length > 0 && (
            <div className="customize-mcp-list">
              <div className="customize-mcp-label">Grok MCP servers</div>
              {grokDraft.map((s) => (
                <div key={s.name} className="customize-mcp-card">
                  <div className="customize-mcp-card-top">
                    <strong>{s.name}</strong>
                    <label className="customize-toggle">
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        onChange={() => toggleGrok(s.name)}
                      />
                      <span>{s.enabled ? "On" : "Off"}</span>
                    </label>
                  </div>
                  {s.command && (
                    <code className="customize-mcp-cmd">
                      {s.command}
                      {s.args?.length ? ` ${s.args.join(" ")}` : ""}
                    </code>
                  )}
                  {"MEM0_USER_ID" in s.env && (
                    <label className="customize-field">
                      <span>MEM0_USER_ID</span>
                      <input
                        type="text"
                        value={s.env.MEM0_USER_ID ?? ""}
                        onChange={(e) =>
                          setGrokUserId(s.name, e.target.value)
                        }
                        spellCheck={false}
                      />
                    </label>
                  )}
                  {Object.entries(s.env)
                    .filter(([k]) => k !== "MEM0_USER_ID")
                    .map(([k, v]) => (
                      <div key={k} className="customize-mcp-env">
                        <span>{k}</span>
                        <code>{v}</code>
                      </div>
                    ))}
                </div>
              ))}
              <div className="customize-editor-actions">
                {mcp?.grokConfigPath && (
                  <button
                    type="button"
                    className="customize-mini"
                    onClick={() => void revealInFinder(mcp.grokConfigPath)}
                  >
                    Reveal config.toml
                  </button>
                )}
                <button
                  type="button"
                  className="customize-mini customize-mini-primary"
                  disabled={mcpBusy}
                  onClick={() => void saveGrokMcp()}
                >
                  {mcpBusy ? "Saving…" : mcpSaved ? "Saved" : "Save Grok MCP"}
                </button>
              </div>
            </div>
          )}

          {!mcpLoading && (
            <div className="customize-mcp-list">
              <div className="customize-mcp-label">Cursor mcp.json</div>
              <div className="customize-editor-actions" style={{ marginBottom: 8 }}>
                <button
                  type="button"
                  className="customize-mini"
                  onClick={() => setShowCursorEditor((v) => !v)}
                >
                  {showCursorEditor ? "Hide editor" : "Edit JSON"}
                </button>
                {mcp?.cursorMcpPath && (
                  <button
                    type="button"
                    className="customize-mini"
                    onClick={() => void revealInFinder(mcp.cursorMcpPath)}
                  >
                    Reveal
                  </button>
                )}
              </div>
              {showCursorEditor && (
                <>
                  <textarea
                    className="customize-textarea customize-textarea-json"
                    value={cursorDraft}
                    onChange={(e) => {
                      setCursorDraft(e.target.value);
                      setMcpSaved(false);
                    }}
                    spellCheck={false}
                    rows={12}
                  />
                  <div className="customize-editor-actions">
                    <button
                      type="button"
                      className="customize-mini customize-mini-primary"
                      disabled={mcpBusy}
                      onClick={() => void saveCursorMcp()}
                    >
                      {mcpBusy ? "Saving…" : "Save Cursor MCP"}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {mcpError && <div className="customize-error">{mcpError}</div>}
        </section>
      </div>
    </div>
  );
}
