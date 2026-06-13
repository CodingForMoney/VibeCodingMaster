export type VcmRoleName =
  | "project-manager"
  | "architect"
  | "coder"
  | "reviewer";

export type CodexReviewerRoleName = "codex-reviewer";

export type RoleName = VcmRoleName | CodexReviewerRoleName;

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
