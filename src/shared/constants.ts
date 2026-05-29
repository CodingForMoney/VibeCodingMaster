import type { DispatchableRole, RoleDefinition, RoleName } from "./types/role.js";

export const DEFAULT_BACKEND_PORT = 4173;
export const DEFAULT_FRONTEND_PORT = 5173;

export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    name: "project-manager",
    label: "Project Manager",
    commandAgent: "project-manager",
    dispatchable: false
  },
  {
    name: "architect",
    label: "Architect",
    commandAgent: "architect",
    dispatchable: true
  },
  {
    name: "coder",
    label: "Coder",
    commandAgent: "coder",
    dispatchable: true
  },
  {
    name: "reviewer",
    label: "Reviewer",
    commandAgent: "reviewer",
    dispatchable: true
  }
] as const;

export const ROLE_NAMES = ROLE_DEFINITIONS.map((role) => role.name) as readonly RoleName[];
export const DISPATCHABLE_ROLES = ROLE_DEFINITIONS
  .filter((role) => role.dispatchable)
  .map((role) => role.name) as readonly DispatchableRole[];

export function isRoleName(value: string): value is RoleName {
  return ROLE_NAMES.includes(value as RoleName);
}

export function isDispatchableRole(value: string): value is DispatchableRole {
  return DISPATCHABLE_ROLES.includes(value as DispatchableRole);
}

export function getRoleDefinition(role: RoleName): RoleDefinition {
  const definition = ROLE_DEFINITIONS.find((candidate) => candidate.name === role);
  if (!definition) {
    throw new Error(`Unknown role: ${role}`);
  }
  return definition;
}
