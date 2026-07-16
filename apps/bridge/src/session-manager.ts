import type { ClientCommand, DomainEvent } from "@agent-pane/shared";
import { nowIso } from "@agent-pane/shared";
import { EventStore, type StoredEvent } from "./event-store.js";
import {
  createAgentProvider,
  type AgentProvider,
} from "./provider-api.js";
import { WorkspaceSnapshotService } from "./workspace-snapshot.js";
import { DiffEngine, fileFingerprint } from "./diff-engine.js";
import {
  invalidateHistoryListCache,
  invalidateSessionEventsCache,
  loadSessionEvents,
  pruneDraftSessions,
  readMeta,
  upsertMeta,
  writeMeta,
} from "./history-index.js";

export type Broadcast = (msg: unknown) => void;

type LiveSession = {
  domainSessionId: string;
  cwd: string;
  model?: string;
  effort?: string;
  /** agent | auto | plan | ask | default … */
  permissionMode: string;
  providerSessionId?: string;
  /** Runtime behind AgentProvider — never concrete Grok type at Host layer. */
  adapter: AgentProvider;
  /**
   * Accept 过的文件指纹。内容没变则不再展示 Diff。
   * 文件再被改动后指纹变化，会重新出现在 Diff 里。
   */
  acceptedFp: Map<string, string>;
};

function modeUsesAlwaysApprove(mode: string): boolean {
  // agent / debug / multitask / always / yolo → full auto-approve tools
  // auto / ask / default / plan → let grok prompt (plan also restricts via prompt)
  const m = mode.toLowerCase();
  return (
    m === "agent" ||
    m === "debug" ||
    m === "multitask" ||
    m === "always" ||
    m === "always-approve" ||
    m === "yolo"
  );
}

