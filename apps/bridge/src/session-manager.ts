import type { ClientCommand, DomainEvent } from "@agent-pane/shared";
import { nowIso } from "@agent-pane/shared";
import { EventStore, type StoredEvent } from "./event-store.js";
import { GrokAcpAdapter } from "./grok-acp-adapter.js";
import { WorkspaceSnapshotService } from "./workspace-snapshot.js";
import { DiffEngine } from "./diff-engine.js";

export type Broadcast = (msg: unknown) => void;

type LiveSession = {
  domainSessionId: string;
  cwd: string;
  model?: string;
  adapter: GrokAcpAdapter;
};

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
    const stored = this.store.append(event);
    this.broadcast({ type: "event", event: stored });
    return stored;
  }

  async handleCommand(cmd: ClientCommand): Promise<void> {
    switch (cmd.type) {
      case "session.create":
        await this.createSession(cmd.cwd, cmd.model);
        break;
      case "session.prompt":
        await this.prompt(cmd.sessionId, cmd.text, cmd.attachments);
        break;
      case "session.cancel":
        await this.live.get(cmd.sessionId)?.adapter.cancel(cmd.sessionId);
        break;
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

  private async createSession(cwd: string, model?: string): Promise<void> {
    const adapter = new GrokAcpAdapter();
    adapter.onEvent((e) => {
      // Remap: adapter already uses domain session id
      this.publish(e);
      if (e.type === "ToolFinished" || e.type === "MessageDone") {
        // refresh diffs after tools / turn
        const sid = e.sessionId;
        setTimeout(() => this.refreshDiff(sid), 300);
      }
    });

    try {
      await adapter.start({
        cwd,
        model,
        permissionMode: this.permissionMode,
      });
    } catch (e) {
      this.broadcast({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    const domainSessionId = adapter.getSessionId();
    this.live.set(domainSessionId, {
      domainSessionId,
      cwd,
      model,
      adapter,
    });

    // Snapshot baseline
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

  private async prompt(
    sessionId: string,
    text: string,
    attachments?: { path: string; kind: "file" | "folder" }[]
  ): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) {
      this.broadcast({ type: "error", message: "Unknown session. Create one first." });
      return;
    }
    await live.adapter.sendPrompt({ sessionId, text, attachments });
  }

  private refreshDiff(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    const snap = this.snapshots.get(sessionId);
    const files = this.diffEngine.compute(live.cwd, snap);
    this.publish({
      type: "DiffProposed",
      sessionId,
      files,
      at: nowIso(),
    });
  }

  private async diffAccept(sessionId: string, filePath: string | "*"): Promise<void> {
    try {
      this.snapshots.advance(sessionId);
      this.publish({
        type: "DiffResolved",
        sessionId,
        filePath,
        action: "accept",
        at: nowIso(),
      });
      const snap = this.snapshots.get(sessionId);
      if (snap) {
        this.publish({
          type: "SnapshotTaken",
          sessionId,
          snapshotId: snap.snapshotId,
          at: nowIso(),
        });
      }
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
    try {
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
