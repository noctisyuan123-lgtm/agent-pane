/**
 * Pure ACP / tool-content text helpers (no process state).
 * Shared by GrokAcpAdapter and future DaemonAcpProvider.
 */

export function numField(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return undefined;
}

/**
 * Pull human-readable text out of ACP tool content shapes, e.g.
 * `[{type:"content", content:{type:"text", text:"Cannot read binary file…"}}]`
 * so ToolFailed / turn-log don't dump raw JSON.
 */
export function unwrapAcpText(v: unknown): string {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return "";

  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const item of v) {
      const t = unwrapAcpText(item);
      if (t) parts.push(t);
    }
    return parts.join("\n").trim();
  }

  const o = v as Record<string, unknown>;

  // { type: "text", text: "…" }
  if (typeof o.text === "string" && o.text.trim()) return o.text;

  // { type: "content", content: { type: "text", text } | […] }
  if (o.content != null) {
    const inner = unwrapAcpText(o.content);
    if (inner) return inner;
  }

  // { message / error / output }
  for (const key of ["message", "error", "output", "rawOutput"] as const) {
    const x = o[key];
    if (typeof x === "string" && x.trim()) return x;
    if (x && typeof x === "object") {
      const inner = unwrapAcpText(x);
      if (inner) return inner;
    }
  }

  return "";
}

export function summarize(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.slice(0, 12_000);
  const unwrapped = unwrapAcpText(v);
  if (unwrapped) return unwrapped.slice(0, 12_000);
  try {
    // 保留足够长度以便前端解析 diff content[]
    return JSON.stringify(v).slice(0, 12_000);
  } catch {
    return String(v).slice(0, 12_000);
  }
}

export function mapTaskStatus(
  s?: string
): "pending" | "in_progress" | "completed" | "cancelled" {
  const x = (s ?? "pending").toLowerCase();
  if (x.includes("progress") || x === "active") return "in_progress";
  if (x.includes("complete") || x === "done") return "completed";
  if (x.includes("cancel")) return "cancelled";
  return "pending";
}
