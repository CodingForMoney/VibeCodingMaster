export type CoreVcmRoleName =
  | "project-manager"
  | "architect"
  | "coder"
  | "tester";

export type ReviewerRoleName = "reviewer";
export type VcmRoleName = CoreVcmRoleName | ReviewerRoleName;
export type TranslatorToolRoleName = "translator";
export type HarnessEngineerToolRoleName = "harness-engineer";
export type ToolRoleName = TranslatorToolRoleName | HarnessEngineerToolRoleName;

export type RoleName = VcmRoleName | ToolRoleName;

export type DispatchableRole =
  | "architect"
  | "coder"
  | "tester";

export type RoleStatus =
  | "not_started"
  | "starting"
  | "running"
  | "waiting"
  | "blocked"
  | "done"
  | "resumable"
  | "crashed"
  | "exited"
  | "missing"
  | "unknown";

export interface RoleDefinition<TName extends RoleName = RoleName> {
  name: TName;
  label: string;
  commandAgent: string;
  dispatchable: boolean;
}
