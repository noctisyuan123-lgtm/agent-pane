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

export type SkillEntry = {
  name: string;
  description: string;
  source: string;
  dir: string;
};

function parseSkillFrontmatter(raw: string): {
  name?: string;
  description?: string;
} {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const block = m[1]!;
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  let description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (description?.startsWith('"') || description?.startsWith("'")) {
    // single-line quoted
    description = description.replace(/^["']|["']$/g, "");
  } else if (description?.startsWith("|") || description?.startsWith(">")) {
    description = description.replace(/^[|>]-?\s*/, "");
  }
  // multiline description: "description: |\n  ..."
  if (!description || description === "|" || description === ">") {
    const multi = block.match(
      /^description:\s*[|>]-?\s*\n((?:[ \t]+.+\n?)+)/m
    );
    if (multi) {
      description = multi[1]!
        .split("\n")
        .map((l) => l.replace(/^[ \t]+/, ""))
        .join(" ")
        .trim();
    }
  }
  return { name, description };
}

/** Discover Grok / Claude / Cursor skills (name + short description). */
export function listSkills(cwd?: string): SkillEntry[] {
  const roots: { dir: string; source: string }[] = [
    { dir: path.join(os.homedir(), ".grok", "skills"), source: "user-grok" },
    { dir: path.join(os.homedir(), ".claude", "skills"), source: "user-claude" },
    { dir: path.join(os.homedir(), ".cursor", "skills"), source: "user-cursor" },
  ];
  if (cwd) {
    roots.unshift(
      { dir: path.join(cwd, ".grok", "skills"), source: "project-grok" },
      { dir: path.join(cwd, ".claude", "skills"), source: "project-claude" },
      { dir: path.join(cwd, ".cursor", "skills"), source: "project-cursor" }
    );
  }

  const byName = new Map<string, SkillEntry>();
  // later roots lower priority — first wins (project first when cwd set)
  for (const { dir, source } of roots) {
    let entries: fs.Dirent[] = [];
    try {
      if (!fs.existsSync(dir)) continue;
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      // skip known vendor noise
      if (["shell", "canvas", "statusline", "node_modules"].includes(ent.name)) {
        continue;
      }
      const skillDir = path.join(dir, ent.name);
      const md = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(md)) continue;
      try {
        const raw = fs.readFileSync(md, "utf8").slice(0, 8000);
        const fm = parseSkillFrontmatter(raw);
        const name = (fm.name || ent.name).trim();
        if (!name || byName.has(name)) continue;
        const description = (fm.description || "").slice(0, 160);
        byName.set(name, {
          name,
          description,
          source,
          dir: skillDir,
        });
      } catch {
        /* skip */
      }
    }
  }

  return [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

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

export type HttpApiHooks = {
  /** Stop live agent before deleting its session dir (avoids write-race resurrecting files). */
  stopSession?: (sessionId: string) => void | Promise<void>;
  /** Clear in-memory event store for a deleted session. */
  purgeSession?: (sessionId: string) => void;
};

export async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  hooks: HttpApiHooks = {}
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

  // Skills from ~/.grok, ~/.claude, and optional project cwd
  if (url.pathname === "/api/skills" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd") || undefined;
    json(res, 200, { skills: listSkills(cwd) });
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
    try {
      await hooks.stopSession?.(sessionId);
    } catch {
      /* best effort — still try disk delete */
    }
    const ok = deleteSession(sessionId);
    try {
      hooks.purgeSession?.(sessionId);
    } catch {
      /* ignore */
    }
    // Second pass: kill anything a late flush recreated
    if (ok) deleteSession(sessionId);
    // Idempotent: gone-on-disk is success (stale UI / double-click)
    if (ok) {
      json(res, 200, { ok: true });
    } else {
      json(res, 500, {
        ok: false,
        error: "Failed to delete session (disk error)",
      });
    }
    return true;
  }

  // POST /api/upload  { name, base64, mime? } → save under ~/.agent-pane/uploads
  // Used for browser/HTML5 drops when native path is unavailable.
  if (url.pathname === "/api/upload" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        name?: string;
        base64?: string;
        mime?: string;
      };
      const name = String(body.name || "upload.bin").replace(/[^\w.\-()+ ]+/g, "_");
      const b64 = String(body.base64 || "");
      if (!b64) {
        json(res, 400, { error: "base64 required" });
        return true;
      }
      const dir = path.join(os.homedir(), ".agent-pane", "uploads");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = Date.now().toString(36);
      const safe = name.slice(0, 120) || "upload.bin";
      const dest = path.join(dir, `${stamp}-${safe}`);
      const buf = Buffer.from(b64, "base64");
      // 40MB cap
      if (buf.length > 40 * 1024 * 1024) {
        json(res, 413, { error: "file too large (max 40MB)" });
        return true;
      }
      fs.writeFileSync(dest, buf);
      json(res, 200, {
        path: dest,
        name: safe,
        size: buf.length,
        mime: body.mime || null,
      });
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
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
