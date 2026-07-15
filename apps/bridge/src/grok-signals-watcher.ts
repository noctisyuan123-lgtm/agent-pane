import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type GrokSignalsUsage = {
  used: number;
  size: number;
  /** Grok's own percentage field when present */
  pct?: number;
};

/** Grok stores sessions under ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/ */
export function resolveGrokSignalsPaths(
  cwd: string,
  providerSessionId: string
): string[] {
  if (!cwd?.trim() || !providerSessionId?.trim()) return [];
  const home = os.homedir();
  const sessionsRoot = path.join(home, ".grok", "sessions");
  const roots = new Set<string>();
  const abs = path.resolve(cwd.trim());
  roots.add(abs);
  try {
    roots.add(fs.realpathSync(abs));
  } catch {
    /* ignore */
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };

  for (const root of roots) {
    push(
      path.join(
        sessionsRoot,
        encodeURIComponent(root),
        providerSessionId,
        "signals.json"
      )
    );
  }

  // Symlink / alternate cwd encodings: find by session id under any workspace dir
  try {
    if (fs.existsSync(sessionsRoot)) {
      for (const ent of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!ent.isDirectory() || !ent.name.startsWith("%")) continue;
        push(
          path.join(sessionsRoot, ent.name, providerSessionId, "signals.json")
        );
      }
    }
  } catch {
    /* ignore */
  }

  return out;
}

export function readGrokSignalsUsage(
  paths: string[]
): GrokSignalsUsage | null {
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const j = JSON.parse(raw) as Record<string, unknown>;
      const used = Number(j.contextTokensUsed);
      const size = Number(j.contextWindowTokens);
      if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) {
        continue;
      }
      const pctRaw = Number(j.contextWindowUsage);
      return {
        used: Math.max(0, Math.round(used)),
        size: Math.max(1, Math.round(size)),
        pct: Number.isFinite(pctRaw) ? pctRaw : undefined,
      };
    } catch {
      /* try next path */
    }
  }
  return null;
}

/**
 * Poll Grok's local signals.json for live context window fill.
 * Updates are typically turn-granular (not every stream token).
 */
export class GrokSignalsWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private watchers: fs.FSWatcher[] = [];
  private lastKey = "";
  private stopped = false;
  private paths: string[];

  constructor(
    paths: string[],
    private onUsage: (u: GrokSignalsUsage) => void,
    private intervalMs = 1200
  ) {
    this.paths = paths;
  }

  start(): void {
    this.stopped = false;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Best-effort instant wake on write (macOS may coalesce; poll is source of truth)
    for (const p of this.paths) {
      try {
        const dir = path.dirname(p);
        if (!fs.existsSync(dir)) continue;
        const w = fs.watch(dir, { persistent: false }, (_evt, filename) => {
          if (this.stopped) return;
          if (
            !filename ||
            filename === "signals.json" ||
            String(filename).endsWith("signals.json")
          ) {
            this.tick();
          }
        });
        this.watchers.push(w);
      } catch {
        /* poll still runs */
      }
    }
  }

  /** Force a read (e.g. after prompt completes). */
  refresh(): void {
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers = [];
  }

  private tick(): void {
    if (this.stopped) return;
    const u = readGrokSignalsUsage(this.paths);
    if (!u) return;
    const key = `${u.used}:${u.size}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.onUsage(u);
  }
}
