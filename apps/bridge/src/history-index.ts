import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DomainEvent } from "@agent-pane/shared";

export type SessionMeta = {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  pinned?: boolean;
  unread?: boolean;
  archived?: boolean;
  /**
   * Last known live Grok ACP session id (ephemeral process handle).
   * Resume always mints a new provider id via session/new + history digest —
   * this field is rewritten; it is NOT "session/load" continuity.
   */
  providerSessionId?: string;
  /**
   * Original Grok session id at import time (stable lineage).
   * Survives resume when providerSessionId is replaced.
   */
  sourceProviderSessionId?: string;
};

export type HistoryGroup = {
  cwd: string;
  name: string;
  sessions: SessionMeta[];
};

const ROOT = path.join(os.homedir(), ".agent-pane", "sessions");
/** Pins live in a dedicated store (like grok-desktop-code) so meta rewrites never drop them */
const PINS_PATH = path.join(os.homedir(), ".agent-pane", "pins.json");

/** In-memory caches — avoid re-scanning disk on every sidebar open */
let listCache: { at: number; groups: HistoryGroup[] } | null = null;
const LIST_TTL_MS = 12_000;

// ── Pin store (sessionId → true) ──────────────────────────────────────
function readPinSet(): Set<string> {
  try {
    if (!fs.existsSync(PINS_PATH)) return new Set();
    const raw = JSON.parse(fs.readFileSync(PINS_PATH, "utf8")) as unknown;
    if (Array.isArray(raw)) return new Set(raw.map(String));
    if (raw && typeof raw === "object") {
      // support { ids: string[] } or Record<id, true>
      const o = raw as Record<string, unknown>;
      if (Array.isArray(o.ids)) return new Set(o.ids.map(String));
      return new Set(Object.keys(o).filter((k) => o[k]));
    }
  } catch {
    /* ignore */
  }
  return new Set();
}

function writePinSet(ids: Set<string>): void {
  ensureRoot();
  const dir = path.dirname(PINS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    PINS_PATH,
    JSON.stringify({ ids: [...ids] }, null, 2),
    "utf8"
  );
  invalidateHistoryListCache();
}

export function isPinned(sessionId: string): boolean {
  return readPinSet().has(sessionId);
}

export function setPinned(sessionId: string, pinned: boolean): void {
  const set = readPinSet();
  if (pinned) set.add(sessionId);
  else set.delete(sessionId);
  writePinSet(set);
}

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

/** Never return meta without a usable title. */
function ensureTitle(sessionId: string, title: string | undefined | null): string {
  const t = (title || "").trim();
  if (t && t !== "Untitled") return t.slice(0, 80);
  const derived = deriveMetaFromEvents(sessionId);
  const d = (derived?.title || "").trim();
  if (d && d !== "New session" && d !== "Untitled") return d.slice(0, 80);
  return t || "New session";
}

export function readMeta(sessionId: string): SessionMeta | null {
  try {
    const p = metaPath(sessionId);
    if (!fs.existsSync(p)) return null;
    const meta = JSON.parse(fs.readFileSync(p, "utf8")) as SessionMeta;
    // Overlay pin from dedicated store (source of truth)
    meta.pinned = isPinned(sessionId) || !!meta.pinned;
    meta.title = ensureTitle(sessionId, meta.title);
    return meta;
  } catch {
    return null;
  }
}

export function writeMeta(meta: SessionMeta): void {
  ensureRoot();
  const dir = path.join(ROOT, meta.sessionId);
  fs.mkdirSync(dir, { recursive: true });
  // Always persist a real title — JSON.stringify drops undefined, which
  // made the UI show "Untitled" after pin/resume rewrites.
  const fixed: SessionMeta = {
    ...meta,
    title: ensureTitle(meta.sessionId, meta.title),
    pinned: isPinned(meta.sessionId) || !!meta.pinned,
  };
  fs.writeFileSync(metaPath(meta.sessionId), JSON.stringify(fixed, null, 2), "utf8");
  invalidateHistoryListCache();
}

