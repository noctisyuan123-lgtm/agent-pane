import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DomainEvent } from "@agent-pane/shared";

export type SessionMeta = {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type HistoryGroup = {
  cwd: string;
  name: string;
  sessions: SessionMeta[];
};

const ROOT = path.join(os.homedir(), ".agent-pane", "sessions");

/** In-memory caches — avoid re-scanning disk on every sidebar open */
let listCache: { at: number; groups: HistoryGroup[] } | null = null;
const LIST_TTL_MS = 12_000;

const eventsCache = new Map<
  string,
  { at: number; mtimeMs: number; events: DomainEvent[] }
>();
const EVENTS_TTL_MS = 60_000;

export function invalidateHistoryListCache(): void {
  listCache = null;
}

export function invalidateSessionEventsCache(sessionId?: string): void {
  if (sessionId) eventsCache.delete(sessionId);
  else eventsCache.clear();
}

function ensureRoot(): void {
  fs.mkdirSync(ROOT, { recursive: true });
}

function metaPath(sessionId: string): string {
  return path.join(ROOT, sessionId, "meta.json");
}

function eventsPath(sessionId: string): string {
  return path.join(ROOT, sessionId, "events.jsonl");
}

export function readMeta(sessionId: string): SessionMeta | null {
  try {
    const p = metaPath(sessionId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8")) as SessionMeta;
  } catch {
    return null;
  }
}

export function writeMeta(meta: SessionMeta): void {
  ensureRoot();
  const dir = path.join(ROOT, meta.sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(metaPath(meta.sessionId), JSON.stringify(meta, null, 2), "utf8");
  invalidateHistoryListCache();
}

/** Create or patch meta when session starts / user speaks */
export function upsertMeta(patch: {
  sessionId: string;
  cwd?: string;
  title?: string;
  bumpMessage?: boolean;
}): SessionMeta {
  const prev = readMeta(patch.sessionId);
  const now = new Date().toISOString();
  const meta: SessionMeta = {
    sessionId: patch.sessionId,
    cwd: patch.cwd ?? prev?.cwd ?? "",
    title: patch.title?.trim()
      ? patch.title.trim().slice(0, 80)
      : prev?.title || "New session",
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    messageCount: (prev?.messageCount ?? 0) + (patch.bumpMessage ? 1 : 0),
  };
  // first real title wins unless still default
  if (
    patch.title?.trim() &&
    prev?.title &&
    prev.title !== "New session" &&
    !patch.title
  ) {
    meta.title = prev.title;
  }
  if (prev?.title && prev.title !== "New session" && patch.title) {
    // keep first user message as title once set
    if (prev.messageCount > 0) meta.title = prev.title;
  }
  writeMeta(meta);
  return meta;
}

function deriveMetaFromEvents(sessionId: string): SessionMeta | null {
  const p = eventsPath(sessionId);
  if (!fs.existsSync(p)) return null;
  let cwd = "";
  let title = "New session";
  let createdAt = "";
  let updatedAt = "";
  let messageCount = 0;
  let firstUser = "";
  try {
    const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as DomainEvent & { at?: string };
        if (!createdAt && e.at) createdAt = e.at;
        if (e.at) updatedAt = e.at;
        if (e.type === "SessionStarted") {
          cwd = (e as { cwd?: string }).cwd ?? cwd;
        }
        if (e.type === "UserMessageAppended") {
          messageCount++;
          const t = (e as { text?: string }).text ?? "";
          if (!firstUser && t) firstUser = t;
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    return null;
  }
  if (!createdAt) return null;
  return {
    sessionId,
    cwd,
    title: (firstUser || title).slice(0, 80),
    createdAt,
    updatedAt: updatedAt || createdAt,
    messageCount,
  };
}

export function listHistory(force = false): HistoryGroup[] {
  if (!force && listCache && Date.now() - listCache.at < LIST_TTL_MS) {
    return listCache.groups;
  }
  ensureRoot();
  const sessions: SessionMeta[] = [];
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(ROOT);
  } catch {
    listCache = { at: Date.now(), groups: [] };
    return [];
  }

  for (const id of dirs) {
    const dir = path.join(ROOT, id);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    let meta = readMeta(id);
    if (!meta) {
      meta = deriveMetaFromEvents(id);
      if (meta) writeMeta(meta);
    }
    if (meta) sessions.push(meta);
  }

  sessions.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  const byCwd = new Map<string, SessionMeta[]>();
  for (const s of sessions) {
    const key = s.cwd || "(unknown)";
    const list = byCwd.get(key) ?? [];
    list.push(s);
    byCwd.set(key, list);
  }

  const groups: HistoryGroup[] = [];
  for (const [cwd, list] of byCwd) {
    groups.push({
      cwd,
      name: cwd === "(unknown)" ? "Unknown" : path.basename(cwd) || cwd,
      sessions: list,
    });
  }
  // sort groups by most recent session
  groups.sort((a, b) => {
    const ta = a.sessions[0] ? new Date(a.sessions[0].updatedAt).getTime() : 0;
    const tb = b.sessions[0] ? new Date(b.sessions[0].updatedAt).getTime() : 0;
    return tb - ta;
  });

  listCache = { at: Date.now(), groups };
  return groups;
}

export function loadSessionEvents(sessionId: string, force = false): DomainEvent[] {
  const p = eventsPath(sessionId);
  if (!fs.existsSync(p)) return [];

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(p).mtimeMs;
  } catch {
    return [];
  }

  const hit = eventsCache.get(sessionId);
  if (
    !force &&
    hit &&
    hit.mtimeMs === mtimeMs &&
    Date.now() - hit.at < EVENTS_TTL_MS
  ) {
    return hit.events;
  }

  const events: DomainEvent[] = [];
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as DomainEvent);
    } catch {
      /* skip */
    }
  }
  eventsCache.set(sessionId, { at: Date.now(), mtimeMs, events });
  return events;
}
