import { execFileSync } from "node:child_process";
import type { DiffFileMeta } from "@agent-pane/shared";
import type { SnapshotInfo } from "./workspace-snapshot.js";

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 30 * 1024 * 1024,
    });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return err.stdout ?? "";
  }
}

function countDiffStats(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

/**
 * Diff Engine: truth = worktree vs session baseline (HEAD for clean git sessions,
 * or full porcelain status with patches). Provider-agnostic.
 */
export class DiffEngine {
  compute(cwd: string, _snapshot: SnapshotInfo | undefined): DiffFileMeta[] {
    // Prefer git
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return [];
    }

    const status = git(cwd, ["status", "--porcelain", "-uall"]);
    if (!status.trim()) return [];

    const files: DiffFileMeta[] = [];
    for (const line of status.split("\n").filter(Boolean)) {
      const xy = line.slice(0, 2);
      let filePath = line.slice(3).trim();
      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ").pop()!;
      }

      let statusKind: DiffFileMeta["status"] = "modified";
      if (xy.includes("A") || xy === "??") statusKind = "added";
      else if (xy.includes("D")) statusKind = "deleted";
      else if (xy.includes("R")) statusKind = "renamed";

      let patch = "";
      if (xy === "??") {
        // untracked: show as all additions via empty vs file is expensive; use git diff --no-index
        patch = git(cwd, ["diff", "--no-index", "--", "/dev/null", filePath]);
      } else {
        patch = git(cwd, ["diff", "HEAD", "--", filePath]);
        if (!patch.trim()) {
          // staged only
          patch = git(cwd, ["diff", "--cached", "HEAD", "--", filePath]);
        }
      }
      const { additions, deletions } = countDiffStats(patch);
      files.push({
        path: filePath,
        status: statusKind,
        additions,
        deletions,
        patch: patch.slice(0, 200_000),
      });
    }
    return files;
  }
}
