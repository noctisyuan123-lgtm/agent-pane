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
  pinned?: boolean;
  unread?: boolean;
  archived?: boolean;
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
  force = true
): Promise<unknown[]> {
  // 打开历史默认强制拉盘，避免脏缓存「加载不出来」
  const hit = eventsMem.get(sessionId);
  if (!force && hit && Date.now() - hit.at < EVENTS_TTL) {
    return hit.events;
  }
  const res = await fetch(
    `${BRIDGE_HTTP}/api/history/${encodeURIComponent(sessionId)}/events?force=1`
  );
  if (!res.ok) {
    // 失败时才回退缓存
    if (hit?.events?.length) return hit.events;
    throw new Error(`Failed to load history HTTP ${res.status}`);
  }
  const data = (await res.json()) as { events: unknown[] };
  const events = data.events ?? [];
  eventsMem.set(sessionId, { at: Date.now(), events });
  return events;
}

export function invalidateHistoryClientCache(sessionId?: string): void {
  historyMem = null;
  if (sessionId) eventsMem.delete(sessionId);
  else eventsMem.clear();
}

export async function patchSessionMeta(
  sessionId: string,
  patch: Partial<
    Pick<SessionMeta, "title" | "pinned" | "unread" | "archived">
  >
): Promise<SessionMeta> {
  const res = await fetch(
    `${BRIDGE_HTTP}/api/history/${encodeURIComponent(sessionId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }
  );
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { meta: SessionMeta };
  invalidateHistoryClientCache(sessionId);
  return data.meta;
}

export async function forkSessionApi(sessionId: string): Promise<SessionMeta> {
  const res = await fetch(
    `${BRIDGE_HTTP}/api/history/${encodeURIComponent(sessionId)}/fork`,
    { method: "POST" }
  );
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { meta: SessionMeta };
  invalidateHistoryClientCache();
  return data.meta;
}

export async function deleteSessionApi(sessionId: string): Promise<void> {
  const res = await fetch(
    `${BRIDGE_HTTP}/api/history/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    let msg = `Delete failed (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { error?: string; ok?: boolean };
      if (body.error) msg = body.error;
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }
  invalidateHistoryClientCache(sessionId);
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

export type SkillEntry = {
  name: string;
  description: string;
  source: string;
  dir: string;
};

export async function fetchSkills(cwd?: string): Promise<SkillEntry[]> {
  const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  const res = await fetch(`${BRIDGE_HTTP}/api/skills${q}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { skills: SkillEntry[] };
  return data.skills ?? [];
}

export async function rememberPath(p: string): Promise<void> {
  await fetch(`${BRIDGE_HTTP}/api/recent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: p }),
  }).catch(() => undefined);
}

/** Persist a dropped/pasted file for attachment (returns absolute path). */
export async function uploadAttachment(input: {
  name: string;
  base64: string;
  mime?: string;
}): Promise<{ path: string; name: string; size: number }> {
  const res = await fetch(`${BRIDGE_HTTP}/api/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `Upload failed HTTP ${res.status}`);
  }
  return (await res.json()) as { path: string; name: string; size: number };
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsDataURL(file);
  });
}
