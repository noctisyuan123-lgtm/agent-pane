const BRIDGE_HTTP =
  import.meta.env.VITE_BRIDGE_HTTP ?? "http://127.0.0.1:8787";

export type ProjectEntry = { path: string; name: string; at?: string };

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
