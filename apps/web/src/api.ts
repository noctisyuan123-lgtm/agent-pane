const BRIDGE_HTTP =
  import.meta.env.VITE_BRIDGE_HTTP ?? "http://127.0.0.1:8787";

export type ProjectEntry = { path: string; name: string; at?: string };

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

/** Client-side cache for history list */
let historyMem: { at: number; groups: HistoryGroup[] } | null = null;
const HISTORY_TTL = 15_000;
const eventsMem = new Map<string, { at: number; events: unknown[] }>();
const EVENTS_TTL = 60_000;

export async function fetchHistory(force = false): Promise<HistoryGroup[]> {
  if (
    !force &&
    historyMem &&
    Date.now() - historyMem.at < HISTORY_TTL
  ) {
    return historyMem.groups;
  }
  const q = force ? "?force=1" : "";
  const res = await fetch(`${BRIDGE_HTTP}/api/history${q}`);
  if (!res.ok) return historyMem?.groups ?? [];
  const data = (await res.json()) as { groups: HistoryGroup[] };
  historyMem = { at: Date.now(), groups: data.groups ?? [] };
  return historyMem.groups;
}

export function peekHistoryCache(): HistoryGroup[] | null {
  return historyMem?.groups ?? null;
}

export async function fetchSessionEvents(
  sessionId: string,
  force = false
): Promise<unknown[]> {
  const hit = eventsMem.get(sessionId);
  if (!force && hit && Date.now() - hit.at < EVENTS_TTL) {
    return hit.events;
  }
  const q = force ? "?force=1" : "";
  const res = await fetch(
    `${BRIDGE_HTTP}/api/history/${encodeURIComponent(sessionId)}/events${q}`
  );
  if (!res.ok) return hit?.events ?? [];
  const data = (await res.json()) as { events: unknown[] };
  const events = data.events ?? [];
  eventsMem.set(sessionId, { at: Date.now(), events });
  return events;
}

export function formatRelTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}

export async function pickFolder(): Promise<string | null> {
  const res = await fetch(`${BRIDGE_HTTP}/api/folder-pick`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as {
    cancelled?: boolean;
    path?: string | null;
  };
  if (data.cancelled || !data.path) return null;
  return data.path;
}

export async function fetchRecent(): Promise<ProjectEntry[]> {
  const res = await fetch(`${BRIDGE_HTTP}/api/recent`);
  if (!res.ok) return [];
  const data = (await res.json()) as { recent: ProjectEntry[] };
  return data.recent ?? [];
}

export async function fetchProjects(): Promise<ProjectEntry[]> {
  const res = await fetch(`${BRIDGE_HTTP}/api/projects`);
  if (!res.ok) return [];
  const data = (await res.json()) as { projects: ProjectEntry[] };
  return data.projects ?? [];
}

export async function rememberPath(p: string): Promise<void> {
  await fetch(`${BRIDGE_HTTP}/api/recent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: p }),
  }).catch(() => undefined);
}
