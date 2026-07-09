import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ContextRef, DomainEvent } from "@agent-pane/shared";
import { nowIso } from "@agent-pane/shared";
import type { AgentProvider } from "./provider-api.js";

type JsonRpcMsg = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

/**
 * Grok ACP adapter — only place that speaks ACP.
 * CRITICAL: when we advertise fs/terminal capabilities, we MUST answer
 * agent→client requests (fs/read_text_file, session/request_permission, …)
 * or the tool loop hangs forever.
 */
export class GrokAcpAdapter implements AgentProvider {
  readonly id = "grok-acp";
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private handlers: Array<(e: DomainEvent) => void> = [];
  private domainSessionId = "";
  private providerSessionId = "";
  private cwd = ".";
  private model?: string;
  private grokBin: string;
  private closed = false;
  private autoApprove: boolean;
  private pendingPermissions = new Map<
    string,
    { rpcId: number | string; options: Array<{ optionId: string; kind?: string }> }
  >();
  /** 本会话用户消息，用于撤回 */
  private userTurns: string[] = [];

  constructor(opts?: { grokBin?: string; autoApprove?: boolean }) {
    this.grokBin =
      opts?.grokBin ??
      process.env.GROK_BIN ??
      `${process.env.HOME}/.grok/bin/grok`;
    this.autoApprove =
      opts?.autoApprove ??
      process.env.AGENT_PANE_PERMISSION !== "ask";
  }

  onEvent(handler: (e: DomainEvent) => void): void {
    this.handlers.push(handler);
  }

