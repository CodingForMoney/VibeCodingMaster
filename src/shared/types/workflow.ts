import type { DispatchableRole, VcmRoleName } from "./role.js";

export const WORKFLOW_FLOWS = [
  "code-change",
  "architect-debug",
  "architecture-diagnosis",
  "docs-only",
  "validation-only"
] as const;

export type WorkflowFlow = typeof WORKFLOW_FLOWS[number];

export interface WorkflowDispatchHistoryEntry {
  sequence: number;
  flow: WorkflowFlow;
  targetRole: DispatchableRole;
  evidence: string;
  overrideAuthorizationId?: string;
  confirmedAt?: string;
}

export interface WorkflowProgressProposal {
  requestedFlow?: WorkflowFlow;
  targetRole: DispatchableRole;
  evidence: string;
  authorizationId?: string;
  authorizationQuote?: string;
  violatedRule?: string;
}

export interface WorkflowProgressDocument {
  taskSlug: string;
  revision: number;
  flow?: WorkflowFlow;
  status: "not-started" | "active" | "completed";
  history: WorkflowDispatchHistoryEntry[];
  proposal?: WorkflowProgressProposal;
}

export interface WorkflowPendingDispatch {
  revision: number;
  baseHistoryHash: string;
  effectiveFlow: WorkflowFlow;
  requestedFlow?: WorkflowFlow;
  targetRole: DispatchableRole;
  evidence: string;
  expectedRoutePath: string;
  overrideAuthorizationId?: string;
  status: "pending" | "dispatching";
  routeContentHash?: string;
  messageId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowOverrideRequest {
  id: string;
  status: "pending" | "approved" | "rejected" | "consumed";
  baseRevision: number;
  baseHistoryHash: string;
  requestedFlow?: WorkflowFlow;
  effectiveFlow: WorkflowFlow;
  targetRole: DispatchableRole;
  evidence: string;
  violatedRule: string;
  proposedAuthorizationQuote: string;
  authorizationText?: string;
  createdAt: string;
  decidedAt?: string;
  consumedAt?: string;
}

export interface WorkflowControlState {
  version: 1;
  taskSlug: string;
  pendingDispatch: WorkflowPendingDispatch | null;
  overrideRequests: WorkflowOverrideRequest[];
  warnings: string[];
  updatedAt: string;
}

export interface WorkflowOverrideDecisionRequest {
  authorizationText?: string;
}

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
