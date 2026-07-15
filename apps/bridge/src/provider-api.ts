import type { ContextRef, DomainEvent } from "@agent-pane/shared";

export interface AgentProvider {
  readonly id: string;
  start(opts: {
    cwd: string;
    model?: string;
    effort?: string;
    permissionMode?: string;
  }): Promise<{ providerSessionId: string }>;
  stop(): Promise<void>;
  sendPrompt(input: {
    sessionId: string;
    text: string;
    attachments?: ContextRef[];
  }): Promise<void>;
  cancel(_sessionId: string): Promise<void>;
  /** Undo last user turn. Returns restored user text. */
  undoLastTurn(): Promise<{
    restoredText: string;
    providerOk: boolean;
    note?: string;
  }>;
  /**
   * Discard user turn `userTurnIndex` (0-based) and everything after.
   * Claude Code Undo / Retry / Edit target.
   */
  rewindToUserTurn(userTurnIndex: number): Promise<{
    restoredText: string;
    userTurnIndex: number;
    providerOk: boolean;
    note?: string;
  }>;
  /** Rebuild local turn list from persisted UserMessageAppended events. */
  hydrateUserTurns(texts: string[]): void;
  respondPermission(requestId: string, allow: boolean): Promise<void>;
  onEvent(handler: (e: DomainEvent) => void): void;
}
