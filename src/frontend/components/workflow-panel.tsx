import type { TaskWorkflowReport } from "../../shared/types/api.js";
import { StatusBadge } from "./status-badge.js";

export interface WorkflowPanelProps {
  workflow?: TaskWorkflowReport;
}

export function WorkflowPanel({ workflow }: WorkflowPanelProps) {
  if (!workflow) {
    return null;
  }

  return (
    <section className="workflow-panel">
      <div className="workflow-summary">
        <p>{workflow.nextAction}</p>
      </div>
      <ol className="workflow-steps">
        {workflow.steps.map((step) => (
          <li className={step.id === workflow.currentStepId ? "is-current" : undefined} key={step.id}>
            <span>{step.label}</span>
            <StatusBadge status={step.status} />
          </li>
        ))}
      </ol>
    </section>
  );
}
