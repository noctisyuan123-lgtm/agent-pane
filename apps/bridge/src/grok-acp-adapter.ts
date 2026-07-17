import {
  spawn,
  execFile,
  execFileSync,
  type ChildProcess,
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ContextRef, DomainEvent } from "@agent-pane/shared";
import { nowIso } from "@agent-pane/shared";
import type { AgentProvider } from "./provider-api.js";
import type { AcpTransport } from "./acp-transport.js";
import { AcpStdioTransport } from "./acp-stdio-transport.js";
import {
  AcpWsHub,
  type SessionTransportView,
} from "./acp-ws-hub.js";
import {
  mapTaskStatus,
  numField,
  summarize,
} from "./acp-text.js";
import {
  GrokSignalsWatcher,
  resolveGrokSignalsPaths,
  readGrokSignalsUsage,
} from "./grok-signals-watcher.js";
import {
  guessMime,
  isImagePath,
  stabilizeAttachments,
} from "./attachment-persist.js";
import {
  buildAugmentedPath,
  resolveToolSpawn,
  withHealthyEnv,
} from "./path-env.js";

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

export type GrokAcpTransportMode = "stdio" | "serve";

/**
 * Grok ACP adapter — Grok packaging + DomainEvent mapping over ACP transport
 * (`stdio` child or WebSocket to `grok agent serve`).
 * CRITICAL: when we advertise fs/terminal capabilities, we MUST answer
 * agent→client requests (fs/read_text_file, session/request_permission, …)
 * or the tool loop hangs forever.
 */
export class GrokAcpAdapter implements AgentProvider {
  readonly id: string;
  private transport: AcpTransport | null = null;
  private handlers: Array<(e: DomainEvent) => void> = [];
  private domainSessionId = "";
  private providerSessionId = "";
  private cwd = ".";
  private model?: string;
  private effort?: string;
  private grokBin: string;
  private closed = false;
  private autoApprove: boolean;
  private readonly transportMode: GrokAcpTransportMode;
  /** Serve mode: shared hub view (one WS for all live sessions). */
  private serveView: SessionTransportView | null = null;
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
   * While true, drop session/update notifications (legacy load-replay path;
   * resume now uses session/new + digest so absorb stays false in practice).
   */
  private absorbUpdates = false;
  /** Resume digest preamble for first prompt after session/new. */
  private contextPrefix: string | null = null;
  /** ACP terminal/create sessions — scoped to THIS Pane session only */
  private terminals = new Map<string, AcpTerminal>();
  /** In-flight tool_call ids (for cancel → ToolFailed UI) */
  private activeTools = new Map<string, string>();

  constructor(opts?: {
    grokBin?: string;
    autoApprove?: boolean;
    /** `stdio` (default) or `serve` (`grok agent serve` WS). */
    transportMode?: GrokAcpTransportMode;
  }) {
    this.grokBin =
      opts?.grokBin ??
      process.env.GROK_BIN ??
      `${process.env.HOME}/.grok/bin/grok`;
    this.autoApprove =
      opts?.autoApprove ??
      process.env.AGENT_PANE_PERMISSION !== "ask";
    this.transportMode = opts?.transportMode ?? "stdio";
    this.id =
      this.transportMode === "serve" ? "grok-acp-serve" : "grok-acp";
  }

  onEvent(handler: (e: DomainEvent) => void): void {
    this.handlers.push(handler);
  }

  onDead(handler: (domainSessionId: string) => void): void {
    this.deadHandlers.push(handler);
  }

