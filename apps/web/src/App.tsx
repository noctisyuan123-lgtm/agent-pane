import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { AgentBrowserPanel } from "./AgentBrowserPanel";
import { CustomizePanel } from "./CustomizePanel";
import { TerminalPanel } from "./TerminalPanel";
import { SessionWorkingDots } from "./SessionWorkingDots";
import { AgentActivityStrip } from "./AgentActivityStrip";
import { WorkspacePicker } from "./WorkspacePicker";
import {
  buildContextBreakdown,
  formatTokenCount,
} from "./contextUsage";
import { useBridge, userTurnIndexAt } from "./useBridge";
import type { AgentMode } from "./useBridge";
import {
  effortLabelFor,
  getEffortFor,
} from "./modelEffort";
import { ToolTimeline } from "./ToolTimeline";
import { renderLiveTurnBody } from "./LiveProcessStack";
import { groupChatIntoTurns, WorkedForFold } from "./TurnBlocks";
import type { ChatItem } from "./chatFromEvents";
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
  isImageAttachment,
  localFileUrl,
  openLocalPath,
  patchSessionMeta,
  peekHistoryCache,
  persistLocalAttachment,
  listFs,
  pickFolder,
  rememberPath,
  revealInFinder,
  uploadAttachment,
  type FsListEntry,
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
  IconAsk,
  IconChevron,
  IconCheck,
  IconCopy,
  IconCustomize,
  IconDiff,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconFork,
  IconGlobe,
  IconLayers,
  IconList,
  IconMoreVertical,
  IconPaperPlane,
  IconPencil,
  IconPin,
  IconPlus,
  IconRefresh,
  IconSidebar,
  IconStop,
  IconTerminal,
  IconTrash,
  IconUndo,
} from "./icons";

/** Folder name for home breadcrumb (Cursor-style workspace label). */
function folderName(p: string): string {
  if (!p) return "";
  const parts = p.replace(/\/$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

function truncateOneLine(text: string, max = 72): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Top-line task outline for the Cursor-style activity strip.
 * Prefer plan/task title or tool-row label — never dump the user's raw prompt.
 */
/** Latest running tool row, if any (external process — not sister herself). */
function findRunningTool(messages: ChatItem[]): {
  label: string;
  title: string;
} | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind !== "tools" || !m.tools.length) continue;
    const running = [...m.tools].reverse().find((t) => t.status === "running");
    if (!running) continue;
    const raw = running.label?.trim() || "";
    if (!raw) continue;
    const title = raw.replace(/^Ran\s+/i, "").trim() || raw;
    return { label: raw, title };
  }
  return null;
}

/**
 * External process block (tools / subagents) — excludes sister-only thinking.
 * Particles + outline + detail only when this is true.
 */
function hasExternalProcess(
  messages: ChatItem[],
  phase: string | null | undefined,
  statusMsg: string | null,
  subagentModel: string | null | undefined
): boolean {
  if (subagentModel?.trim()) return true;
  if (findRunningTool(messages)) return true;
  if (phase === "tool" || phase === "sleeping" || phase === "permission") {
    return true;
  }
  if (
    statusMsg != null &&
    /^(Running|Using|Calling|Permission|Queued:)/i.test(statusMsg)
  ) {
    return true;
  }
  return false;
}

/** Line-1 process outline — tool/subagent title only (never user prompt). */
function activityOutline(
  messages: ChatItem[],
  tasks: { content: string; status: string }[],
  subagentModel: string | null | undefined
): string {
  // Prefer in-progress plan/task when a subagent (or similar) owns a named step
  if (subagentModel?.trim()) {
    const inProg = tasks.find((t) => t.status === "in_progress");
    if (inProg?.content?.trim()) return truncateOneLine(inProg.content);
  }
  const running = findRunningTool(messages);
  if (running) return truncateOneLine(running.title);
  const inProg = tasks.find((t) => t.status === "in_progress");
  if (inProg?.content?.trim()) return truncateOneLine(inProg.content);
  // Last completed tool title while still in tool phase (brief gap)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === "tools" && m.tools.length) {
      const tool = m.tools[m.tools.length - 1]!;
      const label = tool.label?.trim();
      if (label) {
        return truncateOneLine(label.replace(/^Ran\s+/i, "").trim() || label);
      }
    }
  }
  return "Working…";
}

/** Line-2 concrete action from tool activity / statusMsg. */
function activityDetail(
  statusMsg: string | null,
  phase: string | null | undefined,
  messages: ChatItem[]
): string {
  const toolish =
    phase === "tool" ||
    phase === "permission" ||
    phase === "sleeping" ||
    (statusMsg != null &&
      /^(Running|Using|Calling|Permission|Queued:)/i.test(statusMsg));
  if (toolish && statusMsg?.trim()) {
    return truncateOneLine(statusMsg, 96);
  }
  const running = findRunningTool(messages);
  if (running) {
    const raw = running.label;
    if (/^Ran\s+/i.test(raw)) {
      return truncateOneLine(`Running ${raw.replace(/^Ran\s+/i, "")}`, 96);
    }
    if (/^Running\b/i.test(raw)) return truncateOneLine(raw, 96);
    return truncateOneLine(`Running ${raw}`, 96);
  }
  return "";
}

/** Line-3 Cursor-like agent status (not a tool command). */
function activityStatusLine(
  phase: string | null | undefined,
  statusMsg: string | null,
  messages: ChatItem[],
  busy: boolean,
  busyElapsed: number
): string {
  const thinking =
    phase === "thinking" ||
    (statusMsg != null && /^Thinking/i.test(statusMsg));
  if (thinking) {
    // Mirror timeline "Thought briefly" for short streams
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.kind === "thought" && m.text.trim()) {
        return m.text.trim().length < 40
          ? "Thought briefly"
          : "Thinking…";
      }
    }
    return "Thought briefly";
  }
  if (phase === "compact" || (statusMsg != null && /compact/i.test(statusMsg))) {
    return "Compacting…";
  }
  if (phase === "permission") return "Waiting for permission…";
  if (phase === "queue") return "Planning next moves";
  if (phase === "working") {
    if (statusMsg && /waiting for model/i.test(statusMsg)) {
      const sec = (busyElapsed / 1000).toFixed(1);
      return `Waiting for model… ${sec}s`;
    }
    return "Planning next moves";
  }
  if (phase === "tool" || phase === "sleeping") {
    // Soft status under an active tool
    return "Working…";
  }
  if (busy) {
    const sec = (busyElapsed / 1000).toFixed(1);
    return `Waiting for response… ${sec}s`;
  }
  if (statusMsg?.trim() && !/^(Running|Using|Calling)/i.test(statusMsg)) {
    return truncateOneLine(statusMsg, 64);
  }
  return "";
}

/** Models from `grok models` on this machine — passed to `grok agent -m`. */
const MODEL_OPTIONS = [
  { id: "grok-4.5", label: "Grok 4.5", supportsEffort: true },
  {
    id: "grok-composer-2.5-fast",
    label: "Composer 2.5",
    supportsEffort: true,
  },
] as const;

const EFFORT_OPTIONS = [
  { id: "low" as const, label: "Low" },
  { id: "medium" as const, label: "Medium" },
  { id: "high" as const, label: "High" },
];

const DEFAULT_MODEL = MODEL_OPTIONS[0].id;

