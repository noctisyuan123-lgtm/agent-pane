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
  readMeta,
  setPinned,
} from "./history-index.js";
import {
  listCustomizeFiles,
  writeCustomizeFile,
  loadCustomizeMcp,
  patchGrokMcp,
  writeCursorMcp,
  listCustomizeHooks,
  writeCustomizeHook,
  deleteCustomizeHook,
  defaultHookTemplate,
  type GrokMcpPatch,
} from "./customize-config.js";
import {
  readGrokSignalsUsage,
  resolveGrokSignalsPaths,
} from "./grok-signals-watcher.js";
import {
  guessMime,
  persistLocalFile,
  isImagePath,
} from "./attachment-persist.js";

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
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
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

export type FsListEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
  size?: number;
};

function assertUnderRoot(root: string, target: string): string {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(target);
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (targetAbs !== rootAbs && !targetAbs.startsWith(prefix)) {
    throw new Error("path escapes workspace root");
  }
  return targetAbs;
}

function listWorkspaceDir(root: string, relPath: string): FsListEntry[] {
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("workspace root missing");
  }
  const joined = path.resolve(root, relPath || ".");
  const dir = assertUnderRoot(root, joined);
  if (!fs.statSync(dir).isDirectory()) {
    throw new Error("not a directory");
  }
  const names = fs.readdirSync(dir);
  const entries: FsListEntry[] = [];
  for (const name of names) {
    if (name === ".DS_Store") continue;
    const full = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      entries.push({ name, path: full, kind: "dir" });
    } else if (st.isFile()) {
      entries.push({ name, path: full, kind: "file", size: st.size });
    }
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

async function revealInFinder(target: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Reveal in Finder is macOS-only");
  }
  await execFileAsync("open", ["-R", target], { timeout: 15_000 });
}

/** Open path with the OS default app (Preview, TextEdit, …). */
async function openWithDefaultApp(target: string): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("open", [target], { timeout: 15_000 });
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", target], { timeout: 15_000 });
    return;
  }
  await execFileAsync("xdg-open", [target], { timeout: 15_000 });
}

