import type { DispatchableRole, VcmRoleName } from "./role.js";

export const WORKFLOW_FLOWS = [
  "code-change",
  "architect-debug",
  "architecture-diagnosis",
  "docs-only",
  "validation-only"
] as const;

export type WorkflowFlow = typeof WORKFLOW_FLOWS[number];

export const WORKFLOW_EVIDENCE_ARTIFACTS = [
  "architecture-plan.md",
  "coder-completion.md",
  "test-report.md",
  "architect-debug.md",
  "architecture-diagnosis.md",
  "docs-sync-report.md",
  "final-acceptance.md"
] as const;

export const WORKFLOW_EVIDENCE_GATES = [
  "architecture-plan",
  "validation-adequacy",
  "code-diff"
] as const;

export type WorkflowEvidenceArtifact = typeof WORKFLOW_EVIDENCE_ARTIFACTS[number];
export type WorkflowEvidenceGate = typeof WORKFLOW_EVIDENCE_GATES[number];

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
  authorizationText?: string;
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

export interface WorkflowDispatchEvidenceBaseline {
  sequence: number;
  flow: WorkflowFlow;
  targetRole: DispatchableRole;
  artifactHashes: Record<WorkflowEvidenceArtifact, string>;
  gateFingerprints: Record<WorkflowEvidenceGate, string>;
  confirmedAt: string;
}

export interface WorkflowFlowRun {
  rootFlow: WorkflowFlow;
  activeBranch?: "architect-debug" | "architecture-diagnosis";
  resumedFromBranch?: "architect-debug" | "architecture-diagnosis";
  startedAtSequence: number;
}

export interface WorkflowUserAuthorization {
  id: string;
  status: "accepted" | "consumed";
  role: "project-manager";
  operation: "workflow-dispatch";
  baseRevision: number;
  baseHistoryHash: string;
  requestedFlow?: WorkflowFlow;
  effectiveFlow: WorkflowFlow;
  targetRole: DispatchableRole;
  evidence: string;
  violatedRule: string;
  authorizationText: string;
  createdAt: string;
  consumedAt?: string;
}

export interface WorkflowAwaitingUser {
  question: string;
  requestedAt: string;
}

export interface WorkflowControlState {
  version: 1;
  taskSlug: string;
  awaitingUser: WorkflowAwaitingUser | null;
  pendingDispatch: WorkflowPendingDispatch | null;
  activeDispatch: WorkflowDispatchEvidenceBaseline | null;
  flowRun: WorkflowFlowRun | null;
  userAuthorizations: WorkflowUserAuthorization[];
  warnings: string[];
  updatedAt: string;
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