/** Context window size (tokens) for session usage ring. */
const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  "grok-4.5": 256_000,
  "grok-composer-2.5-fast": 128_000,
};
const DEFAULT_CONTEXT_TOKENS = 128_000;

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
): boolean {
  const [crowded, setCrowded] = useState(false);
  const crowdedRef = useRef(false);

  /**
   * Crowded = model should drop to bottom-left.
   * Measure wrap at COMPACT (narrow) width — i.e. with model still on the right.
   * That way: first line fills until it would wrap → push model down → then grow to 2+ lines.
   * Decision does not depend on current layout, so no twitch loop.
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (!value.trim()) {
      if (crowdedRef.current) {
        crowdedRef.current = false;
        setCrowded(false);
      }
      return;
    }
    if (value.includes("\n")) {
      if (!crowdedRef.current) {
        crowdedRef.current = true;
        setCrowded(true);
      }
      return;
    }

    const shell = el.closest(".composer-shell") as HTMLElement | null;
    const shellW = shell?.clientWidth ?? el.clientWidth;
    const chip = shell?.querySelector(".model-chip-btn") as HTMLElement | null;
    const modelW = Math.max(chip?.offsetWidth ?? 0, 120);
    // plus(28) + send(32) + gaps(~16) + shell pad(~16) + model chip
    const reserve = 28 + 32 + 16 + 16 + modelW;
    const narrowTaW = Math.max(100, shellW - reserve);

    const cs = getComputedStyle(el);
    const probe = document.createElement("div");
    probe.style.cssText = [
      "position:absolute",
      "left:-9999px",
      "top:0",
      "visibility:hidden",
      `width:${narrowTaW}px`,
      `font:${cs.font}`,
      `letter-spacing:${cs.letterSpacing}`,
      `line-height:${cs.lineHeight}`,
      "white-space:pre-wrap",
      "word-break:break-word",
      "padding:0",
    ].join(";");
    probe.textContent = value;
    document.body.appendChild(probe);
    const h = probe.scrollHeight;
    document.body.removeChild(probe);

    const lineH = Number.parseFloat(cs.lineHeight) || opts.min || 20;
    const wrapsNarrow = h > lineH * 1.4;
    if (wrapsNarrow !== crowdedRef.current) {
      crowdedRef.current = wrapsNarrow;
      setCrowded(wrapsNarrow);
    }
  }, [value, ref, opts.min]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(opts.max, Math.max(opts.min, el.scrollHeight));
    el.style.height = `${next}px`;
    el.style.overflowY = next >= opts.max - 1 ? "auto" : "hidden";
  }, [value, crowded, ref, opts.min, opts.max]);

  return crowded;
}

const mdComponents = {
  table: ({ children }: { children?: ReactNode }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

/**
 * Every WS tick during streaming (tokens, tool events, activity phase…)
 * re-renders the whole App, and with no memo boundary React re-ran the full
 * remark/rehype-highlight pipeline for EVERY visible bubble on EVERY tick —
 * not just the one actively streaming. That's the real "还是挺卡" during
 * generation. `text` is a primitive, so memo skips untouched bubbles for free.
 */
const MemoMarkdown = memo(function MemoMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={mdComponents}
    >
      {text}
    </ReactMarkdown>
  );
});