/** UI modes → stored permissionMode (plan preamble / tool gate) */
function normalizePermissionMode(mode?: string): string {
  const m = (mode ?? "agent").toLowerCase();
  if (m === "plan") return "plan";
  if (m === "auto" || m === "ask") return "auto";
  return "agent";
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
  /** Serialize create/resume only — prompts must run concurrently across sessions */
  private globalQueue: Promise<void> = Promise.resolve();
  private sessionQueues = new Map<string, Promise<void>>();

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

  /** Tell UI which sessions currently have a live agent */
  private broadcastLive(): void {
    this.broadcast({
      type: "live",
      sessionIds: [...this.live.keys()],
    });
  }

  listLiveSessionIds(): string[] {
    return [...this.live.keys()];
  }

  /**
   * Resolve live agent handle for a Pane sessionId.
   * Used by HTTP context-usage: prefer live provider id over meta / event archaeology.
   */
  getLiveSessionInfo(
    sessionId: string
  ): { cwd: string; providerSessionId?: string; alive: boolean } | null {
    const live = this.live.get(sessionId);
    if (!live) return null;
    return {
      cwd: live.cwd || "",
      providerSessionId: live.providerSessionId,
      alive: live.adapter.isAlive(),
    };
  }

  private enqueueGlobal(fn: () => Promise<void>): Promise<void> {
    const run = this.globalQueue.then(fn);
    this.globalQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private enqueueSession(
    sessionId: string,
    fn: () => Promise<void>
  ): Promise<void> {
    const prev = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const run = prev.then(fn);
    this.sessionQueues.set(
      sessionId,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
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

    // Rewind: truncate disk first, then broadcast (don't persist SessionRewound —
    // the truncated jsonl is the source of truth, Claude Code style).
    if (event.type === "SessionRewound") {
      try {
        this.store.truncateBeforeUserTurn(
          event.sessionId,
          event.userTurnIndex
        );
      } catch {
        /* still notify UI */
      }
      invalidateSessionEventsCache(event.sessionId);
      try {
        const kept = this.store.list(event.sessionId, 0);
        const msgCount = kept.filter((e) => e.type === "UserMessageAppended")
          .length;
        const live = this.live.get(event.sessionId);
        const prev = readMeta(event.sessionId);
        if (prev) {
          writeMeta({
            ...prev,
            cwd: live?.cwd || prev.cwd,
            messageCount: msgCount,
            updatedAt: new Date().toISOString(),
          });
          invalidateHistoryListCache();
        }
      } catch {
        /* non-fatal */
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
    this.broadcastLive();
    // Drop in-memory events so list/load cannot resurrect the folder
    this.store.purge(sessionId);
  }

  /** After disk delete: purge store even if session was not live. */
  purgeSession(sessionId: string): void {
    this.live.delete(sessionId);
    this.store.purge(sessionId);
    this.broadcastLive();
  }

  async handleCommand(cmd: ClientCommand): Promise<void> {
    // create/resume mutate the live map — keep a global mutex to avoid orphans
    if (cmd.type === "session.create" || cmd.type === "session.resume") {
      await this.enqueueGlobal(() => this.handleCommandInner(cmd));
      return;
    }
    // CRITICAL: cancel must NOT wait behind in-flight session.prompt.
    // enqueueSession is FIFO — if prompt awaits sleep/tools for 30s, cancel
    // only ran after the turn ended → UI looked stopped (turnDoneRef) while
    // Core + scripts kept running (false interrupt).
    if (cmd.type === "session.cancel") {
      const live = this.live.get(cmd.sessionId);
      if (live) {
        // Fire immediately; do not await other session work
        void live.adapter.cancel(cmd.sessionId).catch((e) => {
          console.warn(
            `[session] cancel failed:`,
            e instanceof Error ? e.message : e
          );
        });
      }
      return;
    }
    // prompt/diff/permission/rewind: per-session queue so A sleeping
    // does not block B from sending
    const sid =
      "sessionId" in cmd && typeof cmd.sessionId === "string"
        ? cmd.sessionId
        : null;
    if (sid) {
      await this.enqueueSession(sid, () => this.handleCommandInner(cmd));
      return;
    }
    await this.handleCommandInner(cmd);
  }

  private async handleCommandInner(cmd: ClientCommand): Promise<void> {
    switch (cmd.type) {
      case "session.create":
        await this.createSession(
          cmd.cwd,
          cmd.model,
          cmd.permissionMode ?? this.permissionMode,
          cmd.effort,
          cmd.clientRequestId
        );
        break;
      case "session.resume":
        await this.resumeSession({
          sessionId: cmd.sessionId,
          cwd: cmd.cwd,
          model: cmd.model,
          effort: cmd.effort,
          permissionMode: cmd.permissionMode ?? this.permissionMode,
        });
        break;
      case "session.prompt":
        await this.prompt(
          cmd.sessionId,
          cmd.text,
          cmd.attachments,
          cmd.permissionMode
        );
        break;
      case "session.cancel":
        await this.live.get(cmd.sessionId)?.adapter.cancel(cmd.sessionId);
        break;
      case "session.undoLast": {
        const live = this.live.get(cmd.sessionId);
        if (!live) {
          this.rewindOffline(cmd.sessionId, -1);
          break;
        }
        try {
          this.hydrateProviderTurns(live.adapter, cmd.sessionId);
          const r = await live.adapter.undoLastTurn();
          // undoLastTurn is last-turn only; index = length-1 before rewind slice
          const texts = this.store
            .list(cmd.sessionId, 0)
            .filter((e) => e.type === "UserMessageAppended");
          await this.finishRewind(cmd.sessionId, live, {
            restoredText: r.restoredText,
            userTurnIndex: Math.max(0, texts.length - 1),
            providerOk: r.providerOk,
            note: r.note,
          });
        } catch (e) {
          this.broadcast({
            type: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
        break;
      }
      case "session.rewindTo": {
        const live = this.live.get(cmd.sessionId);
        if (!live) {
          this.rewindOffline(cmd.sessionId, cmd.userTurnIndex);
          break;
        }
        try {
          this.hydrateProviderTurns(live.adapter, cmd.sessionId);
          const r = await live.adapter.rewindToUserTurn(cmd.userTurnIndex);
          await this.finishRewind(cmd.sessionId, live, r);
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
        const sid = cmd.sessionId;
        if (sid) {
          const live = this.live.get(sid);
          if (live) {
            await live.adapter.respondPermission(cmd.requestId, cmd.allow);
            break;
          }
        }
        // Route to the adapter that owns this requestId (multi-live safe)
        for (const s of this.live.values()) {
          if (s.adapter.hasPendingPermission(cmd.requestId)) {
            await s.adapter.respondPermission(cmd.requestId, cmd.allow);
            break;
          }
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

  /**
   * Host-owned turn list: rebuild from Pane EventStore before any undo/rewind
   * so provider indices match disk (resume leaves adapter turns empty).
   */
  private hydrateProviderTurns(
    adapter: AgentProvider,
    sessionId: string
  ): string[] {
    const texts = this.store
      .list(sessionId, 0)
      .filter((e) => e.type === "UserMessageAppended")
      .map((e) => (e as { text?: string }).text ?? "");
    adapter.hydrateUserTurns(texts);
    return texts;
  }

  /**
   * Truncate disk → optional Core rebind → notify UI (SessionRewound once).
   * Order matters: UI re-prompts only after provider context is clean.
   */
  private async finishRewind(
    sessionId: string,
    live: LiveSession,
    r: {
      restoredText: string;
      userTurnIndex: number;
      providerOk: boolean;
      note?: string;
    }
  ): Promise<void> {
    try {
      this.store.truncateBeforeUserTurn(sessionId, r.userTurnIndex);
      invalidateSessionEventsCache(sessionId);
      const kept = this.store.list(sessionId, 0);
      const msgCount = kept.filter((e) => e.type === "UserMessageAppended")
        .length;
      const prev = readMeta(sessionId);
      if (prev) {
        writeMeta({
          ...prev,
          cwd: live.cwd || prev.cwd,
          messageCount: msgCount,
          updatedAt: new Date().toISOString(),
        });
        invalidateHistoryListCache();
      }
    } catch {
      /* still rebind / notify */
    }

    let providerOk = r.providerOk;
    let note = r.note;
    if (!providerOk) {
      await this.rebindProviderAfterRewind(sessionId, live);
      // Rebind is the recovery path — context matches truncated Pane log
      providerOk = true;
      note = undefined;
    }

    this.broadcast({
      type: "event",
      event: {
        type: "SessionRewound",
        sessionId,
        restoredText: r.restoredText,
        userTurnIndex: r.userTurnIndex,
        providerOk,
        note,
        at: nowIso(),
        seq: 0,
      },
    });
  }

  /**
   * Core rewind failed / no points — start a clean provider session and inject
   * a digest of the *already truncated* Pane log so Retry/Undo context matches UI.
   */
  private async rebindProviderAfterRewind(
    sessionId: string,
    live: LiveSession
  ): Promise<void> {
    const rebind = live.adapter.rebindProviderSession;
    if (!rebind) {
      console.warn(
        `[session] rebind not supported for provider ${live.adapter.id}`
      );
      return;
    }
    try {
      const { providerSessionId } = await rebind.call(live.adapter, {
        cwd: live.cwd,
        model: live.model,
        effort: live.effort,
      });
      live.providerSessionId = providerSessionId;
      // Digest from disk (SessionRewound already truncated events.jsonl)
      const digest = buildHistoryDigest(sessionId, 40);
      live.adapter.setContextPrefix(digest || null);
      this.hydrateProviderTurns(live.adapter, sessionId);
      console.log(
        `[session] rebind after rewind session=${sessionId.slice(0, 8)} ` +
          `provider=${providerSessionId.slice(0, 8)} digestChars=${digest.length}`
      );
    } catch (e) {
      console.warn(
        `[session] rebind after rewind failed:`,
        e instanceof Error ? e.message : e
      );
      this.broadcast({
        type: "error",
        message: `Provider rebind after undo failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    }
  }

  /**
   * History-only / dead agent rewind: truncate events + broadcast SessionRewound.
   * `userTurnIndex` -1 means last user turn.
   */
  private rewindOffline(sessionId: string, userTurnIndex: number): void {
    const events = this.store.list(sessionId, 0);
    const userTexts = events
      .filter((e) => e.type === "UserMessageAppended")
      .map((e) => (e as { text?: string }).text ?? "");
    if (userTexts.length === 0) {
      this.broadcast({ type: "error", message: "Nothing to undo" });
      return;
    }
    const idx =
      userTurnIndex < 0 ? userTexts.length - 1 : Math.floor(userTurnIndex);
    if (idx < 0 || idx >= userTexts.length) {
      this.broadcast({ type: "error", message: "Invalid turn to undo" });
      return;
    }
    this.publish({
      type: "SessionRewound",
      sessionId,
      restoredText: userTexts[idx]!,
      userTurnIndex: idx,
      providerOk: false,
      note: "UI undid the turn (agent not attached)",
      at: nowIso(),
    });
  }

  /**
   * Stop live adapters (optional cwd filter). Kept for explicit teardown —
   * create/resume no longer call this so multiple agents can run in parallel.
   */
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
    this.broadcastLive();
  }

  private wireAdapter(adapter: AgentProvider): void {
    adapter.onEvent((e) => {
      this.publish(e);
      if (e.type === "ContextUsage" && e.providerSessionId) {
        const live = this.live.get(e.sessionId);
        if (live && live.providerSessionId !== e.providerSessionId) {
          live.providerSessionId = e.providerSessionId;
          try {
            upsertMeta({
              sessionId: e.sessionId,
              cwd: live.cwd,
              providerSessionId: e.providerSessionId,
            });
          } catch {
            /* non-fatal */
          }
        }
      }
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
        this.broadcastLive();
      }
    });
  }

  private async createSession(
    cwd: string,
    model?: string,
    permissionMode?: string,
    effort?: string,
    clientRequestId?: string
  ): Promise<void> {
    // Multi-live: do NOT stop other sessions — Multitask / New Agent run in parallel

    const mode = normalizePermissionMode(
      permissionMode ?? this.permissionMode ?? "agent"
    );
    this.permissionMode = mode;

    this.broadcast({
      type: "status",
      message: "Starting Grok agent…",
      clientRequestId,
    });

    const adapter = await createAgentProvider({
      autoApprove: modeUsesAlwaysApprove(mode),
    });
    this.wireAdapter(adapter);

    let started: {
      providerSessionId: string;
      domainSessionId: string;
      resumed?: boolean;
      cwd: string;
      model?: string;
      effort?: string;
    };
    try {
      started = await adapter.start({
        cwd,
        model,
        effort,
        // adapter maps ask/default → no --always-approve; else always-approve
        permissionMode: modeUsesAlwaysApprove(mode) ? "auto" : "ask",
      });
    } catch (e) {
      this.broadcast({
        type: "error",
        message: `Start failed: ${e instanceof Error ? e.message : String(e)}`,
        clientRequestId,
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
      effort,
      permissionMode: mode,
      providerSessionId,
      adapter,
      acceptedFp: new Map(),
    });
    this.broadcastLive();

    this.publish({
      type: "SessionStarted",
      sessionId: domainSessionId,
      cwd,
      model,
      resumed: false,
      providerSessionId,
      clientRequestId,
      at: nowIso(),
    });

    // Immediate context fill from Grok signals.json (watcher also keeps it fresh)
    try {
      adapter.publishSignalsUsageOnce?.();
    } catch {
      /* non-fatal */
    }

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
    effort?: string;
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

    const mode = normalizePermissionMode(
      opts.permissionMode ?? this.permissionMode ?? "agent"
    );
    this.permissionMode = mode;
    const meta = readMeta(sessionId);
    const providerSessionId =
      meta?.providerSessionId ?? existing?.providerSessionId;

    // Multi-live: do NOT stop other sessions
    this.broadcast({
      type: "status",
      message: "Resuming session…",
      sessionId,
    });

    const adapter = await createAgentProvider({
      autoApprove: modeUsesAlwaysApprove(mode),
    });
    this.wireAdapter(adapter);

    const resumeCwd = cwd || meta?.cwd || existing?.cwd || "";
    const resumeModel = opts.model ?? existing?.model;
    const resumeEffort = opts.effort ?? existing?.effort;
    let started: {
      providerSessionId: string;
      domainSessionId: string;
      needsHistoryDigest?: boolean;
    };
    try {
      started = await adapter.start({
        cwd: resumeCwd,
        model: resumeModel,
        effort: resumeEffort,
        permissionMode: modeUsesAlwaysApprove(mode) ? "auto" : "ask",
        domainSessionId: sessionId,
        // Bookkeeping only — start() always session/new + digest (session/load hangs).
        providerSessionId,
        resumed: true,
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // Don't slap a generic "启动超时" hint on auth/login errors
      const hint =
        /timed out/i.test(raw) && !/登录|login|Authentication|认证/i.test(raw)
          ? "（可再点 Send 重试）"
          : "";
      this.broadcast({
        type: "error",
        message: `Resume failed: ${raw}${hint}`,
        sessionId,
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
      effort: resumeEffort,
      permissionMode: mode,
      providerSessionId: loadedProvider,
      adapter,
      acceptedFp: new Map(),
    });
    this.broadcastLive();
    // Host EventStore → provider turn indices (resume leaves adapter turns empty)
    this.hydrateProviderTurns(adapter, sessionId);

    this.publish({
      type: "SessionStarted",
      sessionId,
      cwd: resumeCwd,
      model: resumeModel,
      resumed: true,
      providerSessionId: loadedProvider,
      at: nowIso(),
    });

    try {
      adapter.publishSignalsUsageOnce?.();
    } catch {
      /* non-fatal */
    }

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
    attachments?: { path: string; kind: "file" | "folder" }[],
    permissionMode?: string
  ): Promise<void> {
    let live = this.live.get(sessionId);
    // Idle / process died: auto-resume same history session before prompting
    if (!live || !live.adapter.isAlive()) {
      const meta = readMeta(sessionId);
      await this.resumeSession({
        sessionId,
        cwd: live?.cwd || meta?.cwd || "",
        model: live?.model,
        effort: live?.effort,
        permissionMode:
          permissionMode ?? live?.permissionMode,
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

    if (permissionMode) {
      live.permissionMode = normalizePermissionMode(permissionMode);
    }

    // `/usage` is a Grok TUI/pager command — not handled by ACP session/prompt
    // (agent would treat it as normal chat). We implement it via `_x.ai/billing`.
    const slashName = text.trim().match(/^\/([a-zA-Z][\w-]*)/)?.[1]?.toLowerCase();
    if (slashName === "usage" || slashName === "billing") {
      try {
        this.broadcast({ type: "status", message: "Fetching usage…" });
        if (!live.adapter.fetchBillingUsage) {
          this.broadcast({
            type: "error",
            message: "Usage not available for this provider",
          });
          return;
        }
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
        // Ephemeral panel — do NOT inject into chat / next-turn context
        this.broadcast({
          type: "notice",
          kind: "usage",
          title: `Usage · ${u.subscriptionTier || "Grok"}`,
          body: lines.join("\n"),
        });
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
          effort: live.effort,
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
