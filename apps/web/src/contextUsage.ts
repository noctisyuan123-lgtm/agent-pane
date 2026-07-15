export type ContextSlice = {
  id: string;
  label: string;
  tokens: number;
  color: string;
  estimated?: boolean;
};

export type AgentContextUsage = {
  used: number;
  size: number;
  source:
    | "acp"
    | "compact"
    | "compact_done"
    | "signals"
    | "session_info"
    /** Local transcript estimate — used when Grok signals belong to a fresh resume digest */
    | "estimate";
  at?: string;
  /** Prefer Grok's integer % when present */
  pct?: number;
};

/** Parse Grok `/session-info` markdown for usage (+ optional provider session id). */
export function parseSessionInfoUsage(text: string): {
  used: number;
  size: number;
  pct?: number;
  providerSessionId?: string;
} | null {
  if (!text || !/session\s*id|context\s*:/i.test(text)) return null;
  const idMatch = text.match(
    /Session\s*ID\s*[:：]\s*\**\s*[`"]?(019f[0-9a-fA-F-]{20,}|[0-9a-f]{8}-[0-9a-f-]{27,})[`"]?/i
  );
  const ctxMatch = text.match(
    /Context[\s\S]{0,48}?([\d,]+)\s*\/\s*([\d,]+)\s*tokens(?:\s*\((\d+)\s*%\))?/i
  );
  if (!ctxMatch) {
    return idMatch?.[1]
      ? { used: 0, size: 0, providerSessionId: idMatch[1] }
      : null;
  }
  const used = Number(String(ctxMatch[1]).replace(/,/g, ""));
  const size = Number(String(ctxMatch[2]).replace(/,/g, ""));
  const pct = ctxMatch[3] != null ? Number(ctxMatch[3]) : undefined;
  if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) {
    return idMatch?.[1]
      ? { used: 0, size: 0, providerSessionId: idMatch[1] }
      : null;
  }
  return {
    used,
    size,
    pct: typeof pct === "number" && Number.isFinite(pct) ? pct : undefined,
    providerSessionId: idMatch?.[1],
  };
}

/** Rough chars→tokens (~4 chars / token) — fallback only when agent silent. */
export function estimateTokensFromText(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

/** Estimate context fill from visible chat items (history / import fallback). */
export function estimateMessagesTokens(
  messages: {
    kind: string;
    text?: string;
    tools?: { label?: string; detailLines?: string[] }[];
    lines?: { text?: string }[];
  }[]
): number {
  let chars = 0;
  for (const m of messages) {
    if (
      m.kind === "user" ||
      m.kind === "assistant" ||
      m.kind === "thought" ||
      m.kind === "status"
    ) {
      chars += (m.text ?? "").length;
    } else if (m.kind === "tools" && m.tools) {
      for (const t of m.tools) {
        chars += (t.label?.length ?? 0) + (t.detailLines?.join("").length ?? 0);
      }
    } else if (m.kind === "turn_log" && m.lines) {
      for (const line of m.lines) chars += (line.text ?? "").length;
    }
  }
  // Imported / history transcripts miss system+tools schemas — pad a little
  return Math.max(0, Math.ceil(chars / 4)) + Math.min(8_000, Math.round(chars / 20));
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  if (k < 100) {
    const s = k.toFixed(1);
    return `${s.endsWith(".0") ? s.slice(0, -2) : s}K`;
  }
  return `${Math.round(k)}K`;
}

/**
 * Prefer agent-reported aggregate usage (signals / ACP / compact).
 * Fake Cursor-style buckets are intentionally not invented here.
 */
export function buildContextBreakdown(
  agent: AgentContextUsage | null,
  fallbackLimit: number
): {
  used: number;
  limit: number;
  pct: number;
  slices: ContextSlice[];
  fromAgent: boolean;
  sourceLabel: string | null;
} {
  if (agent && agent.size > 0) {
    const used = Math.max(0, agent.used);
    const limit = agent.size;
    const pct =
      typeof agent.pct === "number" && Number.isFinite(agent.pct)
        ? Math.max(0, Math.min(100, Math.round(agent.pct)))
        : Math.min(100, Math.round((used / limit) * 100));
    const sourceLabel =
      agent.source === "acp"
        ? "From agent (ACP)"
        : agent.source === "session_info"
          ? "From /session-info"
          : agent.source === "signals"
            ? "From Grok signals.json"
            : agent.source === "estimate"
              ? "Estimated from transcript"
              : agent.source === "compact_done"
                ? "From agent (after compact)"
                : "From agent (compact)";
    return {
      used,
      limit,
      pct,
      fromAgent: true,
      sourceLabel,
      slices: [
        {
          id: "context",
          label: "Context in use",
          tokens: used,
          color: "#7dd3fc",
        },
        {
          id: "free",
          label: "Remaining",
          tokens: Math.max(0, limit - used),
          color: "rgba(255,255,255,0.12)",
        },
      ],
    };
  }

  const limit = fallbackLimit > 0 ? fallbackLimit : 256_000;
  return {
    used: 0,
    limit,
    pct: 0,
    fromAgent: false,
    sourceLabel: null,
    slices: [
      {
        id: "unknown",
        label: "Waiting for agent…",
        tokens: 0,
        color: "rgba(255,255,255,0.2)",
        estimated: true,
      },
    ],
  };
}
