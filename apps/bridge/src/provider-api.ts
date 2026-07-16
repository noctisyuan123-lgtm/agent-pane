import type { ContextRef, DomainEvent } from "@agent-pane/shared";

/**
 * Agent runtime boundary (Host ↔ Core adapter).
 *
 * - UI / SessionManager talk only to this surface for agent lifecycle.
 * - Grok-specific packaging (PATH, signals.json, _x.ai/*) stays inside impls.
 * - Undo/rewind product semantics are Host-owned; provider assist is best-effort.
 *
 * @see docs/superpowers/specs/2026-07-16-phase0-session-id-provider.md
 */
export type AgentStartOpts = {
  cwd: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** Pane conversation id — reuse on resume so history stays one thread. */
  domainSessionId?: string;
  /** Previous provider handle for bookkeeping only (resume still session/new). */
  providerSessionId?: string;
  resumed?: boolean;
};

export type AgentStartResult = {
  providerSessionId: string;
  domainSessionId: string;
  resumed?: boolean;
  cwd: string;
  model?: string;
  effort?: string;
  needsHistoryDigest?: boolean;
};

export type AgentSendPromptInput = {
  sessionId: string;
  text: string;
  attachments?: ContextRef[];
  /** Shown in UI history when model text differs (e.g. plan preamble stripped). */
  displayText?: string;
  /** Skip UserMessageAppended when Host already recorded the turn. */
  skipUserEvent?: boolean;
};

export type AgentRewindResult = {
  restoredText: string;
  userTurnIndex: number;
  providerOk: boolean;
  note?: string;
};

export type AgentBillingUsage = {
  creditUsagePercent?: number;
  periodType?: string;
  periodStart?: string;
  periodEnd?: string;
  subscriptionTier?: string;
  onDemandCap?: number;
  onDemandUsed?: number;
  prepaidBalance?: number;
  raw: unknown;
};

export interface AgentProvider {
  readonly id: string;

  start(opts: AgentStartOpts): Promise<AgentStartResult>;
  stop(): Promise<void>;
  sendPrompt(input: AgentSendPromptInput): Promise<void>;
  cancel(sessionId: string): Promise<void>;

  /**
   * Best-effort provider rewind. Host always truncates Pane event log on SessionRewound.
   * Implementations may set providerOk:false when Core cannot rewind.
   */
  undoLastTurn(): Promise<{
    restoredText: string;
    providerOk: boolean;
    note?: string;
  }>;
  rewindToUserTurn(userTurnIndex: number): Promise<AgentRewindResult>;

  /**
   * Host pushes UserMessageAppended texts so provider turn indices match Pane log
   * (required after resume when adapter state is empty).
   */
  hydrateUserTurns(texts: string[]): void;

  respondPermission(requestId: string, allow: boolean): Promise<void>;
  onEvent(handler: (e: DomainEvent) => void): void;

  // ── Host contract (required for multi-live SessionManager) ──────────
  isAlive(): boolean;
  onDead(handler: (domainSessionId: string) => void): void;
  hasPendingPermission(requestId: string): boolean;
  /** Resume digest preamble for next session/prompt after session/new. */
  setContextPrefix(text: string | null): void;

  // ── Optional capabilities (Grok packaging; other providers may no-op) ─
  /** Push context ring from ~/.grok/.../signals.json once. */
  publishSignalsUsageOnce?(): boolean;
  /** Grok TUI `/usage` via extension RPC. */
  fetchBillingUsage?(): Promise<AgentBillingUsage>;
}

/** Factory for the default CLI ACP provider (keeps Host free of `new GrokAcpAdapter`). */
export async function createGrokAcpProvider(opts?: {
  grokBin?: string;
  autoApprove?: boolean;
}): Promise<AgentProvider> {
  const { GrokAcpAdapter } = await import("./grok-acp-adapter.js");
  return new GrokAcpAdapter(opts);
}
