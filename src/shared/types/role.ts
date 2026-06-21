export type CoreVcmRoleName =
  | "project-manager"
  | "architect"
  | "coder"
  | "reviewer";

export type GateReviewerRoleName = "gate-reviewer";
export type VcmRoleName = CoreVcmRoleName | GateReviewerRoleName;
export type CodexTranslatorRoleName = "codex-translator";
export type CodexRoleName = CodexTranslatorRoleName;

export type RoleName = VcmRoleName | CodexRoleName;

export type DispatchableRole =
  | "architect"
  | "coder"
  | "reviewer";

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