export function App() {
  const b = useBridge();
  const [input, setInput] = useState("");
  const [recent, setRecent] = useState<ProjectEntry[]>([]);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [history, setHistory] = useState<HistoryGroup[]>(
    () => peekHistoryCache() ?? []
  );
  const [expandedCwd, setExpandedCwd] = useState<Record<string, boolean>>({});
  /** Optimistic sidebar highlight — pointerdown before history load finishes. */
  const [sidebarSelectedId, setSidebarSelectedId] = useState<string | null>(
    null
  );
  const activeSessionId = sidebarSelectedId ?? b.sessionId;
  useEffect(() => {
    setSidebarSelectedId(b.sessionId);
  }, [b.sessionId]);
  const [manualOpen, setManualOpen] = useState(false);
  const [wsPickerOpen, setWsPickerOpen] = useState(false);
  const homeLabelRef = useRef<HTMLButtonElement>(null);
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
  /** Which message bubble the ⋯ menu is for */
  const [respMenuTarget, setRespMenuTarget] = useState<{
    text: string;
    messageIndex: number;
    /** Can mutate timeline (not mid-stream) */
    canMutate: boolean;
  } | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const [rightTab, setRightTab] = useState<
    "changes" | "browser" | "terminal" | "files" | null
  >("changes");
  const [rightOpen, setRightOpen] = useState(true);
  const [fsRel, setFsRel] = useState(".");
  const [fsEntries, setFsEntries] = useState<FsListEntry[]>([]);
  const [fsLoading, setFsLoading] = useState(false);
  const [fsError, setFsError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<
    { path: string; name: string; kind: "file" | "folder"; mime?: string }[]
  >([]);
  const [attachPreview, setAttachPreview] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [slashHi, setSlashHi] = useState(0);

  const bottomRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLElement | null>(null);
  /** Follow new output only while user is pinned near the bottom. */
  const stickToBottomRef = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const createFn = useRef(b.createSession);
  createFn.current = b.createSession;

  const hasMessages = b.messages.length > 0;
  /** Stop whenever a turn looks in-flight — don't require !historyOnly (that hid Stop). */
  const showStop =
    hasMessages &&
    !b.resuming &&
    (b.busy ||
      b.activityPhase === "working" ||
      b.activityPhase === "thinking" ||
      b.activityPhase === "tool" ||
      b.activityPhase === "permission" ||
      b.activityPhase === "compact" ||
      b.activityPhase === "queue" ||
      b.activityPhase === "sleeping");
  /** 有消息才进对话布局；空会话/新会话 = Cursor 式居中 Home */
  const showHome = !hasMessages;
  // Home hero: always roomy toolbar row (model bottom-left); follow-up uses auto crowded
  const growMin = showHome ? 56 : 22;
  const growMax = showHome ? 160 : 140;
  const composerCrowdedAuto = useAutoGrow(taRef, input, {
    min: growMin,
    max: growMax,
  });
  const composerCrowded = showHome ? true : composerCrowdedAuto;

  useEffect(() => {
    if (b.restoredDraft != null) {
      setInput(b.restoredDraft);
      b.clearRestoredDraft();
    }
  }, [b.restoredDraft, b]);

  useEffect(() => {
    setFsRel(".");
    setFsEntries([]);
    setFsError(null);
  }, [b.cwd]);

  useEffect(() => {
    if (rightTab !== "files" || !b.cwd) return;
    let cancelled = false;
    setFsLoading(true);
    setFsError(null);
    void listFs(b.cwd, fsRel)
      .then((entries) => {
        if (!cancelled) setFsEntries(entries);
      })
      .catch((e) => {
        if (!cancelled) {
          setFsEntries([]);
          setFsError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setFsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rightTab, b.cwd, fsRel]);

  useEffect(() => {
    if (!usageOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".session-usage")) return;
      setUsageOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setUsageOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [usageOpen]);

  useEffect(() => {
    if (!modelMenuOpen && !effortMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".model-picker")) return;
      setModelMenuOpen(false);
      setEffortMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setEffortMenuOpen(false);
        setModelMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [modelMenuOpen, effortMenuOpen]);

  const modelMeta =
    MODEL_OPTIONS.find((m) => m.id === b.model) ?? MODEL_OPTIONS[0];
  const effortLabel = effortLabelFor({
    effort: b.effort,
    fast: b.effortFast,
  });
  const modelChipLabel = `${modelMeta.label} ${effortLabel}`;

  const pickModel = (id: string) => {
    b.setModel(id);
    localStorage.setItem("agent-pane-model", id);
    // Keep menus open — prefs load per model; close by clicking outside
  };

  const toggleEffortFast = () => {
    b.setEffortFast(!b.effortFast);
  };

  const openModelEffortEdit = (e: ReactMouseEvent, modelId: string) => {
    e.preventDefault();
    e.stopPropagation();
    pickModel(modelId);
    setModelMenuOpen(true);
    setEffortMenuOpen(true);
  };

  const pickEffort = (id: "low" | "medium" | "high") => {
    b.setEffort(id);
    // Persist for current model; leave menus open until outside click
  };

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

  // Refresh history on mount only — NOT on every session switch.
  // sessionId-triggered refreshLists remounted the sidebar mid-click and
  // stacked network work during rapid switching (felt like a freeze).
  useEffect(() => {
    void refreshLists(true);
  }, [refreshLists]);

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

  /** Left sidebar width (independent of right rail) */
  const [sidebarW, setSidebarW] = useState(() => {
    const n = Number(localStorage.getItem("agent-pane-sidebar-w") || "248");
    return Number.isFinite(n) ? Math.min(420, Math.max(180, n)) : 248;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("agent-pane-sidebar-collapsed") === "1"
  );
  /**
   * Right rail width. Default matches left bar; Terminal/Files/Browser widen;
   * Changes snaps back to left width.
   */
  const [rightRailW, setRightRailW] = useState(() => {
    const n = Number(localStorage.getItem("agent-pane-right-rail-w") || "");
    if (Number.isFinite(n) && n > 0) return Math.min(720, Math.max(180, n));
    const left = Number(localStorage.getItem("agent-pane-sidebar-w") || "248");
    return Number.isFinite(left) ? Math.min(420, Math.max(180, left)) : 248;
  });
  const [railResizing, setRailResizing] = useState(false);
  const sidebarDrag = useRef<{
    startX: number;
    startW: number;
    /** left = sidebar; right = right-rail */
    edge: "left" | "right";
  } | null>(null);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--sidebar-w",
      `${sidebarW}px`
    );
    localStorage.setItem("agent-pane-sidebar-w", String(sidebarW));
  }, [sidebarW]);

  useEffect(() => {
    localStorage.setItem(
      "agent-pane-sidebar-collapsed",
      sidebarCollapsed ? "1" : "0"
    );
  }, [sidebarCollapsed]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--right-rail-w",
      `${rightRailW}px`
    );
    localStorage.setItem("agent-pane-right-rail-w", String(rightRailW));
  }, [rightRailW]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = sidebarDrag.current;
      if (!d) return;
      if (d.edge === "left") {
        const next = Math.min(
          420,
          Math.max(180, d.startW + (e.clientX - d.startX))
        );
        setSidebarW(next);
      } else {
        const next = Math.min(
          720,
          Math.max(180, d.startW + (d.startX - e.clientX))
        );
        setRightRailW(next);
      }
    };
    const onUp = () => {
      if (sidebarDrag.current) setRailResizing(false);
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

  const openRightTab = (
    tab: "changes" | "browser" | "terminal" | "files"
  ) => {
    setRightOpen(true);
    setRightTab(tab);
    if (tab === "changes") {
      // Snap back to left-bar width
      setRightRailW(sidebarW);
    } else if (tab === "terminal" || tab === "files") {
      setRightRailW((w) => Math.max(w, Math.max(sidebarW + 160, 420)));
    } else if (tab === "browser") {
      setRightRailW((w) => Math.max(w, Math.max(sidebarW + 120, 400)));
    }
  };

  const NEAR_BOTTOM_PX = 48;
  /** Re-pin only when truly at bottom (hysteresis — avoids 一抽一抽). */
  const REPIN_BOTTOM_PX = 16;

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = chatRef.current;
    if (!el) return;
    if (behavior === "smooth") {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    } else {
      // Instant — smooth + streaming = 一抽一抽
      el.scrollTop = el.scrollHeight;
    }
    setShowJumpBottom(false);
  }, []);

  const pinChatToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    // After send, DOM grows on next paint — pin now and once more after layout
    scrollChatToBottom("auto");
    requestAnimationFrame(() => {
      if (stickToBottomRef.current) scrollChatToBottom("auto");
    });
  }, [scrollChatToBottom]);

  // Stream / layout growth: stick only if user hasn't scrolled away
  useLayoutEffect(() => {
    if (!hasMessages) return;
    if (!stickToBottomRef.current) {
      const el = chatRef.current;
      if (el) {
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
        setShowJumpBottom(dist > REPIN_BOTTOM_PX);
      }
      return;
    }
    scrollChatToBottom("auto");
  }, [b.messages, b.diffs, b.tasks, b.statusMsg, b.busy, hasMessages, scrollChatToBottom]);

  // User scroll / wheel: release stick when reading history
  useEffect(() => {
    const el = chatRef.current;
    if (!el || !hasMessages) return;

    const syncStickFromPosition = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (stickToBottomRef.current) {
        // Already following — only unpin after clearly leaving the bottom
        if (dist > NEAR_BOTTOM_PX) {
          stickToBottomRef.current = false;
          setShowJumpBottom(true);
        } else {
          setShowJumpBottom(false);
        }
      } else if (dist <= REPIN_BOTTOM_PX) {
        // Was reading history — re-pin only when they scroll all the way down
        stickToBottomRef.current = true;
        setShowJumpBottom(false);
      } else {
        setShowJumpBottom(true);
      }
    };

    const onWheel = (e: WheelEvent) => {
      // Intentional upward gesture → release immediately (don't wait for threshold)
      if (e.deltaY < 0) {
        stickToBottomRef.current = false;
        setShowJumpBottom(true);
      }
    };

    const onTouchMove = () => {
      requestAnimationFrame(syncStickFromPosition);
    };

    el.addEventListener("scroll", syncStickFromPosition, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      el.removeEventListener("scroll", syncStickFromPosition);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [hasMessages]);

  const jumpBottom = () => {
    stickToBottomRef.current = true;
    scrollChatToBottom("smooth");
  };

  const selectCwd = async (path: string, opts?: { expand?: boolean }) => {
    b.setCwd(path);
    localStorage.setItem("agent-pane-cwd", path);
    await rememberPath(path);
    await refreshLists(false);
    // Accordion: only the selected folder stays open
    if (opts?.expand) {
      setExpandedCwd({ [path]: true });
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
      if (path) await selectCwd(path, { expand: true });
    } catch (e) {
      b.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  };

  const openWorkspacePicker = () => {
    void refreshLists(false);
    setWsPickerOpen(true);
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

    // Sending → always pin chat to bottom (don't fight user later if they scroll up)
    pinChatToBottom();

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
    // Multitask: fork a parallel live agent (other sessions keep running)
    if (b.agentMode === "multitask" && b.messages.length > 0) {
      setInput("");
      setAttachments([]);
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
    // Stop button (same slot as Send) — always cancel when in-flight
    if (showStop || b.busy) {
      b.cancel();
      return;
    }
    void ensureSessionAndSend(input);
  };

  /** Terminal-style stop: Escape / bare Ctrl·Cmd+C while a turn is in flight */
  useEffect(() => {
    if (!showStop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setRespMenuOpen(false);
        setRespMenuTarget(null);
        b.cancel();
        return;
      }
      // Ctrl/Cmd+C — only when nothing is selected (else let copy work)
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "c"
      ) {
        const ta = taRef.current;
        const taHasSel =
          !!ta &&
          document.activeElement === ta &&
          ta.selectionStart !== ta.selectionEnd;
        const docSel = (window.getSelection()?.toString() ?? "").length > 0;
        if (taHasSel || docSel) return;
        e.preventDefault();
        b.cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [showStop, b.cancel]);

  const pickSlash = (c: SlashCommand) => {
    const rest = c.input ? " " : " ";
    setInput(`/${c.name}${rest}`);
    setSlashHi(0);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const histAbortRef = useRef<AbortController | null>(null);
  const openHist = (sessionId: string, cwd: string) => {
    // Expand target folder without collapsing others / without forcing a remount
    // when already open (pointerdown→setState was swallowing the click).
    setExpandedCwd((prev) => (prev[cwd] ? prev : { ...prev, [cwd]: true }));
    setSidebarSelectedId((prev) => (prev === sessionId ? prev : sessionId));
    // Cancel in-flight history load — rapid multi-click was stacking fetches
    // and feeling like a freeze.
    histAbortRef.current?.abort();
    const ac = new AbortController();
    histAbortRef.current = ac;
    void (async () => {
      const result = await b.openHistorySession(sessionId, cwd, ac.signal);
      if (ac.signal.aborted) return;
      // Only refresh sidebar when a zombie session was scrubbed
      if (result?.scrubbed) {
        invalidateHistoryClientCache(sessionId);
        void refreshLists(true);
      }
    })();
  };

  // CLI / single-instance: `agent-pane open <sessionId>` → same as sidebar open
  const openHistRef = useRef(openHist);
  openHistRef.current = openHist;
  const connectedRef = useRef(b.connected);
  connectedRef.current = b.connected;
  const pendingCliSessionRef = useRef<string | null>(null);
  const lastCliOpenRef = useRef<{ id: string; at: number } | null>(null);

  useEffect(() => {
    const openFromCli = async (sessionId: string) => {
      const id = sessionId.trim();
      if (!id) return;
      const now = Date.now();
      const last = lastCliOpenRef.current;
      // Cold start emits twice; ignore duplicate within 3s
      if (last && last.id === id && now - last.at < 3000) return;
      if (!connectedRef.current) {
        pendingCliSessionRef.current = id;
        return;
      }
      lastCliOpenRef.current = { id, at: now };
      pendingCliSessionRef.current = null;
      try {
        const { fetchSessionMeta } = await import("./api");
        const meta = await fetchSessionMeta(id);
        if (!meta?.cwd) {
          console.warn("[agent-pane] CLI open: session not found", id);
          return;
        }
        await openHistRef.current(meta.sessionId, meta.cwd);
      } catch (e) {
        console.warn("[agent-pane] CLI open failed", e);
      }
    };

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        unlisten = await listen<{ sessionId?: string }>("open-session", (ev) => {
          const sid = ev.payload?.sessionId;
          if (sid) void openFromCli(sid);
        });
      } catch {
        /* browser / non-tauri */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!b.connected) return;
    const pending = pendingCliSessionRef.current;
    if (!pending) return;
    pendingCliSessionRef.current = null;
    const now = Date.now();
    const last = lastCliOpenRef.current;
    if (last && last.id === pending && now - last.at < 3000) return;
    lastCliOpenRef.current = { id: pending, at: now };
    void (async () => {
      try {
        const { fetchSessionMeta } = await import("./api");
        const meta = await fetchSessionMeta(pending);
        if (!meta?.cwd) return;
        await openHistRef.current(meta.sessionId, meta.cwd);
      } catch (e) {
        console.warn("[agent-pane] CLI open (connected flush) failed", e);
      }
    })();
  }, [b.connected]);

  const setMode = (mode: AgentMode) => {
    b.setAgentMode(mode);
    localStorage.setItem("agent-pane-mode", mode);
  };

  const MODE_CYCLE: AgentMode[] = [
    "agent",
    "plan",
    "debug",
    "multitask",
    "auto",
  ];

  const cycleMode = () => {
    const i = Math.max(0, MODE_CYCLE.indexOf(b.agentMode));
    const next = MODE_CYCLE[(i + 1) % MODE_CYCLE.length]!;
    setMode(next);
  };

  const modeChipMeta =
    b.agentMode === "plan"
      ? { key: "plan" as const, label: "Plan", Icon: IconList }
      : b.agentMode === "debug"
        ? { key: "debug" as const, label: "Debug", Icon: IconBug }
        : b.agentMode === "multitask"
          ? { key: "multitask" as const, label: "Multitask", Icon: IconLayers }
          : b.agentMode === "auto"
            ? { key: "ask" as const, label: "Ask", Icon: IconAsk }
            : null;

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
    void (async () => {
      for (const p of paths) {
        if (!p) continue;
        let abs = p;
        let name = p.split(/[/\\]/).pop() || p;
        // Screenshots / temp paths vanish — copy into uploads first
        const ephemeral =
          /TemporaryItems|screencaptureui_|NSIRD_screencapture|\/var\/folders\//i.test(
            p
          ) || isImageAttachment(name);
        if (ephemeral) {
          try {
            const saved = await persistLocalAttachment(p);
            abs = saved.path;
            name = saved.name || name;
          } catch {
            /* keep original path; bridge will try again on send */
          }
        }
        setAttachments((prev) => {
          if (prev.some((a) => a.path === abs || a.path === p)) return prev;
          return [
            ...prev,
            {
              path: abs,
              name,
              kind: "file" as const,
            },
          ];
        });
      }
    })();
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
            : [
                ...prev,
                {
                  path: up.path,
                  name: up.name,
                  kind: "file",
                  mime: f.type || undefined,
                },
              ]
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

  /** Session context usage — prefer agent-reported used/size */
  const sessionUsage = useMemo(() => {
    const fallback =
      MODEL_CONTEXT_TOKENS[b.model] ??
      MODEL_CONTEXT_TOKENS[DEFAULT_MODEL] ??
      DEFAULT_CONTEXT_TOKENS;
    return buildContextBreakdown(b.contextUsage, fallback);
  }, [b.contextUsage, b.model]);

  const diffStats = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const f of b.diffs) {
      add += f.additions;
      del += f.deletions;
    }
    return { add, del, files: b.diffs.length };
  }, [b.diffs]);

  const composer = (
    <div
      className={`composer-stack ${showHome ? "hero" : "followup"} ${
        composerCrowded ? "crowded" : "compact"
      }`}
    >
      <div
        ref={composerShellRef}
        className={`composer-shell ${showHome ? "hero" : "followup"} ${
          composerCrowded ? "crowded" : "compact"
        } ${dragOver ? "drag-over" : ""}`}
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
          {attachments.map((a) => {
            const isImg = isImageAttachment(a.name, a.mime);
            return (
              <span className="attach-chip" key={a.path} title={a.path}>
                <button
                  type="button"
                  className="attach-chip-open"
                  onClick={() => {
                    if (isImg) {
                      setAttachPreview({ path: a.path, name: a.name });
                      return;
                    }
                    void openLocalPath(a.path).catch((e) =>
                      b.setError(e instanceof Error ? e.message : String(e))
                    );
                  }}
                >
                  {isImg ? (
                    <img
                      className="attach-chip-thumb"
                      src={localFileUrl(a.path)}
                      alt=""
                      draggable={false}
                    />
                  ) : (
                    <span className="attach-chip-icon" aria-hidden>
                      {a.kind === "folder" ? (
                        <IconFolder size={12} />
                      ) : (
                        <IconFile size={12} />
                      )}
                    </span>
                  )}
                  <span className="attach-chip-name">{a.name}</span>
                </button>
                <button
                  type="button"
                  className="attach-chip-x"
                  aria-label={`Remove ${a.name}`}
                  onClick={() =>
                    setAttachments((prev) =>
                      prev.filter((x) => x.path !== a.path)
                    )
                  }
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      {/* Cursor-style: short → model right of input; long → model bottom-left */}
      <div
        className={`composer-main-row ${
          composerCrowded ? "crowded" : "compact"
        }`}
      >
        <div className="composer-leading">
          <button
            ref={plusBtnRef}
            type="button"
            className={`plus-btn ${plusOpen ? "open" : ""}`}
            title="Add modes, skills, tools…"
            onClick={() => (plusOpen ? closePlus() : openPlusMenu())}
          >
            <IconPlus size={15} />
          </button>
          {modeChipMeta && (
            <span
              className={`mode-chip mode-chip-${modeChipMeta.key}`}
              title={`${modeChipMeta.label} mode — click × or ⇧Tab to change`}
            >
              <modeChipMeta.Icon size={13} />
              <span className="mode-chip-label">{modeChipMeta.label}</span>
              <button
                type="button"
                className="mode-chip-x"
                aria-label={`Clear ${modeChipMeta.label} mode`}
                onClick={(e) => {
                  e.stopPropagation();
                  setMode("agent");
                }}
              >
                ×
              </button>
            </span>
          )}
        </div>
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
                ? "Plan, Build, / for commands — drop files here"
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
              // ⇧Tab — cycle Agent → Plan → Debug → Multitask → Ask
              if (e.key === "Tab" && e.shiftKey && !ime && !slashParsed.active) {
                e.preventDefault();
                cycleMode();
                return;
              }
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
              if (e.key === "Escape" && !ime) {
                // In-flight turn: Escape = Stop (terminal-style), not only dismiss menus
                if (showStop) {
                  e.preventDefault();
                  b.cancel();
                  return;
                }
                closePlus();
                setModelMenuOpen(false);
                setEffortMenuOpen(false);
                if (slashParsed.active) setInput("");
                return;
              }
              // Explicit Shift+Enter newline — WKWebView sometimes skips default
              if (e.key === "Enter" && e.shiftKey && !ime) {
                e.preventDefault();
                const ta = e.currentTarget;
                const start = ta.selectionStart ?? input.length;
                const end = ta.selectionEnd ?? start;
                const next =
                  input.slice(0, start) + "\n" + input.slice(end);
                setInput(next);
                requestAnimationFrame(() => {
                  const el = taRef.current;
                  if (!el) return;
                  const pos = start + 1;
                  el.selectionStart = pos;
                  el.selectionEnd = pos;
                });
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                if (ime) return;
                e.preventDefault();
                onSubmit();
              }
            }}
          />
        </div>
        <div
          className={`model-picker ${modelMenuOpen ? "open" : ""} ${
            composerCrowded ? "dock-left" : "dock-right"
          }`}
        >
          <button
            ref={modelBtnRef}
            type="button"
            className="model-chip-btn"
            title="Model & effort for the next New Agent / resume"
            onClick={() => {
              setModelMenuOpen((v) => {
                const next = !v;
                // Model list is primary; effort opens via Edit on a model row
                if (!next) setEffortMenuOpen(false);
                return next;
              });
              closePlus();
            }}
          >
            <span className="model-chip-label">{modelChipLabel}</span>
            <IconChevron size={12} className="model-chip-chevron" />
          </button>
          {(effortMenuOpen || modelMenuOpen) && (
            <div className="model-menu" role="listbox">
              {modelMenuOpen && (
                <div className="model-menu-list">
                  {MODEL_OPTIONS.map((m) => {
                    const selected = b.model === m.id;
                    const rowLabel = selected
                      ? effortLabel
                      : effortLabelFor(getEffortFor(m.id));
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`model-menu-item ${selected ? "selected" : ""}`}
                        onClick={() => pickModel(m.id)}
                      >
                        <span className="model-menu-name">{m.label}</span>
                        <span className="model-menu-effort">{rowLabel}</span>
                        <span
                          className={`model-menu-check-slot ${
                            selected ? "on" : ""
                          }`}
                          aria-hidden={!selected}
                        >
                          {selected && (
                            <IconCheck size={14} className="model-menu-check" />
                          )}
                        </span>
                        <button
                          type="button"
                          className="effort-edit-btn"
                          title="Edit effort for this model"
                          onClick={(e) => openModelEffortEdit(e, m.id)}
                        >
                          Edit
                        </button>
                      </button>
                    );
                  })}
                </div>
              )}
              {effortMenuOpen && (
                <div className="effort-menu" role="menu">
                  <div className="effort-menu-title">Effort</div>
                  {EFFORT_OPTIONS.map((e) => {
                    const selected = !b.effortFast && b.effort === e.id;
                    return (
                      <button
                        key={e.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        className={`effort-menu-item ${
                          selected ? "selected" : ""
                        }`}
                        onClick={() => pickEffort(e.id)}
                      >
                        <span>{e.label}</span>
                        {selected && <IconCheck size={14} />}
                      </button>
                    );
                  })}
                  <div className="effort-menu-sep" />
                  <div className="effort-menu-title">Options</div>
                  <label className="effort-fast-row">
                    <span>Fast</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={b.effortFast}
                      className={`toggle-switch ${b.effortFast ? "on" : ""}`}
                      onClick={toggleEffortFast}
                    >
                      <i />
                    </button>
                  </label>
                </div>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          className={`send-btn ${showStop ? "stop" : ""}`}
          onClick={onSubmit}
          disabled={
            // Stop must stay clickable even if WS blips; Send still needs connection
            showStop
              ? false
              : !b.connected || (!input.trim() && attachments.length === 0)
          }
          title={
            showStop
              ? "Stop generating (Esc)"
              : showHome
                ? "Start"
                : "Send"
          }
        >
          {showStop ? <IconStop size={13} /> : <IconArrowUp size={15} />}
        </button>
      </div>
      {dragOver && (
        <div className="drop-overlay" aria-hidden>
          Drop files or images
        </div>
      )}
      </div>
      {/* Outside the glass input — Cursor-style footer */}
      <div className="composer-meta-row">
        {b.historyOnly ? (
          <span className="hist-hint">
            {b.sessionId
              ? "Idle · send continues this chat"
              : "History · pick a session or New Agent"}
          </span>
        ) : (
          <span className="grow" />
        )}
        <span
          className={`session-usage ${usageOpen ? "open" : ""}`}
          title={
            sessionUsage.fromAgent
              ? `Context · ${sessionUsage.used.toLocaleString()} / ${sessionUsage.limit.toLocaleString()} tokens`
              : "Context usage · waiting for agent report"
          }
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            setUsageOpen((v) => !v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setUsageOpen((v) => !v);
            }
          }}
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
              strokeDasharray={`${
                sessionUsage.fromAgent ? (sessionUsage.pct / 100) * 37.7 : 0
              } 37.7`}
              strokeLinecap="round"
              transform="rotate(-90 8 8)"
            />
          </svg>
          <span className="session-usage-pct">
            {sessionUsage.fromAgent ? `${sessionUsage.pct}%` : "—"}
          </span>
          {usageOpen && (
            <div
              className="context-usage-pop"
              role="dialog"
              aria-label="Context Usage"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="context-usage-head">
                <span className="context-usage-title">Context Usage</span>
                <div className="context-usage-head-actions">
                  <button
                    type="button"
                    className="context-usage-close"
                    aria-label="Close"
                    onClick={() => setUsageOpen(false)}
                  >
                    ×
                  </button>
                </div>
              </div>
              <div className="context-usage-summary">
                <span>
                  {sessionUsage.fromAgent
                    ? `${sessionUsage.pct}% Full`
                    : "No agent data yet"}
                </span>
                <span>
                  {sessionUsage.fromAgent
                    ? `${formatTokenCount(sessionUsage.used)} / ${formatTokenCount(sessionUsage.limit)} Tokens`
                    : `Window ${formatTokenCount(sessionUsage.limit)}`}
                </span>
              </div>
              <div className="context-usage-bar" aria-hidden>
                {sessionUsage.fromAgent
                  ? sessionUsage.slices.map((s) =>
                      s.tokens > 0 ? (
                        <i
                          key={s.id}
                          style={{
                            flexGrow: Math.max(s.tokens, 1),
                            background: s.color,
                          }}
                        />
                      ) : null
                    )
                  : (
                    <i
                      style={{
                        flexGrow: 1,
                        background: "rgba(255,255,255,0.08)",
                      }}
                    />
                  )}
              </div>
              <ul className="context-usage-list">
                {sessionUsage.slices.map((s) => (
                  <li key={s.id}>
                    <span
                      className="context-usage-swatch"
                      style={{ background: s.color }}
                    />
                    <span className="context-usage-label">
                      {s.label}
                      {s.estimated ? (
                        <span className="context-usage-est"> —</span>
                      ) : null}
                    </span>
                    <span className="context-usage-n">
                      {formatTokenCount(s.tokens)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="context-usage-footnote">
                {sessionUsage.fromAgent
                  ? sessionUsage.sourceLabel?.includes("Estimated")
                    ? `Estimated from the visible transcript (~${formatTokenCount(sessionUsage.used)}). Grok live meters only track the resumed agent session (often a short digest), so imports can look tiny until you send and /session-info refreshes.`
                    : `${sessionUsage.sourceLabel ?? "From agent"} · ${formatTokenCount(sessionUsage.used)} / ${formatTokenCount(sessionUsage.limit)}. Grok counts system + skills + MCP/tool schemas + reminders — not just the visible chat bubbles, so a short flirt can still sit at a few %.`
                  : "Watching ~/.grok/sessions/…/signals.json after connect. Numbers appear once Grok writes the file (usually after a turn)."}
              </p>
            </div>
          )}
        </span>
      </div>
    </div>
  );

  const startWindowDrag = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    const detail = e.detail;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        if (detail === 2) await win.toggleMaximize();
        else await win.startDragging();
      } catch {
        /* browser / non-tauri */
      }
    })();
  };

  return (
      <div
        className={`shell${customizeOpen ? " customize-mode" : ""}${
          sidebarCollapsed ? " sidebar-collapsed" : ""
        }`}
      >
      {/* Drag only over sidebar chrome — not over chat/scrollbar */}
      <div
        className="titlebar-drag"
        data-tauri-drag-region
        aria-hidden
        onMouseDown={startWindowDrag}
      />
      {/* Web 假灯（桌面用系统灯，此节点 CSS 隐藏）— 与键坐标解耦 */}
      <div className="traffic-lights-slot" aria-hidden>
        <i />
        <i />
        <i />
      </div>
      {/* 折叠键：独立 --sidebar-toggle-top，不跟 lights-y 绑死 */}
      <div className="title-chrome">
        <button
          type="button"
          className="sidebar-toggle"
          title={sidebarCollapsed ? "Show sidebar" : "Collapse sidebar"}
          aria-label={sidebarCollapsed ? "Show sidebar" : "Collapse sidebar"}
          aria-pressed={!sidebarCollapsed}
          onClick={() => setSidebarCollapsed((v) => !v)}
        >
          <IconSidebar size={16} />
        </button>
      </div>
      <div
        className={`sidebar-rail${sidebarCollapsed ? " collapsed" : ""}`}
        aria-hidden={sidebarCollapsed}
      >
      <aside
        className="sidebar"
        /* 收起也保持宽度，由 rail overflow 水平裁切 → 滑出感 */
        style={{ width: sidebarW }}
      >
        <button
          type="button"
          className="side-btn primary"
          onClick={() => {
            setCustomizeOpen(false);
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
        <button
          type="button"
          className={`side-btn ${customizeOpen ? "primary" : ""}`}
          onClick={() => setCustomizeOpen((v) => !v)}
        >
          <IconCustomize className="ico" />
          Customize
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
                    activeSessionId === s.sessionId ? "active" : ""
                  } ${
                    b.busySessionIds?.includes(s.sessionId) ? "working" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="session-main"
                    onPointerDown={(e) => {
                      // Open on pointerdown — a prior setState here remounted the
                      // row and dropped the subsequent click (multi-click stuck).
                      if (e.button !== 0) return;
                      e.preventDefault();
                      openHist(s.sessionId, s.cwd);
                    }}
                    onClick={() => openHist(s.sessionId, s.cwd)}
                    title={`${s.title || "Untitled"}\n${s.cwd}`}
                  >
                    {b.busySessionIds?.includes(s.sessionId) && (
                      <SessionWorkingDots />
                    )}
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
                      // Accordion: only one folder open at a time
                      setExpandedCwd((m) => {
                        if (open) return { ...m, [g.cwd]: false };
                        return { [g.cwd]: true };
                      });
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
                          activeSessionId === s.sessionId ? "active" : ""
                        } ${
                          b.busySessionIds?.includes(s.sessionId)
                            ? "working"
                            : ""
                        }`}
                      >
                        <button
                          type="button"
                          className="session-main"
                          onPointerDown={(e) => {
                            if (e.button !== 0) return;
                            e.preventDefault();
                            openHist(s.sessionId, s.cwd);
                          }}
                          onClick={() => openHist(s.sessionId, s.cwd)}
                          title={s.title}
                        >
                          {b.busySessionIds?.includes(s.sessionId) && (
                            <SessionWorkingDots />
                          )}
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
            sidebarDrag.current = {
              startX: e.clientX,
              startW: sidebarW,
              edge: "left",
            };
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
        />
      </aside>
      </div>

      <div className="stage">
        <div
          className="stage-drag"
          data-tauri-drag-region
          aria-hidden
          onMouseDown={startWindowDrag}
        />
        {statusLocal && !b.error && (
          <div className="status-banner">{statusLocal}</div>
        )}
        {b.error && (
          <div className="error-banner" onClick={() => b.setError(null)}>
            {b.error}
          </div>
        )}

        {customizeOpen ? (
          <CustomizePanel
            connected={b.connected}
            bridgeLabel="Bridge · Grok ACP"
            model={modelMeta.label}
            effortLabel={effortLabel}
            agentMode={b.agentMode}
            onClose={() => setCustomizeOpen(false)}
          />
        ) : showHome ? (
          <div className="home">
            <div className="home-stack">
              <div className="home-label-wrap">
                <button
                  ref={homeLabelRef}
                  type="button"
                  className={`home-label ${wsPickerOpen ? "open" : ""}`}
                  title={
                    b.cwd
                      ? b.cwd
                      : "Open a project folder — this label follows the workspace"
                  }
                  onClick={() =>
                    wsPickerOpen
                      ? setWsPickerOpen(false)
                      : openWorkspacePicker()
                  }
                >
                  <span className="home-label-name">
                    {b.cwd ? folderName(b.cwd) : "Select project"}
                  </span>
                  <span className="home-label-chev" aria-hidden>
                    ▾
                  </span>
                </button>
                <WorkspacePicker
                  open={wsPickerOpen}
                  cwd={b.cwd}
                  recent={recent}
                  anchorRef={homeLabelRef}
                  onClose={() => setWsPickerOpen(false)}
                  onSelect={(path) => {
                    setWsPickerOpen(false);
                    void selectCwd(path, { expand: true });
                  }}
                  onOpenFolder={() => {
                    setWsPickerOpen(false);
                    void onBrowse();
                  }}
                  onSoon={(label) => {
                    setWsPickerOpen(false);
                    setStatusLocal(`${label} — coming soon`);
                  }}
                />
              </div>
              {composer}
              <div className="pills">
                <button
                  type="button"
                  className={`pill ${b.agentMode === "plan" ? "active" : ""}`}
                  title="Plan mode — outline steps without editing files (⇧Tab cycles modes)"
                  onClick={() => {
                    if (!b.cwd.trim()) {
                      openWorkspacePicker();
                      setStatusLocal("Pick a project folder first");
                      return;
                    }
                    setMode("plan");
                    setInput((prev) =>
                      prev.trim()
                        ? prev
                        : "Plan a clean approach for the next change. List steps, risks, and files to touch before editing."
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
                  title="Start a fresh parallel agent session (current chat stays in history)"
                  onClick={() => {
                    if (!b.cwd.trim()) {
                      openWorkspacePicker();
                      setStatusLocal("Pick a project folder for the new agent");
                      return;
                    }
                    setMode("multitask");
                    setInput("");
                    setAttachments([]);
                    b.createSession();
                    requestAnimationFrame(() => taRef.current?.focus());
                  }}
                >
                  Multitask
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
              {b.hiddenHistoryCount > 0 && (
                <button
                  type="button"
                  className="ghost-btn compact load-earlier-btn"
                  onClick={() => b.loadEarlierHistory()}
                >
                  展开更早的消息 ({b.hiddenHistoryCount})
                </button>
              )}
              {groupChatIntoTurns(b.messages, { busy: b.busy }).map((turn) => {
                const flatIndex = (item: ChatItem) =>
                  b.messages.findIndex((x) => x.id === item.id);
                // ⋯ only after the turn settles (MessageDone / cancel / history).
                // Avoids live stream layout jump (right → left) and useless menus mid-gen.
                const showMsgActions = !turn.isLive;

                const openRespMenu = (
                  e: ReactMouseEvent,
                  text: string,
                  item: ChatItem
                ) => {
                  e.stopPropagation();
                  if (turn.isLive) return;
                  const r = (
                    e.currentTarget as HTMLButtonElement
                  ).getBoundingClientRect();
                  const menuW = 160;
                  const menuH = 200;
                  let x = r.left;
                  let y = r.bottom + 4;
                  if (x + menuW > window.innerWidth - 8) {
                    x = Math.max(8, window.innerWidth - menuW - 8);
                  }
                  if (y + menuH > window.innerHeight - 8) {
                    y = Math.max(8, r.top - menuH - 4);
                  }
                  const mi = flatIndex(item);
                  if (mi < 0) {
                    // Don't fall back to 0 — that made Retry rewind turn 0 and wipe history
                    b.setError("Could not locate that message for Retry/Undo");
                    return;
                  }
                  setRespMenuTarget({
                    text,
                    messageIndex: mi,
                    canMutate: !b.busy,
                  });
                  setRespMenuPos({ x, y });
                  setRespMenuOpen(true);
                };

                const renderProcessItem = (m: ChatItem) => {
                  if (m.kind === "thought") {
                    const preview = m.text.trim();
                    if (!preview) return null;
                    const label =
                      preview.length < 40
                        ? "Thought briefly"
                        : `Thought for ${Math.max(1, Math.round(preview.length / 48))}s`;
                    return (
                      <details className="tl-thought" key={m.id}>
                        <summary>
                          <span className="tl-meta-label">{label}</span>
                          <span className="tl-meta-chev">▾</span>
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
                    // Activity strip owns live tool UI. Hide the old tl block
                    // whenever a process is active — don't rely on turn.isLive
                    // alone (busy can be false while statusMsg still says Running).
                    const processLive =
                      turn.isLive ||
                      b.busy ||
                      Boolean(b.activitySubagentModel) ||
                      b.activityPhase === "tool" ||
                      b.activityPhase === "sleeping" ||
                      b.activityPhase === "permission" ||
                      m.tools.some((t) => t.status === "running") ||
                      (b.statusMsg != null &&
                        /^(Running|Using|Calling|Permission|Queued:)/i.test(
                          b.statusMsg
                        ));
                    if (processLive) return null;
                    return (
                      <ToolTimeline
                        key={m.id}
                        tools={m.tools}
                        defaultOpen={false}
                      />
                    );
                  }
                  if (m.kind === "turn_log") {
                    if (turn.process.some((x) => x.kind === "tools")) {
                      return null;
                    }
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
                  return null;
                };

                const renderReply = (
                  m: Extract<ChatItem, { kind: "assistant" }>
                ) => (
                  <div
                    className={`msg assistant${showMsgActions ? "" : " no-actions"}`}
                    key={m.id}
                  >
                    <div className="assistant-text">
                      <MemoMarkdown text={m.text} />
                    </div>
                    {showMsgActions && (
                      <div className="resp-actions">
                        <button
                          type="button"
                          className="resp-more-btn"
                          title="Message actions"
                          aria-label="Message actions"
                          onClick={(e) => openRespMenu(e, m.text, m)}
                        >
                          <IconMoreVertical size={16} />
                        </button>
                      </div>
                    )}
                  </div>
                );

                const user = turn.user;
                return (
                  <div className="chat-turn" key={turn.key}>
                    {user && (
                      <div
                        className={`msg user${showMsgActions ? "" : " no-actions"}`}
                        key={user.id}
                      >
                        <div className="label-row">
                          <div className="label">You</div>
                        </div>
                        {(user.attachments ?? []).length > 0 && (
                          <div className="msg-attach-row">
                            {(user.attachments ?? []).map((a) => {
                              const name =
                                a.path.split(/[/\\]/).pop() || a.path;
                              const isImg = isImageAttachment(name);
                              return isImg ? (
                                <button
                                  type="button"
                                  className="msg-attach-img"
                                  key={a.path}
                                  title={a.path}
                                  onClick={() =>
                                    setAttachPreview({
                                      path: a.path,
                                      name,
                                    })
                                  }
                                >
                                  <img
                                    src={localFileUrl(a.path)}
                                    alt={name}
                                    draggable={false}
                                  />
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="msg-attach-file"
                                  key={a.path}
                                  title={a.path}
                                  onClick={() =>
                                    void openLocalPath(a.path).catch((e) =>
                                      b.setError(
                                        e instanceof Error
                                          ? e.message
                                          : String(e)
                                      )
                                    )
                                  }
                                >
                                  <IconFile size={12} />
                                  <span>{name}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                        {user.text.trim() &&
                          user.text !== "(attached files)" && (
                            <div className="bubble">{user.text}</div>
                          )}
                        {showMsgActions && (
                          <div className="resp-actions">
                            <button
                              type="button"
                              className="resp-more-btn"
                              title="Message actions"
                              aria-label="Message actions"
                              onClick={(e) =>
                                openRespMenu(e, user.text, user)
                              }
                            >
                              <IconMoreVertical size={16} />
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {/* Live: preserve interleaved stream order */}
                    {turn.isLive ? (
                      <div className="worked-live">
                        {renderLiveTurnBody(
                          turn.body,
                          renderProcessItem,
                          renderReply
                        )}
                      </div>
                    ) : (
                      <>
                        {/* Process only under Worked for — never the reply */}
                        <WorkedForFold
                          workedMs={turn.workedMs}
                          isLive={false}
                        >
                          {turn.process.map((item) =>
                            renderProcessItem(item)
                          )}
                        </WorkedForFold>
                        {/* Assistant body always visible */}
                        {turn.replies.map((item) => renderReply(item))}
                      </>
                    )}
                  </div>
                );
              })}

              {b.tasks.length > 0 && (
                <div
                  className={
                    b.tasks.every(
                      (t) =>
                        t.status === "completed" || t.status === "cancelled"
                    )
                      ? "todos todos-all-done"
                      : "todos"
                  }
                >
                  <h3>
                    To-dos
                    {(() => {
                      const left = b.tasks.filter(
                        (t) =>
                          t.status !== "completed" &&
                          t.status !== "cancelled"
                      ).length;
                      if (left === 0) return " · done";
                      if (left < b.tasks.length) {
                        return ` · ${left} left`;
                      }
                      return null;
                    })()}
                  </h3>
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

              {/* Process rows only for tools/subagents; sister-only → status line */}
              {(b.busy || Boolean(b.statusMsg) || Boolean(b.activityPhase)) && (
                <AgentActivityStrip
                  showProcess={hasExternalProcess(
                    b.messages,
                    b.activityPhase,
                    b.statusMsg,
                    b.activitySubagentModel
                  )}
                  outline={activityOutline(
                    b.messages,
                    b.tasks,
                    b.activitySubagentModel
                  )}
                  secondary={b.activitySubagentModel || null}
                  detail={activityDetail(
                    b.statusMsg,
                    b.activityPhase,
                    b.messages
                  )}
                  busy={b.busy}
                  statusForElapsed={(elapsed) =>
                    activityStatusLine(
                      b.activityPhase,
                      b.statusMsg,
                      b.messages,
                      b.busy,
                      elapsed
                    )
                  }
                />
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
                <IconArrowDown size={12} />
              </button>
            )}

            <div className="composer-dock">{composer}</div>
          </>
        )}
      </div>

      {/* Cursor-style right rail — hidden on New Agent / empty home / Customize */}
      {!showHome && !customizeOpen && (
      <aside
        className={`right-rail ${rightOpen ? "open" : "collapsed"}${
          railResizing ? " resizing" : ""
        }`}
        style={
          rightOpen
            ? { width: rightRailW, minWidth: rightRailW }
            : undefined
        }
      >
        {rightOpen && (
          <div
            className="right-rail-resizer"
            title="Drag to resize"
            onMouseDown={(e) => {
              e.preventDefault();
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
              setRailResizing(true);
              sidebarDrag.current = {
                startX: e.clientX,
                startW: rightRailW,
                edge: "right",
              };
            }}
          />
        )}
        <div className="right-rail-head">
          <span className="right-rail-title">
            On {folderName(b.cwd) || "workspace"}
          </span>
          <button
            type="button"
            className="right-rail-toggle"
            title={rightOpen ? "Collapse panel" : "Expand panel"}
            onClick={() => setRightOpen((v) => !v)}
          >
            <IconChevron
              size={14}
              className={rightOpen ? "chev-right" : "chev-left"}
            />
          </button>
        </div>
        <nav className="right-rail-nav">
          <button
            type="button"
            className={`right-rail-item ${rightTab === "changes" ? "active" : ""}`}
            onClick={() => openRightTab("changes")}
          >
            <IconDiff size={15} />
            <span className="right-rail-label">Changes</span>
            {(diffStats.add > 0 || diffStats.del > 0) && (
              <span className="right-rail-stats">
                <span className="add">+{diffStats.add}</span>
                <span className="del">−{diffStats.del}</span>
              </span>
            )}
          </button>
          <button
            type="button"
            className={`right-rail-item ${rightTab === "browser" ? "active" : ""}`}
            onClick={() => openRightTab("browser")}
          >
            <IconGlobe size={15} />
            <span className="right-rail-label">Browser</span>
          </button>
          <button
            type="button"
            className={`right-rail-item ${rightTab === "terminal" ? "active" : ""}`}
            onClick={() => openRightTab("terminal")}
          >
            <IconTerminal size={15} />
            <span className="right-rail-label">Terminal</span>
          </button>
          <button
            type="button"
            className={`right-rail-item ${rightTab === "files" ? "active" : ""}`}
            onClick={() => openRightTab("files")}
          >
            <IconFile size={15} />
            <span className="right-rail-label">Files</span>
          </button>
        </nav>
        {rightOpen && (
          <div className="right-rail-body">
            {rightTab === "changes" && (
              <>
                {b.diffs.length === 0 ? (
                  <div className="right-rail-empty">No pending changes</div>
                ) : (
                  <>
                    <div className="right-rail-actions">
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
                      <div className="right-diff-card" key={f.path}>
                        <header>
                          <span className="path" title={f.path}>
                            {f.path.split("/").pop() || f.path}
                          </span>
                          <span className="stats">
                            <span className="add">+{f.additions}</span>{" "}
                            <span className="del">−{f.deletions}</span>
                          </span>
                        </header>
                        {f.patch && (
                          <pre className="right-diff-patch">{f.patch}</pre>
                        )}
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
                  </>
                )}
              </>
            )}
            {rightTab === "browser" && (
              <AgentBrowserPanel
                active={rightOpen && rightTab === "browser"}
              />
            )}
            {rightTab === "terminal" &&
              (b.cwd ? (
                <TerminalPanel
                  cwd={b.cwd}
                  active={rightOpen && rightTab === "terminal"}
                />
              ) : (
                <div className="right-rail-empty">先选一个项目</div>
              ))}
            {rightTab === "files" && (
              <div className="right-rail-panel">
                {!b.cwd ? (
                  <div className="right-rail-empty">
                    Open a project to browse files
                  </div>
                ) : (
                  <>
                    <div className="fs-toolbar">
                      <button
                        type="button"
                        className="fs-nav"
                        disabled={fsRel === "." || fsLoading}
                        title="Parent folder"
                        onClick={() => {
                          if (fsRel === "." || !fsRel) return;
                          const parts = fsRel.split("/").filter(Boolean);
                          parts.pop();
                          setFsRel(parts.length ? parts.join("/") : ".");
                        }}
                      >
                        ↑
                      </button>
                      <span className="fs-crumb" title={fsRel}>
                        {fsRel === "." ? folderName(b.cwd) : fsRel}
                      </span>
                      <button
                        type="button"
                        className="fs-nav"
                        title="Reveal in Finder"
                        onClick={() => {
                          const abs =
                            fsRel === "."
                              ? b.cwd
                              : `${b.cwd.replace(/\/$/, "")}/${fsRel}`;
                          void revealInFinder(abs).catch(() => undefined);
                        }}
                      >
                        ↗
                      </button>
                    </div>
                    {fsError && (
                      <div className="right-rail-hint err">{fsError}</div>
                    )}
                    {fsLoading ? (
                      <div className="right-rail-empty">Loading…</div>
                    ) : fsEntries.length === 0 ? (
                      <div className="right-rail-empty">Empty folder</div>
                    ) : (
                      <ul className="fs-list">
                        {fsEntries.map((ent) => (
                          <li key={ent.path}>
                            <button
                              type="button"
                              className="fs-row"
                              onClick={() => {
                                if (ent.kind === "dir") {
                                  const rel =
                                    fsRel === "."
                                      ? ent.name
                                      : `${fsRel}/${ent.name}`;
                                  setFsRel(rel);
                                } else {
                                  void revealInFinder(ent.path).catch(
                                    () => undefined
                                  );
                                }
                              }}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                void revealInFinder(ent.path).catch(
                                  () => undefined
                                );
                              }}
                              title={
                                ent.kind === "dir"
                                  ? "Open folder"
                                  : "Reveal in Finder"
                              }
                            >
                              {ent.kind === "dir" ? (
                                <IconFolder size={14} />
                              ) : (
                                <IconFile size={14} />
                              )}
                              <span className="fs-name">{ent.name}</span>
                              {ent.kind === "file" && ent.size != null && (
                                <span className="fs-size">
                                  {ent.size < 1024
                                    ? `${ent.size} B`
                                    : ent.size < 1024 * 1024
                                      ? `${(ent.size / 1024).toFixed(1)} KB`
                                      : `${(ent.size / (1024 * 1024)).toFixed(1)} MB`}
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </aside>
      )}

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
              {respMenuTarget?.canMutate && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const idx = respMenuTarget.messageIndex;
                      setRespMenuOpen(false);
                      setRespMenuTarget(null);
                      b.retryAt(idx);
                    }}
                  >
                    <IconRefresh size={14} /> Retry
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const idx = respMenuTarget.messageIndex;
                      setRespMenuOpen(false);
                      setRespMenuTarget(null);
                      b.undoAt(idx);
                    }}
                  >
                    <IconUndo size={14} /> Undo
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const idx = respMenuTarget.messageIndex;
                      setRespMenuOpen(false);
                      setRespMenuTarget(null);
                      b.editAt(idx);
                      requestAnimationFrame(() => taRef.current?.focus());
                    }}
                  >
                    <IconPencil size={14} /> Edit
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const idx = respMenuTarget.messageIndex;
                      const sid = b.sessionId;
                      setRespMenuOpen(false);
                      setRespMenuTarget(null);
                      if (!sid) {
                        b.setError("No session to fork");
                        return;
                      }
                      const turn = userTurnIndexAt(b.messages, idx);
                      if (turn < 0) {
                        b.setError("Nothing to fork");
                        return;
                      }
                      void (async () => {
                        try {
                          const meta = await forkSessionApi(sid, {
                            throughUserTurn: turn,
                          });
                          await refreshLists(true);
                          await openHist(meta.sessionId, meta.cwd);
                          setStatusLocal("Forked");
                        } catch (e) {
                          b.setError(
                            e instanceof Error ? e.message : String(e)
                          );
                        }
                      })();
                    }}
                  >
                    <IconFork size={14} /> Fork
                  </button>
                </>
              )}
            </div>
          </>,
          document.body
        )}

      {attachPreview &&
        createPortal(
          <div
            className="attach-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={attachPreview.name}
            tabIndex={-1}
            ref={(n) => n?.focus()}
            onClick={() => setAttachPreview(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setAttachPreview(null);
            }}
          >
            <img
              className="attach-lightbox-img"
              src={localFileUrl(attachPreview.path)}
              alt={attachPreview.name}
              draggable={false}
              onClick={(e) => e.stopPropagation()}
            />
            <div className="attach-lightbox-cap">{attachPreview.name}</div>
          </div>,
          document.body
        )}

      {b.notice &&
        createPortal(
          <>
            <div
              className="menu-backdrop"
              onClick={() => b.clearNotice()}
              onKeyDown={() => undefined}
            />
            <div className="notice-panel" role="dialog" aria-label={b.notice.title}>
              <div className="notice-panel-head">
                <span>{b.notice.title}</span>
                <button
                  type="button"
                  className="context-usage-close"
                  aria-label="Close"
                  onClick={() => b.clearNotice()}
                >
                  ×
                </button>
              </div>
              <div className="notice-panel-body assistant-text">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                >
                  {b.notice.body}
                </ReactMarkdown>
              </div>
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
                    if (!b.cwd.trim()) {
                      closePlus();
                      openWorkspacePicker();
                      setStatusLocal("Pick a project folder first");
                      return;
                    }
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
                  className={b.agentMode === "debug" ? "active" : ""}
                  onClick={() => {
                    setMode("debug");
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
                  {b.agentMode === "debug" && (
                    <span className="plus-check">✓</span>
                  )}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={b.agentMode === "multitask" ? "active" : ""}
                  onClick={() => {
                    closePlus();
                    if (!b.cwd.trim()) {
                      openWorkspacePicker();
                      setStatusLocal("Pick a project folder for the new agent");
                      return;
                    }
                    setMode("multitask");
                    setInput("");
                    setAttachments([]);
                    b.createSession();
                    requestAnimationFrame(() => taRef.current?.focus());
                  }}
                >
                  <IconLayers size={14} /> Multitask
                  {b.agentMode === "multitask" && (
                    <span className="plus-check">✓</span>
                  )}
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
                  <IconAsk size={14} /> Ask
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
