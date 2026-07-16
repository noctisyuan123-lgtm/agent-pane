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
  /** Last known live Grok ACP handle (ephemeral; may change on resume). */
  providerSessionId?: string;
  /** Import lineage: original Grok id (stable). */
  sourceProviderSessionId?: string;
};

export type HistoryGroup = {
  cwd: string;
  name: string;
  sessions: SessionMeta[];
};

/** Client-side cache for history list */
let historyMem: { at: number; groups: HistoryGroup[] } | null = null;
const HISTORY_TTL = 15_000;
/**
 * Tiny LRU for non-force event reads. Force loads (openHistory) must NOT
 * accumulate here — multi‑MB jsonl × N sessions was leaking until the UI
 * froze after rapid switching.
 */
const eventsMem = new Map<string, { at: number; events: unknown[] }>();
const EVENTS_TTL = 60_000;
const EVENTS_MEM_MAX = 2;

function rememberEvents(sessionId: string, events: unknown[]): void {
  eventsMem.delete(sessionId);
  eventsMem.set(sessionId, { at: Date.now(), events });
  while (eventsMem.size > EVENTS_MEM_MAX) {
    const oldest = eventsMem.keys().next().value;
    if (oldest == null) break;
    eventsMem.delete(oldest);
  }
}

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

export async function fetchSessionMeta(
  sessionId: string
): Promise<SessionMeta | null> {
  const res = await fetch(
    `${BRIDGE_HTTP}/api/history/${encodeURIComponent(sessionId)}`
  );
  if (res.ok) {
    const data = (await res.json()) as { meta?: SessionMeta };
    if (data.meta) return data.meta;
  }
  // Fallback for older bridges without GET /api/history/:id
  if (res.status === 404 || !res.ok) {
    const groups = await fetchHistory(true);
    for (const g of groups) {
      const hit = g.sessions.find((s) => s.sessionId === sessionId);
      if (hit) return hit;
    }
    if (res.status === 404) return null;
    throw new Error(`Failed to load session meta HTTP ${res.status}`);
  }
  return null;
}

export async function fetchSessionEvents(
  sessionId: string,
  force = true,
  signal?: AbortSignal
): Promise<unknown[]> {
  const hit = eventsMem.get(sessionId);
  if (!force && hit && Date.now() - hit.at < EVENTS_TTL) {
    return hit.events;
  }
  const res = await fetch(
    `${BRIDGE_HTTP}/api/history/${encodeURIComponent(sessionId)}/events?force=1`,
    signal ? { signal } : undefined
  );
  if (!res.ok) {
    if (hit?.events?.length) return hit.events;
    throw new Error(`Failed to load history HTTP ${res.status}`);
  }
  const data = (await res.json()) as { events: unknown[] };
  const events = data.events ?? [];
  // Only remember non-force hits in the tiny LRU. Force=openHistory paths
  // return the array for one-shot convert then let GC reclaim it.
  if (!force) rememberEvents(sessionId, events);
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

export async function forkSessionApi(
  sessionId: string,
  opts?: { throughUserTurn?: number }
): Promise<SessionMeta> {
  const res = await fetch(
    `${BRIDGE_HTTP}/api/history/${encodeURIComponent(sessionId)}/fork`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        opts?.throughUserTurn != null
          ? { throughUserTurn: opts.throughUserTurn }
          : {}
      ),
    }
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

export type CustomizeFile = {
  id: string;
  name: string;
  path: string;
  kind: "rule" | "memory";
  content: string;
};

export type GrokMcpServer = {
  name: string;
  enabled: boolean;
  command?: string;
  args?: string[];
  env: Record<string, string>;
};

export type CustomizeMcpState = {
  grokConfigPath: string;
  cursorMcpPath: string;
  grok: GrokMcpServer[];
  cursorJson: string;
};

export async function fetchContextUsage(opts: {
  sessionId?: string;
  cwd?: string;
  providerSessionId?: string;
}): Promise<{
  used: number;
  size: number;
  pct: number;
  source: "signals";
} | null> {
  const q = new URLSearchParams();
  if (opts.sessionId) q.set("sessionId", opts.sessionId);
  if (opts.cwd) q.set("cwd", opts.cwd);
  if (opts.providerSessionId) q.set("providerSessionId", opts.providerSessionId);
  const res = await fetch(`${BRIDGE_HTTP}/api/context-usage?${q}`);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    ok?: boolean;
    usage?: {
      used: number;
      size: number;
      pct: number;
      source: "signals";
    } | null;
  };
  if (!data.ok || !data.usage) return null;
  return data.usage;
}

