import type { ContextRef, DomainEvent } from "@agent-pane/shared";

export interface AgentProvider {
  readonly id: string;
  start(opts: {
    cwd: string;
    model?: string;
    permissionMode?: string;
  }): Promise<{ providerSessionId: string }>;
  stop(): Promise<void>;
  sendPrompt(input: {
    sessionId: string;
    text: string;
    attachments?: ContextRef[];
  }): Promise<void>;
  cancel(_sessionId: string): Promise<void>;
  respondPermission(requestId: string, allow: boolean): Promise<void>;
  onEvent(handler: (e: DomainEvent) => void): void;
}
