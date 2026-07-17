/** Subagent spawn detection + live activity derivation (Cursor-aligned). */

import type { ChatItem } from "./chatFromEvents";
import type { RunningProcessItem } from "./AgentActivityStrip";

const MODEL_LABELS: Record<string, string> = {
  "grok-4.5": "Grok 4.5",
  "grok-composer-2.5-fast": "Composer 2.5",
  "composer-2.5": "Composer 2.5",
  "composer-2.5-fast": "Composer 2.5 Fast",
  "claude-4.6-opus-medium-thinking": "Opus 4.6",
  "claude-4.6-sonnet-low-thinking": "Sonnet 4.6",
  "gpt-5.6-sol-medium": "GPT 5.6",
};

function truncateOneLine(text: string, max = 72): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Human-readable model chip (e.g. grok-4.5 → Grok 4.5). */
export function formatModelLabel(modelId: string | null | undefined): string {
  const raw = (modelId || "").trim();
  if (!raw) return "";
  const known = MODEL_LABELS[raw];
  if (known) return known;
  // grok-composer-2.5-fast → Composer 2.5 Fast
  const slug = raw
    .replace(/^grok-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return slug || raw;
}

/** Subagent / task spawn tool — NOT sleeping shell or ordinary execute. */
export function isSubagentSpawnTool(t: {
  kind?: string;
  name?: string;
  label?: string;
}): boolean {
  const kind = (t.kind || "").toLowerCase();
  if (kind === "sleeping" || kind === "execute") return false;
  const blob = `${t.name || ""} ${t.label || ""}`;
  return /subagent|spawn_subagent|Task\b|task_tool|dispatch/i.test(blob);
}

/** RunningDock-worthy but not subagent (sleeping / permission). */
export function hasNonSubagentDockProcess(
  messages: ChatItem[],
  phase: string | null | undefined,
  statusMsg: string | null
): boolean {
  if (phase === "sleeping") return true;
  if (phase === "permission") return true;
  if (statusMsg != null && /^Permission\b/i.test(statusMsg)) return true;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind !== "tools") continue;
    for (const t of m.tools) {
      if (t.status !== "running") continue;
      if ((t.kind || "").toLowerCase() === "sleeping") return true;
    }
  }
  return false;
}

function runningSpawnTools(messages: ChatItem[]) {
  const out: Array<{
    toolId: string;
    label: string;
    name: string;
  }> = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind !== "tools") continue;
    for (const t of m.tools) {
      if (t.status !== "running" || !isSubagentSpawnTool(t)) continue;
      if (seen.has(t.toolId)) continue;
      seen.add(t.toolId);
      out.push({
        toolId: t.toolId,
        label: (t.label || t.name || "Subagent").replace(/^Ran\s+/i, "").trim(),
        name: t.name || "",
      });
    }
  }
  return out;
}

/** Active nested subagents only — not shells / ordinary execute. */
export function countActiveSubagents(
  messages: ChatItem[],
  subagentModel: string | null | undefined
): number {
  const spawns = runningSpawnTools(messages);
  if (subagentModel?.trim()) {
    return Math.max(1, spawns.length);
  }
  return spawns.length;
}

export function collectActiveSubagentItems(
  messages: ChatItem[],
  subagentModel: string | null | undefined,
  statusMsg: string | null,
  tasks: { content: string; status: string }[]
): RunningProcessItem[] {
  const items: RunningProcessItem[] = [];
  const seen = new Set<string>();

  for (const t of runningSpawnTools(messages)) {
    if (seen.has(t.toolId)) continue;
    seen.add(t.toolId);
    items.push({
      id: t.toolId,
      kind: "subagent",
      label: t.label,
    });
  }

  if (subagentModel?.trim()) {
    const id = `subagent-model-${subagentModel.trim()}`;
    if (!seen.has(id)) {
      seen.add(id);
      const inProg = tasks.find((x) => x.status === "in_progress");
      items.unshift({
        id,
        kind: "subagent",
        label: inProg?.content?.trim()
          ? truncateOneLine(inProg.content)
          : formatModelLabel(subagentModel) || subagentModel.trim(),
        detail: statusMsg?.trim() || undefined,
      });
    }
  }

  return items;
}

export function deriveSubagentCardTitle(
  tool: { label?: string; name?: string },
  tasks: { content: string; status: string }[]
): string {
  const inProg = tasks.find((t) => t.status === "in_progress");
  if (inProg?.content?.trim()) {
    return truncateOneLine(inProg.content);
  }
  const raw = (tool.label || tool.name || "Subagent")
    .replace(/^Ran\s+/i, "")
    .replace(/^Running\s+/i, "")
    .trim();
  return truncateOneLine(raw || "Subagent");
}

export function deriveSubagentActivityLine(opts: {
  statusMsg: string | null;
  activityPhase: string | null | undefined;
  subagentModel: string | null | undefined;
  spawnRunning: boolean;
  tasks: { content: string; status: string }[];
}): string {
  const { statusMsg, activityPhase, subagentModel, spawnRunning, tasks } =
    opts;

  // Subagent is live — prefer bridge status / step text
  if (subagentModel?.trim() && statusMsg?.trim()) {
    const msg = statusMsg.trim();
    if (
      /^(Running|Using|Calling|Queued:|Exploring|Investigating)/i.test(msg)
    ) {
      return truncateOneLine(msg, 96);
    }
    if (!/^(Thinking|Waiting for model)/i.test(msg)) {
      return truncateOneLine(msg, 96);
    }
  }

  const inProg = tasks.find((t) => t.status === "in_progress");
  if (inProg?.content?.trim() && subagentModel?.trim()) {
    return truncateOneLine(inProg.content, 96);
  }

  // Parent spawned — subagent not reporting yet
  if (
    spawnRunning &&
    (!subagentModel?.trim() ||
      activityPhase === "working" ||
      activityPhase === "tool" ||
      activityPhase === "queue")
  ) {
    return "Waiting for subagent";
  }

  if (subagentModel?.trim()) {
    return "Working…";
  }

  return spawnRunning ? "Waiting for subagent" : "";
}
