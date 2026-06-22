import type { CoreVcmRoleName, DispatchableRole, GateReviewerRoleName, HarnessEngineerToolRoleName, RoleDefinition, RoleName, ToolRoleName, TranslatorToolRoleName, VcmRoleName } from "./types/role.js";

export const DEFAULT_BACKEND_PORT = 4173;
export const DEFAULT_FRONTEND_PORT = 5173;

export const CORE_VCM_ROLE_DEFINITIONS: readonly RoleDefinition<CoreVcmRoleName>[] = [
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

export const GATE_REVIEWER_ROLE_DEFINITION: RoleDefinition<GateReviewerRoleName> = {
  name: "gate-reviewer",
  label: "Gate Reviewer",
  commandAgent: "gate-reviewer",
  dispatchable: false
};

export const VCM_ROLE_DEFINITIONS: readonly RoleDefinition<VcmRoleName>[] = [
  ...CORE_VCM_ROLE_DEFINITIONS,
  GATE_REVIEWER_ROLE_DEFINITION
] as const;

export const TRANSLATOR_TOOL_ROLE_DEFINITION: RoleDefinition<TranslatorToolRoleName> = {
  name: "translator",
  label: "Translator",
  commandAgent: "translator",
  dispatchable: false
};

export const HARNESS_ENGINEER_TOOL_ROLE_DEFINITION: RoleDefinition<HarnessEngineerToolRoleName> = {
  name: "harness-engineer",
  label: "Harness Engineer",
  commandAgent: "harness-engineer",
  dispatchable: false
};

export const TOOL_ROLE_DEFINITIONS: readonly RoleDefinition<ToolRoleName>[] = [
  TRANSLATOR_TOOL_ROLE_DEFINITION,
  HARNESS_ENGINEER_TOOL_ROLE_DEFINITION
] as const;

export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  ...VCM_ROLE_DEFINITIONS,
  ...TOOL_ROLE_DEFINITIONS
] as const;

export const CORE_VCM_ROLE_NAMES = CORE_VCM_ROLE_DEFINITIONS.map((role) => role.name) as readonly CoreVcmRoleName[];
export const VCM_ROLE_NAMES = VCM_ROLE_DEFINITIONS.map((role) => role.name) as readonly VcmRoleName[];
export const TOOL_ROLE_NAMES = TOOL_ROLE_DEFINITIONS.map((role) => role.name) as readonly ToolRoleName[];
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

export function isGateReviewerRoleName(value: string): value is GateReviewerRoleName {
  return value === GATE_REVIEWER_ROLE_DEFINITION.name;
}

export function isToolRoleName(value: string): value is ToolRoleName {
  return TOOL_ROLE_NAMES.includes(value as ToolRoleName);
}

export function isTranslatorToolRoleName(value: string): value is TranslatorToolRoleName {
  return value === TRANSLATOR_TOOL_ROLE_DEFINITION.name;
}

export function isHarnessEngineerToolRoleName(value: string): value is HarnessEngineerToolRoleName {
  return value === HARNESS_ENGINEER_TOOL_ROLE_DEFINITION.name;
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
