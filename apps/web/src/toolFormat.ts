/** Human-readable Cursor-style tool labels from raw ACP payloads. */

export type ToolRow = {
  toolId: string;
  /** raw tool name e.g. read_file */
  name: string;
  /** ACP kind: read | edit | search | execute | other */
  kind: string;
  status: "running" | "done" | "fail";
  /** Cursor-like one-liner: "Read package.json L1-17" */
  label: string;
  /** path if known */
  path?: string;
  /** +n -m for edits */
  additions?: number;
  deletions?: number;
  /** collapsible detail lines */
  detailLines: string[];
  /** mini diff lines for expand */
  diffLines?: Array<{ type: "add" | "del" | "ctx"; text: string }>;
  error?: string;
};

function basename(p: string): string {
  const parts = p.replace(/\/$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractPath(obj: Record<string, unknown>): string | undefined {
  for (const k of [
    "path",
    "target_file",
    "file_path",
    "filePath",
    "file",
    "filename",
  ]) {
    if (typeof obj[k] === "string") return obj[k] as string;
  }
  return undefined;
}

function extractLines(
  obj: Record<string, unknown>
): { start?: number; end?: number; limit?: number } {
  const start =
    typeof obj.offset === "number"
      ? obj.offset
      : typeof obj.line === "number"
        ? obj.line
        : typeof obj.start_line === "number"
          ? obj.start_line
          : undefined;
  const limit = typeof obj.limit === "number" ? obj.limit : undefined;
  const end =
    typeof obj.end_line === "number"
      ? obj.end_line
      : start != null && limit != null
        ? start + limit - 1
        : undefined;
  return { start, end, limit };
}

/** Parse ACP content[] blocks from tool result JSON. */
function parseContentBlocks(raw: string): {
  text?: string;
  path?: string;
  oldText?: string;
  newText?: string;
  lines: string[];
} {
  const lines: string[] = [];
  let text: string | undefined;
  let path: string | undefined;
  let oldText: string | undefined;
  let newText: string | undefined;

  const parsed = tryParseJson(raw);
  if (Array.isArray(parsed)) {
    for (const block of parsed) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "diff") {
        path = typeof b.path === "string" ? b.path : path;
        oldText = typeof b.oldText === "string" ? b.oldText : oldText;
        newText = typeof b.newText === "string" ? b.newText : newText;
      } else if (b.type === "content" && b.content && typeof b.content === "object") {
        const c = b.content as Record<string, unknown>;
        if (typeof c.text === "string") {
          text = (text ?? "") + c.text;
        }
      } else if (typeof b.text === "string") {
        text = (text ?? "") + b.text;
      }
    }
  } else if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    path = extractPath(o) ?? path;
    if (typeof o.text === "string") text = o.text;
    if (typeof o.oldText === "string") oldText = o.oldText;
    if (typeof o.newText === "string") newText = o.newText;
    // nested content
    if (o.content && typeof o.content === "object") {
      const c = o.content as Record<string, unknown>;
      if (typeof c.text === "string") text = c.text;
    }
  } else if (raw && !raw.startsWith("{") && !raw.startsWith("[")) {
    text = raw;
  }

  if (text) {
    const preview = text.split("\n").slice(0, 12);
    lines.push(...preview);
    if (text.split("\n").length > 12) lines.push("…");
  }

  return { text, path, oldText, newText, lines };
}

function buildDiffLines(
  oldText?: string,
  newText?: string
): Array<{ type: "add" | "del" | "ctx"; text: string }> | undefined {
  if (oldText == null && newText == null) return undefined;
  const oldL = (oldText ?? "").split("\n");
  const newL = (newText ?? "").split("\n");
  // simple: show all dels then all adds (good enough for small edits)
  const out: Array<{ type: "add" | "del" | "ctx"; text: string }> = [];
  if (oldText != null && oldText !== "") {
    for (const line of oldL.slice(0, 40)) {
      out.push({ type: "del", text: line });
    }
  }
  if (newText != null) {
    for (const line of newL.slice(0, 40)) {
      out.push({ type: "add", text: line });
    }
  }
  return out.length ? out : undefined;
}

function countDiffStats(
  oldText?: string,
  newText?: string
): { additions: number; deletions: number } {
  const oldN = oldText == null || oldText === "" ? 0 : oldText.split("\n").length;
  const newN = newText == null ? 0 : newText.split("\n").length;
  // crude; better than nothing for display
  if (oldText === newText) return { additions: 0, deletions: 0 };
  if (!oldText) return { additions: newN || 1, deletions: 0 };
  if (newText == null) return { additions: 0, deletions: oldN || 1 };
  return {
    additions: Math.max(0, newN),
    deletions: Math.max(0, oldN),
  };
}

