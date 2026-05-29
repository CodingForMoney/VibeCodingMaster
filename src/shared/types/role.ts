export type RoleName =
  | "project-manager"
  | "architect"
  | "coder"
  | "reviewer";

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

export interface RoleDefinition {
  name: RoleName;
  label: string;
  commandAgent: string;
  dispatchable: boolean;
}
