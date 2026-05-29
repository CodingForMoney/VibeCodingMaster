import type { RoleName } from "../../shared/types/role.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";

export function getSessionForRole(
  sessions: RoleSessionRecord[],
  role: RoleName
): RoleSessionRecord | undefined {
  return sessions.find((session) => session.role === role);
}