export function formatToolStarted(input: {
  toolId: string;
  title: string;
  kind: string;
  inputSummary?: string;
}): ToolRow {
  const name = input.title || "tool";
  const kind = input.kind || "other";
  let path: string | undefined;
  let label = name;
  const detailLines: string[] = [];

  const rawIn = input.inputSummary ?? "";
  const parsed = tryParseJson(rawIn);
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    path = extractPath(o);
    const { start, end, limit } = extractLines(o);
    const base = path ? basename(path) : name;

    if (name.includes("read") || kind === "read") {
      if (path && start != null && end != null) {
        label = `Read ${base} L${start}-${end}`;
      } else if (path && start != null && limit != null) {
        label = `Read ${base} L${start}-${start + limit - 1}`;
      } else if (path) {
        label = `Read ${base}`;
      } else {
        label = `Reading…`;
      }
    } else if (
      name.includes("write") ||
      name.includes("edit") ||
      name.includes("search_replace") ||
      kind === "edit"
    ) {
      label = path ? `Editing ${base}` : `Editing…`;
    } else if (name.includes("grep") || name.includes("search") || kind === "search") {
      const q = String(o.pattern ?? o.query ?? o.regex ?? "");
      label = q ? `Searched ${q.slice(0, 40)}` : `Searching…`;
      if (path) detailLines.push(path);
    } else if (
      name.includes("run") ||
      name.includes("shell") ||
      name.includes("terminal") ||
      kind === "execute"
    ) {
      const cmd = String(o.command ?? o.cmd ?? o.script ?? rawIn).slice(0, 80);
      label = cmd ? `Ran ${cmd}` : `Running…`;
    } else if (path) {
      label = `${name} ${base}`;
    } else {
      label = name;
    }

    // short detail
    if (path) detailLines.push(path);
  } else if (rawIn) {
    label = `${name}`;
    detailLines.push(rawIn.slice(0, 120));
  }

  return {
    toolId: input.toolId,
    name,
    kind,
    status: "running",
    label,
    path,
    detailLines,
  };
}

export function formatToolFinished(
  row: ToolRow,
  outputSummary?: string
): ToolRow {
  const out = { ...row, status: "done" as const };
  if (!outputSummary) return out;

  const parsed = parseContentBlocks(outputSummary);
  if (parsed.path) out.path = parsed.path;

  const name = row.name.toLowerCase();
  const isEdit =
    name.includes("write") ||
    name.includes("edit") ||
    name.includes("search_replace") ||
    row.kind === "edit" ||
    parsed.oldText != null ||
    (parsed.newText != null && parsed.path);

  if (isEdit) {
    const base = out.path ? basename(out.path) : "file";
    const stats = countDiffStats(parsed.oldText, parsed.newText);
    out.additions = stats.additions;
    out.deletions = stats.deletions;
    out.label = `Edited ${base}`;
    out.diffLines = buildDiffLines(parsed.oldText, parsed.newText);
    if (out.path) out.detailLines = [out.path];
  } else if (name.includes("read") || row.kind === "read") {
    const base = out.path ? basename(out.path) : row.path ? basename(row.path) : "file";
    // keep L range from running label if present
    if (!out.label.startsWith("Read")) {
      out.label = `Read ${base}`;
    } else {
      out.label = out.label.replace(/^Reading/, "Read");
    }
    out.detailLines = parsed.lines.length
      ? parsed.lines
      : out.path
        ? [out.path]
        : out.detailLines;
  } else if (name.includes("grep") || name.includes("search")) {
    out.label = out.label.replace(/^Search(ing)?/, "Searched");
    out.detailLines = parsed.lines.length ? parsed.lines : out.detailLines;
  } else {
    if (parsed.lines.length) out.detailLines = parsed.lines;
    else if (outputSummary.length < 200 && !outputSummary.startsWith("[{")) {
      out.detailLines = [outputSummary];
    }
  }

  return out;
}

export function formatToolFailed(row: ToolRow, error: string): ToolRow {
  return {
    ...row,
    status: "fail",
    label: row.label.startsWith("Failed") ? row.label : `Failed: ${row.label}`,
    error,
    detailLines: [error.slice(0, 300)],
  };
}

/** Collapse tool list into Cursor-style summary for the group header. */
export function summarizeToolGroup(tools: ToolRow[]): string {
  const reads = tools.filter(
    (t) => t.kind === "read" || t.name.includes("read")
  ).length;
  const edits = tools.filter(
    (t) =>
      t.kind === "edit" ||
      t.name.includes("write") ||
      t.name.includes("edit") ||
      t.label.startsWith("Edited")
  ).length;
  const searches = tools.filter(
    (t) =>
      t.kind === "search" ||
      t.name.includes("grep") ||
      t.name.includes("search")
  ).length;
  const runs = tools.filter(
    (t) =>
      t.kind === "execute" ||
      t.name.includes("run") ||
      t.name.includes("shell")
  ).length;

  const parts: string[] = [];
  if (searches) parts.push(`explored ${searches} search${searches > 1 ? "es" : ""}`);
  if (reads) parts.push(`read ${reads} file${reads > 1 ? "s" : ""}`);
  if (edits) parts.push(`edited ${edits} file${edits > 1 ? "s" : ""}`);
  if (runs) parts.push(`ran ${runs} command${runs > 1 ? "s" : ""}`);
  if (!parts.length) parts.push(`${tools.length} step${tools.length > 1 ? "s" : ""}`);

  // capitalize first
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
