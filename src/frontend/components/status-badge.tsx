import type { RoleStatus } from "../../shared/types/role.js";
import type { VcmMessageStatus } from "../../shared/types/message.js";

export interface StatusBadgeProps {
  status: RoleStatus | VcmMessageStatus | "ok" | "missing" | "empty" | "incomplete";
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return <span className={`status-badge status-${status}`}>{status.replaceAll("_", " ")}</span>;
}
