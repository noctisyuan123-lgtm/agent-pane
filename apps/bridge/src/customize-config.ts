import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GROK_DIR = path.join(os.homedir(), ".grok");
const RULES_DIR = path.join(GROK_DIR, "rules");
const HOOKS_DIR = path.join(GROK_DIR, "hooks");
const MEMORY_INDEX = path.join(GROK_DIR, "memory", "MEMORY.md");
const GROK_CONFIG = path.join(GROK_DIR, "config.toml");
const CURSOR_MCP = path.join(os.homedir(), ".cursor", "mcp.json");

const SAFE_RULE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.md$/;
const SAFE_HOOK_JSON = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.json$/;
const SAFE_HOOK_SCRIPT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.(sh|py|js|mjs|cjs|ts)$/;
const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|AUTH)/i;
const MASK = "••••••••";

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

function ensureParent(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function maskEnvValue(key: string, value: string): string {
  if (!SECRET_ENV_RE.test(key)) return value;
  if (!value) return "";
  if (value.length <= 4) return MASK;
  return `${value.slice(0, 3)}${MASK}`;
}

function isMasked(value: string): boolean {
  return value.includes("•") || value === MASK;
}

/** List editable rule / memory files. */
export function listCustomizeFiles(): CustomizeFile[] {
  const out: CustomizeFile[] = [];

  if (fs.existsSync(MEMORY_INDEX)) {
    try {
      out.push({
        id: "memory:MEMORY.md",
        name: "MEMORY.md",
        path: MEMORY_INDEX,
        kind: "memory",
        content: fs.readFileSync(MEMORY_INDEX, "utf8"),
      });
    } catch {
      /* skip */
    }
  }

  try {
    if (fs.existsSync(RULES_DIR)) {
      const names = fs
        .readdirSync(RULES_DIR)
        .filter((n) => SAFE_RULE_NAME.test(n))
        .sort();
      for (const name of names) {
        const p = path.join(RULES_DIR, name);
        try {
          const st = fs.statSync(p);
          if (!st.isFile()) continue;
          out.push({
            id: `rule:${name}`,
            name,
            path: p,
            kind: "rule",
            content: fs.readFileSync(p, "utf8"),
          });
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* skip */
  }

  return out;
}

export function readCustomizeFile(id: string): CustomizeFile | null {
  return listCustomizeFiles().find((f) => f.id === id) ?? null;
}

/** Write a known customize file by id. */
export function writeCustomizeFile(
  id: string,
  content: string
): CustomizeFile {
  if (typeof content !== "string") {
    throw new Error("content must be a string");
  }
  if (content.length > 512_000) {
    throw new Error("file too large (max 512KB)");
  }

  if (id === "memory:MEMORY.md") {
    ensureParent(MEMORY_INDEX);
    fs.writeFileSync(MEMORY_INDEX, content, "utf8");
    return {
      id,
      name: "MEMORY.md",
      path: MEMORY_INDEX,
      kind: "memory",
      content,
    };
  }

  const m = id.match(/^rule:(.+)$/);
  if (!m) throw new Error("unknown file id");
  const name = m[1]!;
  if (!SAFE_RULE_NAME.test(name)) throw new Error("invalid rule name");

  ensureParent(path.join(RULES_DIR, name));
  const p = path.join(RULES_DIR, name);
  // Refuse path escape
  if (path.resolve(p) !== path.resolve(RULES_DIR, name)) {
    throw new Error("invalid path");
  }
  fs.writeFileSync(p, content, "utf8");
  return { id, name, path: p, kind: "rule", content };
}

function parseTomlStringArray(raw: string): string[] | undefined {
  const m = raw.match(/^\s*args\s*=\s*\[([\s\S]*?)\]/m);
  if (!m) return undefined;
  const inner = m[1]!;
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(inner))) {
    out.push((hit[1] ?? hit[2] ?? "").replace(/\\"/g, '"'));
  }
  return out;
}

function parseGrokMcp(raw: string): GrokMcpServer[] {
  const servers = new Map<string, GrokMcpServer>();
  const sectionRe = /^\[mcp_servers\.([^\]]+)\]\s*$/gm;
  const indices: { name: string; start: number; headerEnd: number }[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = sectionRe.exec(raw))) {
    indices.push({
      name: sm[1]!,
      start: sm.index,
      headerEnd: sm.index + sm[0].length,
    });
  }

  for (let i = 0; i < indices.length; i++) {
    const cur = indices[i]!;
    const end = i + 1 < indices.length ? indices[i + 1]!.start : raw.length;
    const body = raw.slice(cur.headerEnd, end);
    const isEnv = cur.name.endsWith(".env");
    const baseName = isEnv ? cur.name.slice(0, -".env".length) : cur.name;

    let server = servers.get(baseName);
    if (!server) {
      server = { name: baseName, enabled: true, env: {} };
      servers.set(baseName, server);
    }

    if (isEnv) {
      const envRe = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:\\.|[^"\\])*)"/gm;
      let em: RegExpExecArray | null;
      while ((em = envRe.exec(body))) {
        const key = em[1]!;
        const val = em[2]!.replace(/\\"/g, '"');
        server.env[key] = maskEnvValue(key, val);
      }
    } else {
      const enabled = body.match(/^\s*enabled\s*=\s*(true|false)\s*$/m);
      if (enabled) server.enabled = enabled[1] === "true";
      const command = body.match(/^\s*command\s*=\s*"((?:\\.|[^"\\])*)"/m);
      if (command) server.command = command[1]!.replace(/\\"/g, '"');
      const args = parseTomlStringArray(body);
      if (args) server.args = args;
    }
  }

  return [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadCustomizeMcp(): CustomizeMcpState {
  let grok: GrokMcpServer[] = [];
  if (fs.existsSync(GROK_CONFIG)) {
    try {
      grok = parseGrokMcp(fs.readFileSync(GROK_CONFIG, "utf8"));
    } catch {
      grok = [];
    }
  }

  let cursorJson = '{\n  "mcpServers": {}\n}\n';
  if (fs.existsSync(CURSOR_MCP)) {
    try {
      const raw = fs.readFileSync(CURSOR_MCP, "utf8");
      // Pretty-print for editor; do not strip secrets from Cursor JSON
      // (http mem0 usually has no key in file). Mask nothing if parse fails.
      const parsed = JSON.parse(raw) as unknown;
      cursorJson = `${JSON.stringify(parsed, null, 2)}\n`;
    } catch {
      cursorJson = fs.readFileSync(CURSOR_MCP, "utf8");
    }
  }

  return {
    grokConfigPath: GROK_CONFIG,
    cursorMcpPath: CURSOR_MCP,
    grok,
    cursorJson,
  };
}

function findTomlSection(
  raw: string,
  sectionHeader: string
): { start: number; headerEnd: number; end: number } | null {
  const header = `[${sectionHeader}]`;
  // Exact section line only — avoid matching mcp_servers.foo inside mcp_servers.foo.env
  const re = new RegExp(
    `^\\[${sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`,
    "m"
  );
  const m = re.exec(raw);
  if (!m || m.index === undefined) return null;
  const start = m.index;
  const headerEnd = start + m[0].length;
  const rest = raw.slice(headerEnd);
  const next = rest.search(/\n\s*\[[^\]]+\]/);
  const end = next >= 0 ? headerEnd + next : raw.length;
  return { start, headerEnd, end };
}

function setTomlKeyInSection(
  raw: string,
  sectionHeader: string,
  key: string,
  line: string
): string {
  const found = findTomlSection(raw, sectionHeader);
  if (!found) {
    const block = `\n[${sectionHeader}]\n${line}\n`;
    return raw.endsWith("\n") ? raw + block : `${raw}\n${block}`;
  }
  const { headerEnd, end } = found;
  const before = raw.slice(0, headerEnd);
  let body = raw.slice(headerEnd, end);
  const after = raw.slice(end);

  const keyRe = new RegExp(`^\\s*${key}\\s*=\\s*.*$`, "m");
  if (keyRe.test(body)) {
    body = body.replace(keyRe, line);
  } else {
    // Keep a leading newline after the header, then insert the key line.
    if (!body.startsWith("\n")) body = `\n${body}`;
    body = body.replace(/^\n/, `\n${line}\n`);
  }
  // Guarantee header is followed by a newline
  if (!body.startsWith("\n")) body = `\n${body}`;
  return before + body + after;
}

function setTomlEnvString(
  raw: string,
  serverName: string,
  key: string,
  value: string
): string {
  const section = `mcp_servers.${serverName}.env`;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const line = `${key} = "${escaped}"`;
  return setTomlKeyInSection(raw, section, key, line);
}

export type GrokMcpPatch = {
  name: string;
  enabled?: boolean;
  env?: Record<string, string>;
};

/** Patch Grok MCP servers in config.toml (enabled + non-secret env). */
export function patchGrokMcp(patches: GrokMcpPatch[]): CustomizeMcpState {
  if (!Array.isArray(patches) || patches.length === 0) {
    return loadCustomizeMcp();
  }

  let raw = fs.existsSync(GROK_CONFIG)
    ? fs.readFileSync(GROK_CONFIG, "utf8")
    : "";

  for (const patch of patches) {
    const name = String(patch.name || "").trim();
    if (!name || /[\[\]]/.test(name)) throw new Error("invalid server name");

    if (typeof patch.enabled === "boolean") {
      raw = setTomlKeyInSection(
        raw,
        `mcp_servers.${name}`,
        "enabled",
        `enabled = ${patch.enabled}`
      );
    }

    if (patch.env && typeof patch.env === "object") {
      for (const [k, v] of Object.entries(patch.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
        if (typeof v !== "string") continue;
        if (SECRET_ENV_RE.test(k) && isMasked(v)) continue; // keep existing
        if (SECRET_ENV_RE.test(k) && !v.trim()) continue;
        raw = setTomlEnvString(raw, name, k, v);
      }
    }
  }

  ensureParent(GROK_CONFIG);
  fs.writeFileSync(GROK_CONFIG, raw, "utf8");
  return loadCustomizeMcp();
}

/** Replace Cursor ~/.cursor/mcp.json with validated JSON. */
export function writeCursorMcp(jsonText: string): CustomizeMcpState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(
      `invalid JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("mcp.json root must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (!("mcpServers" in obj) || typeof obj.mcpServers !== "object") {
    throw new Error('mcp.json must contain an "mcpServers" object');
  }
  const pretty = `${JSON.stringify(parsed, null, 2)}\n`;
  ensureParent(CURSOR_MCP);
  fs.writeFileSync(CURSOR_MCP, pretty, "utf8");
  return loadCustomizeMcp();
}

// ── Hooks (~/.grok/hooks/*.json + companion scripts) ──────────────

export type CustomizeHookFile = {
  id: string;
  name: string;
  path: string;
  kind: "json" | "script";
  content: string;
  /** Event names declared in a hook JSON (empty for scripts). */
  events: string[];
};

export type CustomizeHooksState = {
  hooksDir: string;
  files: CustomizeHookFile[];
};

function parseHookEvents(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as { hooks?: Record<string, unknown> };
    if (!parsed?.hooks || typeof parsed.hooks !== "object") return [];
    return Object.keys(parsed.hooks).sort();
  } catch {
    return [];
  }
}

function resolveHookPath(name: string): string {
  const p = path.join(HOOKS_DIR, name);
  if (path.resolve(p) !== path.resolve(HOOKS_DIR, name)) {
    throw new Error("invalid path");
  }
  return p;
}

/** List global Grok hooks under ~/.grok/hooks. */
export function listCustomizeHooks(): CustomizeHooksState {
  const files: CustomizeHookFile[] = [];
  try {
    if (!fs.existsSync(HOOKS_DIR)) {
      return { hooksDir: HOOKS_DIR, files: [] };
    }
    const names = fs.readdirSync(HOOKS_DIR).sort();
    for (const name of names) {
      const isJson = SAFE_HOOK_JSON.test(name);
      const isScript = SAFE_HOOK_SCRIPT.test(name);
      if (!isJson && !isScript) continue;
      const p = path.join(HOOKS_DIR, name);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        const content = fs.readFileSync(p, "utf8");
        files.push({
          id: name,
          name,
          path: p,
          kind: isJson ? "json" : "script",
          content,
          events: isJson ? parseHookEvents(content) : [],
        });
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  return { hooksDir: HOOKS_DIR, files };
}

function validateHookJson(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(
      `invalid JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("hook file root must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (!("hooks" in obj) || typeof obj.hooks !== "object" || obj.hooks === null) {
    throw new Error('hook file must contain a "hooks" object');
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** Create or overwrite a hook JSON / script in ~/.grok/hooks. */
export function writeCustomizeHook(
  name: string,
  content: string
): CustomizeHookFile {
  if (typeof content !== "string") throw new Error("content must be a string");
  if (content.length > 512_000) throw new Error("file too large (max 512KB)");

  const trimmed = String(name || "").trim();
  const isJson = SAFE_HOOK_JSON.test(trimmed);
  const isScript = SAFE_HOOK_SCRIPT.test(trimmed);
  if (!isJson && !isScript) {
    throw new Error(
      "invalid name (use name.json or name.sh|py|js|mjs|cjs|ts)"
    );
  }

  let body = content;
  if (isJson) {
    body = validateHookJson(content);
  }

  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  const p = resolveHookPath(trimmed);
  fs.writeFileSync(p, body, { encoding: "utf8", mode: isScript ? 0o755 : 0o644 });
  // Ensure scripts stay executable even if umask stripped bits
  if (isScript) {
    try {
      fs.chmodSync(p, 0o755);
    } catch {
      /* ignore */
    }
  }

  return {
    id: trimmed,
    name: trimmed,
    path: p,
    kind: isJson ? "json" : "script",
    content: body,
    events: isJson ? parseHookEvents(body) : [],
  };
}

/** Delete a hook file under ~/.grok/hooks (name only, no path escape). */
export function deleteCustomizeHook(name: string): void {
  const trimmed = String(name || "").trim();
  if (!SAFE_HOOK_JSON.test(trimmed) && !SAFE_HOOK_SCRIPT.test(trimmed)) {
    throw new Error("invalid name");
  }
  const p = resolveHookPath(trimmed);
  if (!fs.existsSync(p)) throw new Error("file not found");
  fs.unlinkSync(p);
}

/** Default template for a new SessionStart hook. */
export function defaultHookTemplate(nameBase: string): string {
  const safe = nameBase.replace(/[^a-zA-Z0-9._-]/g, "-") || "my-hook";
  return `${JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `echo '[${safe}] session start in' "$(pwd)"`,
                timeout: 5,
              },
            ],
          },
        ],
      },
    },
    null,
    2
  )}\n`;
}
