export const VCM_MEMORY_ROLE_NAMES = [
  "project-manager",
  "architect",
  "coder",
  "tester",
  "gate-reviewer",
  "harness-engineer"
] as const;

export type VcmMemoryRoleName = typeof VCM_MEMORY_ROLE_NAMES[number];
export type AutoMemoryReviewStatus = "idle" | "collecting" | "reviewing" | "failed";
export type MemoryReviewRunStatus = "applied" | "failed" | "reverted";
export type MemoryReviewRunSource = "auto" | "harness-engineer" | "user";
export type AutoMemoryDisposition =
  | "not-applicable"
  | "disabled"
  | "pending"
  | "collecting"
  | "reviewing"
  | "completed"
  | "failed";

export interface TaskRetrospectiveMemoryReadiness {
  ready: boolean;
  disposition: AutoMemoryDisposition;
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
  status: "pending" | "running" | "completed";
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
  diff: string;
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