  /** Transport still open (stdio child or WS). */
  isAlive(): boolean {
    return !this.closed && Boolean(this.transport?.isAlive());
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

  private send(
    method: string,
    params?: unknown,
    timeoutMs = 120_000
  ): Promise<unknown> {
    if (!this.transport) {
      return Promise.reject(new Error("Agent not started"));
    }
    return this.transport.send(method, params, timeoutMs);
  }

  private reply(id: number | string, result: unknown): void {
    this.transport?.reply(id, result);
  }

  private replyError(id: number | string, message: string, code = -32000): void {
    this.transport?.replyError(id, message, code);
  }

  private bindHandlers(): {
    onRequest: (
      id: number | string,
      method: string,
      params: unknown
    ) => void | Promise<void>;
    onNotification: (method: string, params: unknown) => void;
    onClose: (reason?: string) => void;
  } {
    return {
      onRequest: (id, method, params) =>
        this.handleServerRequest(id, method, params),
      onNotification: (method, params) =>
        this.handleNotification(method, params),
      onClose: (reason) => this.onTransportClosed(reason),
    };
  }

  private onTransportClosed(reason?: string): void {
    if (this.closed) return;
    this.transport = null;
    this.stopSignalsWatcher();
    const msg =
      reason?.trim() ||
      (this.transportMode === "serve"
        ? "grok agent serve connection lost — send again to resume"
        : "grok agent exited — send again to resume");
    this.emit({
      type: "SessionError",
      sessionId: this.domainSessionId,
      message: msg,
      at: nowIso(),
    });
    this.emit({
      type: "SessionEnded",
      sessionId: this.domainSessionId,
      stopReason: "transport_closed",
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

  private attachStdio(proc: ChildProcess): void {
    const stdio = new AcpStdioTransport();
    stdio.attach(proc, this.bindHandlers());
    this.transport = stdio;
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown
  ): Promise<void> {
    const p = (params ?? {}) as Record<string, unknown>;

    try {
      // Permission / session-scoped agent→client RPCs must not be answered by
      // the wrong live session when serve fans out to every WS.
      if (
        method === "session/request_permission" ||
        method.endsWith("/request_permission")
      ) {
        if (this.isForeignProviderSession(p)) {
          // Another client owns this session — do not reply (owner will).
          return;
        }
      }

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

      // Grok browser / device auth — open URL so authenticate() can finish
      if (
        method === "_x.ai/auth/get_url" ||
        method === "x.ai/auth/get_url"
      ) {
        const url = String(
          (p as { url?: string }).url ??
            (p as { authUrl?: string }).authUrl ??
            ""
        );
        if (url) {
          this.emitActivity("Grok login — browser opened…", "working");
          try {
            execFile("open", [url], () => undefined);
          } catch (e) {
            console.warn("[adapter] open auth url failed", e);
          }
        }
        this.reply(id, { ok: true });
        return;
      }
      if (
        method === "_x.ai/auth/submit_code" ||
        method === "x.ai/auth/submit_code"
      ) {
        // Agent drives device-code flow; acknowledge so it doesn't hang
        this.reply(id, { ok: true });
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
    // Relative paths are relative to session cwd (not bridge process cwd).
    const base = this.cwd && this.cwd !== "." ? this.cwd : process.cwd();
    const resolved = path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(base, filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }
    if (isImagePath(resolved)) {
      const st = fs.statSync(resolved);
      return (
        `[Image file — not text]\n` +
        `path: ${resolved}\n` +
        `mime: ${guessMime(resolved)}\n` +
        `size: ${st.size} bytes\n` +
        `Do not use Read/read_file on images. If this image was attached by the user, ` +
        `it is already available as vision content in the conversation — describe it from that.`
      );
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
    const base = this.cwd && this.cwd !== "." ? this.cwd : process.cwd();
    const resolved = path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(base, filePath);
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

  /** Last context window size from agent (for compact_completed which only sends after). */
  private lastContextSize = 0;
  /** Monotonic guard — signals can briefly point at the wrong session after resume. */
  private lastContextUsed = 0;
  private lastContextProviderId = "";
  private turnAssistantText = "";
  private signalsWatcher: GrokSignalsWatcher | null = null;

  private stopSignalsWatcher(): void {
    this.signalsWatcher?.stop();
    this.signalsWatcher = null;
  }

  private startSignalsWatcher(): void {
    this.stopSignalsWatcher();
    if (!this.providerSessionId || !this.cwd?.trim()) return;
    const paths = resolveGrokSignalsPaths(this.cwd, this.providerSessionId);
    if (paths.length === 0) return;
    this.signalsWatcher = new GrokSignalsWatcher(paths, (u) => {
      this.emitContextUsage(u.used, u.size, "signals", u.pct);
    });
    this.signalsWatcher.start();
  }

  /** Point watcher at a different Grok session id (e.g. from /session-info). */
  private retargetProviderSession(nextId: string): void {
    const id = nextId.trim();
    if (!id || id === this.providerSessionId) return;
    this.providerSessionId = id;
    this.lastContextUsed = 0; // allow new baseline for the retargeted session
    this.lastContextProviderId = id;
    this.startSignalsWatcher();
    this.publishSignalsUsageOnce();
  }

  /** One-shot read for SessionManager / HTTP (no watcher required). */
  publishSignalsUsageOnce(): boolean {
    if (!this.providerSessionId || !this.cwd?.trim()) return false;
    const u = readGrokSignalsUsage(
      resolveGrokSignalsPaths(this.cwd, this.providerSessionId)
    );
    if (!u) return false;
    this.emitContextUsage(u.used, u.size, "signals", u.pct);
    return true;
  }

  private emitContextUsage(
    used: number,
    size: number,
    source:
      | "acp"
      | "compact"
      | "compact_done"
      | "signals"
      | "session_info",
    pct?: number
  ): void {
    if (!this.domainSessionId) return;
    if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return;
    const usedN = Math.max(0, Math.round(used));
    const sizeN = Math.max(1, Math.round(size));

    // Ignore stale/wrong-session signals that would drop usage without compact
    if (
      source === "signals" &&
      this.lastContextProviderId === this.providerSessionId &&
      this.lastContextUsed > 0 &&
      usedN + 500 < this.lastContextUsed // allow tiny jitter, block big drops
    ) {
      return;
    }

    this.lastContextSize = sizeN;
    this.lastContextUsed = usedN;
    this.lastContextProviderId = this.providerSessionId;
    this.emit({
      type: "ContextUsage",
      sessionId: this.domainSessionId,
      used: usedN,
      size: sizeN,
      source,
      pct:
        typeof pct === "number" && Number.isFinite(pct)
          ? Math.max(0, Math.min(100, Math.round(pct)))
          : Math.min(100, Math.round((usedN / sizeN) * 100)),
      providerSessionId: this.providerSessionId || undefined,
      at: nowIso(),
    });
  }

  /** Pull usage (+ optional session id) out of /session-info style replies. */
  private ingestSessionInfoText(text: string): void {
    if (!text || !/session\s*id|context\s*:/i.test(text)) return;

    const idMatch = text.match(
      /Session\s*ID\s*[:：]\s*\**\s*[`"]?(019f[0-9a-fA-F-]{20,}|[0-9a-f]{8}-[0-9a-f-]{27,})[`"]?/i
    );
    if (idMatch?.[1]) {
      this.retargetProviderSession(idMatch[1]);
    }

    const ctxMatch = text.match(
      /Context[\s\S]{0,48}?([\d,]+)\s*\/\s*([\d,]+)\s*tokens(?:\s*\((\d+)\s*%\))?/i
    );
    if (ctxMatch) {
      const used = Number(String(ctxMatch[1]).replace(/,/g, ""));
      const size = Number(String(ctxMatch[2]).replace(/,/g, ""));
      const pct =
        ctxMatch[3] != null ? Number(ctxMatch[3]) : undefined;
      if (Number.isFinite(used) && Number.isFinite(size) && size > 0) {
        this.emitContextUsage(used, size, "session_info", pct);
      }
    }
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
    // PATH-safe env; never rely on login profiles for tool shells.
    const env: NodeJS.ProcessEnv = withHealthyEnv(process.env);
    for (const e of envList) {
      if (e?.name) env[e.name] = String(e.value ?? "");
    }
    // Re-augment after overlays so tool-provided PATH can't drop system bins.
    env.PATH = buildAugmentedPath(env.PATH);

    // Grok often sends `/bin/bash -lc '…'` (login shell). That sources
    // ~/.bash_profile / conda and produces dirname/head-not-found + "环境混乱".
    // Also avoid spawn({ shell:true }) which wraps again in $SHELL -c.
    const spec = resolveToolSpawn(command, args, env.PATH);
    const proc = spawn(spec.file, spec.args, {
      cwd,
      env: spec.env ? { ...env, ...spec.env } : env,
      shell: false,
      stdio: [
        spec.stdinScript != null ? "pipe" : "ignore",
        "pipe",
        "pipe",
      ],
    });
    if (spec.stdinScript != null && proc.stdin) {
      proc.stdin.write(spec.stdinScript);
      proc.stdin.end();
    }

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
        // Don't spam activity strip with profile noise if any slips through
        if (/command not found|bash_profile|zshrc|conda initialize/i.test(last)) {
          return;
        }
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
    const label = spec.label;
    this.emitActivity(`Running ${label}${label.length >= 60 ? "…" : ""}`, "tool");
    return id;
  }

  /**
   * Serve mode: daemon may fan out ACP traffic to every WS client.
   * Drop notifications/RPCs that name a *different* provider session.
   * Missing sessionId → accept (stdio / legacy shapes; permission must not hang).
   * Before we own a providerSessionId, any *named* foreign id is dropped.
   */
  private isForeignProviderSession(params: Record<string, unknown>): boolean {
    const nested = params.update as Record<string, unknown> | undefined;
    const wire = String(
      params.sessionId ?? nested?.sessionId ?? ""
    ).trim();
    if (!wire) return false;
    if (!this.providerSessionId) return true;
    return wire !== this.providerSessionId;
  }

  private handleNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;

    if (method === "session/update") {
      // CRITICAL multi-session demux (esp. `grok agent serve`):
      // params.sessionId is the Core handle; without this filter, B's WS
      // paints A's tool stream (observed: sleep 30 leaked into "hello").
      if (this.isForeignProviderSession(p)) return;
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
      if (this.isForeignProviderSession(p)) return;
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
      if (this.isForeignProviderSession(p)) return;
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
        const used = numField(update.tokens_used ?? update.tokensUsed);
        const size = numField(
          update.context_window ?? update.contextWindow
        );
        if (used != null && size != null) {
          this.emitContextUsage(used, size, "compact");
        }
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
        const afterN = numField(after);
        const size =
          numField(update.context_window ?? update.contextWindow) ??
          (this.lastContextSize > 0 ? this.lastContextSize : undefined);
        if (afterN != null && size != null) {
          this.emitContextUsage(afterN, size, "compact_done");
        }
        // keep longer so user can actually read it
        setTimeout(() => this.emitActivity(null), 8000);
      } else if (kind === "turn_completed") {
        // Don't wipe compact-complete message immediately
        // (prompt RPC finally may clear separately)
      } else if (kind === "session_summary_generated") {
        // ignore for activity strip
      }
      return;
    }

    // Other notifications that name a session — ignore foreign in serve mode
    if (
      this.transportMode === "serve" &&
      p.sessionId != null &&
      this.isForeignProviderSession(p)
    ) {
      return;
    }
  }

  private mapSessionUpdate(update: Record<string, unknown>): void {
    const kind = String(update.sessionUpdate ?? update.type ?? "");
    const sid = this.domainSessionId;
    const at = nowIso();

    // Absorb path: drop residual history updates so they do not pollute domain events / UI
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
          this.turnAssistantText += text;
          // Live-parse session-info as it streams (so the ring updates immediately)
          if (
            /Session\s*ID|Context\s*:/i.test(this.turnAssistantText) &&
            this.turnAssistantText.length < 20_000
          ) {
            this.ingestSessionInfoText(this.turnAssistantText);
          }
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
        this.activeTools.set(toolId, title);
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
          this.activeTools.delete(toolId);
          this.emit({
            type: "ToolFailed",
            sessionId: sid,
            toolId,
            error: detail || "failed",
            at,
          });
        } else if (status === "completed" || status === "success") {
          this.activeTools.delete(toolId);
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
      case "usage_update": {
        const used = numField(update.used);
        const size = numField(update.size);
        if (used != null && size != null) {
          this.emitContextUsage(used, size, "acp");
        }
        break;
      }
      case "auto_compact_started":
      case "compact_started": {
        const used = numField(update.tokens_used ?? update.tokensUsed);
        const size = numField(
          update.context_window ?? update.contextWindow
        );
        if (used != null && size != null) {
          this.emitContextUsage(used, size, "compact");
        }
        this.emitActivity("Compacting conversation…", "compact");
        break;
      }
      case "auto_compact_completed":
      case "compact_completed": {
        const after = numField(
          update.tokens_after ?? update.tokensAfter
        );
        const size =
          numField(update.context_window ?? update.contextWindow) ??
          (this.lastContextSize > 0 ? this.lastContextSize : undefined);
        if (after != null && size != null) {
          this.emitContextUsage(after, size, "compact_done");
        }
        break;
      }
      default:
        break;
    }
  }

  async start(opts: {
    cwd: string;
    model?: string;
    effort?: string;
    permissionMode?: string;
    /** Reuse Agent Pane domain id so history appends to the same session */
    domainSessionId?: string;
    /** Previous Grok ACP id for bookkeeping only (resume still session/new). */
    providerSessionId?: string;
    resumed?: boolean;
  }): Promise<{
    providerSessionId: string;
    domainSessionId: string;
    resumed: boolean;
    cwd: string;
    model?: string;
    effort?: string;
    needsHistoryDigest?: boolean;
  }> {
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.effort = opts.effort;
    this.closed = false;
    this.lastContextSize = 0;
    this.lastContextUsed = 0;
    this.lastContextProviderId = "";
    this.turnAssistantText = "";
    this.domainSessionId = opts.domainSessionId ?? randomUUID();
    if (opts.permissionMode === "default" || opts.permissionMode === "ask") {
      this.autoApprove = false;
    } else {
      this.autoApprove = true;
    }

    if (this.transportMode === "serve") {
      await this.openServeTransport();
    } else {
      this.openStdioTransport(opts);
    }

    const init = (await this.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        // Implemented: terminal/create|output|wait_for_exit|kill|release
        terminal: true,
      },
      clientInfo: { name: "agent-pane", version: "0.1.2" },
    })) as {
      authMethods?: Array<{ id?: string; name?: string }>;
      _meta?: { defaultAuthMethodId?: string | null };
    };

    /**
     * Auth — match acpx default (`authPolicy: "skip"`):
     * Grok advertises authMethods even when ~/.grok/auth.json is valid.
     * Calling authenticate({methodId:"grok.com"}) forces browser OAuth and
     * hangs ~90s. CLI/Cursor stay instant because the agent reads cached
     * creds itself. Only authenticate after session/new returns auth_required.
     */
    const methods = Array.isArray(init?.authMethods) ? init.authMethods : [];
    const methodId =
      (typeof init?._meta?.defaultAuthMethodId === "string" &&
        init._meta.defaultAuthMethodId) ||
      methods.find((m) => typeof m?.id === "string" && m.id)?.id ||
      (methods.length > 0 ? "grok.com" : null);

    /**
     * Resume strategy: always session/new + history digest (SessionManager).
     *
     * session/load can succeed but leave the ACP session in a state where the
     * next session/prompt never returns (UI shows 60s timeout). New session +
     * our event-log digest is reliable for "continue this chat".
     */
    this.absorbUpdates = false;
    const { browserMcpServers } = await import("./browser-mcp-config.js");
    // Resume skips browser MCP (Playwright handshake hang). Fresh may use MCP.
    const wantMcp =
      process.env.AGENT_PANE_BROWSER_MCP !== "0" && !opts.resumed;
    const mcpServers = wantMcp ? browserMcpServers() : [];

    const isAuthRequired = (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return /Authentication required|auth_required|no auth method/i.test(msg);
    };

    const sessionNew = async (
      servers: typeof mcpServers,
      timeoutMs: number
    ) =>
      (await this.send(
        "session/new",
        { cwd: opts.cwd, mcpServers: servers },
        timeoutMs
      )) as { sessionId?: string };

    const t0 = Date.now();
    let result: { sessionId?: string };
    try {
      // Fast path: rely on ~/.grok/auth.json — no authenticate round-trip.
      const firstTimeout = mcpServers.length > 0 ? 20_000 : 25_000;
      this.emitActivity("Connecting…", "working");
      result = await sessionNew(mcpServers, firstTimeout);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);

      if (methodId && isAuthRequired(e)) {
        console.warn(
          `[adapter] session/new needs auth after ${Date.now() - t0}ms — authenticate once`
        );
        try {
          this.emitActivity("Grok login required…", "working");
          await this.send("authenticate", { methodId }, 45_000);
        } catch (authErr) {
          this.emitActivity(null);
          const am =
            authErr instanceof Error ? authErr.message : String(authErr);
          throw new Error(
            `需要登录 Grok（${am}）。终端跑：grok login  然后回到这里再 Send。`
          );
        }
        this.emitActivity("Connecting…", "working");
        result = await sessionNew([], 25_000);
      } else if (mcpServers.length > 0 && /timed out/i.test(msg)) {
        console.warn(
          `[adapter] session/new with MCP timed out after ${Date.now() - t0}ms — retry without MCP`
        );
        this.emitActivity("Connecting…", "working");
        result = await sessionNew([], 25_000);
      } else if (isAuthRequired(e)) {
        this.emitActivity(null);
        throw new Error(
          `需要登录 Grok。终端跑：grok login  然后回到这里再 Send。（${msg}）`
        );
      } else {
        this.emitActivity(null);
        throw e;
      }
    }
    this.emitActivity(null);
    this.providerSessionId = result.sessionId ?? randomUUID();
    // Serve: bind provider id so hub demux routes this session's stream here
    if (this.serveView) {
      this.serveView.attachProviderSession(this.providerSessionId);
    }
    this.startSignalsWatcher();

    // NOTE: do NOT emit SessionStarted here. SessionManager must register
    // this adapter in `live` first, then emit — otherwise the UI races a
    // prompt against an empty live map (idle resume / New Agent + pending).
    return {
      providerSessionId: this.providerSessionId,
      domainSessionId: this.domainSessionId,
      resumed: Boolean(opts.resumed),
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
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
    // Stabilize temp screenshots into ~/.agent-pane/uploads; send images as
    // vision blocks so the model doesn't try text-Read on PNGs.
    const attachments = stabilizeAttachments(input.attachments);
    const imageNames: string[] = [];
    if (attachments?.length) {
      for (const a of attachments) {
        const abs = a.path;
        const name = path.basename(abs);
        if (a.kind !== "folder" && isImagePath(abs) && fs.existsSync(abs)) {
          try {
            const buf = fs.readFileSync(abs);
            // Cap ~12MB per image for prompt payload
            if (buf.length <= 12 * 1024 * 1024) {
              blocks.push({
                type: "image",
                mimeType: guessMime(abs),
                data: buf.toString("base64"),
              });
              imageNames.push(name);
            }
          } catch {
            /* fall through to resource_link */
          }
        }
        blocks.push({
          type: "resource_link",
          uri: `file://${abs}`,
          name,
        });
      }
    }
    if (imageNames.length) {
      blocks.push({
        type: "text",
        text:
          `[Attached image${imageNames.length > 1 ? "s" : ""}: ${imageNames.join(", ")}. ` +
          `Vision content is already included above — look at the image(s) directly. ` +
          `Do NOT call Read/read_file on these image paths (binary files).]`,
      });
    }

    const shown = input.displayText ?? input.text;
    this.turnCancelled = false;
    this.promptInFlight = true;
    this.signalsWatcher?.setActive(true);
    this.turnAssistantText = "";
    if (!input.skipUserEvent) {
      this.userTurns.push(shown);
      this.emit({
        type: "UserMessageAppended",
        sessionId: this.domainSessionId,
        text: shown,
        attachments,
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

    // Long multi-tool turns routinely exceed the default 120s RPC timeout.
    // Idle-extend: transport still uses an absolute cap, but we pass a higher
    // limit so legitimate work is not treated as a dead session.
    const PROMPT_TIMEOUT_MS = 30 * 60_000;
    try {
      const result = (await this.send(
        "session/prompt",
        {
          sessionId: this.providerSessionId,
          prompt: blocks,
        },
        PROMPT_TIMEOUT_MS
      )) as { stopReason?: string } | undefined;

      this.promptInFlight = false;
      this.signalsWatcher?.setActive(false);
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
      this.ingestSessionInfoText(this.turnAssistantText);
      this.turnAssistantText = "";
      // Grok updates signals.json after the turn — nudge a read
      this.signalsWatcher?.refresh();
      setTimeout(() => this.signalsWatcher?.refresh(), 400);
      setTimeout(() => this.signalsWatcher?.refresh(), 1200);
    } catch (e) {
      this.promptInFlight = false;
      this.signalsWatcher?.setActive(false);
      this.emitActivity(null);
      if (this.turnCancelled) {
        this.emit({
          type: "MessageDone",
          sessionId: this.domainSessionId,
          role: "assistant",
          at: nowIso(),
        });
        this.signalsWatcher?.refresh();
        return;
      }
      // Timeout / transport error: surface the error but still seal the turn so
      // the UI does not stick on "Waiting for response" / Stop forever. The
      // Core may still finish; residual chunks are dropped once MessageDone
      // lands (frontend turnDoneRef).
      this.emit({
        type: "SessionError",
        sessionId: this.domainSessionId,
        message: e instanceof Error ? e.message : String(e),
        at: nowIso(),
      });
      this.emit({
        type: "MessageDone",
        sessionId: this.domainSessionId,
        role: "assistant",
        at: nowIso(),
      });
      this.ingestSessionInfoText(this.turnAssistantText);
      this.turnAssistantText = "";
      this.signalsWatcher?.refresh();
    }
  }

  /**
   * Kill every ACP terminal process tree owned by THIS adapter (this Pane
   * session). Other live sessions have their own adapter.terminals maps.
   */
  private killSessionProcessTree(signal: NodeJS.Signals = "SIGTERM"): number {
    let killed = 0;
    for (const term of this.terminals.values()) {
      if (term.exited) continue;
      const pid = term.proc.pid;
      if (pid && pid > 0) {
        this.killPidTree(pid, signal);
        killed++;
      } else {
        try {
          term.proc.kill(signal);
          killed++;
        } catch {
          /* ignore */
        }
      }
      term.exited = true;
      term.signal = signal;
      term.exitCode = term.exitCode ?? 1;
      for (const w of term.waiters.splice(0)) w();
    }
    return killed;
  }

  /** Recurse children via pgrep -P, then signal the root pid. Session-local only. */
  private killPidTree(pid: number, signal: NodeJS.Signals): void {
    if (!Number.isFinite(pid) || pid <= 0) return;
    if (process.platform !== "win32") {
      try {
        const out = execFileSync("pgrep", ["-P", String(pid)], {
          encoding: "utf8",
        });
        for (const line of out.split("\n")) {
          const child = Number(line.trim());
          if (Number.isFinite(child) && child > 0) {
            this.killPidTree(child, signal);
          }
        }
      } catch {
        /* no children */
      }
    }
    try {
      process.kill(pid, signal);
    } catch {
      /* already dead */
    }
  }

  /**
   * 取消当前 turn：停模型 + 杀本 session 的脚本/终端树 + 标工具失败。
   * 不碰其他 live session（各自独立 adapter / terminals）。
   * ACP 规定 session/cancel 是 **notification（无 id）**。
   *
   * Order matters: Core cancel FIRST (stop tool loop / subagents), then hard-kill
   * host ACP terminals. Waking wait_for_exit before Core cancel can look like
   * "tool finished" and let the model keep talking.
   */
  async cancel(_sessionId: string): Promise<void> {
    this.turnCancelled = true;
    const at = nowIso();

    // 1) Tell Core immediately (this providerSession only) — soft-stop model + tool loop
    if (this.providerSessionId) {
      try {
        this.transport?.notify("session/cancel", {
          sessionId: this.providerSessionId,
        });
      } catch (e) {
        console.warn(
          `[adapter] session/cancel notify failed:`,
          e instanceof Error ? e.message : e
        );
      }
    }

    // 2) Hard-kill host-side ACP terminals (sleep / bash) for THIS session only
    const nTerm = this.killSessionProcessTree("SIGTERM");
    if (nTerm > 0) {
      const pids: number[] = [];
      for (const term of this.terminals.values()) {
        const pid = term.proc.pid;
        if (pid && pid > 0) pids.push(pid);
      }
      setTimeout(() => {
        for (const pid of pids) {
          try {
            process.kill(pid, 0);
            this.killPidTree(pid, "SIGKILL");
          } catch {
            /* gone */
          }
        }
      }, 600);
    }

    // 3) Mark open tools failed so UI stops "Running…"
    for (const [toolId, title] of this.activeTools) {
      this.emit({
        type: "ToolFailed",
        sessionId: this.domainSessionId,
        toolId,
        error: `Interrupted by user${title ? ` (${title})` : ""}`,
        at,
      });
    }
    this.activeTools.clear();

    // 4) Cancel pending permissions
    for (const [requestId, pending] of this.pendingPermissions) {
      this.reply(pending.rpcId, { outcome: { outcome: "cancelled" } });
      this.emit({
        type: "PermissionResolved",
        sessionId: this.domainSessionId,
        requestId,
        allow: false,
        at,
      });
    }
    this.pendingPermissions.clear();

    // 5) UI drop busy immediately; in-flight session/prompt RPC returns cancelled later
    const wasInFlight = this.promptInFlight;
    this.promptInFlight = false;
    this.signalsWatcher?.setActive(false);
    this.emitActivity(null);
    if (wasInFlight) {
      this.emit({
        type: "MessageDone",
        sessionId: this.domainSessionId,
        role: "assistant",
        at: nowIso(),
      });
    }
    console.log(
      `[adapter] cancel session=${this.domainSessionId.slice(0, 8)} ` +
        `provider=${(this.providerSessionId || "").slice(0, 8)} ` +
        `terminalsKilled=${nTerm} wasInFlight=${wasInFlight}`
    );
  }

  /**
   * Discard user turn `userTurnIndex` and everything after (Claude Code Undo).
   * 1) cancel only if a prompt is in flight (idle cancel injects
   *    `[Request interrupted by user]` into Core context — never do that for Retry)
   * 2) best-effort Grok `_x.ai/rewind/*` (verify points shrunk)
   * 3) emit SessionRewound so Host truncates Pane log
   * Host rebinds with digest when providerOk is false.
   */
  async rewindToUserTurn(userTurnIndex: number): Promise<{
    restoredText: string;
    userTurnIndex: number;
    providerOk: boolean;
    note?: string;
  }> {
    if (this.userTurns.length === 0) {
      throw new Error("Nothing to undo");
    }
    if (
      !Number.isFinite(userTurnIndex) ||
      userTurnIndex < 0 ||
      userTurnIndex >= this.userTurns.length
    ) {
      throw new Error("Invalid turn to undo");
    }

    // Only cancel when generating — idle cancel pollutes Core with interrupt noise.
    if (this.promptInFlight) {
      await this.cancel(this.domainSessionId);
    }

    const restoredText = this.userTurns[userTurnIndex]!;
    let providerOk = false;
    let note: string | undefined;

    try {
      const listPoints = async () => {
        const pts = (await this.send("_x.ai/rewind/points", {
          sessionId: this.providerSessionId,
        })) as {
          rewind_points?: Array<{
            prompt_index: number;
            prompt_preview?: string;
          }>;
        };
        return pts?.rewind_points ?? [];
      };

      const pointsBefore = await listPoints();
      if (pointsBefore.length === 0) {
        note = "Grok had no rewind point — will rebind provider context";
      } else {
        // Align Pane userTurns with Grok points (resume may add digest turns)
        let target =
          pointsBefore[userTurnIndex] ??
          pointsBefore.find((p) => {
            const preview = (p.prompt_preview ?? "").trim();
            return (
              preview && restoredText.trim().startsWith(preview.slice(0, 40))
            );
          }) ??
          null;
        if (!target && pointsBefore.length === this.userTurns.length) {
          target = pointsBefore[userTurnIndex] ?? null;
        }
        if (!target && userTurnIndex === this.userTurns.length - 1) {
          target = pointsBefore[pointsBefore.length - 1] ?? null;
        }
        if (!target) {
          const offset = pointsBefore.length - this.userTurns.length;
          if (offset >= 0 && pointsBefore[offset + userTurnIndex]) {
            target = pointsBefore[offset + userTurnIndex]!;
          }
        }

        if (!target) {
          note =
            "Could not map Grok rewind point — will rebind provider context";
        } else {
          // Prefer `all` — conversation_only often returns success:false on 0.2.101
          const modes = ["all", "conversation_only"] as const;
          for (const mode of modes) {
            try {
              const result = (await this.send("_x.ai/rewind/execute", {
                sessionId: this.providerSessionId,
                target_prompt_index: target.prompt_index,
                mode,
              })) as {
                success?: boolean;
                prompt_text?: string | null;
                error?: string | null;
              };
              const after = await listPoints();
              // Success if Core reports it OR points actually shrank / dropped target
              const shrunk = after.length < pointsBefore.length;
              const droppedTarget = !after.some(
                (p) => p.prompt_index === target!.prompt_index
              );
              if (result?.success || shrunk || droppedTarget) {
                providerOk = true;
                note = undefined;
                break;
              }
              note =
                result?.error ||
                `Grok rewind mode=${mode} not confirmed`;
            } catch (e) {
              note = `Grok rewind mode=${mode} failed: ${
                e instanceof Error ? e.message : String(e)
              }`;
            }
          }
          if (!providerOk) {
            note = `${note ?? "Grok rewind failed"} — will rebind provider context`;
          }
        }
      }
    } catch (e) {
      note = `Grok rewind failed: ${
        e instanceof Error ? e.message : String(e)
      } — will rebind provider context`;
    }

    this.userTurns = this.userTurns.slice(0, userTurnIndex);

    // Host publishes SessionRewound after optional rebind — do not emit here
    // (UI must not re-prompt against stale Core context mid-rebind).
    return { restoredText, userTurnIndex, providerOk, note };
  }

  /**
   * After a failed Core rewind: open a fresh provider session on the same
   * transport and attach digest via setContextPrefix (Host). Does NOT emit
   * SessionEnded — live Pane session stays continuous.
   */
  async rebindProviderSession(opts: {
    cwd: string;
    model?: string;
    effort?: string;
  }): Promise<{ providerSessionId: string }> {
    // Drop old demux binding (serve); stdio replaces the whole process.
    if (this.serveView && this.providerSessionId) {
      try {
        const { AcpWsHub } = await import("./acp-ws-hub.js");
        AcpWsHub.shared().unbindProvider(this.providerSessionId);
      } catch {
        /* ignore */
      }
      this.serveView.providerSessionId = "";
    }

    if (this.transportMode === "stdio") {
      try {
        this.transport?.dispose();
      } catch {
        /* ignore */
      }
      this.transport = null;
      this.openStdioTransport({
        cwd: opts.cwd,
        model: opts.model ?? this.model,
        effort: opts.effort ?? this.effort,
      });
      await this.send("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: "agent-pane", version: "0.1.2" },
      });
    } else {
      // Serve: keep shared WS; only session/new
      await this.openServeTransport();
    }

    const result = (await this.send(
      "session/new",
      { cwd: opts.cwd || this.cwd, mcpServers: [] },
      25_000
    )) as { sessionId?: string };

    this.providerSessionId = result.sessionId ?? randomUUID();
    if (this.serveView) {
      this.serveView.attachProviderSession(this.providerSessionId);
    }
    this.promptInFlight = false;
    this.turnCancelled = false;
    this.closed = false;
    return { providerSessionId: this.providerSessionId };
  }

  /**
   * 撤回上一条用户消息 — thin wrapper around rewindToUserTurn.
   */
  async undoLastTurn(): Promise<{
    restoredText: string;
    providerOk: boolean;
    note?: string;
  }> {
    if (this.userTurns.length === 0) {
      throw new Error("Nothing to undo");
    }
    const r = await this.rewindToUserTurn(this.userTurns.length - 1);
    return {
      restoredText: r.restoredText,
      providerOk: r.providerOk,
      note: r.note,
    };
  }

  /** Rebuild turn list after resume / history hydrate. */
  hydrateUserTurns(texts: string[]): void {
    this.userTurns = texts.filter((t) => typeof t === "string");
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

  hasPendingPermission(requestId: string): boolean {
    return this.pendingPermissions.has(requestId);
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
    this.stopSignalsWatcher();
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
    try {
      this.transport?.dispose();
    } catch {
      /* ignore */
    }
    this.transport = null;
    this.serveView = null;
    if (this.domainSessionId) {
      this.emit({
        type: "SessionEnded",
        sessionId: this.domainSessionId,
        stopReason: "client_stop",
        at: nowIso(),
      });
    }
  }

  /** Spawn `grok agent … stdio` and attach NDJSON transport. */
  private openStdioTransport(opts: {
    cwd: string;
    model?: string;
    effort?: string;
  }): void {
    const agentArgs = ["agent"];
    if (opts.model) agentArgs.push("--model", opts.model);
    if (opts.effort) agentArgs.push("--effort", opts.effort);
    if (this.autoApprove) agentArgs.push("--always-approve");
    agentArgs.push("stdio");

    const proc = spawn(this.grokBin, agentArgs, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: withHealthyEnv(process.env),
    });

    proc.stderr?.on("data", (buf: Buffer) => {
      const line = buf.toString();
      try {
        const logDir = path.join(process.env.HOME || "/tmp", ".agent-pane");
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(
          path.join(logDir, "grok-stderr.log"),
          `[${new Date().toISOString()}] ${line.slice(0, 2000)}`
        );
      } catch {
        /* ignore */
      }
      if (process.env.AGENT_PANE_DEBUG) {
        console.error("[grok stderr]", line.slice(0, 500));
      }
    });

    this.attachStdio(proc);

    proc.on("exit", (code) => {
      const unexpected = !this.closed;
      try {
        this.transport?.close();
      } catch {
        /* ignore */
      }
      this.transport = null;
      this.stopSignalsWatcher();
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
  }

  /**
   * Ensure `grok agent serve` is up and attach a **shared** WS hub view.
   *
   * Multi-WS (one socket per Pane session) was verified to break concurrency on
   * 0.2.101: updates only reach one client and the other session/prompt hangs.
   * One connection + sessionId demux is required.
   */
  private async openServeTransport(): Promise<void> {
    const hub = AcpWsHub.shared();
    await hub.ensureReady();
    const view = hub.openView({ domainSessionId: this.domainSessionId });
    view.setHandlers(this.bindHandlers());
    this.serveView = view;
    this.transport = view;
  }
}
