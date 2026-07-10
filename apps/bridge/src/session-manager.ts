import type { ClientCommand, DomainEvent } from "@agent-pane/shared";
import { nowIso } from "@agent-pane/shared";
import { EventStore, type StoredEvent } from "./event-store.js";
import { GrokAcpAdapter } from "./grok-acp-adapter.js";
import { WorkspaceSnapshotService } from "./workspace-snapshot.js";
import { DiffEngine, fileFingerprint } from "./diff-engine.js";
import {
  invalidateSessionEventsCache,
  loadSessionEvents,
  pruneDraftSessions,
  readMeta,
  upsertMeta,
} from "./history-index.js";

export type Broadcast = (msg: unknown) => void;

type LiveSession = {
  domainSessionId: string;
  cwd: string;
  model?: string;
  /** agent | auto | plan | ask | default … */
  permissionMode: string;
  providerSessionId?: string;
  adapter: GrokAcpAdapter;
  /**
   * Accept 过的文件指纹。内容没变则不再展示 Diff。
   * 文件再被改动后指纹变化，会重新出现在 Diff 里。
   */
  acceptedFp: Map<string, string>;
};

function modeUsesAlwaysApprove(mode: string): boolean {
  // agent / always / yolo → full auto-approve tools
  // auto / ask / default / plan → let grok prompt (plan also restricts via prompt)
  const m = mode.toLowerCase();
  return m === "agent" || m === "always" || m === "always-approve" || m === "yolo";
}

/** Compact transcript so a fresh ACP session can continue the chat. */
function buildHistoryDigest(sessionId: string, maxTurns = 12): string {
  const events = loadSessionEvents(sessionId, true);
  if (!events.length) return "";
  const lines: string[] = [
    "[Conversation resume context — this is a continued chat in the same UI session.",
    "Stay in character and continue from the last turns. Do not claim you are starting fresh.]",
  ];
  let turns = 0;
  let assistantBuf = "";
  const flushAssistant = () => {
    const t = assistantBuf.trim();
    if (!t) return;
    const clipped = t.length > 1200 ? `${t.slice(0, 1200)}…` : t;
    lines.push(`Assistant: ${clipped}`);
    assistantBuf = "";
  };
  for (const e of events) {
    if (e.type === "UserMessageAppended") {
      flushAssistant();
      turns++;
      if (turns > maxTurns) {
        const header = lines.slice(0, 2);
        const body = lines.slice(2);
        const keep = body.slice(-maxTurns * 2);
        lines.length = 0;
        lines.push(...header, ...keep);
      }
      lines.push(`User: ${e.text.slice(0, 800)}`);
    } else if (e.type === "MessageChunk") {
      assistantBuf += e.text;
    } else if (e.type === "MessageDone") {
      flushAssistant();
    }
  }
  flushAssistant();
  if (lines.length <= 2) return "";
  return lines.join("\n");
}

export class SessionManager {
  private store: EventStore;
  private snapshots: WorkspaceSnapshotService;
  private diffEngine: DiffEngine;
  private live = new Map<string, LiveSession>();
  private broadcast: Broadcast;
  private permissionMode: string;

  constructor(opts: {
    store?: EventStore;
    broadcast: Broadcast;
    permissionMode?: string;
  }) {
    this.store = opts.store ?? new EventStore();
    this.snapshots = new WorkspaceSnapshotService();
    this.diffEngine = new DiffEngine();
    this.broadcast = opts.broadcast;
    this.permissionMode = opts.permissionMode ?? "auto";
  }

  private publish(event: DomainEvent): StoredEvent {
    // Resume re-attach must not write a second SessionStarted into history
    if (event.type === "SessionStarted" && event.resumed) {
      const live = this.live.get(event.sessionId);
      if (live && event.providerSessionId) {
        live.providerSessionId = event.providerSessionId;
      }
      if (event.providerSessionId) {
        upsertMeta({
          sessionId: event.sessionId,
          cwd: event.cwd,
          providerSessionId: event.providerSessionId,
        });
      }
      const ephemeral = { ...event, seq: 0 } as StoredEvent;
      this.broadcast({ type: "event", event: ephemeral });
      return ephemeral;
    }

    const stored = this.store.append(event);
    this.broadcast({ type: "event", event: stored });
    invalidateSessionEventsCache(event.sessionId);

    // History only after the user actually starts chatting — bare New Agent
    // must not clutter the sidebar with "New session" drafts.
    if (event.type === "UserMessageAppended") {
      const live = this.live.get(event.sessionId);
      upsertMeta({
        sessionId: event.sessionId,
        cwd: live?.cwd,
        title: event.text,
        bumpMessage: true,
        providerSessionId: live?.providerSessionId,
      });
    } else if (event.type === "SessionStarted" && event.providerSessionId) {
      // live map may not be set yet during start(); createSession sets it after
      const live = this.live.get(event.sessionId);
      if (live) live.providerSessionId = event.providerSessionId;
    }

    return stored;
  }