async function openItermAt(cwd: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("iTerm open is macOS-only");
  }
  const abs = path.resolve(cwd);
  const script = `
on run argv
  set targetPath to item 1 of argv
  try
    tell application "iTerm"
      activate
      if (count of windows) = 0 then
        create window with default profile
      else
        tell current window
          create tab with default profile
        end tell
      end if
      tell current session of current window
        write text "cd " & quoted form of targetPath & "; clear"
      end tell
    end tell
  on error
    do shell script "open -a iTerm " & quoted form of targetPath
  end try
end run
`;
  try {
    await execFileAsync("osascript", ["-e", script, abs], { timeout: 20_000 });
  } catch {
    await execFileAsync("open", ["-a", "iTerm", abs], { timeout: 15_000 });
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

  // Live context fill from Grok ~/.grok/sessions/.../signals.json
  if (url.pathname === "/api/context-usage" && req.method === "GET") {
    let cwd = url.searchParams.get("cwd") || "";
    let providerSessionId = url.searchParams.get("providerSessionId") || "";
    const sessionId = url.searchParams.get("sessionId") || "";
    if ((!cwd || !providerSessionId) && sessionId) {
      const meta = readMeta(sessionId);
      if (meta) {
        cwd = cwd || meta.cwd || "";
        providerSessionId = providerSessionId || meta.providerSessionId || "";
      }
    }
    if (!providerSessionId) {
      json(res, 200, { ok: false, usage: null });
      return true;
    }
    const paths = resolveGrokSignalsPaths(cwd || os.homedir(), providerSessionId);
    // Also try bare id scan via empty-cwd helper: resolve with cwd + fallbacks
    const usage = readGrokSignalsUsage(
      paths.length
        ? paths
        : resolveGrokSignalsPaths(os.homedir(), providerSessionId)
    );
    if (!usage) {
      json(res, 200, { ok: false, usage: null, providerSessionId, cwd });
      return true;
    }
    json(res, 200, {
      ok: true,
      usage: {
        used: usage.used,
        size: usage.size,
        pct:
          typeof usage.pct === "number"
            ? usage.pct
            : Math.min(100, Math.round((usage.used / usage.size) * 100)),
        source: "signals" as const,
      },
      providerSessionId,
      cwd,
    });
    return true;
  }

  // Customize: Grok rules + MEMORY.md
  if (url.pathname === "/api/customize/files" && req.method === "GET") {
    json(res, 200, { files: listCustomizeFiles() });
    return true;
  }

  if (url.pathname === "/api/customize/files" && req.method === "PUT") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        id?: string;
        content?: string;
      };
      if (!body.id || typeof body.content !== "string") {
        json(res, 400, { error: "id and content required" });
        return true;
      }
      const file = writeCustomizeFile(body.id, body.content);
      json(res, 200, { file });
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }

  // Customize: Grok config.toml MCP + Cursor mcp.json
  if (url.pathname === "/api/customize/mcp" && req.method === "GET") {
    json(res, 200, loadCustomizeMcp());
    return true;
  }

  if (url.pathname === "/api/customize/mcp" && req.method === "PUT") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        grok?: GrokMcpPatch[];
        cursorJson?: string;
      };
      let state = loadCustomizeMcp();
      if (Array.isArray(body.grok) && body.grok.length > 0) {
        state = patchGrokMcp(body.grok);
      }
      if (typeof body.cursorJson === "string") {
        state = writeCursorMcp(body.cursorJson);
      }
      json(res, 200, state);
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }

  // Customize: ~/.grok/hooks/*.json (+ companion scripts)
  if (url.pathname === "/api/customize/hooks" && req.method === "GET") {
    json(res, 200, listCustomizeHooks());
    return true;
  }

  if (url.pathname === "/api/customize/hooks" && req.method === "PUT") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        name?: string;
        content?: string;
        create?: boolean;
      };
      if (!body.name || typeof body.content !== "string") {
        json(res, 400, { error: "name and content required" });
        return true;
      }
      let content = body.content;
      if (body.create && !content.trim()) {
        const base = body.name.replace(/\.json$/i, "");
        content = defaultHookTemplate(base);
      }
      const file = writeCustomizeHook(body.name, content);
      json(res, 200, { file, ...listCustomizeHooks() });
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }

  if (url.pathname === "/api/customize/hooks" && req.method === "DELETE") {
    try {
      const body = JSON.parse(await readBody(req)) as { name?: string };
      const name = body.name || url.searchParams.get("name") || "";
      if (!name) {
        json(res, 400, { error: "name required" });
        return true;
      }
      deleteCustomizeHook(name);
      json(res, 200, listCustomizeHooks());
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
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

  // POST /api/history/import-grok  { sessionId, force? }
  if (url.pathname === "/api/history/import-grok" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        sessionId?: string;
        force?: boolean;
      };
      const sessionId = (body.sessionId || "").trim();
      if (!sessionId) {
        json(res, 400, { error: "sessionId required" });
        return true;
      }
      const { importGrokSession } = await import("./grok-session-import.js");
      const result = importGrokSession(sessionId, { force: !!body.force });
      json(res, 200, result);
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
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

  // GET|PATCH /api/history/:sessionId
  const metaMatch = url.pathname.match(/^\/api\/history\/([^/]+)$/);
  if (metaMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(metaMatch[1]!);
    const meta = readMeta(sessionId);
    if (!meta) {
      json(res, 404, { error: "session not found" });
      return true;
    }
    json(res, 200, { meta });
    return true;
  }
  if (metaMatch && req.method === "PATCH") {
    const sessionId = decodeURIComponent(metaMatch[1]!);
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

  // POST /api/history/:sessionId/fork  body?: { throughUserTurn?: number }
  const forkMatch = url.pathname.match(/^\/api\/history\/([^/]+)\/fork$/);
  if (forkMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(forkMatch[1]!);
    let throughUserTurn: number | undefined;
    try {
      const raw = await readBody(req);
      if (raw.trim()) {
        const body = JSON.parse(raw) as { throughUserTurn?: number };
        if (
          typeof body.throughUserTurn === "number" &&
          Number.isFinite(body.throughUserTurn) &&
          body.throughUserTurn >= 0
        ) {
          throughUserTurn = Math.floor(body.throughUserTurn);
        }
      }
    } catch {
      /* empty body = full fork */
    }
    const meta = forkSession(
      sessionId,
      throughUserTurn != null ? { throughUserTurn } : undefined
    );
    if (!meta) {
      json(res, 404, { error: "cannot fork" });
      return true;
    }
    json(res, 200, { meta });
    return true;
  }

  // DELETE /api/history/:sessionId
  if (metaMatch && req.method === "DELETE") {
    const sessionId = decodeURIComponent(metaMatch[1]!);
    try {
      await hooks.stopSession?.(sessionId);
    } catch {
      /* best effort — still try disk delete */
    }
    // Drop pin so a deleted id can't linger in pins.json
    try {
      setPinned(sessionId, false);
    } catch {
      /* ignore */
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
        mime: body.mime || guessMime(dest),
      });
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }

  // POST /api/fs/persist  { path } — copy ephemeral/local file into uploads
  if (url.pathname === "/api/fs/persist" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { path?: string };
      const src = String(body.path || "");
      if (!src || !path.isAbsolute(src) || !fs.existsSync(src)) {
        json(res, 400, { error: "path missing or not found" });
        return true;
      }
      const dest = persistLocalFile(src);
      json(res, 200, {
        path: dest,
        name: path.basename(dest),
        mime: guessMime(dest),
        image: isImagePath(dest),
      });
    } catch (e) {
      json(res, 500, {
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

  // GET /api/fs/list?root=&path=  — list directory under workspace root
  if (url.pathname === "/api/fs/list" && req.method === "GET") {
    const root = url.searchParams.get("root") || "";
    const rel = url.searchParams.get("path") || ".";
    try {
      const entries = listWorkspaceDir(root, rel);
      json(res, 200, { root, path: rel, entries });
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }

  // POST /api/fs/reveal  { path } — reveal in Finder
  if (url.pathname === "/api/fs/reveal" && req.method === "POST") {
    const raw = await readBody(req);
    let target = "";
    try {
      target = String((JSON.parse(raw) as { path?: string }).path ?? "");
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    if (!target || !fs.existsSync(target)) {
      json(res, 400, { error: "path missing or not found" });
      return true;
    }
    try {
      await revealInFinder(target);
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 500, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }

  // POST /api/fs/open  { path } — open with default app
  if (url.pathname === "/api/fs/open" && req.method === "POST") {
    const raw = await readBody(req);
    let target = "";
    try {
      target = String((JSON.parse(raw) as { path?: string }).path ?? "");
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    if (!target || !fs.existsSync(target)) {
      json(res, 400, { error: "path missing or not found" });
      return true;
    }
    try {
      await openWithDefaultApp(target);
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 500, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }

  // GET /api/fs/file?path= — serve a local file (attachment preview / lightbox)
  if (url.pathname === "/api/fs/file" && req.method === "GET") {
    const target = url.searchParams.get("path") || "";
    if (!target || !path.isAbsolute(target) || !fs.existsSync(target)) {
      json(res, 404, { error: "file not found" });
      return true;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(target);
    } catch {
      json(res, 404, { error: "file not found" });
      return true;
    }
    if (!st.isFile()) {
      json(res, 400, { error: "not a file" });
      return true;
    }
    // 40MB — same cap as upload
    if (st.size > 40 * 1024 * 1024) {
      json(res, 413, { error: "file too large" });
      return true;
    }
    try {
      const buf = fs.readFileSync(target);
      cors(res);
      res.statusCode = 200;
      res.setHeader("Content-Type", guessMime(target));
      res.setHeader("Content-Length", String(buf.length));
      res.setHeader("Cache-Control", "private, max-age=60");
      res.end(buf);
    } catch (e) {
      json(res, 500, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }

  // POST /api/terminal/iterm  { cwd } — open iTerm2 at workspace
  if (url.pathname === "/api/terminal/iterm" && req.method === "POST") {
    const raw = await readBody(req);
    let cwd = "";
    try {
      cwd = String((JSON.parse(raw) as { cwd?: string }).cwd ?? "");
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      json(res, 400, { error: "cwd missing or not a directory" });
      return true;
    }
    try {
      await openItermAt(cwd);
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 500, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }

  // —— Agent browser (Playwright) ——
  if (url.pathname === "/api/browser/state" && req.method === "GET") {
    const { getBrowserSession } = await import("./browser-session.js");
    json(res, 200, getBrowserSession().getState());
    return true;
  }

  if (url.pathname === "/api/browser/navigate" && req.method === "POST") {
    const { getBrowserSession } = await import("./browser-session.js");
    const raw = await readBody(req);
    let target = "";
    try {
      target = String((JSON.parse(raw) as { url?: string }).url ?? "");
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    try {
      await getBrowserSession().navigate(target);
      json(res, 200, getBrowserSession().getState());
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
        ...getBrowserSession().getState(),
      });
    }
    return true;
  }

  if (url.pathname === "/api/browser/back" && req.method === "POST") {
    const { getBrowserSession } = await import("./browser-session.js");
    try {
      await getBrowserSession().back();
      json(res, 200, getBrowserSession().getState());
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
        ...getBrowserSession().getState(),
      });
    }
    return true;
  }

  if (url.pathname === "/api/browser/screenshot" && req.method === "POST") {
    const { getBrowserSession } = await import("./browser-session.js");
    try {
      const screenshotBase64 = await getBrowserSession().screenshot();
      json(res, 200, { ...getBrowserSession().getState(), screenshotBase64 });
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
        ...getBrowserSession().getState(),
      });
    }
    return true;
  }

  if (url.pathname === "/api/browser/snapshot" && req.method === "POST") {
    const { getBrowserSession } = await import("./browser-session.js");
    try {
      const snapshot = await getBrowserSession().snapshot();
      json(res, 200, { snapshot, ...getBrowserSession().getState() });
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }

  if (url.pathname === "/api/browser/click" && req.method === "POST") {
    const { getBrowserSession } = await import("./browser-session.js");
    const raw = await readBody(req);
    let selector = "";
    try {
      selector = String((JSON.parse(raw) as { selector?: string }).selector ?? "");
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    try {
      await getBrowserSession().click(selector);
      json(res, 200, getBrowserSession().getState());
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
        ...getBrowserSession().getState(),
      });
    }
    return true;
  }

  if (url.pathname === "/api/browser/type" && req.method === "POST") {
    const { getBrowserSession } = await import("./browser-session.js");
    const raw = await readBody(req);
    let selector = "";
    let text = "";
    try {
      const body = JSON.parse(raw) as { selector?: string; text?: string };
      selector = String(body.selector ?? "");
      text = String(body.text ?? "");
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    try {
      await getBrowserSession().type(selector, text);
      json(res, 200, getBrowserSession().getState());
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
        ...getBrowserSession().getState(),
      });
    }
    return true;
  }

  return false;
}
