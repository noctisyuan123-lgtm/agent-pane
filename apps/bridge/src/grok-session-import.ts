import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DomainEvent } from "@agent-pane/shared";
import {
  invalidateHistoryListCache,
  invalidateSessionEventsCache,
  readMeta,
  writeMeta,
  type SessionMeta,
} from "./history-index.js";

const GROK_ROOT = path.join(os.homedir(), ".grok", "sessions");
const PANE_ROOT = path.join(os.homedir(), ".agent-pane", "sessions");

type GrokSummary = {
  info?: { id?: string; cwd?: string };
  cwd?: string;
  created_at?: string;
  updated_at?: string;
  current_model_id?: string;
  session_kind?: string;
};

function extractText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((x) => {
        if (!x || typeof x !== "object") return "";
        const o = x as { type?: string; text?: string };
        if (o.type === "text" || o.type === "summary_text" || o.text != null) {
          return String(o.text ?? "");
        }
        return "";
      })
      .join("");
  }
  return String(content);
}

function reasoningText(obj: Record<string, unknown>): string {
  const summary = obj.summary;
  if (Array.isArray(summary)) {
    const parts = summary
      .map((x) => {
        if (!x || typeof x !== "object") return "";
        const o = x as { type?: string; text?: string };
        if (o.type === "summary_text" || o.text != null) return String(o.text ?? "");
        return "";
      })
      .filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  return extractText(obj.content ?? obj.text);
}

function isNoiseUser(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith("<local-command")) return true;
  if (t.startsWith("<command-name>") || t.startsWith("<command-message>")) {
    return true;
  }
  return false;
}

function trunc(s: string, n = 4000): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 20)}\n…(truncated)`;
}

export function findGrokSessionDir(sessionId: string): string | null {
  if (!fs.existsSync(GROK_ROOT)) return null;
  for (const ent of fs.readdirSync(GROK_ROOT, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const cand = path.join(GROK_ROOT, ent.name, sessionId);
    if (fs.existsSync(path.join(cand, "chat_history.jsonl"))) return cand;
  }
  return null;
}

export type ImportGrokResult = {
  ok: true;
  skipped: boolean;
  sessionId: string;
  meta: SessionMeta;
  events?: number;
  userMessages?: number;
  grokDir?: string;
  reason?: string;
};

/**
 * Import Grok CLI / Claude-import chat_history into Pane history.
 * Uses the same UUID as the Grok session id.
 */
export function importGrokSession(
  sessionId: string,
  opts?: { force?: boolean }
): ImportGrokResult {
  const id = sessionId.trim();
  if (!id) throw new Error("sessionId required");

  const eventsPath = path.join(PANE_ROOT, id, "events.jsonl");
  if (fs.existsSync(eventsPath) && !opts?.force) {
    const meta = readMeta(id);
    if (meta) {
      return {
        ok: true,
        skipped: true,
        sessionId: id,
        meta,
        reason: "already imported",
      };
    }
  }

  const grokDir = findGrokSessionDir(id);
  if (!grokDir) throw new Error(`grok session not found: ${id}`);

  let summary: GrokSummary = {};
  try {
    summary = JSON.parse(
      fs.readFileSync(path.join(grokDir, "summary.json"), "utf8")
    ) as GrokSummary;
  } catch {
    /* optional */
  }

  const cwd =
    (summary.info?.cwd || summary.cwd || "").trim() || os.homedir();
  const createdAt = summary.created_at || new Date().toISOString();
  const updatedAt = summary.updated_at || createdAt;
  const model = summary.current_model_id || undefined;

  const lines = fs
    .readFileSync(path.join(grokDir, "chat_history.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);

  const events: DomainEvent[] = [];
  let seq = 0;
  let userCount = 0;
  let title = "";
  const openTools = new Map<string, string>();

  const push = (ev: Record<string, unknown> & { type: string; at?: string }) => {
    seq += 1;
    events.push({
      ...ev,
      seq,
      sessionId: id,
      at: ev.at ?? createdAt,
    } as DomainEvent);
  };

  push({
    type: "SessionStarted",
    cwd,
    model,
    providerSessionId: id,
    resumed: true,
  });

  for (const raw of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const typ = obj.type;

    if (typ === "user") {
      const text = extractText(obj.content).trim();
      if (isNoiseUser(text)) continue;
      userCount += 1;
      if (!title) title = text.replace(/\n/g, " ").trim().slice(0, 80);
      push({ type: "UserMessageAppended", text });
    } else if (typ === "reasoning") {
      const text = reasoningText(obj).trim();
      if (text) push({ type: "ThoughtChunk", text });
    } else if (typ === "assistant") {
      const text = extractText(obj.content).trim();
      if (text) {
        push({ type: "MessageChunk", role: "assistant", text });
        push({ type: "MessageDone", role: "assistant" });
      }
      const toolCalls = obj.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (!tc || typeof tc !== "object") continue;
          const tco = tc as {
            id?: string;
            name?: string;
            arguments?: unknown;
          };
          const tid = String(tco.id || `tool-${seq}`);
          const name = String(tco.name || "tool");
          const args =
            typeof tco.arguments === "string"
              ? tco.arguments
              : JSON.stringify(tco.arguments ?? "");
          openTools.set(tid, name);
          push({
            type: "ToolStarted",
            toolId: tid,
            title: name,
            kind: name,
            inputSummary: trunc(args, 1500),
          });
        }
      }
    } else if (typ === "tool_result") {
      const tid = String(obj.tool_call_id || `tool-result-${seq}`);
      const out = extractText(obj.content);
      openTools.delete(tid);
      push({
        type: "ToolFinished",
        toolId: tid,
        outputSummary: trunc(out, 4000),
      });
    }
  }

  if (userCount === 0) {
    throw new Error(`no user messages in grok chat_history: ${grokDir}`);
  }
  if (!title) title = `Imported ${id.slice(0, 8)}`;

  if (events.length) {
    (events[0] as { at: string }).at = createdAt;
    (events[events.length - 1] as { at: string }).at = updatedAt;
  }

  fs.mkdirSync(path.join(PANE_ROOT, id), { recursive: true });
  fs.writeFileSync(
    eventsPath,
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8"
  );

  const meta: SessionMeta = {
    sessionId: id,
    cwd,
    title,
    createdAt,
    updatedAt,
    messageCount: userCount,
    /** Current handle (initially same as Grok); resume will rewrite this. */
    providerSessionId: id,
    /** Stable import lineage — keep original Grok id after resume. */
    sourceProviderSessionId: id,
  };
  writeMeta(meta);
  // Extra bookkeeping fields (ignored by typed readers, useful on disk)
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(PANE_ROOT, id, "meta.json"), "utf8")) as Record<
      string,
      unknown
    >;
    raw.importedFrom = "grok";
    raw.sourceKind = summary.session_kind || "grok";
    raw.sourceProviderSessionId = id;
    fs.writeFileSync(
      path.join(PANE_ROOT, id, "meta.json"),
      JSON.stringify(raw, null, 2) + "\n",
      "utf8"
    );
  } catch {
    /* ignore */
  }

  invalidateSessionEventsCache(id);
  invalidateHistoryListCache();

  return {
    ok: true,
    skipped: false,
    sessionId: id,
    meta: readMeta(id) ?? meta,
    events: events.length,
    userMessages: userCount,
    grokDir,
  };
}
