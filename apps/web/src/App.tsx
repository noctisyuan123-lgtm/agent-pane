import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useBridge } from "./useBridge";
import { ToolTimeline } from "./ToolTimeline";
import {
  deleteSessionApi,
  fetchHistory,
  fetchProjects,
  fetchRecent,
  fetchSkills,
  fileToBase64,
  forkSessionApi,
  formatRelTime,
  invalidateHistoryClientCache,
  patchSessionMeta,
  peekHistoryCache,
  pickFolder,
  rememberPath,
  uploadAttachment,
  type HistoryGroup,
  type ProjectEntry,
  type SessionMeta,
  type SkillEntry,
} from "./api";
import {
  loadPinnedIds,
  mergeServerPins,
  setPinnedLocal,
} from "./pinnedSessions";
import {
  BUILTIN_SLASH,
  filterSlashCommands,
  parseSlashInput,
  type SlashCommand,
} from "./slashCommands";
import {
  IconArchive,
  IconArrowDown,
  IconArrowUp,
  IconBell,
  IconBook,
  IconBug,
  IconChevron,
  IconCopy,
  IconFolder,
  IconFolderOpen,
  IconFork,
  IconList,
  IconMoreVertical,
  IconPaperPlane,
  IconPencil,
  IconPin,
  IconPlus,
  IconQuestion,
  IconRefresh,
  IconSpark,
  IconStop,
  IconTerminal,
  IconTrash,
  IconUndo,
} from "./icons";
import type { ChatItem } from "./useBridge";

function shortPath(p: string): string {
  if (!p) return "No project selected";
  const parts = p.replace(/\/$/, "").split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return parts.slice(-2).join("/");
}

/** Folder name for home breadcrumb (Cursor-style workspace label). */
function folderName(p: string): string {
  if (!p) return "";
  const parts = p.replace(/\/$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** Models from `grok models` on this machine — passed to `grok agent -m`. */
const MODEL_OPTIONS = [
  { id: "grok-4.5", label: "Grok 4.5" },
  { id: "grok-composer-2.5-fast", label: "Composer 2.5" },
] as const;

const DEFAULT_MODEL = MODEL_OPTIONS[0].id;

/** Context window size (tokens) for session usage ring. */
const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  "grok-4.5": 256_000,
  "grok-composer-2.5-fast": 128_000,
};
const DEFAULT_CONTEXT_TOKENS = 128_000;

/** Rough session token estimate from chat text (~4 chars / token). */
function estimateSessionTokens(messages: ChatItem[], draft = ""): number {
  let chars = draft.length;
  for (const m of messages) {
    if (
      m.kind === "user" ||
      m.kind === "assistant" ||
      m.kind === "thought" ||
      m.kind === "status"
    ) {
      chars += m.text.length;
    } else if (m.kind === "tools") {
      for (const t of m.tools) {
        chars += (t.label?.length ?? 0) + (t.detailLines?.join("").length ?? 0);
      }
    } else if (m.kind === "turn_log") {
      for (const line of m.lines) chars += line.text.length;
    }
  }
  return Math.max(0, Math.ceil(chars / 4));
}

/** Cursor / Grok-style agent modes */
const MODE_OPTIONS = [
  {
    id: "agent" as const,
    label: "Agent",
    title: "Always-approve tools (yolo) — full edit power",
  },
  {
    id: "auto" as const,
    label: "Auto",
    title: "Normal permissions — agent may ask before tools",
  },
  {
    id: "plan" as const,
    label: "Plan",
    title: "Plan only — no file edits until you switch mode",
  },
];

type AnchorBox = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
};