/** Create or patch meta when session starts / user speaks */
export function upsertMeta(patch: {
  sessionId: string;
  cwd?: string;
  title?: string;
  bumpMessage?: boolean;
  providerSessionId?: string;
  sourceProviderSessionId?: string;
}): SessionMeta {
  const prev = readMeta(patch.sessionId);
  const now = new Date().toISOString();
  const prevTitle = (prev?.title || "").trim();
  const patchTitle = (patch.title || "").trim().slice(0, 80);
  // Once a real title is set (not empty / default), keep it — never clobber
  // with later turns or wipe on resume-only upserts.
  const keepTitle =
    prevTitle &&
    prevTitle !== "New session" &&
    prevTitle !== "Untitled" &&
    (prev?.messageCount ?? 0) > 0;
  const title = keepTitle
    ? prevTitle
    : patchTitle || prevTitle || "New session";

  const meta: SessionMeta = {
    sessionId: patch.sessionId,
    cwd: patch.cwd ?? prev?.cwd ?? "",
    title: ensureTitle(patch.sessionId, title),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    messageCount: (prev?.messageCount ?? 0) + (patch.bumpMessage ? 1 : 0),
    providerSessionId:
      patch.providerSessionId ?? prev?.providerSessionId,
    // Import lineage: set once, never clobber with empty
    sourceProviderSessionId:
      patch.sourceProviderSessionId ?? prev?.sourceProviderSessionId,
    // Pin from dedicated store (never lost on upsert)
    pinned: isPinned(patch.sessionId) || !!prev?.pinned,
    unread: prev?.unread,
    archived: prev?.archived,
  };
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
    // Zombie: meta or empty dir without any real events — hide and self-heal
    if (!hasReplayableEvents(id)) {
      try {
        const metaOnly = readMeta(id);
        const ev = eventsPath(id);
        const emptyOrMissing =
          !fs.existsSync(ev) || fs.statSync(ev).size === 0;
        // Keep draft shells with only SessionStarted (still no history entry).
        // Drop meta-only / empty corpses so they never stick in the sidebar.
        if (metaOnly && emptyOrMissing) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
      continue;
    }
    let meta = readMeta(id);
    if (!meta) {
      meta = deriveMetaFromEvents(id);
      // Only persist meta once there's a real conversation — drafts stay disk-only
      if (meta && !isDraftSession(meta)) {
        meta.pinned = isPinned(id);
        writeMeta(meta);
      }
    } else {
      // Migrate legacy meta.pinned → pins.json once
      if (meta.pinned && !isPinned(id)) setPinned(id, true);
      // Always overlay pin store + ensure title before listing
      const before = JSON.stringify({ t: meta.title, p: meta.pinned });
      meta = {
        ...meta,
        title: ensureTitle(id, meta.title),
        pinned: isPinned(id) || !!meta.pinned,
      };
      const after = JSON.stringify({ t: meta.title, p: meta.pinned });
      if (before !== after && !isDraftSession(meta)) writeMeta(meta);
    }
    if (meta && !isDraftSession(meta)) sessions.push(meta);
  }

  sessions.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  const byCwd = new Map<string, SessionMeta[]>();
  // 默认不展示已归档；空 New session（未发过消息）不进 history
  const active = sessions.filter((s) => !s.archived && !isDraftSession(s));

  for (const s of active) {
    const key = s.cwd || "(unknown)";
    const list = byCwd.get(key) ?? [];
    list.push(s);
    byCwd.set(key, list);
  }

  // pin 置顶
  for (const list of byCwd.values()) {
    list.sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return a.pinned ? -1 : 1;
      return (
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    });
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

/** Patch flags / title without bumping message count */
export function patchMeta(
  sessionId: string,
  patch: Partial<
    Pick<SessionMeta, "title" | "pinned" | "unread" | "archived" | "cwd">
  >
): SessionMeta | null {
  let prev = readMeta(sessionId);
  if (!prev) {
    prev = deriveMetaFromEvents(sessionId) ?? null;
  }
  if (!prev) return null;
  const next: SessionMeta = {
    ...prev,
    updatedAt: new Date().toISOString(),
  };
  // Apply only defined fields — never spread undefined over title/pin
  if (patch.title != null && String(patch.title).trim()) {
    next.title = String(patch.title).trim().slice(0, 80);
  }
  if (typeof patch.pinned === "boolean") {
    setPinned(sessionId, patch.pinned);
    next.pinned = patch.pinned;
  } else {
    next.pinned = isPinned(sessionId) || !!prev.pinned;
  }
  if (typeof patch.unread === "boolean") next.unread = patch.unread;
  if (typeof patch.archived === "boolean") next.archived = patch.archived;
  if (patch.cwd != null) next.cwd = patch.cwd;
  next.title = ensureTitle(sessionId, next.title);
  writeMeta(next);
  return next;
}

/**
 * Remove a session from disk. Idempotent: missing dir still counts as success
 * so UI never gets a raw `{"ok":false}` from double-delete / race.
 */
export function deleteSession(sessionId: string): boolean {
  const dir = path.join(ROOT, sessionId);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error("[history] deleteSession failed", sessionId, e);
    return false;
  }
  // Belt-and-suspenders: if a late write recreated the folder, kill it again
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
  // Clear pin entry so deleted ids don't linger
  try {
    if (isPinned(sessionId)) setPinned(sessionId, false);
  } catch {
    /* ignore */
  }
  invalidateHistoryListCache();
  invalidateSessionEventsCache(sessionId);
  return true;
}

