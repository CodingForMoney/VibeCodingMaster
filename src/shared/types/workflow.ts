import type { VcmRoleName } from "./role.js";

export interface TaskWorkflowDeclaration {
  flow?: string | null;
  step?: string | null;
  branch?: string | null;
  resumePoint?: string | null;
  status?: string | null;
  evidenceRefs?: string[];
}

export interface DeclaredTaskWorkflowState {
  flow?: string;
  step?: string;
  branch?: string;
  resumePoint?: string;
  status?: string;
  evidenceRefs: string[];
  updatedBy: "project-manager";
  updatedAt: string;
}

export interface TaskWorkflowDispatchState {
  messageId: string;
  toRole: VcmRoleName;
  updatedAt: string;
}

export interface TaskWorkflowState {
  version: 1;
  taskSlug: string;
  revision: number;
  declared: DeclaredTaskWorkflowState | null;
  lastDispatch: TaskWorkflowDispatchState | null;
  warnings: string[];
  updatedAt: string;
}

export interface UpdateTaskWorkflowStateRequest extends TaskWorkflowDeclaration {}