  /** Stop a live agent (if any) so disk delete won't race with writes. */
  async stopSession(sessionId: string): Promise<void> {
    const s = this.live.get(sessionId);
    if (!s) return;
    try {
      await s.adapter.stop();
    } catch {
      /* best effort */
    }
    this.live.delete(sessionId);
    // Drop in-memory events so list/load cannot resurrect the folder
    this.store.purge(sessionId);
  }

  /** After disk delete: purge store even if session was not live. */
  purgeSession(sessionId: string): void {
    this.live.delete(sessionId);
    this.store.purge(sessionId);
  }

  async handleCommand(cmd: ClientCommand): Promise<void> {
    switch (cmd.type) {
      case "session.create":
        await this.createSession(
          cmd.cwd,
          cmd.model,
          cmd.permissionMode ?? this.permissionMode
        );
        break;
      case "session.resume":
        await this.resumeSession({
          sessionId: cmd.sessionId,
          cwd: cmd.cwd,
          model: cmd.model,
          permissionMode: cmd.permissionMode ?? this.permissionMode,
        });
        break;
      case "session.prompt":
        await this.prompt(cmd.sessionId, cmd.text, cmd.attachments);
        break;
      case "session.cancel":
        await this.live.get(cmd.sessionId)?.adapter.cancel(cmd.sessionId);
        break;
      case "session.undoLast": {
        const live = this.live.get(cmd.sessionId);
        if (!live) {
          this.broadcast({ type: "error", message: "Unknown session" });
          break;
        }
        try {
          await live.adapter.undoLastTurn();
        } catch (e) {
          this.broadcast({
            type: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
        break;
      }
      case "session.replay": {
        const events = this.store.list(cmd.sessionId, cmd.fromSeq ?? 0);
        this.broadcast({
          type: "replay",
          sessionId: cmd.sessionId,
          events,
        });
        break;
      }
      case "permission.respond": {
        for (const s of this.live.values()) {
          await s.adapter.respondPermission(cmd.requestId, cmd.allow);
        }
        break;
      }
      case "diff.accept":
        await this.diffAccept(cmd.sessionId, cmd.filePath);
        break;
      case "diff.reject":
        await this.diffReject(cmd.sessionId, cmd.filePath);
        break;
      case "diff.refresh":
        this.refreshDiff(cmd.sessionId);
        break;
      default:
        break;
    }
  }

  /** 关掉所有（或指定 cwd）旧 adapter，避免 grok agent 进程堆僵尸 */
  private async stopLiveSessions(filterCwd?: string): Promise<void> {
    const entries = [...this.live.entries()];
    for (const [id, s] of entries) {
      if (filterCwd && s.cwd !== filterCwd) continue;
      try {
        await s.adapter.stop();
      } catch {
        /* best effort */
      }
      this.live.delete(id);
    }
  }

  private wireAdapter(adapter: GrokAcpAdapter): void {
    adapter.onEvent((e) => {
      this.publish(e);
      if (e.type === "ToolFinished" || e.type === "MessageDone") {
        const sid = e.sessionId;
        setTimeout(() => this.refreshDiff(sid), 300);
      }
    });
    // Process died: drop live entry but keep event log for resume
    adapter.onDead((domainSessionId) => {
      const s = this.live.get(domainSessionId);
      if (s?.adapter === adapter) {
        this.live.delete(domainSessionId);
      }
    });
  }

  private async createSession(
    cwd: string,
    model?: string,
    permissionMode?: string
  ): Promise<void> {
    // 先清旧会话——这是「New Agent 点了像死了」的主因
    await this.stopLiveSessions();

    const mode = (permissionMode ?? this.permissionMode ?? "agent").toLowerCase();
    this.permissionMode = mode;

    this.broadcast({
      type: "status",
      message: "正在启动 Grok agent…",
    });

    const adapter = new GrokAcpAdapter({
      autoApprove: modeUsesAlwaysApprove(mode),
    });
    this.wireAdapter(adapter);

    let started: {
      providerSessionId: string;
      domainSessionId: string;
      resumed?: boolean;
      cwd: string;
      model?: string;
    };
    try {
      started = await adapter.start({
        cwd,
        model,
        // adapter maps ask/default → no --always-approve; else always-approve
        permissionMode: modeUsesAlwaysApprove(mode) ? "auto" : "ask",
      });
    } catch (e) {
      this.broadcast({
        type: "error",
        message: `启动失败: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    const domainSessionId = started.domainSessionId;
    const providerSessionId = started.providerSessionId;
    // Register live BEFORE SessionStarted so pending prompts never race empty map
    this.live.set(domainSessionId, {
      domainSessionId,
      cwd,
      model,
      permissionMode: mode,
      providerSessionId,
      adapter,
      acceptedFp: new Map(),
    });

    this.publish({
      type: "SessionStarted",
      sessionId: domainSessionId,
      cwd,
      model,
      resumed: false,
      providerSessionId,
      at: nowIso(),
    });

    // Persist provider id as soon as agent is up (needed for later resume)
    // Only touch meta if session already has history (avoid empty drafts in list)
    if (readMeta(domainSessionId)) {
      upsertMeta({ sessionId: domainSessionId, cwd, providerSessionId });
    }

    // Drop leftover empty "New session" dirs from previous New Agent clicks
    try {
      pruneDraftSessions({ keepSessionId: domainSessionId, cwd });
    } catch {
      /* non-fatal */
    }

    try {
      const snap = this.snapshots.take(domainSessionId, cwd);
      this.publish({
        type: "SnapshotTaken",
        sessionId: domainSessionId,
        snapshotId: snap.snapshotId,
        at: nowIso(),
      });
    } catch (e) {
      this.publish({
        type: "SessionError",
        sessionId: domainSessionId,
        message: `Snapshot failed: ${e instanceof Error ? e.message : e}`,
        at: nowIso(),
      });
    }

    this.refreshDiff(domainSessionId);
  }

  /**
   * Re-attach a live Grok agent to an existing history session so follow-ups
   * continue the same conversation (same domain sessionId on disk).
   */
  private async resumeSession(opts: {
    sessionId: string;
    cwd: string;
    model?: string;
    permissionMode?: string;
  }): Promise<void> {
    const { sessionId, cwd } = opts;
    const existing = this.live.get(sessionId);
    if (existing?.adapter.isAlive()) {
      // Already live — just tell UI we're attached
      this.broadcast({
        type: "event",
        event: {
          type: "SessionStarted",
          sessionId,
          cwd: existing.cwd,
          model: existing.model,
          resumed: true,
          providerSessionId: existing.providerSessionId,
          at: nowIso(),
        },
      });
      return;
    }
    // Stale live entry (process died but map not cleared yet)
    if (existing) {
      try {
        await existing.adapter.stop();
      } catch {
        /* ignore */
      }
      this.live.delete(sessionId);
    }

    const mode = (opts.permissionMode ?? this.permissionMode ?? "agent").toLowerCase();
    this.permissionMode = mode;
    const meta = readMeta(sessionId);
    const providerSessionId =
      meta?.providerSessionId ?? existing?.providerSessionId;

    // Stop other lives but do NOT purge this session's event store
    const others = [...this.live.entries()].filter(([id]) => id !== sessionId);
    for (const [id, s] of others) {
      try {
        await s.adapter.stop();
      } catch {
        /* best effort */
      }
      this.live.delete(id);
    }

    this.broadcast({
      type: "status",
      message: "正在恢复会话…",
    });

    const adapter = new GrokAcpAdapter({
      autoApprove: modeUsesAlwaysApprove(mode),
    });
    this.wireAdapter(adapter);

    const resumeCwd = cwd || meta?.cwd || existing?.cwd || "";
    const resumeModel = opts.model ?? existing?.model;
    let started: {
      providerSessionId: string;
      domainSessionId: string;
      needsHistoryDigest?: boolean;
    };
    try {
      started = await adapter.start({
        cwd: resumeCwd,
        model: resumeModel,
        permissionMode: modeUsesAlwaysApprove(mode) ? "auto" : "ask",
        domainSessionId: sessionId,
        // Keep id for bookkeeping; start() no longer session/load (prompt hang).
        providerSessionId,
        resumed: true,
      });
    } catch (e) {
      this.broadcast({
        type: "error",
        message: `恢复会话失败: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    const loadedProvider = started.providerSessionId;
    // Always inject our event-log digest on resume (fresh ACP session).
    const digest = buildHistoryDigest(sessionId);
    if (digest) adapter.setContextPrefix(digest);

    // live BEFORE SessionStarted — fixes race where UI prompts into empty map
    this.live.set(sessionId, {
      domainSessionId: sessionId,
      cwd: resumeCwd,
      model: resumeModel,
      permissionMode: mode,
      providerSessionId: loadedProvider,
      adapter,
      acceptedFp: new Map(),
    });

    this.publish({
      type: "SessionStarted",
      sessionId,
      cwd: resumeCwd,
      model: resumeModel,
      resumed: true,
      providerSessionId: loadedProvider,
      at: nowIso(),
    });

    // Always refresh provider id on disk after successful resume
    upsertMeta({
      sessionId,
      cwd: resumeCwd,
      providerSessionId: loadedProvider,
    });

    try {
      const snap = this.snapshots.take(sessionId, resumeCwd);
      this.publish({
        type: "SnapshotTaken",
        sessionId,
        snapshotId: snap.snapshotId,
        at: nowIso(),
      });
    } catch {
      /* non-fatal on resume */
    }

    this.refreshDiff(sessionId);
  }

  private async prompt(
    sessionId: string,
    text: string,
    attachments?: { path: string; kind: "file" | "folder" }[]
  ): Promise<void> {
    let live = this.live.get(sessionId);
    // Idle / process died: auto-resume same history session before prompting
    if (!live || !live.adapter.isAlive()) {
      const meta = readMeta(sessionId);
      await this.resumeSession({
        sessionId,
        cwd: live?.cwd || meta?.cwd || "",
        model: live?.model,
        permissionMode: live?.permissionMode,
      });
      live = this.live.get(sessionId);
      if (!live || !live.adapter.isAlive()) {
        this.broadcast({
          type: "error",
          message: "Session disconnected — resume failed, try Send again",
        });
        return;
      }
    }

    // `/usage` is a Grok TUI/pager command — not handled by ACP session/prompt
    // (agent would treat it as normal chat). We implement it via `_x.ai/billing`.
    const slashName = text.trim().match(/^\/([a-zA-Z][\w-]*)/)?.[1]?.toLowerCase();
    if (slashName === "usage" || slashName === "billing") {
      try {
        this.broadcast({ type: "status", message: "Fetching usage…" });
        const u = await live.adapter.fetchBillingUsage();
        const pct =
          u.creditUsagePercent != null
            ? `${Math.round(u.creditUsagePercent)}%`
            : "—";
        const fmtDate = (iso?: string) => {
          if (!iso) return "—";
          try {
            return new Date(iso).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });
          } catch {
            return iso;
          }
        };
        const periodLabel =
          u.periodType?.includes("WEEKLY") || u.periodType?.includes("weekly")
            ? "Weekly"
            : u.periodType?.replace(/^USAGE_PERIOD_TYPE_/, "") || "Current";
        const barFilled = Math.min(
          20,
          Math.max(0, Math.round((u.creditUsagePercent ?? 0) / 5))
        );
        const bar =
          "█".repeat(barFilled) + "░".repeat(Math.max(0, 20 - barFilled));
        const lines = [
          `**Usage · ${u.subscriptionTier || "Grok"}**`,
          "",
          `${periodLabel} credits: **${pct}** used`,
          `\`${bar}\``,
          "",
          `Period: ${fmtDate(u.periodStart)} → ${fmtDate(u.periodEnd)}`,
        ];
        if (u.onDemandCap != null || u.onDemandUsed != null) {
          lines.push(
            `On-demand: ${u.onDemandUsed ?? 0} / ${u.onDemandCap ?? "—"}`
          );
        }
        if (u.prepaidBalance != null && u.prepaidBalance !== 0) {
          lines.push(`Prepaid balance: ${u.prepaidBalance}`);
        }
        lines.push("", "_Source: Grok `_x.ai/billing` (same as TUI `/usage`)._");
        live.adapter.emitLocalReply(text.trim(), lines.join("\n"));
        this.broadcast({ type: "status", message: " " }); // clear strip
      } catch (e) {
        this.broadcast({
          type: "error",
          message: `Usage lookup failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        });
      }
      return;
    }

    let body = text;
    // Slash commands (/compact, /context, …) must stay bare — plan-mode
    // preamble would prevent Grok shell from intercepting them.
    const isSlash = /^\s*\/[a-zA-Z]/.test(text);
    if (live.permissionMode === "plan" && !isSlash) {
      body =
        "[Plan mode active: do NOT edit, create, or delete files. " +
        "Research if needed, then produce a clear step-by-step plan only. " +
        "Wait for approval before any implementation.]\n\n" +
        text;
    }
    try {
      await live.adapter.sendPrompt({
        sessionId,
        text: body,
        displayText: text,
        attachments,
      });
    } catch (e) {
      // One more retry after forced resume (stale provider / dead pipe)
      const msg = e instanceof Error ? e.message : String(e);
      if (/not alive|EPIPE|exited|disconnect/i.test(msg)) {
        this.live.delete(sessionId);
        const meta = readMeta(sessionId);
        await this.resumeSession({
          sessionId,
          cwd: live.cwd || meta?.cwd || "",
          model: live.model,
          permissionMode: live.permissionMode,
        });
        const again = this.live.get(sessionId);
        if (again?.adapter.isAlive()) {
          await again.adapter.sendPrompt({
            sessionId,
            text: body,
            displayText: text,
            attachments,
            // UserMessage already recorded on first attempt (or not — if
            // fail-before-emit, skipUserEvent false would be safer; we only
            // get here after emit for RPC failures, so skip duplicate).
            skipUserEvent: !/not alive/i.test(msg),
          });
          return;
        }
      }
      this.broadcast({
        type: "error",
        message: msg || "Prompt failed",
      });
    }
  }

  private refreshDiff(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    const snap = this.snapshots.get(sessionId);
    let files = this.diffEngine.compute(live.cwd, snap);

    // 过滤已 Accept 且内容未再变的文件
    files = files.filter((f) => {
      const accepted = live.acceptedFp.get(f.path);
      if (!accepted) return true;
      const now = fileFingerprint(live.cwd, f.path);
      return now !== accepted;
    });

    this.publish({
      type: "DiffProposed",
      sessionId,
      files,
      at: nowIso(),
    });
  }

  private async diffAccept(sessionId: string, filePath: string | "*"): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) {
      this.broadcast({ type: "error", message: "Unknown session — 新开会话后再 Accept" });
      return;
    }

    try {
      const snap = this.snapshots.get(sessionId);
      const current = this.diffEngine.compute(live.cwd, snap);
      const targets =
        filePath === "*"
          ? current.map((f) => f.path)
          : [filePath];

      for (const p of targets) {
        live.acceptedFp.set(p, fileFingerprint(live.cwd, p));
      }

      // 推进 baseline（给 Reject 用）；Accept 本身 = 保留磁盘现状
      try {
        this.snapshots.advance(sessionId);
      } catch {
        /* non-fatal */
      }

      this.publish({
        type: "DiffResolved",
        sessionId,
        filePath,
        action: "accept",
        at: nowIso(),
      });

      const after = this.snapshots.get(sessionId);
      if (after) {
        this.publish({
          type: "SnapshotTaken",
          sessionId,
          snapshotId: after.snapshotId,
          at: nowIso(),
        });
      }

      // 必须在标记 accepted 之后 refresh，卡片才会真正消失
      this.refreshDiff(sessionId);
    } catch (e) {
      this.publish({
        type: "SessionError",
        sessionId,
        message: e instanceof Error ? e.message : String(e),
        at: nowIso(),
      });
    }
  }

  private async diffReject(sessionId: string, filePath: string | "*"): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) {
      this.broadcast({ type: "error", message: "Unknown session — 新开会话后再 Reject" });
      return;
    }

    try {
      if (filePath === "*") {
        live.acceptedFp.clear();
      } else {
        live.acceptedFp.delete(filePath);
      }

      this.snapshots.restore(sessionId, filePath);

      this.publish({
        type: "SnapshotRestored",
        sessionId,
        snapshotId: this.snapshots.get(sessionId)?.snapshotId ?? "",
        at: nowIso(),
      });
      this.publish({
        type: "DiffResolved",
        sessionId,
        filePath,
        action: "reject",
        at: nowIso(),
      });
      this.refreshDiff(sessionId);
    } catch (e) {
      this.publish({
        type: "SessionError",
        sessionId,
        message: e instanceof Error ? e.message : String(e),
        at: nowIso(),
      });
    }
  }
}