/** True if the session has no real conversation yet (draft / abandoned New Agent). */
export function isDraftSession(meta: SessionMeta): boolean {
  return (meta.messageCount ?? 0) <= 0;
}

/** Has at least one user message on disk — otherwise not openable history. */
export function hasReplayableEvents(sessionId: string): boolean {
  const p = eventsPath(sessionId);
  if (!fs.existsSync(p)) return false;
  try {
    const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as { type?: string };
        if (e.type === "UserMessageAppended") return true;
      } catch {
        /* skip */
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Drop abandoned empty sessions (messageCount 0), optionally keeping the live one.
 * Called when starting a New Agent so history doesn't pile up with "New session".
 */
export function pruneDraftSessions(opts?: {
  keepSessionId?: string;
  cwd?: string;
}): number {
  ensureRoot();
  let removed = 0;
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(ROOT);
  } catch {
    return 0;
  }
  for (const id of dirs) {
    if (opts?.keepSessionId && id === opts.keepSessionId) continue;
    const dir = path.join(ROOT, id);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const meta = readMeta(id) ?? deriveMetaFromEvents(id);
    if (!meta || !isDraftSession(meta)) continue;
    if (opts?.cwd && meta.cwd && meta.cwd !== opts.cwd) continue;
    if (deleteSession(id)) removed++;
  }
  return removed;
}

/**
 * Slice domain events by user-turn boundaries.
 * - `beforeTurn`: keep events before UserMessageAppended at that index (Undo).
 * - `throughTurn`: keep through end of that turn (until next user) — Fork.
 */
export function sliceEventsByUserTurn(
  events: DomainEvent[],
  opts: { beforeTurn?: number; throughTurn?: number }
): DomainEvent[] {
  let turn = -1;
  const out: DomainEvent[] = [];
  for (const e of events) {
    if (e.type === "SessionRewound") continue;
    if (e.type === "UserMessageAppended") {
      turn++;
      if (opts.beforeTurn != null && turn === opts.beforeTurn) break;
      if (opts.throughTurn != null && turn > opts.throughTurn) break;
    }
    out.push(e);
  }
  return out;
}

/**
 * Fork = copy events (+ optional cut at a user turn) under a new session id.
 * `throughUserTurn` = 0-based last user turn to keep (inclusive, full turn).
 * Omit to copy the entire transcript (sidebar "Fork Chat").
 */
export function forkSession(
  sessionId: string,
  opts?: { throughUserTurn?: number }
): SessionMeta | null {
  const events = loadSessionEvents(sessionId, true);
  if (!events.length) return null;
  const prev = readMeta(sessionId) ?? deriveMetaFromEvents(sessionId);
  if (!prev) return null;
  const sliced =
    typeof opts?.throughUserTurn === "number"
      ? sliceEventsByUserTurn(events, { throughTurn: opts.throughUserTurn })
      : events.filter((e) => e.type !== "SessionRewound");
  if (!sliced.length) return null;
  const newId = randomUUID();
  const dir = path.join(ROOT, newId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = sliced.map((e, i) =>
    JSON.stringify({ ...e, sessionId: newId, seq: i + 1 })
  );
  fs.writeFileSync(path.join(dir, "events.jsonl"), lines.join("\n") + "\n", "utf8");
  const messageCount = sliced.filter((e) => e.type === "UserMessageAppended").length;
  const firstUser = sliced.find((e) => e.type === "UserMessageAppended") as
    | { text?: string }
    | undefined;
  const meta: SessionMeta = {
    ...prev,
    sessionId: newId,
    title: `${(firstUser?.text || prev.title).slice(0, 60)} (fork)`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount,
    pinned: false,
    unread: false,
    archived: false,
    // New branch — don't inherit stale provider id (resume starts fresh)
    providerSessionId: undefined,
  };
  writeMeta(meta);
  invalidateSessionEventsCache(newId);
  invalidateHistoryListCache();
  return meta;
}
