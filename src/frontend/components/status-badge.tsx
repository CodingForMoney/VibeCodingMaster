import type { RoleStatus } from "../../shared/types/role.js";
import type { RoleActivityStatus } from "../../shared/types/session.js";
import type { HarnessFileAction } from "../../shared/types/harness.js";
import type { TranslationStatus } from "../../shared/types/translation.js";

export interface StatusBadgeProps {
  status: RoleStatus | RoleActivityStatus | HarnessFileAction | TranslationStatus | "ok" | "missing" | "empty" | "incomplete";
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return <span className={`status-badge status-${status}`}>{status.replaceAll("_", " ")}</span>;
}
