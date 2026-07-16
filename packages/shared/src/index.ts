/** Domain events — provider-agnostic. React only consumes these. */

export type ContextRef = {
  path: string;
  kind: "file" | "folder";
};

export type Task = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  source?: "plan" | "workflow" | "checklist" | "other";
};

export type DiffFileMeta = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "unknown";
  additions: number;
  deletions: number;
  /** unified patch text for Monaco / preview */
  patch?: string;
  beforePath?: string;
  afterPath?: string;
};

export type DomainEventBase = {
  seq?: number;
  sessionId: string;
  at: string;
};

export type DomainEvent =
  | (DomainEventBase & {
      type: "SessionStarted";
      cwd: string;
      model?: string;
      /** Re-attached to an existing history session — UI must not wipe messages */
      resumed?: boolean;
      providerSessionId?: string;
      /** Echo of session.create clientRequestId for parallel-create correlation */
      clientRequestId?: string;
    })
  | (DomainEventBase & { type: "SessionEnded"; stopReason: string })
  | (DomainEventBase & { type: "SessionError"; message: string })
  | (DomainEventBase & {
      type: "UserMessageAppended";
      text: string;
      attachments?: ContextRef[];
    })
  | (DomainEventBase & {
      type: "MessageChunk";
      role: "assistant";
      text: string;
    })
  | (DomainEventBase & { type: "ThoughtChunk"; text: string })
  | (DomainEventBase & { type: "MessageDone"; role: "assistant" })
  | (DomainEventBase & {
      type: "ToolStarted";
      toolId: string;
      title: string;
      kind: string;
      inputSummary?: string;
    })
  | (DomainEventBase & {
      type: "ToolProgress";
      toolId: string;
      detail?: string;
    })
  | (DomainEventBase & {
      type: "ToolFinished";
      toolId: string;
      outputSummary?: string;
    })
  | (DomainEventBase & {
      type: "ToolFailed";
      toolId: string;
      error: string;
    })
  | (DomainEventBase & { type: "TaskUpserted"; task: Task })
  | (DomainEventBase & { type: "TaskRemoved"; taskId: string })
  | (DomainEventBase & { type: "TasksReplaced"; tasks: Task[] })
  | (DomainEventBase & {
      type: "PermissionRequested";
      requestId: string;
      tool: string;
      summary: string;
    })
  | (DomainEventBase & {
      type: "PermissionResolved";
      requestId: string;
      allow: boolean;
    })
  | (DomainEventBase & { type: "DiffProposed"; files: DiffFileMeta[] })
  | (DomainEventBase & {
      type: "DiffResolved";
      filePath: string | "*";
      action: "accept" | "reject";
    })
  | (DomainEventBase & { type: "SnapshotTaken"; snapshotId: string })
  | (DomainEventBase & { type: "SnapshotRestored"; snapshotId: string })
  /**
   * Conversation rewound: discard user turn `userTurnIndex` and everything after.
   * UI keeps chat items before that user bubble.
   */
  | (DomainEventBase & {
      type: "SessionRewound";
      restoredText: string;
      /** 0-based user turn that was removed (and all later turns) */
      userTurnIndex: number;
      /** Grok 侧 rewind 是否成功 */
      providerOk: boolean;
      note?: string;
    })
  /**
   * Live activity strip (Grok TUI-style: "Compacting…", "Waiting for model…",
   * "Running sleep 2…"). Not a chat bubble — ephemeral status under the thread.
   */
  | (DomainEventBase & {
      type: "AgentActivity";
      /** null / empty clears the strip */
      text: string | null;
      /** coarse phase for UI styling */
      phase?:
        | "idle"
        | "working"
        | "thinking"
        | "tool"
        | "permission"
        | "compact"
        | "queue"
        | "sleeping"
        | "error";
      /** When a subagent is running — shown muted on the process outline line */
      subagentModel?: string;
      /** Optional agent kind; "subagent" + model also drives the outline chip */
      agentKind?: "main" | "subagent";
      model?: string;
    })
  /**
   * Agent-reported context window fill (ACP `usage_update` or Grok compact).
   * Aggregate only — providers rarely expose Cursor-style per-bucket splits.
   */
  | (DomainEventBase & {
      type: "ContextUsage";
      /** Tokens currently in the model context */
      used: number;
      /** Effective context window size */
      size: number;
      /** Where the numbers came from */
      source:
        | "acp"
        | "compact"
        | "compact_done"
        | "signals"
        | "session_info";
      /** Optional precomputed % from Grok */
      pct?: number;
      /** Grok ACP session id these numbers belong to */
      providerSessionId?: string;
    });

/**
 * Composer UI modes (Cursor-style chips).
 * Bridge permission: plan→plan, auto→ask, others→agent.
 */
export type AgentMode = "agent" | "auto" | "plan" | "debug" | "multitask";

/** Grok `--reasoning-effort` / `--effort` levels we expose in UI */
export type ReasoningEffort = "low" | "medium" | "high";

export type ClientCommand =
  | {
      type: "session.create";
      cwd: string;
      model?: string;
      /** Grok reasoning effort (`--effort`) */
      effort?: ReasoningEffort | string;
      /** agent=always-approve · auto=default · plan=no edits */
      permissionMode?: AgentMode | string;
      /** Correlate SessionStarted when multiple creates run in parallel */
      clientRequestId?: string;
    }
  | {
      /** Re-attach live agent to an existing history session (same id) */
      type: "session.resume";
      sessionId: string;
      cwd: string;
      model?: string;
      effort?: ReasoningEffort | string;
      permissionMode?: AgentMode | string;
    }
  | {
      type: "session.prompt";
      sessionId: string;
      text: string;
      attachments?: ContextRef[];
      /** Update live permission for this turn (plan / ask / agent) */
      permissionMode?: AgentMode | string;
    }
  | { type: "session.cancel"; sessionId: string }
  | { type: "session.replay"; sessionId: string; fromSeq?: number }
  /** 撤回最近一条用户消息（停生成 + UI/尽力 rewind provider） */
  | { type: "session.undoLast"; sessionId: string }
  /**
   * Rewind to before user turn `userTurnIndex` (0-based).
   * Removes that user message and everything after (Claude Code Undo/Retry/Edit).
   */
  | { type: "session.rewindTo"; sessionId: string; userTurnIndex: number }
  | {
      type: "permission.respond";
      requestId: string;
      allow: boolean;
      /** Prefer routing to this live session when multiple agents run */
      sessionId?: string;
    }
  | { type: "diff.accept"; sessionId: string; filePath: string | "*" }
  | { type: "diff.reject"; sessionId: string; filePath: string | "*" }
  | { type: "diff.refresh"; sessionId: string };

export type ServerMessage =
  | { type: "hello"; version: string }
  | { type: "event"; event: DomainEvent }
  | { type: "replay"; sessionId: string; events: DomainEvent[] }
  | { type: "error"; message: string; sessionId?: string; clientRequestId?: string }
  | { type: "status"; message: string; sessionId?: string; clientRequestId?: string }
  /** Ephemeral UI panel — not persisted into chat / model context */
  | {
      type: "notice";
      kind: "usage" | "info";
      title: string;
      /** Markdown body */
      body: string;
      sessionId?: string;
    }
  /** Which domain sessions currently have a live agent process */
  | { type: "live"; sessionIds: string[] };

export function nowIso(): string {
  return new Date().toISOString();
}
