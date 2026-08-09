export const VCM_MEMORY_ROLE_NAMES = [
  "project-manager",
  "architect",
  "coder",
  "tester",
  "reviewer",
  "harness-engineer"
] as const;

export type VcmMemoryRoleName = typeof VCM_MEMORY_ROLE_NAMES[number];
export type AutoMemoryReviewStatus = "idle" | "collecting" | "reviewing" | "documenting" | "failed";
export type MemoryReviewRunStatus = "applied" | "failed" | "reverted";
export type MemoryReviewRunSource = "auto" | "user";
export type MemoryReviewTrigger = "manual" | "auto";
export type AutoMemoryDisposition =
  | "not-applicable"
  | "disabled"
  | "pending"
  | "collecting"
  | "reviewing"
  | "documenting"
  | "completed"
  | "failed";

export type DurableDocAssignmentOwner = "architect" | "coder" | "tester";
export type DurableDocAssignmentStatus =
  | "waiting-owner"
  | "resolving-owner"
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface DurableDocAssignmentState {
  id: string;
  runId: string;
  sourceMemoryPath: string;
  sourceEntry: string;
  targetPath: string;
  content: string;
  reason: string;
  evidence: string[];
  owner?: DurableDocAssignmentOwner;
  requestedOwner?: DurableDocAssignmentOwner;
  status: DurableDocAssignmentStatus;
  reportPath: string;
  createdAt: string;
  updatedAt: string;
  dispatchedAt?: string;
  completedAt?: string;
  baseCommit?: string;
  reportHashBefore?: string;
  commit?: string;
  error?: string;
}

export interface TaskRetrospectiveMemoryReadiness {
  ready: boolean;
  disposition: AutoMemoryDisposition;
  trigger?: MemoryReviewTrigger;
  reason?: string;
}

export interface MemoryFileSummary {
  path: string;
  title: string;
  role?: VcmMemoryRoleName;
  sizeBytes: number;
}

export interface MemoryFileContent extends MemoryFileSummary {
  content: string;
  editable: true;
}

export interface MemoryDraftState {
  role: Exclude<VcmMemoryRoleName, "harness-engineer">;
  path: string;
  status: "pending" | "dispatched" | "completed";
}

export interface ActiveMemoryReview {
  runId: string;
  taskSlug: string;
  status: Exclude<AutoMemoryReviewStatus, "idle">;
  finalAcceptanceHash: string;
  createdAt: string;
  updatedAt: string;
  currentRole?: MemoryDraftState["role"];
  drafts: MemoryDraftState[];
  assignments: DurableDocAssignmentState[];
  trigger: MemoryReviewTrigger;
  error?: string;
}

export interface MemoryReviewRunSummary {
  runId: string;
  taskSlug: string;
  source: MemoryReviewRunSource;
  status: MemoryReviewRunStatus;
  createdAt: string;
  appliedAt?: string;
  failedAt?: string;
  revertedAt?: string;
  finalAcceptanceHash?: string;
  trigger?: MemoryReviewTrigger;
  diff: string;
  assignments: DurableDocAssignmentState[];
  canRevert: boolean;
  error?: string;
}

export interface AutoMemoryStateReport {
  version: 1;
  status: AutoMemoryReviewStatus;
  files: MemoryFileSummary[];
  runs: MemoryReviewRunSummary[];
  active?: ActiveMemoryReview;
  warnings: string[];
}

export interface UpdateMemoryFileRequest {
  taskSlug?: string;
  content: string;
}

export interface RevertMemoryRunRequest {
  taskSlug?: string;
  runId: string;
}

export interface RetryMemoryReviewRequest {
  taskSlug?: string;
}

export interface RetryDurableDocAssignmentRequest {
  taskSlug?: string;
  assignmentId: string;
}

export interface ResolveDurableDocAssignmentOwnerRequest {
  taskSlug?: string;
  assignmentId: string;
  owner: DurableDocAssignmentOwner;
}
