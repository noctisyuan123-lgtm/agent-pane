import { useState } from "react";
import type { ToolRow } from "./toolFormat";
import {
  aggregateToolDiffStats,
  summarizeToolGroup,
} from "./toolFormat";
import { highlightCode, highlightLine } from "./codeHighlight";
import { releaseChatStickForInspect } from "./chatScrollStick";

function ToolRowView({ tool }: { tool: ToolRow }) {
  // Default collapsed — expand on click only (keeps chat skim-friendly).
  const [open, setOpen] = useState(false);
  const hasBody =
    (tool.detailLines && tool.detailLines.length > 0) ||
    (tool.diffLines && tool.diffLines.length > 0) ||
    Boolean(tool.error);

  return (
    <div
      className={`tl-row ${tool.status} ${open ? "open" : ""} ${
        hasBody ? "expandable" : ""
      }`}
    >
      <button
        type="button"
        className="tl-head"
        onClick={() => {
          if (!hasBody) return;
          releaseChatStickForInspect();
          setOpen((v) => !v);
        }}
        disabled={!hasBody}
      >
        <span
          className={`tl-chev ${open ? "open" : ""} ${hasBody ? "" : "empty"}`}
        >
          {hasBody ? "▸" : "·"}
        </span>
        <span className="tl-label">
          {tool.label}
          {tool.additions != null && (
            <span className="tl-stats">
              {" "}
              <span className="add">+{tool.additions}</span>{" "}
              <span className="del">−{tool.deletions ?? 0}</span>
            </span>
          )}
          {tool.status === "running" && <span className="tl-spin"> …</span>}
          {tool.status === "fail" && (
            <span className="tl-fail-tag"> failed</span>
          )}
        </span>
      </button>
      {open && hasBody && (
        <div className="tl-body">
          {tool.path && <div className="tl-path">{tool.path}</div>}
          {tool.diffLines && tool.diffLines.length > 0 ? (
            <pre className="tl-diff hljs-source">
              {tool.diffLines.map((l, i) => (
                <div key={i} className={`tl-diff-line ${l.type}`}>
                  <span className="gutter">
                    {l.type === "add" ? "+" : l.type === "del" ? "−" : " "}
                  </span>
                  <code
                    className="tl-code"
                    // highlight.js HTML for Cursor-like token colors
                    dangerouslySetInnerHTML={{
                      __html: highlightLine(l.text, tool.path),
                    }}
                  />
                </div>
              ))}
            </pre>
          ) : (
            tool.detailLines.length > 0 && (
              <pre className="tl-detail hljs-source">
                <code
                  dangerouslySetInnerHTML={{
                    __html: highlightCode(
                      tool.detailLines.join("\n"),
                      tool.path
                    ),
                  }}
                />
              </pre>
            )
          )}
          {tool.error && <div className="tl-error">{tool.error}</div>}
        </div>
      )}
    </div>
  );
}

export function ToolTimeline({
  tools,
  /** Cursor: bottom list default collapsed; live turn can pass true */
  defaultOpen = false,
  /** Live: keep summary + at most last N tool rows visible */
  liveMaxRows,
  /**
   * Nested under L1 ProcessPackFold — skip the outer "Explored…" summary
   * (parent already owns that title) and show rows directly.
   */
  embedded = false,
}: {
  tools: ToolRow[];
  defaultOpen?: boolean;
  liveMaxRows?: number;
  embedded?: boolean;
}) {
  // Summary always visible; step list folds (Cursor "Explored N files…")
  const [groupOpen, setGroupOpen] = useState(
    defaultOpen || liveMaxRows != null || embedded
  );
  if (!tools.length) return null;

  const summary = summarizeToolGroup(tools);
  const running = tools.some((t) => t.status === "running");
  // Cursor: summary line shows sum of all row +/− (e.g. +97 −3)
  const { additions: sumAdd, deletions: sumDel } =
    aggregateToolDiffStats(tools);
  const hasDiffStats = sumAdd > 0 || sumDel > 0;
  const listTools =
    liveMaxRows != null && groupOpen
      ? tools.slice(-liveMaxRows)
      : tools;

  // L2 inside process pack: rows only (L1 already has Explored/Edited title)
  if (embedded) {
    return (
      <div className="tl tl-embedded">
        <div className="tl-list">
          {listTools.map((t) => (
            <ToolRowView key={t.toolId} tool={t} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`tl${liveMaxRows != null ? " tl-live" : ""}`}>
      <button
        type="button"
        className="tl-summary"
        onClick={() => {
          releaseChatStickForInspect();
          setGroupOpen((v) => !v);
        }}
        aria-expanded={groupOpen}
      >
        <span className="tl-summary-text">
          {summary}
          {running ? " …" : ""}
          {hasDiffStats ? (
            <span className="tl-stats tl-stats-sum">
              {" "}
              <span className="add">+{sumAdd}</span>{" "}
              <span className="del">−{sumDel}</span>
            </span>
          ) : null}
        </span>
        <span className={`tl-meta-chev ${groupOpen ? "open" : ""}`}>▾</span>
      </button>
      {groupOpen ? (
        <div className="tl-list">
          {listTools.map((t) => (
            <ToolRowView key={t.toolId} tool={t} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
