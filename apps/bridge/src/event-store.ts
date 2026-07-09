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

  private sessionDir(sessionId: string): string {
    const dir = path.join(this.root, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private eventsPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "events.jsonl");
  }

  append(event: DomainEvent): StoredEvent {
    const prev = this.seqBySession.get(event.sessionId) ?? 0;
    const seq = prev + 1;
    this.seqBySession.set(event.sessionId, seq);
    const stored: StoredEvent = { ...event, seq };
    const list = this.memory.get(event.sessionId) ?? [];
    list.push(stored);
    this.memory.set(event.sessionId, list);
    fs.appendFileSync(this.eventsPath(event.sessionId), JSON.stringify(stored) + "\n", "utf8");
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
    const p = this.eventsPath(sessionId);
    if (!fs.existsSync(p)) {
      this.memory.set(sessionId, []);
      return;
    }
    const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
    const events: StoredEvent[] = [];
    let maxSeq = 0;
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as StoredEvent;
        events.push(e);
        if (e.seq > maxSeq) maxSeq = e.seq;
      } catch {
        /* skip bad line */
      }
    }
    this.memory.set(sessionId, events);
    this.seqBySession.set(sessionId, maxSeq);
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
