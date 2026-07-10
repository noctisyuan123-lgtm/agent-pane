import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { DomainEvent } from "@agent-pane/shared";

export type StoredEvent = DomainEvent & { seq: number };

export class EventStore {
  private seqBySession = new Map<string, number>();
  private memory = new Map<string, StoredEvent[]>();
  readonly root: string;

  constructor(root?: string) {
    this.root = root ?? path.join(os.homedir(), ".agent-pane", "sessions");
    fs.mkdirSync(this.root, { recursive: true });
  }

  private sessionDir(sessionId: string, create: boolean): string {
    const dir = path.join(this.root, sessionId);
    if (create) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private eventsPath(sessionId: string, create = false): string {
    return path.join(this.sessionDir(sessionId, create), "events.jsonl");
  }

  /**
   * Ensure in-memory seq cursor is at least as high as anything already on disk.
   * Without this, after bridge restart / resume the cursor resets to 0 and new
   * events reuse seq 1..N — UI seenSeq then drops them as "already applied"
   * from the history replay. That was "resume works on disk but UI blank".
   */
  private ensureSessionLoaded(sessionId: string): void {
    if (!this.memory.has(sessionId)) {
      this.loadFromDisk(sessionId);
      return;
    }
    // Memory present but cursor may be stale if file grew elsewhere
    const cursor = this.seqBySession.get(sessionId) ?? 0;
    const p = this.eventsPath(sessionId, false);
    if (!fs.existsSync(p)) return;
    try {
      const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
      let maxSeq = cursor;
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as StoredEvent;
          if ((e.seq ?? 0) > maxSeq) maxSeq = e.seq ?? 0;
        } catch {
          /* skip */
        }
      }
      // Also guard against corrupt restarts: never go below line count
      if (lines.length > maxSeq) maxSeq = lines.length;
      if (maxSeq > cursor) this.seqBySession.set(sessionId, maxSeq);
    } catch {
      /* ignore */
    }
  }

  append(event: DomainEvent): StoredEvent {
    this.ensureSessionLoaded(event.sessionId);
    const prev = this.seqBySession.get(event.sessionId) ?? 0;
    const seq = prev + 1;
    this.seqBySession.set(event.sessionId, seq);
    const stored: StoredEvent = { ...event, seq };
    const list = this.memory.get(event.sessionId) ?? [];
    list.push(stored);
    this.memory.set(event.sessionId, list);
    // only append creates dirs — list/load must not resurrect deleted sessions
    fs.appendFileSync(
      this.eventsPath(event.sessionId, true),
      JSON.stringify(stored) + "\n",
      "utf8"
    );
    return stored;
  }

  list(sessionId: string, fromSeq = 0): StoredEvent[] {
    if (!this.memory.has(sessionId)) {
      this.loadFromDisk(sessionId);
    }
    const list = this.memory.get(sessionId) ?? [];
    return list.filter((e) => (e.seq ?? 0) > fromSeq);
  }

  private loadFromDisk(sessionId: string): void {
    const p = this.eventsPath(sessionId, false);
    if (!fs.existsSync(p)) {
      this.memory.set(sessionId, []);
      this.seqBySession.set(sessionId, 0);
      return;
    }
    const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
    const events: StoredEvent[] = [];
    let maxSeq = 0;
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as StoredEvent;
        events.push(e);
        if ((e.seq ?? 0) > maxSeq) maxSeq = e.seq ?? 0;
      } catch {
        /* skip bad line */
      }
    }
    // Corrupt files may restart seq at 1 after resume; high-water = max(seq, lines)
    if (lines.length > maxSeq) maxSeq = lines.length;
    this.memory.set(sessionId, events);
    this.seqBySession.set(sessionId, maxSeq);
  }

  /** Drop in-memory state after disk delete so zombies cannot reappear. */
  purge(sessionId: string): void {
    this.memory.delete(sessionId);
    this.seqBySession.delete(sessionId);
  }

  listSessions(): string[] {
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }
}
