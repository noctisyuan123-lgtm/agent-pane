import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ContextRef, DomainEvent } from "@agent-pane/shared";
import { nowIso } from "@agent-pane/shared";
import type { AgentProvider } from "./provider-api.js";

/** ACP terminal/* session state */
type AcpTerminal = {
  id: string;
  proc: ChildProcess;
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  exited: boolean;
  waiters: Array<() => void>;
  byteLimit: number;
};

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
  /** 当前 turn 是否已被用户取消（忽略后续 stream，直到下次 prompt） */
  private turnCancelled = false;
  private promptInFlight = false;
  /** Called when the child process dies unexpectedly (not after stop()). */
  private deadHandlers: Array<(domainSessionId: string) => void> = [];
  /**
   * While true, drop session/update notifications (session/load replays history
   * as updates — must not re-append into our event log / UI).
   */
  private absorbUpdates = false;
  /** If session/load fails, first prompt gets a short history preamble. */
  private contextPrefix: string | null = null;
  /** ACP terminal/create sessions */
  private terminals = new Map<string, AcpTerminal>();

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

  onDead(handler: (domainSessionId: string) => void): void {
    this.deadHandlers.push(handler);
  }

  /** Child still running and stdin open. */
  isAlive(): boolean {
    return Boolean(
      this.proc &&
        !this.closed &&
        this.proc.exitCode === null &&
        this.proc.killed !== true &&
        this.proc.stdin &&
        !this.proc.stdin.destroyed
    );
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

  private send(
    method: string,
    params?: unknown,
    timeoutMs = 120_000
  ): Promise<unknown> {
    // During start(), isAlive() may be strict; only require proc+stdin here
    if (!this.proc?.stdin || this.closed) {
      return Promise.reject(new Error("Agent not started"));
    }
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
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
        this.emitActivity(`Permission: ${tool}`, "permission");

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
          this.emitActivity(null);
        } else {
          this.pendingPermissions.set(requestId, { rpcId: id, options });
        }
        return;
      }

      // ── ACP terminal/* (required once we advertise terminal: true) ──
      if (method === "terminal/create") {
        const termId = this.createTerminal(p);
        this.reply(id, { terminalId: termId });
        return;
      }
      if (method === "terminal/output") {
        const term = this.terminals.get(String(p.terminalId ?? ""));
        if (!term) {
          this.replyError(id, `Unknown terminal: ${p.terminalId}`);
          return;
        }
        this.reply(id, {
          output: term.output,
          truncated: term.truncated,
          exitStatus: term.exited
            ? { exitCode: term.exitCode, signal: term.signal }
            : null,
        });
        return;
      }
      if (method === "terminal/wait_for_exit") {
        const term = this.terminals.get(String(p.terminalId ?? ""));
        if (!term) {
          this.replyError(id, `Unknown terminal: ${p.terminalId}`);
          return;
        }
        if (term.exited) {
          this.reply(id, { exitCode: term.exitCode, signal: term.signal });
          return;
        }
        await new Promise<void>((resolve) => {
          term.waiters.push(resolve);
        });
        this.reply(id, { exitCode: term.exitCode, signal: term.signal });
        return;
      }
      if (method === "terminal/kill") {
        const term = this.terminals.get(String(p.terminalId ?? ""));
        if (term && !term.exited) {
          try {
            term.proc.kill("SIGTERM");
          } catch {
            /* ignore */
          }
        }
        this.reply(id, {});
        return;
      }
      if (method === "terminal/release") {
        const tid = String(p.terminalId ?? "");
        const term = this.terminals.get(tid);
        if (term) {
          if (!term.exited) {
            try {
              term.proc.kill("SIGTERM");
            } catch {
              /* ignore */
            }
          }
          this.terminals.delete(tid);
        }
        this.reply(id, {});
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

  private emitActivity(
    text: string | null,
    phase?:
      | "idle"
      | "working"
      | "thinking"
      | "tool"
      | "permission"
      | "compact"
      | "queue"
      | "sleeping"
      | "error"
  ): void {
    if (!this.domainSessionId) return;
    this.emit({
      type: "AgentActivity",
      sessionId: this.domainSessionId,
      text,
      phase,
      at: nowIso(),
    });
  }

  private createTerminal(p: Record<string, unknown>): string {
    const id = `term-${randomUUID()}`;
    const command = String(p.command ?? "");
    const args = Array.isArray(p.args) ? (p.args as string[]).map(String) : [];
    const cwd =
      typeof p.cwd === "string" && p.cwd
        ? p.cwd
        : this.cwd || process.cwd();
    const byteLimit =
      typeof p.outputByteLimit === "number" && p.outputByteLimit > 0
        ? p.outputByteLimit
        : 1_048_576;
    const envList = Array.isArray(p.env)
      ? (p.env as Array<{ name?: string; value?: string }>)
      : [];
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const e of envList) {
      if (e?.name) env[e.name] = String(e.value ?? "");
    }

    // Grok often sends a full shell line as `command` (e.g. `/bin/bash -lc '…'`)
    // with empty args. Prefer shell:true for that shape; else spawn file+args.
    const useShell = args.length === 0 && /[\s'"|&;<>]/.test(command);
    const proc = useShell
      ? spawn(command, {
          cwd,
          env,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(command || "/bin/bash", args.length ? args : ["-lc", "true"], {
          cwd,
          env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });

    const term: AcpTerminal = {
      id,
      proc,
      output: "",
      truncated: false,
      exitCode: null,
      signal: null,
      exited: false,
      waiters: [],
      byteLimit,
    };

    const append = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      term.output += s;
      if (term.output.length > term.byteLimit) {
        term.output = term.output.slice(term.output.length - term.byteLimit);
        term.truncated = true;
      }
      // Surface live command output as muted activity (Cursor/Grok "sleeping")
      const last = s.trim().split("\n").filter(Boolean).pop();
      if (last) {
        this.emitActivity(
          last.length > 80 ? `${last.slice(0, 80)}…` : last,
          "sleeping"
        );
      }
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
    proc.on("error", (err) => {
      term.output += `\n[spawn error] ${err.message}`;
      term.exitCode = 1;
      term.exited = true;
      for (const w of term.waiters.splice(0)) w();
    });
    proc.on("close", (code, signal) => {
      term.exitCode = code;
      term.signal = signal;
      term.exited = true;
      for (const w of term.waiters.splice(0)) w();
      this.emitActivity(null);
    });

    this.terminals.set(id, term);
    const label = useShell
      ? command.slice(0, 60)
      : `${command} ${args.join(" ")}`.trim().slice(0, 60);
    this.emitActivity(`Running ${label}${label.length >= 60 ? "…" : ""}`, "tool");
    return id;
  }

  private handleNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;

    if (method === "session/update") {
      const update = (p.update ?? p) as Record<string, unknown>;
      this.mapSessionUpdate(update);
      return;
    }

    // Live activity from sessions list (working / idle)
    if (method === "_x.ai/sessions/changed" || method === "x.ai/sessions/changed") {
      const upserted = (p.upserted as Array<Record<string, unknown>>) ?? [];
      for (const u of upserted) {
        if (String(u.sessionId ?? "") !== this.providerSessionId) continue;
        const activity = String(u.activity ?? "");
        if (activity === "working") {
          this.emitActivity("Working…", "working");
        } else if (activity === "idle") {
          this.emitActivity(null, "idle");
        }
      }
      return;
    }

    // Prompt queue (shows while compact / queued)
    if (method === "_x.ai/queue/changed" || method === "x.ai/queue/changed") {
      if (String(p.sessionId ?? "") && String(p.sessionId) !== this.providerSessionId) {
        return;
      }
      const entries = (p.entries as Array<{ kind?: string; text?: string }>) ?? [];
      const running = p.runningPromptId ? String(p.runningPromptId) : "";
      const head = entries[0];
      if (head?.text?.trim().startsWith("/compact")) {
        this.emitActivity("Compacting conversation…", "compact");
      } else if (running && head?.text) {
        this.emitActivity(
          `Queued: ${String(head.text).slice(0, 60)}`,
          "queue"
        );
      } else if (running) {
        this.emitActivity("Waiting for model…", "working");
      }
      return;
    }

    // xAI extension notifications
    if (method === "_x.ai/session_notification" || method === "x.ai/session_notification") {
      const update = (p.update ?? p) as Record<string, unknown>;
      const kind = String(update.sessionUpdate ?? "");
      if (kind === "tool_call_delta_chunk") {
        const toolId = String(update.tool_call_id ?? update.toolCallId ?? "delta");
        const name = String(update.name ?? "");
        const argDelta = update.arguments_delta;
        // Only attach real tool names — never "pending: permission" as a tool row
        if (name && !name.startsWith("pending")) {
          this.emit({
            type: "ToolProgress",
            sessionId: this.domainSessionId,
            toolId,
            detail: name + (argDelta ? ` ${String(argDelta).slice(0, 120)}` : ""),
            at: nowIso(),
          });
          this.emitActivity(`Calling ${name}…`, "tool");
        }
      } else if (kind === "pending_interaction") {
        // NOT a tool failure — ephemeral status (Grok TUI small text)
        const ik = String(update.kind ?? "interaction");
        if (ik === "permission") {
          this.emitActivity("Waiting for permission…", "permission");
        } else {
          this.emitActivity(`Waiting: ${ik}…`, "working");
        }
      } else if (kind === "interaction_resolved") {
        this.emitActivity(null);
      } else if (
        kind === "auto_compact_started" ||
        kind === "compact_started" ||
        kind === "compacting"
      ) {
        this.emitActivity("Compacting conversation…", "compact");
      } else if (
        kind === "auto_compact_completed" ||
        kind === "compact_completed"
      ) {
        const before = update.tokens_before ?? update.tokensBefore;
        const after = update.tokens_after ?? update.tokensAfter;
        const msg =
          before != null && after != null
            ? `Compacted · ${before} → ${after} tokens`
            : "Compact complete";
        this.emitActivity(msg, "compact");
        // keep longer so user can actually read it
        setTimeout(() => this.emitActivity(null), 8000);
      } else if (kind === "turn_completed") {
        // Don't wipe compact-complete message immediately
        // (prompt RPC finally may clear separately)
      } else if (kind === "session_summary_generated") {
        // ignore for activity strip
      }
    }
  }

  private mapSessionUpdate(update: Record<string, unknown>): void {
    const kind = String(update.sessionUpdate ?? update.type ?? "");
    const sid = this.domainSessionId;
    const at = nowIso();

    // session/load (and residual history) must not pollute domain events / UI
    if (this.absorbUpdates) {
      return;
    }

    // 用户点了 Stop 之后仍可能收到少量残留 chunk —— 直接丢掉
    if (
      this.turnCancelled &&
      (kind === "agent_message_chunk" ||
        kind === "agent_thought_chunk" ||
        kind === "tool_call" ||
        kind === "tool_call_update" ||
        kind === "plan")
    ) {
      return;
    }

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
          this.emitActivity("Thinking…", "thinking");
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
        this.emitActivity(
          title.startsWith("Execute") || toolKind === "execute"
            ? `${title.slice(0, 72)}${title.length > 72 ? "…" : ""}`
            : `Using ${title.slice(0, 60)}…`,
          "tool"
        );
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
    /** Reuse Agent Pane domain id so history appends to the same session */
    domainSessionId?: string;
    /** Grok ACP session id for session/load */
    providerSessionId?: string;
    resumed?: boolean;
  }): Promise<{
    providerSessionId: string;
    domainSessionId: string;
    resumed: boolean;
    cwd: string;
    model?: string;
    needsHistoryDigest?: boolean;
  }> {
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.closed = false;
    this.domainSessionId = opts.domainSessionId ?? randomUUID();
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
      const unexpected = !this.closed;
      this.proc = null;
      if (unexpected) {
        this.emit({
          type: "SessionError",
          sessionId: this.domainSessionId,
          message: `grok agent exited (${code}) — send again to resume`,
          at: nowIso(),
        });
        this.emit({
          type: "SessionEnded",
          sessionId: this.domainSessionId,
          stopReason: `exited:${code ?? "?"}`,
          at: nowIso(),
        });
        for (const h of this.deadHandlers) {
          try {
            h(this.domainSessionId);
          } catch (e) {
            console.error("[adapter] onDead error", e);
          }
        }
      }
    });

    await this.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        // Implemented: terminal/create|output|wait_for_exit|kill|release
        terminal: true,
      },
      clientInfo: { name: "agent-pane", version: "0.1.2" },
    });

    /**
     * Resume strategy: always session/new + history digest (SessionManager).
     *
     * session/load can succeed but leave the ACP session in a state where the
     * next session/prompt never returns (UI shows 60s timeout). New session +
     * our event-log digest is reliable for "continue this chat".
     */
    this.absorbUpdates = false;
    const result = (await this.send(
      "session/new",
      { cwd: opts.cwd, mcpServers: [] },
      30_000
    )) as { sessionId?: string };
    this.providerSessionId = result.sessionId ?? randomUUID();

    // NOTE: do NOT emit SessionStarted here. SessionManager must register
    // this adapter in `live` first, then emit — otherwise the UI races a
    // prompt against an empty live map (idle resume / New Agent + pending).
    return {
      providerSessionId: this.providerSessionId,
      domainSessionId: this.domainSessionId,
      resumed: Boolean(opts.resumed),
      cwd: opts.cwd,
      model: opts.model,
      /** Always need digest when resumed (we no longer session/load). */
      needsHistoryDigest: Boolean(opts.resumed),
    };
  }

  /** Optional preamble for first prompt after resume-without-load. */
  setContextPrefix(text: string | null): void {
    this.contextPrefix = text && text.trim() ? text.trim() : null;
  }

  getSessionId(): string {
    return this.domainSessionId;
  }

  getProviderSessionId(): string {
    return this.providerSessionId;
  }

  async sendPrompt(input: {
    sessionId: string;
    text: string;
    /** Shown in UI / history title; defaults to text */
    displayText?: string;
    attachments?: ContextRef[];
    /** Retry after reconnect — don't duplicate UserMessageAppended */
    skipUserEvent?: boolean;
  }): Promise<void> {
    if (!this.isAlive()) {
      this.emit({
        type: "SessionError",
        sessionId: this.domainSessionId,
        message: "grok agent not running — send again to resume",
        at: nowIso(),
      });
      throw new Error("agent not alive");
    }

    // First real user turn after resume/load — accept live updates again
    this.absorbUpdates = false;

    let promptText = input.text;
    if (this.contextPrefix) {
      promptText = `${this.contextPrefix}\n\n---\n\n${input.text}`;
      this.contextPrefix = null;
    }

    const blocks: Array<Record<string, unknown>> = [
      { type: "text", text: promptText },
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

    const shown = input.displayText ?? input.text;
    this.turnCancelled = false;
    this.promptInFlight = true;
    if (!input.skipUserEvent) {
      this.userTurns.push(shown);
      this.emit({
        type: "UserMessageAppended",
        sessionId: this.domainSessionId,
        text: shown,
        attachments: input.attachments,
        at: nowIso(),
      });
    }

    // Grok TUI-style status while waiting on the model / slash handlers
    if (shown.trim().startsWith("/compact")) {
      this.emitActivity("Compacting conversation…", "compact");
    } else if (shown.trim().startsWith("/")) {
      this.emitActivity(`Running ${shown.trim().split(/\s+/)[0]}…`, "working");
    } else {
      this.emitActivity("Waiting for model…", "working");
    }

    try {
      const result = (await this.send("session/prompt", {
        sessionId: this.providerSessionId,
        prompt: blocks,
      })) as { stopReason?: string } | undefined;

      this.promptInFlight = false;
      this.emitActivity(null);
      const stop = result?.stopReason ?? "end_turn";
      if (stop === "cancelled" || this.turnCancelled) {
        this.emit({
          type: "MessageDone",
          sessionId: this.domainSessionId,
          role: "assistant",
          at: nowIso(),
        });
        // 可选：标注取消（前端 busy=false 即可）
        return;
      }
      this.emit({
        type: "MessageDone",
        sessionId: this.domainSessionId,
        role: "assistant",
        at: nowIso(),
      });
    } catch (e) {
      this.promptInFlight = false;
      if (this.turnCancelled) {
        this.emit({
          type: "MessageDone",
          sessionId: this.domainSessionId,
          role: "assistant",
          at: nowIso(),
        });
        return;
      }
      this.emit({
        type: "SessionError",
        sessionId: this.domainSessionId,
        message: e instanceof Error ? e.message : String(e),
        at: nowIso(),
      });
    }
  }

  /**
   * 取消当前 turn。
   * ACP 规定 session/cancel 是 **notification（无 id）**，
   * 若带 id 当 request 发，Grok 会回 Method not found，生成不会停。
   */
  async cancel(_sessionId: string): Promise<void> {
    this.turnCancelled = true;

    // 取消进行中的权限请求
    for (const [requestId, pending] of this.pendingPermissions) {
      this.reply(pending.rpcId, { outcome: { outcome: "cancelled" } });
      this.emit({
        type: "PermissionResolved",
        sessionId: this.domainSessionId,
        requestId,
        allow: false,
        at: nowIso(),
      });
    }
    this.pendingPermissions.clear();

    // 关键：notification，不要 id，不要 await 响应
    if (this.providerSessionId) {
      this.write({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: this.providerSessionId },
      });
    }

    // 立刻让 UI 脱 busy；prompt 的 JSON-RPC 稍后会以 cancelled 回来
    if (this.promptInFlight) {
      this.emit({
        type: "MessageDone",
        sessionId: this.domainSessionId,
        role: "assistant",
        at: nowIso(),
      });
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
      throw new Error("Nothing to undo");
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
        note = "UI undid the turn; Grok had no rewind point";
      } else {
        const last = points[points.length - 1]!;
        const target = last.prompt_index;
        // conversation_only first; still emit UI rewind either way
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
          note = undefined;
        } else {
          note =
            "UI undid the turn; Grok rewind not confirmed — model may still recall the last message";
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
      note = `UI undid the turn; Grok rewind failed: ${
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

  /**
   * Weekly credit usage / billing snapshot (Grok TUI `/usage`).
   * Not advertised in available_commands under ACP — pager-only there;
   * exposed via extension `_x.ai/billing`.
   */
  async fetchBillingUsage(): Promise<{
    creditUsagePercent?: number;
    periodType?: string;
    periodStart?: string;
    periodEnd?: string;
    subscriptionTier?: string;
    onDemandCap?: number;
    onDemandUsed?: number;
    prepaidBalance?: number;
    raw: unknown;
  }> {
    if (!this.isAlive() || !this.providerSessionId) {
      throw new Error("agent not alive");
    }
    const result = (await this.send("_x.ai/billing", {
      sessionId: this.providerSessionId,
    })) as {
      config?: Record<string, unknown>;
      subscription_tier?: string;
    };
    const cfg = result?.config ?? {};
    const period = (cfg.currentPeriod ?? {}) as Record<string, unknown>;
    const numVal = (v: unknown): number | undefined => {
      if (typeof v === "number") return v;
      if (v && typeof v === "object" && "val" in (v as object)) {
        const n = Number((v as { val: unknown }).val);
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    };
    return {
      creditUsagePercent:
        typeof cfg.creditUsagePercent === "number"
          ? cfg.creditUsagePercent
          : undefined,
      periodType: typeof period.type === "string" ? period.type : undefined,
      periodStart:
        (typeof period.start === "string" ? period.start : undefined) ??
        (typeof cfg.billingPeriodStart === "string"
          ? cfg.billingPeriodStart
          : undefined),
      periodEnd:
        (typeof period.end === "string" ? period.end : undefined) ??
        (typeof cfg.billingPeriodEnd === "string"
          ? cfg.billingPeriodEnd
          : undefined),
      subscriptionTier: result?.subscription_tier,
      onDemandCap: numVal(cfg.onDemandCap),
      onDemandUsed: numVal(cfg.onDemandUsed),
      prepaidBalance: numVal(cfg.prepaidBalance),
      raw: result,
    };
  }

  /** Show a local system-style reply without hitting the model. */
  emitLocalReply(userText: string, assistantText: string): void {
    const at = nowIso();
    this.userTurns.push(userText);
    this.emit({
      type: "UserMessageAppended",
      sessionId: this.domainSessionId,
      text: userText,
      at,
    });
    this.emit({
      type: "MessageChunk",
      sessionId: this.domainSessionId,
      role: "assistant",
      text: assistantText,
      at,
    });
    this.emit({
      type: "MessageDone",
      sessionId: this.domainSessionId,
      role: "assistant",
      at: nowIso(),
    });
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
    for (const term of this.terminals.values()) {
      if (!term.exited) {
        try {
          term.proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    }
    this.terminals.clear();
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
  if (typeof v === "string") return v.slice(0, 12_000);
  try {
    // 保留足够长度以便前端解析 diff content[]
    return JSON.stringify(v).slice(0, 12_000);
  } catch {
    return String(v).slice(0, 12_000);
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
