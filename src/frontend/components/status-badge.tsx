import type { RoleStatus } from "../../shared/types/role.js";
import type { VcmMessageStatus } from "../../shared/types/message.js";
import type { TaskWorkflowStepStatus } from "../../shared/types/api.js";

export interface StatusBadgeProps {
  status: RoleStatus | VcmMessageStatus | TaskWorkflowStepStatus | "ok" | "missing" | "empty" | "incomplete";
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return <span className={`status-badge status-${status}`}>{status.replaceAll("_", " ")}</span>;
}
