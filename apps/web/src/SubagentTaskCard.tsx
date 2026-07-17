import { SessionWorkingDots } from "./SessionWorkingDots";
import { TextRoll } from "./TextRoll";
import { formatModelLabel } from "./subagentProcess";

export type SubagentTaskCardProps = {
  title: string;
  model?: string | null;
  activityLine: string;
  active?: boolean;
};

/**
 * Cursor-style hanging card under a spawn/task tool row:
 * title + model chip, dots, clipped TextRoll activity line.
 */
export function SubagentTaskCard({
  title,
  model,
  activityLine,
  active = true,
}: SubagentTaskCardProps) {
  const modelLabel = formatModelLabel(model);
  const line = activityLine.trim();

  return (
    <div
      className={`subagent-task-card${active ? " subagent-task-card--active" : ""}`}
      aria-live="polite"
    >
      <div className="subagent-task-card-head">
        {active ? (
          <SessionWorkingDots className="subagent-task-card-dots" />
        ) : null}
        <span className="subagent-task-card-title">{title}</span>
        {modelLabel ? (
          <span className="subagent-task-card-model">{modelLabel}</span>
        ) : null}
      </div>
      {line ? (
        <div className="subagent-task-card-activity">
          <TextRoll
            text={line}
            textKey={line}
            shimmer={active}
            className="subagent-task-card-roll"
          />
        </div>
      ) : null}
    </div>
  );
}