export async function fetchCustomizeFiles(): Promise<CustomizeFile[]> {
  const res = await fetch(`${BRIDGE_HTTP}/api/customize/files`);
  if (!res.ok) return [];
  const data = (await res.json()) as { files: CustomizeFile[] };
  return data.files ?? [];
}

export async function saveCustomizeFile(
  id: string,
  content: string
): Promise<CustomizeFile> {
  const res = await fetch(`${BRIDGE_HTTP}/api/customize/files`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, content }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `save failed HTTP ${res.status}`);
  }
  const data = (await res.json()) as { file: CustomizeFile };
  return data.file;
}

export async function fetchCustomizeMcp(): Promise<CustomizeMcpState | null> {
  const res = await fetch(`${BRIDGE_HTTP}/api/customize/mcp`);
  if (!res.ok) return null;
  return (await res.json()) as CustomizeMcpState;
}

export async function saveCustomizeMcp(input: {
  grok?: Array<{
    name: string;
    enabled?: boolean;
    env?: Record<string, string>;
  }>;
  cursorJson?: string;
}): Promise<CustomizeMcpState> {
  const res = await fetch(`${BRIDGE_HTTP}/api/customize/mcp`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let msg = `save MCP failed HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* keep */
    }
    throw new Error(msg);
  }
  return (await res.json()) as CustomizeMcpState;
}

export type CustomizeHookFile = {
  id: string;
  name: string;
  path: string;
  kind: "json" | "script";
  content: string;
  events: string[];
};

export type CustomizeHooksState = {
  hooksDir: string;
  files: CustomizeHookFile[];
};

export async function fetchCustomizeHooks(): Promise<CustomizeHooksState> {
  const res = await fetch(`${BRIDGE_HTTP}/api/customize/hooks`);
  if (!res.ok) return { hooksDir: "", files: [] };
  return (await res.json()) as CustomizeHooksState;
}

export async function saveCustomizeHook(
  name: string,
  content: string,
  create = false
): Promise<{ file: CustomizeHookFile } & CustomizeHooksState> {
  const res = await fetch(`${BRIDGE_HTTP}/api/customize/hooks`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, content, create }),
  });
  if (!res.ok) {
    let msg = `save hook failed HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* keep */
    }
    throw new Error(msg);
  }
  return (await res.json()) as { file: CustomizeHookFile } & CustomizeHooksState;
}

export async function deleteCustomizeHook(
  name: string
): Promise<CustomizeHooksState> {
  const res = await fetch(`${BRIDGE_HTTP}/api/customize/hooks`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    let msg = `delete hook failed HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* keep */
    }
    throw new Error(msg);
  }
  return (await res.json()) as CustomizeHooksState;
}

export async function rememberPath(p: string): Promise<void> {
  await fetch(`${BRIDGE_HTTP}/api/recent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: p }),
  }).catch(() => undefined);
}

export type FsListEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
  size?: number;
};

export async function listFs(
  root: string,
  dirPath = "."
): Promise<FsListEntry[]> {
  const q = new URLSearchParams({ root, path: dirPath });
  const res = await fetch(`${BRIDGE_HTTP}/api/fs/list?${q}`);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `fs/list failed HTTP ${res.status}`);
  }
  const data = (await res.json()) as { entries?: FsListEntry[] };
  return data.entries ?? [];
}

export async function revealInFinder(target: string): Promise<void> {
  const res = await fetch(`${BRIDGE_HTTP}/api/fs/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: target }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `reveal failed HTTP ${res.status}`);
  }
}

/** Open a local path with the OS default app. */
export async function openLocalPath(target: string): Promise<void> {
  const res = await fetch(`${BRIDGE_HTTP}/api/fs/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: target }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `open failed HTTP ${res.status}`);
  }
}

/** URL that serves a local file through the bridge (for <img> / preview). */
export function localFileUrl(absPath: string): string {
  return `${BRIDGE_HTTP}/api/fs/file?path=${encodeURIComponent(absPath)}`;
}

export function isImageAttachment(name: string, mime?: string | null): boolean {
  if (mime && mime.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i.test(name);
}

export async function openIterm(cwd: string): Promise<void> {
  const res = await fetch(`${BRIDGE_HTTP}/api/terminal/iterm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `iterm failed HTTP ${res.status}`);
  }
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

/** Copy an absolute path into ~/.agent-pane/uploads (screenshots / temp files). */
export async function persistLocalAttachment(
  absPath: string
): Promise<{ path: string; name: string; mime?: string }> {
  const res = await fetch(`${BRIDGE_HTTP}/api/fs/persist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: absPath }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `Persist failed HTTP ${res.status}`);
  }
  return (await res.json()) as { path: string; name: string; mime?: string };
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
