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
  | (DomainEventBase & { type: "SessionStarted"; cwd: string; model?: string })
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
  /** 撤回上一条用户消息及其后的 agent 输出 */
  | (DomainEventBase & {
      type: "SessionRewound";
      restoredText: string;
      /** Grok 侧 rewind 是否成功 */
      providerOk: boolean;
      note?: string;
    });

export type ClientCommand =
  | { type: "session.create"; cwd: string; model?: string }
  | {
      type: "session.prompt";
      sessionId: string;
      text: string;
      attachments?: ContextRef[];
    }
  | { type: "session.cancel"; sessionId: string }
  | { type: "session.replay"; sessionId: string; fromSeq?: number }
  /** 撤回最近一条用户消息（停生成 + UI/尽力 rewind provider） */
  | { type: "session.undoLast"; sessionId: string }
  | { type: "permission.respond"; requestId: string; allow: boolean }
  | { type: "diff.accept"; sessionId: string; filePath: string | "*" }
  | { type: "diff.reject"; sessionId: string; filePath: string | "*" }
  | { type: "diff.refresh"; sessionId: string };

export type ServerMessage =
  | { type: "hello"; version: string }
  | { type: "event"; event: DomainEvent }
  | { type: "replay"; sessionId: string; events: DomainEvent[] }
  | { type: "error"; message: string };

export function nowIso(): string {
  return new Date().toISOString();
}
