import { useState } from "react";
import type { ToolRow } from "./toolFormat";
import { summarizeToolGroup } from "./toolFormat";

function ToolRowView({ tool }: { tool: ToolRow }) {
  const [open, setOpen] = useState(
    () => Boolean(tool.diffLines && tool.diffLines.length > 0 && tool.status === "done")
  );
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
        onClick={() => hasBody && setOpen((v) => !v)}
        disabled={!hasBody}
      >
        <span className={`tl-chev ${open ? "open" : ""} ${hasBody ? "" : "empty"}`}>
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
          {tool.status === "fail" && <span className="tl-fail-tag"> failed</span>}
        </span>
      </button>
      {open && hasBody && (
        <div className="tl-body">
          {tool.path && <div className="tl-path">{tool.path}</div>}
          {tool.diffLines && tool.diffLines.length > 0 ? (
            <pre className="tl-diff">
              {tool.diffLines.map((l, i) => (
                <div key={i} className={`tl-diff-line ${l.type}`}>
                  <span className="gutter">
                    {l.type === "add" ? "+" : l.type === "del" ? "−" : " "}
                  </span>
                  {l.text}
                </div>
              ))}
            </pre>
          ) : (
            tool.detailLines.length > 0 && (
              <pre className="tl-detail">{tool.detailLines.join("\n")}</pre>
            )
          )}
          {tool.error && <div className="tl-error">{tool.error}</div>}
        </div>
      )}
    </div>
  );
}

export function ToolTimeline({ tools }: { tools: ToolRow[] }) {
  const [groupOpen, setGroupOpen] = useState(true);
  if (!tools.length) return null;

  const summary = summarizeToolGroup(tools);
  const running = tools.some((t) => t.status === "running");

  return (
    <div className="tl">
      <button
        type="button"
        className="tl-summary"
        onClick={() => setGroupOpen((v) => !v)}
      >
        <span className={`tl-chev ${groupOpen ? "open" : ""}`}>▸</span>
        <span>
          {summary}
          {running ? " …" : ""}
        </span>
      </button>
      {groupOpen && (
        <div className="tl-list">
          {tools.map((t) => (
            <ToolRowView key={t.toolId} tool={t} />
          ))}
        </div>
      )}
    </div>
  );
}