/** Place fixed menu next to anchor; flip up / clamp so it stays fully on-screen. */
function placeMenu(
  anchor: AnchorBox,
  menuW: number,
  menuH: number
): { x: number; y: number } {
  const pad = 8;
  const gap = 4;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Menu CSS has max-height + scroll; placement uses what can actually show
  const h = Math.min(menuH, vh - pad * 2);
  const w = Math.min(menuW, vw - pad * 2);

  // Right-align with the ⋯ button (sessions sit in left sidebar)
  let x = anchor.right - w;
  if (x < pad) x = pad;
  if (x + w > vw - pad) x = Math.max(pad, vw - w - pad);

  const spaceBelow = vh - pad - (anchor.bottom + gap);
  const spaceAbove = anchor.top - gap - pad;

  let y: number;
  if (spaceBelow >= h) {
    y = anchor.bottom + gap;
  } else if (spaceAbove >= h) {
    y = anchor.top - h - gap;
  } else if (spaceBelow >= spaceAbove) {
    // Not enough either side — stick near button, clamp into viewport
    y = Math.min(anchor.bottom + gap, Math.max(pad, vh - h - pad));
  } else {
    y = Math.max(pad, anchor.top - h - gap);
  }
  // Final safety clamp (never clip half off-screen)
  if (y < pad) y = pad;
  if (y + h > vh - pad) y = Math.max(pad, vh - h - pad);

  return { x, y };
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
  const [menu, setMenu] = useState<{
    session: SessionMeta;
    x: number;
    y: number;
    anchor: AnchorBox;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SessionMeta | null>(null);
  const [renameTarget, setRenameTarget] = useState<SessionMeta | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [plusOpen, setPlusOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  /** Skills panel sits beside main menu (Cursor-style), not under it */
  const [skillsSide, setSkillsSide] = useState<"right" | "left">("right");
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [plusPos, setPlusPos] = useState<{ x: number; y: number } | null>(null);
  /** Independent fixed box for skills list — clamped so last items aren't cut off */
  const [skillsFlyPos, setSkillsFlyPos] = useState<{
    x: number;
    y: number;
    maxH: number;
  } | null>(null);
  const [respMenuOpen, setRespMenuOpen] = useState(false);
  const [respMenuPos, setRespMenuPos] = useState<{ x: number; y: number } | null>(
    null
  );
  /** Which assistant bubble the ⋯ menu is for */
  const [respMenuTarget, setRespMenuTarget] = useState<{
    text: string;
    isLast: boolean;
  } | null>(null);
  const [attachments, setAttachments] = useState<
    { path: string; name: string; kind: "file" | "folder" }[]
  >([]);
  const [dragOver, setDragOver] = useState(false);
  const [slashHi, setSlashHi] = useState(0);

  const bottomRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const respMenuBtnRef = useRef<HTMLButtonElement>(null);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const createFn = useRef(b.createSession);
  createFn.current = b.createSession;

  const hasMessages = b.messages.length > 0;
  /** 有消息才进对话布局；空会话/新会话 = Cursor 式居中 Home */
  const showHome = !hasMessages;
  // follow-up bar: single-line grow; home hero: Cursor empty = ~1 line
  const growMin = showHome ? 18 : 22;
  const growMax = showHome ? 120 : 140;
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
    // 首屏强制拉 history，避免空 cache / 以为「记录没了」
    void refreshLists(true);
  }, [refreshLists]);

  // 有会话的项目一律保持可展开；若被误点折起，刷新后仍默认打开
  useEffect(() => {
    if (history.length === 0) return;
    setExpandedCwd((m) => {
      let changed = false;
      const next = { ...m };
      for (const g of history) {
        if (g.sessions.length > 0 && next[g.cwd] !== true) {
          next[g.cwd] = true;
          changed = true;
        }
      }
      return changed ? next : m;
    });
  }, [history]);

  /** Flat list — always visible, not buried under collapsed project folders */
  const flatSessions = useMemo(() => {
    const rows: (SessionMeta & { projectName: string })[] = [];
    for (const g of history) {
      for (const s of g.sessions) {
        rows.push({ ...s, projectName: g.name });
      }
    }
    rows.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    return rows;
  }, [history]);

  /** Instant pin set (localStorage) — server sync is fire-and-forget */
  const [localPins, setLocalPins] = useState<Set<string>>(() => loadPinnedIds());
  const pinsSeeded = useRef(false);

  // Seed from server pins once (additive only — never undoes a local unpin)
  useEffect(() => {
    if (pinsSeeded.current || flatSessions.length === 0) return;
    pinsSeeded.current = true;
    const serverPinned = flatSessions
      .filter((s) => s.pinned)
      .map((s) => s.sessionId);
    setLocalPins((prev) => mergeServerPins(prev, serverPinned));
  }, [flatSessions]);

  const isSessionPinned = useCallback(
    (s: SessionMeta) => localPins.has(s.sessionId),
    [localPins]
  );

  const pinnedSessions = useMemo(
    () => flatSessions.filter((s) => localPins.has(s.sessionId)),
    [flatSessions, localPins]
  );

  /** Resizable sidebar width (Cursor-style) */
  const [sidebarW, setSidebarW] = useState(() => {
    const n = Number(localStorage.getItem("agent-pane-sidebar-w") || "248");
    return Number.isFinite(n) ? Math.min(420, Math.max(180, n)) : 248;
  });
  const sidebarDrag = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--sidebar-w",
      `${sidebarW}px`
    );
    localStorage.setItem("agent-pane-sidebar-w", String(sidebarW));
  }, [sidebarW]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = sidebarDrag.current;
      if (!d) return;
      const next = Math.min(420, Math.max(180, d.startW + (e.clientX - d.startX)));
      setSidebarW(next);
    };
    const onUp = () => {
      sidebarDrag.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // 有真实对话后再刷 history（空 New Agent 不应进侧栏）
  useEffect(() => {
    if (!b.sessionId || b.messages.length === 0) return;
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
  }, [hasMessages]);

  const jumpBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    setShowJumpBottom(false);
  };

  const selectCwd = async (path: string, opts?: { expand?: boolean }) => {
    b.setCwd(path);
    localStorage.setItem("agent-pane-cwd", path);
    await rememberPath(path);
    await refreshLists(false);
    // 不要强行展开，否则点文件夹折叠会被 selectCwd 再打开
    if (opts?.expand) {
      setExpandedCwd((m) => ({ ...m, [path]: true }));
    }
  };

  // After mount, re-place with real size so menu sticks to the session, not a fixed clamp
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const el = menuRef.current;
    const { x, y } = placeMenu(
      menu.anchor,
      el.offsetWidth,
      el.offsetHeight
    );
    if (Math.abs(x - menu.x) > 0.5 || Math.abs(y - menu.y) > 0.5) {
      setMenu((m) => (m ? { ...m, x, y } : m));
    }
  }, [menu]);

  const openSessionMenu = (session: SessionMeta, anchorEl: HTMLElement) => {
    const rect = anchorEl.getBoundingClientRect();
    const anchor: AnchorBox = {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
    };
    // Rough first paint; layout effect re-places with measured size
    const { x, y } = placeMenu(anchor, 200, 240);
    setMenu({ session, x, y, anchor });
  };

  const runSessionAction = async (
    action: "pin" | "rename" | "unread" | "fork" | "archive" | "delete",
    session: SessionMeta
  ) => {
    setMenu(null);
    try {
      if (action === "pin") {
        // Instant local toggle (grok-desktop-code pattern) — no await on refresh
        const currently = isSessionPinned(session);
        const nextPinned = !currently;
        const nextSet = setPinnedLocal(session.sessionId, nextPinned);
        setLocalPins(nextSet);
        setHistory((groups) =>
          groups.map((g) => ({
            ...g,
            sessions: g.sessions.map((s) =>
              s.sessionId === session.sessionId
                ? {
                    ...s,
                    pinned: nextPinned,
                    title: s.title || session.title || "New session",
                  }
                : s
            ),
          }))
        );
        // Background server sync only — never block UI / never full refresh
        void patchSessionMeta(session.sessionId, { pinned: nextPinned }).catch(
          (e) => {
            // roll back local on failure
            const rolled = setPinnedLocal(session.sessionId, currently);
            setLocalPins(rolled);
            b.setError(e instanceof Error ? e.message : String(e));
          }
        );
        return;
      } else if (action === "rename") {
        // Tauri WebView: window.prompt is unreliable — use in-app modal
        setRenameValue(session.title || "");
        setRenameTarget(session);
        return;
      } else if (action === "unread") {
        const nextUnread = !session.unread;
        setHistory((groups) =>
          groups.map((g) => ({
            ...g,
            sessions: g.sessions.map((s) =>
              s.sessionId === session.sessionId
                ? { ...s, unread: nextUnread }
                : s
            ),
          }))
        );
        await patchSessionMeta(session.sessionId, { unread: nextUnread });
        invalidateHistoryClientCache();
        void refreshLists(true);
        return;
      } else if (action === "fork") {
        const meta = await forkSessionApi(session.sessionId);
        await refreshLists(true);
        await openHist(meta.sessionId, meta.cwd);
        return;
      } else if (action === "archive") {
        await patchSessionMeta(session.sessionId, { archived: true });
        if (b.sessionId === session.sessionId) {
          b.createSession();
        }
      } else if (action === "delete") {
        // Tauri WebView: window.confirm often no-ops — use in-app modal
        setConfirmDelete(session);
        return;
      }
      invalidateHistoryClientCache();
      await refreshLists(true);
    } catch (e) {
      b.setError(e instanceof Error ? e.message : String(e));
    }
  };

  const confirmDeleteSession = async () => {
    const session = confirmDelete;
    if (!session) return;
    setConfirmDelete(null);
    // Optimistic: drop from sidebar immediately so double-delete / stale cache
    // can't flash {"ok":false}
    setHistory((groups) =>
      groups
        .map((g) => ({
          ...g,
          sessions: g.sessions.filter((s) => s.sessionId !== session.sessionId),
        }))
        .filter((g) => g.sessions.length > 0)
    );
    try {
      await deleteSessionApi(session.sessionId);
      if (b.sessionId === session.sessionId) {
        b.createSession();
      }
      invalidateHistoryClientCache();
      await refreshLists(true);
    } catch (e) {
      b.setError(e instanceof Error ? e.message : String(e));
      invalidateHistoryClientCache();
      await refreshLists(true);
    }
  };

  const confirmRenameSession = async () => {
    const session = renameTarget;
    if (!session) return;
    const t = renameValue.trim();
    setRenameTarget(null);
    if (!t) return;
    // Optimistic rename
    setHistory((groups) =>
      groups.map((g) => ({
        ...g,
        sessions: g.sessions.map((s) =>
          s.sessionId === session.sessionId ? { ...s, title: t } : s
        ),
      }))
    );
    try {
      const meta = await patchSessionMeta(session.sessionId, { title: t });
      setHistory((groups) =>
        groups.map((g) => ({
          ...g,
          sessions: g.sessions.map((s) =>
            s.sessionId === session.sessionId
              ? { ...s, title: meta.title || t, pinned: meta.pinned }
              : s
          ),
        }))
      );
      invalidateHistoryClientCache();
      void refreshLists(true);
    } catch (e) {
      b.setError(e instanceof Error ? e.message : String(e));
      await refreshLists(true);
    }
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

  const applyLocalSlash = (cmd: string, args: string): boolean => {
    const name = cmd.toLowerCase();
    const def = BUILTIN_SLASH.find((c) => c.name === name);
    if (!def?.local) return false;
    if (def.local === "new") {
      if (!b.cwd.trim()) {
        b.setError("Select a project folder first");
        return true;
      }
      setInput("");
      setAttachments([]);
      b.createSession();
      return true;
    }
    if (def.local === "plan") {
      setMode("plan");
      setInput(args.trim() ? args : "");
      return true;
    }
    if (def.local === "agent") {
      setMode("agent");
      setInput("");
      return true;
    }
    if (def.local === "auto") {
      setMode("auto");
      setInput("");
      return true;
    }
    if (def.local === "model") {
      const id = args.trim();
      if (id) {
        b.setModel(id);
        localStorage.setItem("agent-pane-model", id);
        setInput("");
        b.setError(null);
        setStatusLocal(`Model set to ${id} for next session`);
      } else {
        b.setError("Usage: /model <model-id>  e.g. /model grok-4.5");
      }
      return true;
    }
    return false;
  };

  const [statusLocal, setStatusLocal] = useState<string | null>(null);
  useEffect(() => {
    if (!statusLocal) return;
    const t = setTimeout(() => setStatusLocal(null), 3500);
    return () => clearTimeout(t);
  }, [statusLocal]);

  const ensureSessionAndSend = async (text: string) => {
    const trimmed = text.trim();
    const atts = attachments.map((a) => ({
      path: a.path,
      kind: a.kind as "file" | "folder",
    }));
    if (!trimmed && atts.length === 0) return;

    // Local slash handling (/new, /plan, …)
    if (trimmed.startsWith("/")) {
      const sp = trimmed.indexOf(" ");
      const cmd = (sp < 0 ? trimmed.slice(1) : trimmed.slice(1, sp)).trim();
      const args = sp < 0 ? "" : trimmed.slice(sp + 1);
      if (applyLocalSlash(cmd, args)) return;
    }

    if (!b.cwd.trim() && !b.sessionId) {
      b.setError("Select a project folder first");
      return;
    }
    // History-only / agent died after idle: resume SAME session, then send
    if (b.sessionId && b.historyOnly) {
      setInput("");
      setAttachments([]);
      b.queuePromptAfterAttach(trimmed, atts.length ? atts : undefined);
      b.resumeSession(b.sessionId, b.cwd);
      return;
    }
    if (!b.sessionId) {
      setInput("");
      setAttachments([]);
      if (!b.cwd.trim()) {
        b.setError("Select a project folder first");
        return;
      }
      b.queuePromptAfterAttach(trimmed, atts.length ? atts : undefined);
      b.createSession();
      return;
    }
    // Still "live" in UI — bridge will auto-resume if process already died
    setInput("");
    setAttachments([]);
    b.prompt(trimmed, atts.length ? atts : undefined);
  };

  const onSubmit = () => {
    if (b.busy) {
      b.cancel();
      return;
    }
    void ensureSessionAndSend(input);
  };

  const pickSlash = (c: SlashCommand) => {
    const rest = c.input ? " " : " ";
    setInput(`/${c.name}${rest}`);
    setSlashHi(0);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const openHist = async (sessionId: string, cwd: string) => {
    await b.openHistorySession(sessionId, cwd);
    setExpandedCwd((m) => ({ ...m, [cwd]: true }));
    // If open scrubbed a zombie, refresh sidebar so it disappears
    invalidateHistoryClientCache(sessionId);
    await refreshLists(true);
  };

  const setMode = (mode: "agent" | "auto" | "plan") => {
    b.setAgentMode(mode);
    localStorage.setItem("agent-pane-mode", mode);
  };

  const closePlus = () => {
    setPlusOpen(false);
    setSkillsOpen(false);
    setSkillsFlyPos(null);
  };

  const placeSkillsFlyout = (menuX: number, menuY: number, side: "right" | "left") => {
    const mainW = 188;
    const flyW = 240;
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Independent fixed panel — use almost full remaining height so last skills show
    let x =
      side === "right" ? menuX + mainW + 6 : menuX - flyW - 6;
    if (x < pad) x = pad;
    if (x + flyW > vw - pad) x = Math.max(pad, vw - pad - flyW);
    let y = menuY;
    const maxH = Math.max(160, vh - y - pad);
    // If very little room below, pin near top of window
    if (maxH < 200 && menuY > pad + 40) {
      y = pad;
    }
    const maxH2 = Math.max(160, Math.min(vh - y - pad, vh - pad * 2));
    setSkillsFlyPos({ x, y, maxH: maxH2 });
  };

  const openPlusMenu = () => {
    const el = plusBtnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mainW = 188;
    const flyW = 240;
    const menuH = 220;
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Prefer below on home, above on follow-up bar
    const preferBelow = showHome;
    let y = preferBelow ? r.bottom + 6 : r.top - menuH - 6;
    if (y < pad) y = r.bottom + 6;
    if (y + menuH > vh - pad) y = Math.max(pad, vh - menuH - pad);

    // Leave room for side flyout (Cursor: skills open to the side)
    let x = r.left;
    const need = mainW + 6 + flyW;
    if (x + need > vw - pad) {
      x = Math.max(pad, vw - pad - need);
    }
    if (x < pad) x = pad;

    const side: "right" | "left" =
      x + mainW + 6 + flyW <= vw - pad ? "right" : "left";
    setSkillsSide(side);
    setPlusPos({ x, y });
    setPlusOpen(true);
    setSkillsOpen(false);
    setSkillsFlyPos(null);
  };

  const loadSkills = async () => {
    const menuX = plusPos?.x ?? 8;
    const menuY = plusPos?.y ?? 8;
    const mainW = 188;
    const flyW = 240;
    const side: "right" | "left" =
      menuX + mainW + 6 + flyW <= window.innerWidth - 8 ? "right" : "left";
    setSkillsSide(side);
    setSkillsOpen((o) => {
      const next = !o;
      if (next) placeSkillsFlyout(menuX, menuY, side);
      else setSkillsFlyPos(null);
      return next;
    });
    if (skills.length > 0 || skillsLoading) return;
    setSkillsLoading(true);
    try {
      const list = await fetchSkills(b.cwd || undefined);
      setSkills(list);
    } catch {
      setSkills([]);
    } finally {
      setSkillsLoading(false);
    }
  };

  const insertSkill = (name: string) => {
    setInput((prev) => {
      const t = prev.trim();
      const slash = `/${name} `;
      return t ? `${t}\n${slash}` : slash;
    });
    closePlus();
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const slashCatalog = useMemo((): SlashCommand[] => {
    const fromSkills: SlashCommand[] = skills.map((s) => ({
      name: s.name,
      description: s.description || `Skill · ${s.source}`,
    }));
    const seen = new Set(BUILTIN_SLASH.map((c) => c.name.toLowerCase()));
    const extra = fromSkills.filter((s) => !seen.has(s.name.toLowerCase()));
    return [...BUILTIN_SLASH, ...extra];
  }, [skills]);

  const slashParsed = useMemo(() => parseSlashInput(input), [input]);
  const slashMatches = useMemo(() => {
    if (!slashParsed.active) return [] as SlashCommand[];
    return filterSlashCommands(slashCatalog, slashParsed.query);
  }, [slashParsed, slashCatalog]);

  useEffect(() => {
    setSlashHi(0);
  }, [slashParsed.query, slashParsed.active]);

  // Prefetch skills so / autocomplete includes them
  useEffect(() => {
    let cancelled = false;
    setSkillsLoading(true);
    void fetchSkills(b.cwd || undefined)
      .then((list) => {
        if (!cancelled) setSkills(list);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [b.cwd]);

  const addPathsAsAttachments = useCallback((paths: string[]) => {
    if (!paths.length) return;
    setAttachments((prev) => {
      const next = [...prev];
      for (const p of paths) {
        if (!p || next.some((a) => a.path === p)) continue;
        const name = p.split(/[/\\]/).pop() || p;
        // crude folder heuristic
        const kind: "file" | "folder" = /\.[a-z0-9]{1,8}$/i.test(name)
          ? "file"
          : "file";
        next.push({ path: p, name, kind });
      }
      return next;
    });
  }, []);

  const addBlobFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    for (const f of list) {
      try {
        // Tauri / Electron sometimes expose path on File
        const native = (f as File & { path?: string }).path;
        if (native && native.startsWith("/")) {
          addPathsAsAttachments([native]);
          continue;
        }
        const base64 = await fileToBase64(f);
        const up = await uploadAttachment({
          name: f.name,
          base64,
          mime: f.type || undefined,
        });
        setAttachments((prev) =>
          prev.some((a) => a.path === up.path)
            ? prev
            : [...prev, { path: up.path, name: up.name, kind: "file" }]
        );
      } catch (e) {
        b.setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [addPathsAsAttachments, b]);

  // Native Tauri file drop (absolute paths)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        if (cancelled) return;
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDragOver(true);
          } else if (event.payload.type === "leave") {
            setDragOver(false);
          } else if (event.payload.type === "drop") {
            setDragOver(false);
            addPathsAsAttachments(event.payload.paths || []);
          }
        });
      } catch {
        /* browser / non-tauri */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addPathsAsAttachments]);

  /** Session context usage (estimate) — ring under composer like Cursor */
  const sessionUsage = useMemo(() => {
    const used = estimateSessionTokens(b.messages, input);
    const limit =
      MODEL_CONTEXT_TOKENS[b.model] ??
      MODEL_CONTEXT_TOKENS[DEFAULT_MODEL] ??
      DEFAULT_CONTEXT_TOKENS;
    const pct = Math.min(100, Math.round((used / limit) * 100));
    return { used, limit, pct };
  }, [b.messages, b.model, input]);

  const composer = (
    <div
      ref={composerShellRef}
      className={`composer-shell ${showHome ? "hero" : "followup"} ${
        dragOver ? "drag-over" : ""
      }`}
      onDragEnter={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files?.length) {
          void addBlobFiles(e.dataTransfer.files);
        }
      }}
    >
      {attachments.length > 0 && (
        <div className="attach-row">
          {attachments.map((a) => (
            <span className="attach-chip" key={a.path} title={a.path}>
              <span className="attach-chip-name">{a.name}</span>
              <button
                type="button"
                className="attach-chip-x"
                aria-label={`Remove ${a.name}`}
                onClick={() =>
                  setAttachments((prev) => prev.filter((x) => x.path !== a.path))
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {/* Cursor-style single row: + | input | model | ↑ */}
      <div className="composer-main-row">
        <button
          ref={plusBtnRef}
          type="button"
          className={`plus-btn ${plusOpen ? "open" : ""}`}
          title="Add modes, skills, tools…"
          onClick={() => (plusOpen ? closePlus() : openPlusMenu())}
        >
          <IconPlus size={15} />
        </button>
        <div className="composer-ta-wrap">
          {slashParsed.active && slashMatches.length > 0 && (
            <div className="slash-menu" role="listbox">
              {slashMatches.map((c, i) => (
                <button
                  key={c.name}
                  type="button"
                  role="option"
                  aria-selected={i === slashHi}
                  className={`slash-item ${i === slashHi ? "hi" : ""}`}
                  onMouseEnter={() => setSlashHi(i)}
                  onClick={() => pickSlash(c)}
                >
                  <span className="slash-name">/{c.name}</span>
                  <span className="slash-desc">{c.description}</span>
                  {c.input && <span className="slash-hint">{c.input}</span>}
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            className="composer-ta"
            placeholder={
              showHome
                ? "Plan, Build, / for commands · drop files here"
                : "Send follow-up"
            }
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const items = e.clipboardData?.items;
              if (!items) return;
              const files: File[] = [];
              for (const it of Array.from(items)) {
                if (it.kind === "file") {
                  const f = it.getAsFile();
                  if (f) files.push(f);
                }
              }
              if (files.length) {
                e.preventDefault();
                void addBlobFiles(files);
              }
            }}
            onKeyDown={(e) => {
              // IME (拼音/日文等) 组字中：Enter 是「选词上屏」，绝不能当发送
              const ime =
                e.nativeEvent.isComposing ||
                (e.nativeEvent as KeyboardEvent).keyCode === 229 ||
                e.key === "Process";
              if (slashParsed.active && slashMatches.length > 0 && !ime) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashHi((i) => Math.min(slashMatches.length - 1, i + 1));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashHi((i) => Math.max(0, i - 1));
                  return;
                }
                if (
                  e.key === "Tab" ||
                  (e.key === "Enter" &&
                    !e.shiftKey &&
                    slashParsed.query !== slashMatches[slashHi]?.name)
                ) {
                  if (
                    e.key === "Tab" ||
                    (e.key === "Enter" &&
                      slashParsed.query.length <
                        (slashMatches[slashHi]?.name.length ?? 0))
                  ) {
                    e.preventDefault();
                    const c = slashMatches[slashHi];
                    if (c) pickSlash(c);
                    return;
                  }
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                if (ime) return;
                e.preventDefault();
                onSubmit();
              }
              if (e.key === "Escape" && !ime) {
                closePlus();
                if (slashParsed.active) setInput("");
              }
            }}
          />
        </div>
        <label
          className="model-chip"
          title="Model for the next turn / New Agent"
        >
          <select
            className="model-select"
            value={
              MODEL_OPTIONS.some((m) => m.id === b.model)
                ? b.model
                : DEFAULT_MODEL
            }
            onChange={(e) => {
              const next = e.target.value;
              b.setModel(next);
              localStorage.setItem("agent-pane-model", next);
            }}
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`send-btn ${b.busy ? "stop" : ""}`}
          onClick={onSubmit}
          disabled={
            !b.connected ||
            (!b.busy && !input.trim() && attachments.length === 0)
          }
          title={b.busy ? "Stop" : showHome ? "Start" : "Send"}
        >
          {b.busy ? <IconStop size={13} /> : <IconArrowUp size={15} />}
        </button>
      </div>
      {/* Under-composer: no This Mac; session usage ring on the right */}
      <div className="composer-meta-row">
        {b.historyOnly ? (
          <span className="hist-hint">
            {b.sessionId
              ? "Disconnected · send resumes this chat"
              : "History · pick a session or New Agent"}
          </span>
        ) : (
          <span className="grow" />
        )}
        <span
          className="session-usage"
          title={`Session context · ~${sessionUsage.used.toLocaleString()} / ${sessionUsage.limit.toLocaleString()} tokens (estimate)`}
        >
          <svg
            className="session-usage-ring"
            viewBox="0 0 16 16"
            width={14}
            height={14}
            aria-hidden
          >
            <circle
              className="session-usage-track"
              cx="8"
              cy="8"
              r="6"
              fill="none"
              strokeWidth="2"
            />
            <circle
              className="session-usage-fill"
              cx="8"
              cy="8"
              r="6"
              fill="none"
              strokeWidth="2"
              strokeDasharray={`${(sessionUsage.pct / 100) * 37.7} 37.7`}
              strokeLinecap="round"
              transform="rotate(-90 8 8)"
            />
          </svg>
          <span className="session-usage-pct">{sessionUsage.pct}%</span>
        </span>
      </div>
      {dragOver && (
        <div className="drop-overlay" aria-hidden>
          Drop files or images
        </div>
      )}
    </div>
  );

  return (
    <div className="shell">
      {/* macOS Overlay titlebar: drag strip (lights sit over sidebar) */}
      <div className="titlebar-drag" data-tauri-drag-region />
      <aside className="sidebar" style={{ width: sidebarW }}>
        <button
          type="button"
          className="side-btn primary"
          onClick={() => {
            if (!b.cwd) {
              b.setError("Select a project folder first");
              void onBrowse();
              return;
            }
            b.createSession();
          }}
        >
          <IconPaperPlane className="ico" />
          New Agent
        </button>
        <button type="button" className="side-btn" onClick={() => void onBrowse()}>
          <IconFolder className="ico" />
          {picking ? "Opening…" : "Open project…"}
        </button>
        <button
          type="button"
          className="side-btn"
          onClick={() => {
            setManualPath(b.cwd);
            setManualOpen(true);
          }}
        >
          <IconTerminal className="ico" />
          Enter path…
        </button>

        <div className="side-list">
          {/* Cursor Agents: Pinned → Repositories (folders nest chats). No separate Chats / Recent. */}
          {pinnedSessions.length > 0 && (
            <>
              <div className="side-section">
                <span>Pinned</span>
              </div>
              {pinnedSessions.map((s) => (
                <div
                  key={s.sessionId}
                  className={`side-item session row nested ${
                    b.sessionId === s.sessionId ? "active" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="session-main"
                    onClick={() => void openHist(s.sessionId, s.cwd)}
                    title={`${s.title || "Untitled"}\n${s.cwd}`}
                  >
                    <span className="name">{s.title || "Untitled"}</span>
                    <span className="meta">{formatRelTime(s.updatedAt)}</span>
                  </button>
                  <button
                    type="button"
                    className="more-btn"
                    title="More"
                    onClick={(e) => {
                      e.stopPropagation();
                      openSessionMenu(s, e.currentTarget as HTMLButtonElement);
                    }}
                  >
                    <IconMoreVertical size={14} />
                  </button>
                </div>
              ))}
            </>
          )}

          <div className="side-section">
            <span>Repositories</span>
            <button
              type="button"
              className="icon-mini"
              title="Refresh"
              onClick={() => void refreshLists(true)}
            >
              <IconRefresh size={13} />
            </button>
          </div>

          {history.length === 0 && flatSessions.length === 0 && (
            <div className="hint" style={{ padding: "6px 10px" }}>
              Open a project to start
            </div>
          )}

          {/* Cursor Agents: one Repositories tree — folders nest chats; recent-only paths as empty repos */}
          {(() => {
            const histCwds = new Set(history.map((g) => g.cwd));
            const extrarepos = recent
              .filter((r) => r.path && !histCwds.has(r.path))
              .slice(0, 12)
              .map((r) => ({
                cwd: r.path,
                name: r.name,
                sessions: [] as SessionMeta[],
              }));
            type Repo = {
              cwd: string;
              name: string;
              sessions: SessionMeta[];
            };
            const repos: Repo[] = [
              ...history.map((g) => ({
                cwd: g.cwd,
                name: g.name,
                sessions: g.sessions,
              })),
              ...extrarepos,
            ];
            return repos.map((g) => {
              // Default: only current workspace expanded
              const open =
                expandedCwd[g.cwd] !== undefined
                  ? !!expandedCwd[g.cwd]
                  : g.cwd === b.cwd;
              const isCurrent = b.cwd === g.cwd;
              return (
                <div key={g.cwd} className="hist-group">
                  <button
                    type="button"
                    className={`side-item folder ${isCurrent ? "active" : ""} ${
                      open ? "expanded" : ""
                    }`}
                    onClick={() => {
                      setExpandedCwd((m) => ({ ...m, [g.cwd]: !open }));
                      if (g.cwd !== b.cwd) void selectCwd(g.cwd);
                    }}
                    title={g.cwd}
                  >
                    {open ? (
                      <IconFolderOpen size={15} className="ico-folder" />
                    ) : (
                      <IconFolder size={15} className="ico-folder" />
                    )}
                    <span className="name">{g.name}</span>
                  </button>
                  {open &&
                    g.sessions.map((s) => (
                      <div
                        key={s.sessionId}
                        className={`side-item session row nested ${
                          b.sessionId === s.sessionId ? "active" : ""
                        }`}
                      >
                        <button
                          type="button"
                          className="session-main"
                          onClick={() => void openHist(s.sessionId, s.cwd)}
                          title={s.title}
                        >
                          <span className="name">{s.title || "Untitled"}</span>
                          <span className="meta">
                            {formatRelTime(s.updatedAt)}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="more-btn"
                          title="More"
                          onClick={(e) => {
                            e.stopPropagation();
                            openSessionMenu(
                              s,
                              e.currentTarget as HTMLButtonElement
                            );
                          }}
                        >
                          <IconMoreVertical size={14} />
                        </button>
                      </div>
                    ))}
                </div>
              );
            });
          })()}
        </div>

        <div className="side-foot">
          <div className={`status-pill ${b.connected ? "ok" : ""}`}>
            <span className="dot" />
            {b.connected ? "Bridge · Grok ACP" : "Bridge offline"}
          </div>
        </div>

        {/* Resize handle — drag to change sidebar width */}
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onMouseDown={(e) => {
            e.preventDefault();
            sidebarDrag.current = { startX: e.clientX, startW: sidebarW };
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
        />
      </aside>

      <div className="stage">
        <div className="stage-top">
          <div className="workspace-chip">
            <strong title={b.cwd || undefined}>{shortPath(b.cwd)}</strong>
            <button type="button" onClick={() => void onBrowse()}>
              {picking ? "…" : "Browse"}
            </button>
          </div>
          <div className="spacer" />
        </div>

        {statusLocal && !b.error && (
          <div className="status-banner">{statusLocal}</div>
        )}
        {b.error && (
          <div className="error-banner" onClick={() => b.setError(null)}>
            {b.error}
          </div>
        )}
        {/* Live activity lives in the chat thread (CLI-style), not a top banner */}

        {showHome ? (
          <div className="home">
            <div className="home-stack">
              <button
                type="button"
                className="home-label"
                title={
                  b.cwd
                    ? b.cwd
                    : "Open a project folder — this label follows the workspace"
                }
                onClick={() => void onBrowse()}
              >
                <span className="home-label-name">
                  {b.cwd ? folderName(b.cwd) : "Select project"}
                </span>
                <span className="home-label-chev" aria-hidden>
                  ▾
                </span>
              </button>
              {composer}
              <div className="pills">
                <button
                  type="button"
                  className="pill"
                  title="Plan mode — design before editing"
                  onClick={() => {
                    setMode("plan");
                    setInput(
                      (prev) =>
                        prev.trim() ||
                        "Plan a clean approach for the next change. List steps, risks, and files to touch before editing."
                    );
                    requestAnimationFrame(() => taRef.current?.focus());
                  }}
                >
                  Plan
                  <span className="kbd">⇧Tab</span>
                </button>
                <button
                  type="button"
                  className="pill"
                  title="Start a parallel agent session"
                  onClick={() => {
                    if (b.cwd) b.createSession();
                    else void onBrowse();
                  }}
                >
                  Multitask
                </button>
                <button
                  type="button"
                  className="pill"
                  title="Browse skills"
                  onClick={() => {
                    openPlusMenu();
                    void loadSkills();
                  }}
                >
                  Skills
                </button>
              </div>
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
              <div className="chat-inner">
              {b.messages.map((m, idx) => {
                if (m.kind === "user") {
                  return (
                    <div className="msg user" key={m.id}>
                      <div className="label-row">
                        <div className="label">You</div>
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
                if (m.kind === "status") {
                  return (
                    <div className="msg-status" key={m.id}>
                      {m.text}
                    </div>
                  );
                }
                if (m.kind === "tools") {
                  return <ToolTimeline key={m.id} tools={m.tools} />;
                }
                if (m.kind === "turn_log") {
                  return (
                    <div className="turn-log" key={m.id}>
                      {m.lines.map((line, i) => (
                        <div
                          key={`${m.id}-${i}`}
                          className={`turn-log-line ${line.tone}`}
                        >
                          <span className="turn-log-dia" aria-hidden>
                            ◆
                          </span>
                          <span className="turn-log-text">{line.text}</span>
                        </div>
                      ))}
                    </div>
                  );
                }
                // Every assistant gets ⋯ ; Retry/Undo/Edit only on the last
                let lastAsstIdx = -1;
                for (let i = b.messages.length - 1; i >= 0; i--) {
                  if (b.messages[i]!.kind === "assistant") {
                    lastAsstIdx = i;
                    break;
                  }
                }
                const isLastAssistant = lastAsstIdx === idx;
                return (
                  <div className="msg assistant" key={m.id}>
                    <div className="assistant-text">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          table: ({ children }) => (
                            <div className="md-table-wrap">
                              <table>{children}</table>
                            </div>
                          ),
                        }}
                      >
                        {m.text}
                      </ReactMarkdown>
                    </div>
                    <div className="resp-actions">
                      <button
                        ref={isLastAssistant ? respMenuBtnRef : undefined}
                        type="button"
                        className="resp-more-btn"
                        title="Message actions"
                        aria-label="Message actions"
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = (
                            e.currentTarget as HTMLButtonElement
                          ).getBoundingClientRect();
                          const menuW = 160;
                          const menuH = 160;
                          let x = r.left;
                          let y = r.bottom + 4;
                          if (x + menuW > window.innerWidth - 8) {
                            x = Math.max(8, window.innerWidth - menuW - 8);
                          }
                          if (y + menuH > window.innerHeight - 8) {
                            y = Math.max(8, r.top - menuH - 4);
                          }
                          setRespMenuTarget({
                            text: m.text,
                            isLast: isLastAssistant && !b.busy,
                          });
                          setRespMenuPos({ x, y });
                          setRespMenuOpen(true);
                        }}
                      >
                        <IconMoreVertical size={16} />
                      </button>
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

              {/* CLI-style: particle orbit + "Waiting for response… 2.2s" */}
              {(b.busy || Boolean(b.statusMsg)) && (
                <div className="agent-activity" aria-live="polite">
                  <span className="agent-activity-particles" aria-hidden>
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="agent-activity-text">
                    {(() => {
                      const base =
                        b.statusMsg ||
                        (b.busy ? "Waiting for response…" : "");
                      if (!b.busy || !base) return base;
                      if (
                        /waiting|working|thinking|model|response|compacting/i.test(
                          base
                        )
                      ) {
                        const sec = (b.busyElapsed / 1000).toFixed(1);
                        if (/\d+(\.\d+)?s\s*$/.test(base)) return base;
                        return `${base.replace(/\.\.\.$/, "…")} ${sec}s`;
                      }
                      return base;
                    })()}
                  </span>
                </div>
              )}

              <div ref={bottomRef} />
              </div>
            </main>

            {showJumpBottom && (
              <button
                type="button"
                className="jump-bottom"
                onClick={jumpBottom}
                title="Jump to bottom"
              >
                <IconArrowDown size={16} />
              </button>
            )}

            <div className="composer-dock">{composer}</div>
          </>
        )}
      </div>

      {respMenuOpen &&
        respMenuPos &&
        createPortal(
          <>
            <div
              className="menu-backdrop"
              onClick={() => {
                setRespMenuOpen(false);
                setRespMenuTarget(null);
              }}
              onKeyDown={() => undefined}
            />
            <div
              className="resp-menu"
              style={{ top: respMenuPos.y, left: respMenuPos.x }}
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const text = respMenuTarget?.text ?? "";
                  setRespMenuOpen(false);
                  setRespMenuTarget(null);
                  void navigator.clipboard.writeText(text).then(
                    () => setStatusLocal("Copied"),
                    () => b.setError("Copy failed")
                  );
                }}
              >
                <IconCopy size={14} /> Copy
              </button>
              {respMenuTarget?.isLast && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setRespMenuOpen(false);
                      setRespMenuTarget(null);
                      b.retryLast();
                    }}
                  >
                    <IconRefresh size={14} /> Retry
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setRespMenuOpen(false);
                      setRespMenuTarget(null);
                      b.undoLast();
                    }}
                  >
                    <IconUndo size={14} /> Undo
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setRespMenuOpen(false);
                      setRespMenuTarget(null);
                      b.editLast();
                      requestAnimationFrame(() => taRef.current?.focus());
                    }}
                  >
                    <IconPencil size={14} /> Edit
                  </button>
                </>
              )}
            </div>
          </>,
          document.body
        )}

      {plusOpen &&
        plusPos &&
        createPortal(
          <>
            <div
              className="menu-backdrop"
              onClick={closePlus}
              onKeyDown={() => undefined}
            />
            <div
              ref={plusMenuRef}
              className="plus-menu-wrap"
              style={{ top: plusPos.y, left: plusPos.x }}
            >
              <div className="plus-menu" role="menu">
                <div className="plus-menu-head">Add…</div>
                <button
                  type="button"
                  role="menuitem"
                  className={b.agentMode === "plan" ? "active" : ""}
                  onClick={() => {
                    setMode("plan");
                    setInput(
                      (prev) =>
                        prev.trim() ||
                        "Plan a clean approach for the next change. List steps, risks, and files to touch."
                    );
                    closePlus();
                    requestAnimationFrame(() => taRef.current?.focus());
                  }}
                >
                  <IconList size={14} /> Plan
                  {b.agentMode === "plan" && (
                    <span className="plus-check">✓</span>
                  )}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMode("agent");
                    setInput(
                      (prev) =>
                        prev.trim() ||
                        "Debug the current issue. Reproduce if needed, find root cause, then propose a minimal fix."
                    );
                    closePlus();
                    requestAnimationFrame(() => taRef.current?.focus());
                  }}
                >
                  <IconBug size={14} /> Debug
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closePlus();
                    if (b.cwd) b.createSession();
                    else void onBrowse();
                  }}
                >
                  <IconSpark size={14} /> Multitask
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={b.agentMode === "auto" ? "active" : ""}
                  onClick={() => {
                    setMode("auto");
                    closePlus();
                  }}
                >
                  <IconQuestion size={14} /> Ask
                  {b.agentMode === "auto" && (
                    <span className="plus-check">✓</span>
                  )}
                </button>
                <div className="ctx-sep" />
                <button
                  type="button"
                  role="menuitem"
                  className={`plus-sub ${skillsOpen ? "open" : ""}`}
                  onClick={() => void loadSkills()}
                >
                  <IconBook size={14} /> Skills
                  <span className="plus-sub-chev">
                    <IconChevron size={12} />
                  </span>
                </button>
                <div className="ctx-sep" />
                <button
                  type="button"
                  role="menuitem"
                  className={b.agentMode === "agent" ? "active" : ""}
                  onClick={() => {
                    setMode("agent");
                    closePlus();
                  }}
                >
                  <IconTerminal size={14} /> Agent
                  {b.agentMode === "agent" && (
                    <span className="plus-check">✓</span>
                  )}
                </button>
              </div>
            </div>
            {/* Skills as separate fixed portal panel — full remaining height, no clip */}
            {skillsOpen && skillsFlyPos && (
              <div
                className={`plus-skills-flyout fixed-fly ${skillsSide}`}
                role="menu"
                style={{
                  top: skillsFlyPos.y,
                  left: skillsFlyPos.x,
                  maxHeight: skillsFlyPos.maxH,
                }}
              >
                {skillsLoading && (
                  <div className="plus-skills-empty">Loading…</div>
                )}
                {!skillsLoading && skills.length === 0 && (
                  <div className="plus-skills-empty">No skills found</div>
                )}
                {!skillsLoading &&
                  skills.map((s) => (
                    <button
                      key={`${s.source}:${s.name}`}
                      type="button"
                      role="menuitem"
                      className="plus-skill-item"
                      title={s.description || s.dir}
                      onClick={() => insertSkill(s.name)}
                    >
                      <span className="plus-skill-name">{s.name}</span>
                      {s.description && (
                        <span className="plus-skill-desc">
                          {s.description}
                        </span>
                      )}
                    </button>
                  ))}
              </div>
            )}
          </>,
          document.body
        )}

      {menu &&
        createPortal(
          <>
            <div
              className="menu-backdrop"
              onClick={() => setMenu(null)}
              onKeyDown={() => undefined}
            />
            <div
              ref={menuRef}
              className="ctx-menu"
              style={{ top: menu.y, left: menu.x }}
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => void runSessionAction("pin", menu.session)}
              >
                <IconPin size={14} />{" "}
                {isSessionPinned(menu.session) ? "Unpin" : "Pin"}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void runSessionAction("rename", menu.session)}
              >
                <IconPencil size={14} /> Rename
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void runSessionAction("unread", menu.session)}
              >
                <IconBell size={14} />{" "}
                {menu.session.unread ? "Mark as Read" : "Mark as Unread"}
              </button>
              <div className="ctx-sep" />
              <button
                type="button"
                role="menuitem"
                onClick={() => void runSessionAction("fork", menu.session)}
              >
                <IconFork size={14} /> Fork Chat
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void runSessionAction("archive", menu.session)}
              >
                <IconArchive size={14} /> Archive
              </button>
              <div className="ctx-sep" />
              <button
                type="button"
                className="danger"
                role="menuitem"
                onClick={() => void runSessionAction("delete", menu.session)}
              >
                <IconTrash size={14} /> Delete
              </button>
            </div>
          </>,
          document.body
        )}

      {confirmDelete &&
        createPortal(
          <div
            className="modal-backdrop"
            onClick={() => setConfirmDelete(null)}
            onKeyDown={() => undefined}
          >
            <div
              className="modal"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={() => undefined}
            >
              <h3>Delete session?</h3>
              <p className="modal-body">
                Permanently delete “{confirmDelete.title || "Untitled"}”? This
                cannot be undone.
              </p>
              <div className="modal-actions">
                <button type="button" onClick={() => setConfirmDelete(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary danger-btn"
                  onClick={() => void confirmDeleteSession()}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {renameTarget &&
        createPortal(
          <div
            className="modal-backdrop"
            onClick={() => setRenameTarget(null)}
            onKeyDown={() => undefined}
          >
            <div
              className="modal"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={() => undefined}
            >
              <h3>Rename session</h3>
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void confirmRenameSession();
                  if (e.key === "Escape") setRenameTarget(null);
                }}
              />
              <div className="modal-actions">
                <button type="button" onClick={() => setRenameTarget(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void confirmRenameSession()}
                >
                  Save
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {manualOpen &&
        createPortal(
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
              <h3>Enter path</h3>
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
                  Cancel
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
                  Use this path
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
