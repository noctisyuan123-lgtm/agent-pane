/**
 * Healthy PATH for GUI-launched bridge / agent tool shells.
 *
 * Root cause of "环境混乱" in Agent Pane tools:
 * - Grok ACP runs tools as `/bin/bash -lc '…'` (login shell).
 * - Login shells source ~/.bash_profile / conda init, which reorder or briefly
 *   break PATH → `dirname: command not found`, `head: command not found`.
 * - Node `spawn(cmd, { shell: true })` wraps that again in $SHELL -c, so
 *   zshrc + bash_profile both fire.
 *
 * Fix: clean PATH on the spawn `env`, and run tool shells as
 * `/bin/bash --noprofile --norc -c <script>` without re-prefixing
 * `export PATH=...` into the script string (that mangled nested quotes /
 * pipes: `unexpected EOF while looking for matching '"'`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Always present; put early so coreutils work even if user PATH is weird. */
const SYSTEM_DIRS = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
];

function nvmDefaultBin(home: string): string | null {
  const nvmDir = process.env.NVM_DIR || path.join(home, ".nvm");
  const alias = path.join(nvmDir, "alias", "default");
  try {
    if (fs.existsSync(alias)) {
      const ver = fs.readFileSync(alias, "utf8").trim();
      if (ver) {
        const bin = path.join(nvmDir, "versions", "node", ver, "bin");
        if (fs.existsSync(bin)) return bin;
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const versions = path.join(nvmDir, "versions", "node");
    if (!fs.existsSync(versions)) return null;
    const names = fs
      .readdirSync(versions)
      .filter((n) => n.startsWith("v"))
      .sort();
    for (let i = names.length - 1; i >= 0; i--) {
      const bin = path.join(versions, names[i]!, "bin");
      if (fs.existsSync(bin)) return bin;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function userExtraDirs(home: string): string[] {
  const extras = [
    path.join(home, ".grok", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
  ];
  const nvm = nvmDefaultBin(home);
  if (nvm) extras.push(nvm);
  return extras.filter((d) => {
    try {
      return fs.existsSync(d);
    } catch {
      return false;
    }
  });
}

/** Drop broken tokens like a lone `$` from a bad `export PATH=...:$`. */
function cleanPathParts(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p !== "$" && !/^\$+$/.test(p));
}

/**
 * Prefer a stable tool PATH:
 *   system coreutils → homebrew → user bins (grok/cargo/nvm) → remaining existing
 * Deduped, first wins.
 */
export function buildAugmentedPath(existing?: string | null): string {
  const home = os.homedir();
  const parts = [
    ...SYSTEM_DIRS,
    ...userExtraDirs(home),
    ...cleanPathParts(existing),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.join(path.delimiter);
}

/** Mutate process.env.PATH once at bridge boot. */
export function applyHealthyPathToProcess(): void {
  process.env.PATH = buildAugmentedPath(process.env.PATH);
}

/** Clone env with a healthy PATH (for spawn / PTY). */
export function withHealthyEnv(
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  env.PATH = buildAugmentedPath(base.PATH ?? process.env.PATH);
  // Non-interactive tool shells must not re-source random ENV files.
  env.BASH_ENV = "";
  env.ENV = "";
  return env;
}

/** String map for node-pty (no undefined values). */
export function withHealthyEnvRecord(
  base: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env = withHealthyEnv(base);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v != null) out[k] = v;
  }
  return out;
}

export type ToolSpawnSpec = {
  file: string;
  args: string[];
  /** Always false for hardened tool spawns — avoid $SHELL -c double wrap. */
  shell: false;
  /** Short label for activity strip */
  label: string;
  /** Extra env for this spawn */
  env?: Record<string, string>;
  /**
   * Script body written to stdin. Used with `bash --noprofile --norc -s`
   * so we never put the user script on a `bash -c` argv (Grok wraps with
   * single quotes; `tr … '\n'` then breaks the outer quotes → whole pipeline
   * becomes argv[0] / a fake script path).
   */
  stdinScript?: string;
};

/**
 * Unwrap outer single/double quotes once (bash -lc 'script').
 * For double-quoted wrappers, also unescape common shell escapes so
 * `bash -c "python3 -c \"code\""` becomes `python3 -c "code"` — not
 * `python3 -c \"code\"` (literal backslashes break bash -c).
 */
function unwrapOuterQuotes(s: string): string {
  const t = s.trim();
  if (t.length < 2) return t;
  const a = t[0];
  const b = t[t.length - 1];
  if (a === "'" && b === "'") {
    return t.slice(1, -1);
  }
  if (a === '"' && b === '"') {
    return t
      .slice(1, -1)
      .replace(/\\([\\"`$])/g, "$1");
  }
  return t;
}

/**
 * If Grok (or us) already prefixed `export PATH=...;`, drop that so we don't
 * stack competing PATH exports — we inject a clean one ourselves.
 */
function stripLeadingPathExports(script: string): string {
  let s = script.trimStart();
  // export PATH="...";  or export PATH=...;
  for (let i = 0; i < 3; i++) {
    const m = s.match(
      /^export\s+PATH=(?:"[^"]*"|'[^']*'|[^\s;]+)\s*;?\s*/
    );
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s;
}

/**
 * Peel one layer of `bash -c` / `bash -lc` wrapping if Grok already wrapped
 * the user script. Returns the inner script when detected.
 */
function stripBashCWrapper(script: string): string {
  const t = script.trim();
  // /bin/bash -lc '…'   or   bash -c "…"
  const m = t.match(/^(?:\/bin\/)?bash\s+-(l)?c\s+([\s\S]+)$/i);
  if (!m) return script;
  return unwrapOuterQuotes(m[2]!);
}

/**
 * Grok often shell-escapes a script for `bash -c '…'`, then sends that
 * *source text* as ACP argv. Correct form uses `'"'"'`; Grok's broken form:
 *   'echo "$PATH" | tr '"':' '\\n' | head -8
 * (leading `'`, botched `'"':`, doubled `\\n`, often no closing `'`).
 * Feeding that to bash -s makes line 1 one quoted command name.
 */
function looksLikeGrokQuoteNest(s: string): boolean {
  return s.includes("'" + '"') || s.includes('"' + "'");
}

/**
 * Repair Grok's *invalid* nest (set -- cannot parse it).
 * Observed from Agent Pane activity labels (2026-07-15):
 *   'echo "$PATH" | tr '"':' '\\n' | head -8
 *   'echo "$HOME" | tr '"'/'' '\\n' | head -5
 *   'echo "$PATH" | tr ":" "'"\\n\" | head -
 * → echo "$PATH" | tr ':' '\n' | head -8  (etc.)
 */
function repairGrokBrokenShellEscapes(script: string): string {
  let t = script.trim();
  if (!looksLikeGrokQuoteNest(t)) return t;

  // Peel a broken outer single-quote wrapper (often no matching close).
  if (t.startsWith("'")) {
    if (t.endsWith("'") && t.length >= 2) {
      // Only peel if internals still contain nest artifacts.
      const inner = t.slice(1, -1);
      if (looksLikeGrokQuoteNest(inner) || /[|]/.test(inner)) {
        t = inner;
      }
    } else {
      t = t.slice(1);
    }
  }

  // '"': ' / '"'/ '  →  ':' / '/'   (botched single-char in quotes)
  t = t.replace(/'"'(.)'/g, "'$1'");

  // Double-quote tr form: ":" "'"\\n\"  →  ":" "\n"
  t = t.replace(/"'"\\+n\\?"/g, '"\\n"');
  t = t.replace(/"'"\\+n"/g, '"\\n"');

  // Inside '...': collapse \\n / \\\n → \n (one backslash for shell source)
  t = t.replace(/'\\+n'/g, "'\\n'");
  t = t.replace(/"\\+n"/g, '"\\n"');

  // Leftover correct-ish toggles if any remain
  t = t.replace(/'"'"'/g, "'");
  t = t.replace(/'\"'\"'/g, "'");

  return t;
}

/**
 * Demangle Grok's shell-word argv into a real script body.
 * 1) `set --` for valid `'"'"'` encoding
 * 2) heuristic repair for Grok's broken nest
 */
function demangleGrokShellWord(script: string): string {
  const t = script.trim();
  if (!looksLikeGrokQuoteNest(t)) return t;

  // Prefer bash word-parse when the nest is actually valid shell.
  const r = spawnSync("/bin/bash", ["--noprofile", "--norc"], {
    input: `set -- ${t}\nprintf '%s' "$1"\n`,
    encoding: "utf8",
    env: withHealthyEnv(process.env) as NodeJS.ProcessEnv,
  });
  if (r.status === 0 && typeof r.stdout === "string" && r.stdout.length > 0) {
    return r.stdout;
  }

  return repairGrokBrokenShellEscapes(t);
}

function bashHardenedArgs(script: string): {
  args: string[];
  stdinScript: string;
  labelBody: string;
} {
  // Demangle FIRST — outer quotes are part of Grok's shell-word form.
  // Unwrapping before demangle destroys valid `'"'"'` encodings.
  let body = demangleGrokShellWord(script.trim());
  body = stripLeadingPathExports(unwrapOuterQuotes(body));
  body = stripBashCWrapper(body);
  body = demangleGrokShellWord(body);
  body = stripLeadingPathExports(unwrapOuterQuotes(body));
  body = stripBashCWrapper(body);
  // If an upstream JSON layer turned '\n' / "\n" into a real newline inside
  // quotes, restore the two-char escape so `tr` still gets a newline char.
  body = body.replace(/'(\r?\n)'/g, "'\\n'").replace(/"(\r?\n)"/g, '"\\n"');
  return {
    // -s: read script from stdin — no -c argv quoting battlefield
    args: ["--noprofile", "--norc", "-s"],
    stdinScript: body.endsWith("\n") ? body : `${body}\n`,
    labelBody: body,
  };
}

function bashSpec(
  script: string,
  healthyPath: string
): ToolSpawnSpec {
  void healthyPath;
  const h = bashHardenedArgs(script);
  return {
    file: "/bin/bash",
    args: h.args,
    shell: false,
    label: `bash -s ${h.labelBody.slice(0, 40)}`,
    stdinScript: h.stdinScript,
  };
}

/**
 * Resolve how to spawn an ACP terminal/create command so login shells
 * cannot poison PATH.
 *
 * Handles:
 * - command=`/bin/bash -lc '…'`, args=[]
 * - command=`bash`, args=`['-lc', '…']` or `['-c', '…']`
 * - bash + script body WITHOUT -c (Grok sometimes omits the flag)
 * - arbitrary one-liner with spaces → bash --noprofile -c (not shell:true)
 * - plain binary + args → as-is
 *
 * Scripts always ride in AGENT_PANE_TOOL_SCRIPT (see bashHardenedArgs).
 */
export function resolveToolSpawn(
  command: string,
  args: string[],
  healthyPath: string
): ToolSpawnSpec {
  const cmd = (command ?? "").trim();
  const a = args.map(String);

  // Form: bash /bin/bash + (-lc|-c) + script
  // Use a[1] only as the script — do NOT join(a.slice(1)): extra argv
  // are bash -c's $0/$1, and joining mangles '\n' / quoted segments.
  if (/^(?:\/bin\/)?bash$/.test(cmd) && a.length >= 1 && /^-l?c$/.test(a[0]!)) {
    const script = a[1] ?? "";
    return bashSpec(script, healthyPath);
  }

  // Form: bash + script body WITHOUT -c/-lc (Grok sometimes omits the flag).
  if (/^(?:\/bin\/)?bash$/.test(cmd) && a.length >= 1 && !/^-/.test(a[0]!)) {
    const script = a.length === 1 ? a[0]! : a.join(" ");
    if (a.length > 1 || /[\s'"|&;<>$`]/.test(script)) {
      return bashSpec(script, healthyPath);
    }
  }

  // Form: entire line `/bin/bash -lc '…'` or `bash -c "…"`
  const line = a.length === 0 ? cmd : "";
  if (line) {
    const m = line.match(/^(?:\/bin\/)?bash\s+-(l)?c\s+([\s\S]+)$/i);
    if (m) {
      return bashSpec(m[2]!, healthyPath);
    }

    // Other one-liners: never shell:true (avoids zsh -c wrapping).
    if (/[\s'"|&;<>$`]/.test(line)) {
      return bashSpec(line, healthyPath);
    }
  }

  // Plain executable — but never exec a "binary" whose name is a shell line
  // (spaces / pipes / quotes / $vars). Those must go through bash -c.
  const file = cmd || "/bin/bash";
  const argv = a.length ? a : [];
  if (/[\s'"|&;<>$`]/.test(file)) {
    const script = argv.length ? `${file} ${argv.join(" ")}` : file;
    return bashSpec(script, healthyPath);
  }

  // echo/tr/… with shell metacharacters buried in argv (e.g. echo +
  // ["$PATH | tr ':' '\\n' | head -8"] is rare; more common is argv
  // containing "|" as its own token from a bad split).
  if (argv.some((x) => /[|&;<>]/.test(x) || x.includes("\n"))) {
    const script = [file, ...argv].join(" ");
    return bashSpec(script, healthyPath);
  }

  return {
    file,
    args: argv,
    shell: false,
    label: `${file} ${argv.join(" ")}`.trim().slice(0, 60),
  };
}
