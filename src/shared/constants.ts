import type { CodexReviewerRoleName, CodexRoleName, CodexTranslatorRoleName, DispatchableRole, RoleDefinition, RoleName, VcmRoleName } from "./types/role.js";

export const DEFAULT_BACKEND_PORT = 4173;
export const DEFAULT_FRONTEND_PORT = 5173;

export const VCM_ROLE_DEFINITIONS: readonly RoleDefinition<VcmRoleName>[] = [
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

export const CODEX_REVIEWER_ROLE_DEFINITION: RoleDefinition<CodexReviewerRoleName> = {
  name: "codex-reviewer",
  label: "Codex Reviewer",
  commandAgent: "codex-reviewer",
  dispatchable: false
};

export const CODEX_TRANSLATOR_ROLE_DEFINITION: RoleDefinition<CodexTranslatorRoleName> = {
  name: "codex-translator",
  label: "Codex Translator",
  commandAgent: "codex-translator",
  dispatchable: false
};

export const CODEX_ROLE_DEFINITIONS: readonly RoleDefinition<CodexRoleName>[] = [
  CODEX_REVIEWER_ROLE_DEFINITION,
  CODEX_TRANSLATOR_ROLE_DEFINITION
] as const;

export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  ...VCM_ROLE_DEFINITIONS,
  ...CODEX_ROLE_DEFINITIONS
] as const;

export const VCM_ROLE_NAMES = VCM_ROLE_DEFINITIONS.map((role) => role.name) as readonly VcmRoleName[];
export const CODEX_ROLE_NAMES = CODEX_ROLE_DEFINITIONS.map((role) => role.name) as readonly CodexRoleName[];
export const ROLE_NAMES = ROLE_DEFINITIONS.map((role) => role.name) as readonly RoleName[];
export const DISPATCHABLE_ROLES = ROLE_DEFINITIONS
  .filter((role) => role.dispatchable)
  .map((role) => role.name) as readonly DispatchableRole[];

export function isRoleName(value: string): value is RoleName {
  return ROLE_NAMES.includes(value as RoleName);
}

export function isVcmRoleName(value: string): value is VcmRoleName {
  return VCM_ROLE_NAMES.includes(value as VcmRoleName);
}

export function isCodexRoleName(value: string): value is CodexRoleName {
  return CODEX_ROLE_NAMES.includes(value as CodexRoleName);
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
