import { ROLE_DEFINITIONS } from "../../shared/constants.js";
import type { RoleName } from "../../shared/types/role.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import { getSessionForRole } from "../state/session-store.js";
import { StatusBadge } from "./status-badge.js";

export interface RoleSessionTabsProps {
  activeRole: RoleName;
  sessions: RoleSessionRecord[];
  onSelect(role: RoleName): void;
}

export function RoleSessionTabs({ activeRole, sessions, onSelect }: RoleSessionTabsProps) {
  return (
    <div className="role-tabs" role="tablist" aria-label="Role sessions">
      {ROLE_DEFINITIONS.map((definition) => {
        const session = getSessionForRole(sessions, definition.name);
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
            <StatusBadge status={session?.status ?? "not_started"} />
          </button>
        );
      })}
    </div>
  );
}
