import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export type SnapshotInfo = {
  snapshotId: string;
  cwd: string;
  kind: "git" | "files";
  /** git: commit/tree-ish or "WORKTREE_BASE"; files: backup dir */
  ref: string;
};

function isGitRepo(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}

/**
 * Hybrid strategy C: git preferred.
 * Baseline is recorded at session start. Reject restores paths to baseline.
 * For git we use `git stash create` equivalent: record HEAD + unstaged via
 * `git rev-parse HEAD` and on reject `git checkout HEAD -- paths` only if clean
 * baseline was clean HEAD. Better: store patch of dirty state.
 *
 * Practical v1 approach for git:
 * - On snapshot: create a temporary commit-like tree via `git write-tree` after
 *   `git add -A` is TOO invasive.
 * - Instead: use `git status --porcelain` and for each tracked/untracked change
 *   on reject: `git checkout -- path` for modified tracked; delete added; restore
 *   deleted from HEAD. For true baseline of "state at session start including
 *   dirty tree", we copy changed files to snapshot dir at first snapshot and
 *   re-copy any file before first modification is hard without FS watch.
 *
 * v1 pragmatic:
 * - Snapshot records HEAD sha + full `git status` list + copies of currently
 *   dirty files into snapshot dir.
 * - On reject: restore dirty-at-start files from snapshot copy; for files that
 *   became dirty after session: git checkout HEAD -- path or delete if untracked new.
 * - On accept: just update snapshot to current state (re-take).
 */
export class WorkspaceSnapshotService {
  private snapshots = new Map<string, SnapshotInfo>();
  private root: string;

  constructor(root?: string) {
    this.root = root ?? path.join(os.homedir(), ".agent-pane", "snapshots");
    fs.mkdirSync(this.root, { recursive: true });
  }

  take(sessionId: string, cwd: string): SnapshotInfo {
    const snapshotId = randomUUID();
    const dir = path.join(this.root, snapshotId);
    fs.mkdirSync(dir, { recursive: true });

    if (isGitRepo(cwd)) {
      let head = "UNBORN";
      try {
        head = git(cwd, ["rev-parse", "HEAD"]);
      } catch {
        head = "UNBORN";
      }
      // Save list of dirty paths + content for restore
      const status = git(cwd, ["status", "--porcelain", "-uall"]);
      fs.writeFileSync(path.join(dir, "head"), head, "utf8");
      fs.writeFileSync(path.join(dir, "status.txt"), status, "utf8");
      const meta: SnapshotInfo = {
        snapshotId,
        cwd,
        kind: "git",
        ref: head,
      };
      fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
      // backup currently dirty files
      for (const line of status.split("\n").filter(Boolean)) {
        const p = line.slice(3).trim().split(" -> ").pop()!;
        const abs = path.join(cwd, p);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          const dest = path.join(dir, "files", p);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          try {
            fs.copyFileSync(abs, dest);
          } catch {
            /* skip */
          }
        }
      }
      this.snapshots.set(sessionId, meta);
      return meta;
    }

    // non-git: empty baseline marker; reject uses file backups taken lazily via full tree optional
    const meta: SnapshotInfo = {
      snapshotId,
      cwd,
      kind: "files",
      ref: dir,
    };
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    this.snapshots.set(sessionId, meta);
    return meta;
  }

  get(sessionId: string): SnapshotInfo | undefined {
    return this.snapshots.get(sessionId);
  }

  /** Reject: restore workspace to session baseline for given paths or all. */
  restore(sessionId: string, filePath: string | "*"): void {
    const snap = this.snapshots.get(sessionId);
    if (!snap) throw new Error("No snapshot for session");
    const dir = path.join(this.root, snap.snapshotId);
    const cwd = snap.cwd;

    if (snap.kind === "git") {
      // Files changed since session: reset to HEAD then re-apply baseline dirty copies
      if (filePath === "*") {
        try {
          git(cwd, ["checkout", "--", "."]);
          git(cwd, ["clean", "-fd"]);
        } catch {
          /* best effort */
        }
      } else {
        try {
          git(cwd, ["checkout", "HEAD", "--", filePath]);
        } catch {
          const abs = path.join(cwd, filePath);
          if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
        }
        try {
          // remove if was untracked new
          const status = git(cwd, ["status", "--porcelain", "--", filePath]);
          if (status.startsWith("??")) {
            fs.rmSync(path.join(cwd, filePath), { force: true });
          }
        } catch {
          /* */
        }
      }
      // restore files that were dirty at baseline
      const filesRoot = path.join(dir, "files");
      if (fs.existsSync(filesRoot)) {
        const restoreOne = (rel: string) => {
          const src = path.join(filesRoot, rel);
          const dest = path.join(cwd, rel);
          if (!fs.existsSync(src)) return;
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
        };
        if (filePath === "*") {
          const walk = (d: string, prefix = "") => {
            for (const name of fs.readdirSync(d)) {
              const p = path.join(d, name);
              const rel = prefix ? `${prefix}/${name}` : name;
              if (fs.statSync(p).isDirectory()) walk(p, rel);
              else restoreOne(rel);
            }
          };
          walk(filesRoot);
        } else {
          restoreOne(filePath);
        }
      }
      return;
    }

    // files kind: only can restore if we had backups — v1 limited
    throw new Error("Non-git snapshot restore is limited in v1; use a git workspace");
  }

  /** Accept: re-take baseline as current worktree. */
  advance(sessionId: string): SnapshotInfo {
    const prev = this.snapshots.get(sessionId);
    if (!prev) throw new Error("No snapshot for session");
    return this.take(sessionId, prev.cwd);
  }
}
