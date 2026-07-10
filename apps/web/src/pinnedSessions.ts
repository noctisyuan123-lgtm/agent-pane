/**
 * Client-side pin store — same idea as grok-desktop-code/src/lib/pinnedSessions.ts.
 * Instant pin/unpin; server is fire-and-forget.
 */
const STORAGE_KEY = "agent-pane.pinned-sessions";

function readIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { ids?: string[] }).ids)
    ) {
      return (parsed as { ids: string[] }).ids.map(String);
    }
  } catch {
    /* ignore */
  }
  return [];
}

function writeIds(ids: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ids }));
  } catch {
    /* ignore */
  }
}

export function loadPinnedIds(): Set<string> {
  return new Set(readIds());
}

export function setPinnedLocal(sessionId: string, pinned: boolean): Set<string> {
  const set = loadPinnedIds();
  if (pinned) set.add(sessionId);
  else set.delete(sessionId);
  writeIds([...set]);
  return set;
}

/** Merge server-pinned ids into local set (additive only — never re-pins after unpin). */
export function mergeServerPins(
  local: ReadonlySet<string>,
  serverPinnedIds: string[]
): Set<string> {
  const next = new Set(local);
  let changed = false;
  for (const id of serverPinnedIds) {
    if (!next.has(id)) {
      next.add(id);
      changed = true;
    }
  }
  if (changed) writeIds([...next]);
  return next;
}
