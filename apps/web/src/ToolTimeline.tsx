import { useState, type ReactNode } from "react";
import type { ToolRow } from "./toolFormat";
import {
  aggregateToolDiffStats,
  summarizeToolGroup,
} from "./toolFormat";
import { highlightCode, highlightLine } from "./codeHighlight";
import { releaseChatStickForInspect } from "./chatScrollStick";
import { TextRoll } from "./TextRoll";

function ToolRowView({
  tool,
  rollLabels = false,
  subagentCard,
}: {
  tool: ToolRow;
  rollLabels?: boolean;
  subagentCard?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const hasBody =
    (tool.detailLines && tool.detailLines.length > 0) ||
    (tool.diffLines && tool.diffLines.length > 0) ||
    Boolean(tool.error);

  const labelCore = rollLabels ? (
    <TextRoll
      text={tool.label}
      textKey={`${tool.toolId}:${tool.label}`}
      shimmer={tool.status === "running"}
      className="tl-label-roll"
    />
  ) : (
    tool.label
  );

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
          {labelCore}
          {tool.additions != null && (
            <span className="tl-stats">
              {" "}
              <span className="add">+{tool.additions}</span>{" "}
              <span className="del">−{tool.deletions ?? 0}</span>
            </span>
          )}
          {tool.status === "running" && !rollLabels && (
            <span className="tl-spin"> …</span>
          )}
          {tool.status === "fail" && (
            <span className="tl-fail-tag"> failed</span>
          )}
        </span>
      </button>
      {subagentCard ? (
        <div className="tl-subagent-hang">{subagentCard}</div>
      ) : null}
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
  defaultOpen = false,
  /** @deprecated live multi-row slot removed — single-slot is process-card level */
  liveMaxRows,
  embedded = false,
  /** Cursor text-roll on labels (live process seat). */
  rollLabels = false,
  /** Optional hanging subagent card per running spawn tool (toolId → node). */
  subagentCardsByToolId,
}: {
  tools: ToolRow[];
  defaultOpen?: boolean;
  liveMaxRows?: number;
  embedded?: boolean;
  rollLabels?: boolean;
  subagentCardsByToolId?: Record<string, ReactNode>;
}) {
  // Live process card: summary line only by default (compact single card).
  // User expands to see rows — not a carousel of tools.
  const [groupOpen, setGroupOpen] = useState(
    defaultOpen || embedded || liveMaxRows != null
  );
  if (!tools.length) return null;

  const summary = summarizeToolGroup(tools);
  const running = tools.some((t) => t.status === "running");
  const { additions: sumAdd, deletions: sumDel } =
    aggregateToolDiffStats(tools);
  const hasDiffStats = sumAdd > 0 || sumDel > 0;

  if (embedded) {
    return (
      <div className="tl tl-embedded">
        <div className="tl-list">
          {tools.map((t) => (
            <ToolRowView
              key={t.toolId}
              tool={t}
              rollLabels={rollLabels}
              subagentCard={subagentCardsByToolId?.[t.toolId]}
            />
          ))}
        </div>
      </div>
    );
  }

  // Single-tool live seat: show the row directly (TextRoll on label).
  if (rollLabels && tools.length === 1) {
    return (
      <div className="tl tl-live-seat">
        <div className="tl-list">
          <ToolRowView
            tool={tools[0]!}
            rollLabels
            subagentCard={subagentCardsByToolId?.[tools[0]!.toolId]}
          />
        </div>
      </div>
    );
  }

  const summaryNode = rollLabels ? (
    <TextRoll
      text={`${summary}${running ? " …" : ""}`}
      textKey={summary}
      shimmer={running}
      className="tl-summary-roll"
    />
  ) : (
    <>
      {summary}
      {running ? " …" : ""}
    </>
  );

  return (
    <div className={`tl${groupOpen ? " tl-open" : ""}`}>
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
          {summaryNode}
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
          {tools.map((t) => (
            <ToolRowView
              key={t.toolId}
              tool={t}
              rollLabels={rollLabels}
              subagentCard={subagentCardsByToolId?.[t.toolId]}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
