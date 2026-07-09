import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { ContextRef, DomainEvent } from "@agent-pane/shared";
import { nowIso } from "@agent-pane/shared";
import type { AgentProvider } from "./provider-api.js";

type JsonRpc =
  | { jsonrpc: "2.0"; id: number; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: number; result?: unknown; error?: unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown };

/**
 * Grok ACP adapter — only place that speaks ACP.
 * Emits provider-agnostic DomainEvents via onEvent.
 */
export class GrokAcpAdapter implements AgentProvider {
  readonly id = "grok-acp";
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private handlers: Array<(e: DomainEvent) => void> = [];
  private domainSessionId = "";
  private providerSessionId = "";
  private cwd = ".";
  private model?: string;
  private grokBin: string;
  private closed = false;
  private permissionWaiters = new Map<
    string,
    { resolve: (allow: boolean) => void }
  >();

  constructor(grokBin?: string) {
    this.grokBin =
      grokBin ??
      process.env.GROK_BIN ??
      `${process.env.HOME}/.grok/bin/grok`;
  }

  onEvent(handler: (e: DomainEvent) => void): void {
    this.handlers.push(handler);
  }

  private emit(event: DomainEvent): void {
    for (const h of this.handlers) h(event);
  }

  private send(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc?.stdin) return Promise.reject(new Error("Agent not started"));
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private handleLine(line: string): void {
    let msg: JsonRpc;
    try {
      msg = JSON.parse(line) as JsonRpc;
    } catch {
      return;
    }

    if ("id" in msg && msg.id != null && (msg as { result?: unknown }).result !== undefined) {
      const p = this.pending.get(msg.id as number);
      if (p) {
        this.pending.delete(msg.id as number);
        p.resolve((msg as { result: unknown }).result);
      }
      return;
    }
    if ("id" in msg && msg.id != null && (msg as { error?: unknown }).error) {
      const p = this.pending.get(msg.id as number);
      if (p) {
        this.pending.delete(msg.id as number);
        p.reject(new Error(JSON.stringify((msg as { error: unknown }).error)));
      }
      return;
    }

    if ("method" in msg && msg.method) {
      this.handleNotification(msg.method, (msg as { params?: unknown }).params);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const p = params as Record<string, unknown>;

    // Permission requests — shape may vary; handle common ACP forms
    if (
      method === "session/request_permission" ||
      method === "request_permission" ||
      method.endsWith("/request_permission")
    ) {
      const requestId = String(p?.requestId ?? p?.id ?? randomUUID());
      const tool = String(
        (p?.toolCall as { title?: string })?.title ??
          p?.tool ??
          p?.title ??
          "tool"
      );
      const summary = JSON.stringify(p).slice(0, 500);
      this.emit({
        type: "PermissionRequested",
        sessionId: this.domainSessionId,
        requestId,
        tool,
        summary,
        at: nowIso(),
      });
      // auto-resolve via waiter when UI responds — store for respondPermission
      this.permissionWaiters.set(requestId, {
        resolve: () => {},
      });
      // Try to reply if protocol expects immediate response with id
      return;
    }

    if (method === "session/update") {
      const update = (p?.update ?? p) as Record<string, unknown>;
      this.mapSessionUpdate(update);
    }
  }

  private mapSessionUpdate(update: Record<string, unknown>): void {
    const kind = String(update.sessionUpdate ?? update.type ?? "");
    const sid = this.domainSessionId;
    const at = nowIso();

    switch (kind) {
      case "agent_message_chunk": {
        const content = update.content as { text?: string } | undefined;
        const text = content?.text ?? (update.text as string) ?? "";
        if (text) {
          this.emit({
            type: "MessageChunk",
            sessionId: sid,
            role: "assistant",
            text,
            at,
          });
        }
        break;
      }
      case "agent_thought_chunk": {
        const content = update.content as { text?: string } | undefined;
        const text = content?.text ?? (update.text as string) ?? "";
        if (text) {
          this.emit({ type: "ThoughtChunk", sessionId: sid, text, at });
        }
        break;
      }
      case "tool_call": {
        const toolId = String(update.toolCallId ?? update.id ?? randomUUID());
        this.emit({
          type: "ToolStarted",
          sessionId: sid,
          toolId,
          title: String(update.title ?? update.kind ?? "tool"),
          kind: String(update.kind ?? "other"),
          inputSummary: summarize(update.rawInput ?? update.input ?? update.arguments),
          at,
        });
        break;
      }
      case "tool_call_update": {
        const toolId = String(update.toolCallId ?? update.id ?? "unknown");
        const status = String(update.status ?? "");
        if (status === "failed" || status === "error") {
          this.emit({
            type: "ToolFailed",
            sessionId: sid,
            toolId,
            error: summarize(update.error ?? update.content ?? update),
            at,
          });
        } else if (status === "completed" || status === "success") {
          this.emit({
            type: "ToolFinished",
            sessionId: sid,
            toolId,
            outputSummary: summarize(update.content ?? update.rawOutput ?? update.output),
            at,
          });
        } else {
          this.emit({
            type: "ToolProgress",
            sessionId: sid,
            toolId,
            detail: summarize(update),
            at,
          });
        }
        break;
      }
      case "plan": {
        const entries = (update.entries ?? update.tasks ?? update.plan ?? []) as Array<{
          id?: string;
          content?: string;
          priority?: string;
          status?: string;
        }>;
        const tasks = entries.map((e, i) => ({
          id: e.id ?? `task-${i}`,
          content: e.content ?? String(e),
          status: mapTaskStatus(e.status),
          source: "plan" as const,
        }));
        this.emit({ type: "TasksReplaced", sessionId: sid, tasks, at });
        break;
      }
      default:
        break;
    }
  }

  async start(opts: {
    cwd: string;
    model?: string;
    permissionMode?: string;
  }): Promise<{ providerSessionId: string }> {
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.closed = false;
    this.domainSessionId = randomUUID();

    // grok agent [--model] [--always-approve] stdio
    const agentArgs = ["agent"];
    if (opts.model) agentArgs.push("--model", opts.model);
    if (opts.permissionMode === "bypassPermissions" || opts.permissionMode === "auto") {
      agentArgs.push("--always-approve");
    }
    agentArgs.push("stdio");

    this.proc = spawn(this.grokBin, agentArgs, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.proc.stderr?.on("data", (buf: Buffer) => {
      const s = buf.toString();
      if (process.env.AGENT_PANE_DEBUG) {
        console.error("[grok stderr]", s.slice(0, 500));
      }
    });

    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => this.handleLine(line));

    this.proc.on("exit", (code) => {
      if (!this.closed) {
        this.emit({
          type: "SessionError",
          sessionId: this.domainSessionId,
          message: `grok agent exited (${code})`,
          at: nowIso(),
        });
      }
    });

    await this.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "agent-pane", version: "0.1.0" },
    });

    // Some agents require authenticated session; try session/new
    const result = (await this.send("session/new", {
      cwd: opts.cwd,
      mcpServers: [],
    })) as { sessionId?: string };

    this.providerSessionId = result.sessionId ?? randomUUID();

    this.emit({
      type: "SessionStarted",
      sessionId: this.domainSessionId,
      cwd: opts.cwd,
      model: opts.model,
      at: nowIso(),
    });

    return { providerSessionId: this.providerSessionId };
  }

  /** Domain session id used in events */
  getSessionId(): string {
    return this.domainSessionId;
  }

  async sendPrompt(input: {
    sessionId: string;
    text: string;
    attachments?: ContextRef[];
  }): Promise<void> {
    const blocks: Array<Record<string, unknown>> = [
      { type: "text", text: input.text },
    ];
    if (input.attachments?.length) {
      for (const a of input.attachments) {
        blocks.push({
          type: "resource_link",
          uri: `file://${a.path}`,
          name: a.path,
        });
      }
    }

    this.emit({
      type: "UserMessageAppended",
      sessionId: this.domainSessionId,
      text: input.text,
      attachments: input.attachments,
      at: nowIso(),
    });

    try {
      await this.send("session/prompt", {
        sessionId: this.providerSessionId,
        prompt: blocks,
      });
      this.emit({
        type: "MessageDone",
        sessionId: this.domainSessionId,
        role: "assistant",
        at: nowIso(),
      });
    } catch (e) {
      this.emit({
        type: "SessionError",
        sessionId: this.domainSessionId,
        message: e instanceof Error ? e.message : String(e),
        at: nowIso(),
      });
    }
  }

  async cancel(_sessionId: string): Promise<void> {
    try {
      await this.send("session/cancel", { sessionId: this.providerSessionId });
    } catch {
      /* optional method */
    }
  }

  async respondPermission(requestId: string, allow: boolean): Promise<void> {
    this.emit({
      type: "PermissionResolved",
      sessionId: this.domainSessionId,
      requestId,
      allow,
      at: nowIso(),
    });
    // ACP permission response shapes vary; try common ones
    try {
      await this.send("session/request_permission_response", {
        requestId,
        outcome: allow ? { outcome: "selected", optionId: "allow" } : { outcome: "cancelled" },
      });
    } catch {
      try {
        await this.send("session/allow", { requestId, allow });
      } catch {
        /* best effort */
      }
    }
    const w = this.permissionWaiters.get(requestId);
    w?.resolve(allow);
    this.permissionWaiters.delete(requestId);
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.rl?.close();
    this.proc?.kill();
    this.proc = null;
    if (this.domainSessionId) {
      this.emit({
        type: "SessionEnded",
        sessionId: this.domainSessionId,
        stopReason: "client_stop",
        at: nowIso(),
      });
    }
  }
}

function summarize(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.slice(0, 400);
  try {
    return JSON.stringify(v).slice(0, 400);
  } catch {
    return String(v).slice(0, 400);
  }
}

function mapTaskStatus(
  s?: string
): "pending" | "in_progress" | "completed" | "cancelled" {
  const x = (s ?? "pending").toLowerCase();
  if (x.includes("progress") || x === "active") return "in_progress";
  if (x.includes("complete") || x === "done") return "completed";
  if (x.includes("cancel")) return "cancelled";
  return "pending";
}
