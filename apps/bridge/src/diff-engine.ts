import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DiffFileMeta } from "@agent-pane/shared";
import {
  loadSnapshotFingerprints,
  type SnapshotInfo,
} from "./workspace-snapshot.js";

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

/** Fingerprint of current on-disk content for Accept tracking. */
export function fileFingerprint(cwd: string, relPath: string): string {
  const abs = path.join(cwd, relPath);
  try {
    if (!fs.existsSync(abs)) return "missing";
    const st = fs.statSync(abs);
    if (st.isDirectory()) return `dir:${st.mtimeMs}`;
    const buf = fs.readFileSync(abs);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return "error";
  }
}

/**
 * Diff Engine: show only files that changed *during this session*.
 *
 * Pre-existing dirty worktree (vs HEAD) is recorded at session snapshot and
 * filtered out — so "hello" / Read-only turns no longer dump 25 unrelated diffs.
 * Caller may further filter with Accept fingerprints so Keep 后不再弹出同内容.
 */
export class DiffEngine {
  compute(cwd: string, snapshot: SnapshotInfo | undefined): DiffFileMeta[] {
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

    const baseline = loadSnapshotFingerprints(snapshot);

    const files: DiffFileMeta[] = [];
    for (const line of status.split("\n").filter(Boolean)) {
      const xy = line.slice(0, 2);
      let filePath = line.slice(3).trim();
      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ").pop()!;
      }

      // Skip paths unchanged since session open (already dirty before New Agent)
      if (baseline) {
        const nowFp = fileFingerprint(cwd, filePath);
        const baseFp = baseline.get(filePath);
        if (baseFp != null && baseFp === nowFp) {
          continue;
        }
      }

      let statusKind: DiffFileMeta["status"] = "modified";
      if (xy.includes("A") || xy === "??") statusKind = "added";
      else if (xy.includes("D")) statusKind = "deleted";
      else if (xy.includes("R")) statusKind = "renamed";

      let patch = "";
      if (xy === "??") {
        patch = git(cwd, ["diff", "--no-index", "--", "/dev/null", filePath]);
      } else {
        patch = git(cwd, ["diff", "HEAD", "--", filePath]);
        if (!patch.trim()) {
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
