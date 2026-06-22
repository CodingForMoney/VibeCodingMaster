import { ROLE_DEFINITIONS } from "../../shared/constants.js";
import type { RoleDefinition, RoleName } from "../../shared/types/role.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import { getSessionForRole } from "../state/session-store.js";
import { StatusBadge } from "./status-badge.js";

export interface RoleSessionTabsProps {
  activeRole: RoleName;
  roles?: readonly RoleDefinition[];
  sessions: RoleSessionRecord[];
  onSelect(role: RoleName): void;
}

export function RoleSessionTabs({ activeRole, roles = ROLE_DEFINITIONS, sessions, onSelect }: RoleSessionTabsProps) {
  return (
    <div className="role-tabs" role="tablist" aria-label="Role sessions">
      {roles.map((definition) => {
        const session = getSessionForRole(sessions, definition.name);
        const tabStatus = session?.status === "running"
          ? session.activityStatus ?? "idle"
          : session?.status ?? "not_started";
        return (
          <button
            className={definition.name === activeRole ? "role-tab is-active" : "role-tab"}
            key={definition.name}
            type="button"
            role="tab"
            aria-selected={definition.name === activeRole}
            onClick={() => onSelect(definition.name)}
          >
            <span>{definition.label}</span>
            <StatusBadge status={tabStatus} />
          </button>
        );
      })}
    </div>
  );
}