  private emit(event: DomainEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (e) {
        console.error("[adapter] handler error", e);
      }
    }
  }

  private write(obj: unknown): void {
    if (!this.proc?.stdin) return;
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  private send(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc?.stdin) return Promise.reject(new Error("Agent not started"));
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private reply(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private replyError(id: number | string, message: string, code = -32000): void {
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
  }

  private handleLine(line: string): void {
    let msg: JsonRpcMsg;
    try {
      msg = JSON.parse(line) as JsonRpcMsg;
    } catch {
      return;
    }

    // Client←Agent response to our request
    if (msg.id != null && msg.method == null) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }

    // Agent→Client request (must reply) or notification
    if (msg.method) {
      if (msg.id != null) {
        void this.handleServerRequest(msg.id, msg.method, msg.params);
      } else {
        this.handleNotification(msg.method, msg.params);
      }
    }
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown
  ): Promise<void> {
    const p = (params ?? {}) as Record<string, unknown>;

    try {
      if (method === "fs/read_text_file") {
        const filePath = String(p.path ?? "");
        const content = this.readTextFile(
          filePath,
          p.line as number | undefined,
          p.limit as number | undefined
        );
        this.reply(id, { content });
        return;
      }

      if (method === "fs/write_text_file") {
        const filePath = String(p.path ?? "");
        const content = String(p.content ?? "");
        this.writeTextFile(filePath, content);
        this.reply(id, null);
        this.emit({
          type: "ToolProgress",
          sessionId: this.domainSessionId,
          toolId: "fs-write",
          detail: `wrote ${filePath}`,
          at: nowIso(),
        });
        return;
      }

      if (
        method === "session/request_permission" ||
        method.endsWith("/request_permission")
      ) {
        const options = (p.options as Array<{ optionId: string; kind?: string }>) ?? [];
        const toolCall = (p.toolCall ?? {}) as Record<string, unknown>;
        const tool = String(
          toolCall.title ?? toolCall.kind ?? p.tool ?? "tool"
        );
        const requestId = String(
          toolCall.toolCallId ?? p.requestId ?? id ?? randomUUID()
        );

        this.emit({
          type: "PermissionRequested",
          sessionId: this.domainSessionId,
          requestId,
          tool,
          summary: JSON.stringify(p).slice(0, 500),
          at: nowIso(),
        });

        if (this.autoApprove) {
          const optionId =
            options.find((o) => o.kind === "allow_always")?.optionId ??
            options.find((o) => o.kind === "allow_once")?.optionId ??
            options[0]?.optionId ??
            "allow-once";
          this.reply(id, {
            outcome: { outcome: "selected", optionId },
          });
          this.emit({
            type: "PermissionResolved",
            sessionId: this.domainSessionId,
            requestId,
            allow: true,
            at: nowIso(),
          });
        } else {
          this.pendingPermissions.set(requestId, { rpcId: id, options });
        }
        return;
      }

      // Unknown server request — don't hang the agent
      console.warn("[adapter] unhandled server request", method);
      this.replyError(id, `Unsupported method: ${method}`, -32601);
    } catch (e) {
      this.replyError(
        id,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  private readTextFile(
    filePath: string,
    line?: number,
    limit?: number
  ): string {
    if (!filePath) throw new Error("path required");
    // basic path safety: must exist
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }
    let text = fs.readFileSync(resolved, "utf8");
    if (line != null || limit != null) {
      const lines = text.split("\n");
      const start = Math.max(0, (line ?? 1) - 1);
      const end =
        limit != null ? start + limit : lines.length;
      text = lines.slice(start, end).join("\n");
    }
    // cap huge files
    if (text.length > 2_000_000) {
      text = text.slice(0, 2_000_000) + "\n/* truncated */";
    }
    return text;
  }

  private writeTextFile(filePath: string, content: string): void {
    if (!filePath) throw new Error("path required");
    const resolved = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
  }

  private handleNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;

    if (method === "session/update") {
      const update = (p.update ?? p) as Record<string, unknown>;
      this.mapSessionUpdate(update);
      return;
    }

    // xAI extension notifications — log tool deltas into timeline
    if (method === "_x.ai/session_notification" || method === "x.ai/session_notification") {
      const update = (p.update ?? p) as Record<string, unknown>;
      const kind = String(update.sessionUpdate ?? "");
      if (kind === "tool_call_delta_chunk") {
        const toolId = String(update.tool_call_id ?? update.toolCallId ?? "delta");
        const name = String(update.name ?? "");
        const argDelta = update.arguments_delta;
        if (name) {
          this.emit({
            type: "ToolProgress",
            sessionId: this.domainSessionId,
            toolId,
            detail: name + (argDelta ? ` ${String(argDelta).slice(0, 120)}` : ""),
            at: nowIso(),
          });
        }
      } else if (kind === "pending_interaction") {
        this.emit({
          type: "ToolProgress",
          sessionId: this.domainSessionId,
          toolId: String(update.tool_call_id ?? "interaction"),
          detail: `pending: ${update.kind ?? "interaction"}`,
          at: nowIso(),
        });
      }
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
        const title = String(update.title ?? update.kind ?? "tool");
        const toolKind = String(update.kind ?? "other");
        this.emit({
          type: "ToolStarted",
          sessionId: sid,
          toolId,
          title,
          kind: toolKind,
          inputSummary: summarize(update.rawInput ?? update.input ?? update.arguments),
          at,
        });
        break;
      }
      case "tool_call_update": {
        const toolId = String(update.toolCallId ?? update.id ?? "unknown");
        const status = String(update.status ?? "").toLowerCase();
        const title = update.title != null ? String(update.title) : undefined;
        const detail =
          summarize(update.content ?? update.rawOutput ?? update.output) ||
          title ||
          summarize(update);

        if (status === "failed" || status === "error") {
          this.emit({
            type: "ToolFailed",
            sessionId: sid,
            toolId,
            error: detail || "failed",
            at,
          });
        } else if (status === "completed" || status === "success") {
          this.emit({
            type: "ToolFinished",
            sessionId: sid,
            toolId,
            outputSummary: detail,
            at,
          });
        } else {
          // pending / in_progress / missing status
          this.emit({
            type: "ToolProgress",
            sessionId: sid,
            toolId,
            detail: detail || title,
            at,
          });
          // If update carries a nicer title, re-emit as progress label
          if (title && !status) {
            // some streams only send kind+title without status then complete later
          }
        }
        break;
      }
      case "plan": {
        const entries = (update.entries ??
          update.tasks ??
          update.plan ??
          []) as Array<{
          id?: string;
          content?: string;
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
    if (opts.permissionMode === "default" || opts.permissionMode === "ask") {
      this.autoApprove = false;
    } else {
      this.autoApprove = true;
    }

    const agentArgs = ["agent"];
    if (opts.model) agentArgs.push("--model", opts.model);
    if (this.autoApprove) agentArgs.push("--always-approve");
    agentArgs.push("stdio");

    this.proc = spawn(this.grokBin, agentArgs, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.proc.stderr?.on("data", (buf: Buffer) => {
      if (process.env.AGENT_PANE_DEBUG) {
        console.error("[grok stderr]", buf.toString().slice(0, 500));
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
        // Don't claim terminal until we implement terminal/* RPC
      },
      clientInfo: { name: "agent-pane", version: "0.1.1" },
    });

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

    this.userTurns.push(input.text);
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
      /* optional */
    }
  }

  /**
   * 撤回上一条用户消息：
   * 1) 取消进行中的 turn
   * 2) 尽力调用 Grok `_x.ai/rewind/*`
   * 3) 无论 provider 是否成功，都发出 SessionRewound 让 UI 回滚
   */
  async undoLastTurn(): Promise<{
    restoredText: string;
    providerOk: boolean;
    note?: string;
  }> {
    if (this.userTurns.length === 0) {
      throw new Error("没有可撤回的消息");
    }

    await this.cancel(this.domainSessionId);

    const restoredText = this.userTurns[this.userTurns.length - 1]!;
    let providerOk = false;
    let note: string | undefined;

    try {
      // Grok 扩展方法用 _x.ai/ 前缀（无下划线的 x.ai/ 会 Method not found）
      const pts = (await this.send("_x.ai/rewind/points", {
        sessionId: this.providerSessionId,
      })) as { rewind_points?: Array<{ prompt_index: number; prompt_preview?: string }> };

      const points = pts?.rewind_points ?? [];
      if (points.length === 0) {
        note = "Grok 侧暂无 rewind 点，仅界面已撤回";
      } else {
        const last = points[points.length - 1]!;
        const target = last.prompt_index;
        // conversation_only：尽量只撤对话；执行失败时仍做 UI 撤回
        const result = (await this.send("_x.ai/rewind/execute", {
          sessionId: this.providerSessionId,
          target_prompt_index: target,
          mode: "conversation_only",
        })) as {
          success?: boolean;
          prompt_text?: string | null;
          error?: string | null;
        };

        if (result?.success) {
          providerOk = true;
          note = "已同步撤回 Grok 会话上下文";
        } else {
          note =
            "界面已撤回；Grok rewind 未确认成功，若模型仍提上条内容请新开会话或再说「忽略上一条」";
          // 再试 all 模式（部分版本 success 标志不可靠）
          try {
            await this.send("_x.ai/rewind/execute", {
              sessionId: this.providerSessionId,
              target_prompt_index: target,
              mode: "all",
            });
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      note = `界面已撤回；Grok rewind 调用失败：${
        e instanceof Error ? e.message : String(e)
      }`;
    }

    this.userTurns.pop();

    this.emit({
      type: "SessionRewound",
      sessionId: this.domainSessionId,
      restoredText,
      providerOk,
      note,
      at: nowIso(),
    });

    return { restoredText, providerOk, note };
  }

  async respondPermission(requestId: string, allow: boolean): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    this.emit({
      type: "PermissionResolved",
      sessionId: this.domainSessionId,
      requestId,
      allow,
      at: nowIso(),
    });
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    const optionId = allow
      ? pending.options.find((o) => o.kind === "allow_once")?.optionId ??
        pending.options.find((o) => o.kind?.startsWith("allow"))?.optionId ??
        "allow-once"
      : pending.options.find((o) => o.kind === "reject_once")?.optionId ??
        pending.options.find((o) => o.kind?.startsWith("reject"))?.optionId ??
        "reject-once";
    this.reply(pending.rpcId, {
      outcome: allow
        ? { outcome: "selected", optionId }
        : { outcome: "selected", optionId },
    });
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
