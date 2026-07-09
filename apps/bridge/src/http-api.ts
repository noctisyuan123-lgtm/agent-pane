import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  listHistory,
  loadSessionEvents,
  invalidateHistoryListCache,
  patchMeta,
  deleteSession,
  forkSession,
} from "./history-index.js";

const execFileAsync = promisify(execFile);
const recentPath = path.join(os.homedir(), ".agent-pane", "recent.json");

export type RecentEntry = { path: string; name: string; at: string };

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function loadRecent(): RecentEntry[] {
  try {
    if (!fs.existsSync(recentPath)) return [];
    const data = JSON.parse(fs.readFileSync(recentPath, "utf8")) as RecentEntry[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function pushRecent(cwd: string): RecentEntry[] {
  const name = path.basename(cwd) || cwd;
  const next: RecentEntry[] = [
    { path: cwd, name, at: new Date().toISOString() },
    ...loadRecent().filter((e) => e.path !== cwd),
  ].slice(0, 24);
  fs.mkdirSync(path.dirname(recentPath), { recursive: true });
  fs.writeFileSync(recentPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function pickFolderMac(): Promise<string | null> {
  // Native macOS folder dialog via AppleScript
  const script = `
try
  set theFolder to choose folder with prompt "选择 Agent 工作区"
  return POSIX path of theFolder
on error
  return ""
end try
`;
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    const p = stdout.trim().replace(/\/$/, "");
    return p || null;
  } catch {
    return null;
  }
}

function scanProjects(): RecentEntry[] {
  const roots = [
    path.join(os.homedir(), "projects"),
    path.join(os.homedir(), "Desktop"),
    path.join(os.homedir(), "dev"),
  ];
  const out: RecentEntry[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith(".") || ent.name === "node_modules" || ent.name === "__pycache__")
        continue;
      const full = path.join(root, ent.name);
      out.push({
        path: full,
        name: ent.name,
        at: "",
      });
    }
  }
  return out.slice(0, 40);
}

export async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return true;
  }

  if (url.pathname === "/health" && req.method === "GET") {
    json(res, 200, { ok: true, service: "agent-pane-bridge" });
    return true;
  }

  if (url.pathname === "/api/recent" && req.method === "GET") {
    json(res, 200, { recent: loadRecent() });
    return true;
  }

  if (url.pathname === "/api/projects" && req.method === "GET") {
    json(res, 200, { projects: scanProjects() });
    return true;
  }

  // History: group by project cwd · list cached in memory
  if (url.pathname === "/api/history" && req.method === "GET") {
    const force = url.searchParams.get("force") === "1";
    const groups = listHistory(force);
    cors(res);
    res.setHeader("Cache-Control", "private, max-age=10");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ groups, cached: !force }));
    return true;
  }

  if (url.pathname === "/api/history/invalidate" && req.method === "POST") {
    invalidateHistoryListCache();
    json(res, 200, { ok: true });
    return true;
  }

  // GET /api/history/:sessionId/events
  const histMatch = url.pathname.match(
    /^\/api\/history\/([^/]+)\/events$/
  );
  if (histMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(histMatch[1]!);
    // 默认 force 读盘：打开历史必须最新，不能被脏 cache 挡住
    const force = url.searchParams.get("force") !== "0";
    const events = loadSessionEvents(sessionId, force);
    cors(res);
    res.setHeader("Cache-Control", "no-store");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({ sessionId, events, count: events.length })
    );
    return true;
  }

  // PATCH /api/history/:sessionId  { title?, pinned?, unread?, archived? }
  const patchMatch = url.pathname.match(/^\/api\/history\/([^/]+)$/);
  if (patchMatch && req.method === "PATCH") {
    const sessionId = decodeURIComponent(patchMatch[1]!);
    try {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const meta = patchMeta(sessionId, {
        title: typeof body.title === "string" ? body.title : undefined,
        pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
        unread: typeof body.unread === "boolean" ? body.unread : undefined,
        archived: typeof body.archived === "boolean" ? body.archived : undefined,
      });
      if (!meta) {
        json(res, 404, { error: "session not found" });
        return true;
      }
      json(res, 200, { meta });
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }

  // POST /api/history/:sessionId/fork
  const forkMatch = url.pathname.match(/^\/api\/history\/([^/]+)\/fork$/);
  if (forkMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(forkMatch[1]!);
    const meta = forkSession(sessionId);
    if (!meta) {
      json(res, 404, { error: "cannot fork" });
      return true;
    }
    json(res, 200, { meta });
    return true;
  }

  // DELETE /api/history/:sessionId
  if (patchMatch && req.method === "DELETE") {
    const sessionId = decodeURIComponent(patchMatch[1]!);
    const ok = deleteSession(sessionId);
    json(res, ok ? 200 : 404, { ok });
    return true;
  }

  if (url.pathname === "/api/folder-pick" && req.method === "POST") {
    if (process.platform !== "darwin") {
      json(res, 501, {
        error: "Native folder picker is only implemented on macOS for now",
      });
      return true;
    }
    const picked = await pickFolderMac();
    if (!picked) {
      json(res, 200, { cancelled: true, path: null });
      return true;
    }
    const recent = pushRecent(picked);
    json(res, 200, { cancelled: false, path: picked, recent });
    return true;
  }

  if (url.pathname === "/api/recent" && req.method === "POST") {
    const raw = await readBody(req);
    let cwd = "";
    try {
      cwd = String((JSON.parse(raw) as { path?: string }).path ?? "");
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    if (!cwd || !fs.existsSync(cwd)) {
      json(res, 400, { error: "path missing or not found" });
      return true;
    }
    json(res, 200, { recent: pushRecent(cwd) });
    return true;
  }

  return false;
}
