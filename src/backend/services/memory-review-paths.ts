import type { VcmRoleName } from "../../shared/types/role.js";

export const MEMORY_REVIEW_ROOT = ".ai/vcm/memory-review";
export const MEMORY_REVIEW_RUNS_ROOT = `${MEMORY_REVIEW_ROOT}/runs`;
export const MEMORY_REVIEW_STATE_PATH = `${MEMORY_REVIEW_ROOT}/state.json`;
export const ARCHITECT_PLANNING_MEMORY_CANDIDATE_PATH =
  `${MEMORY_REVIEW_ROOT}/candidates/architect/planning.md`;

const MEMORY_REVIEW_ROLE_DRAFT_PATTERN = new RegExp(
  `^${escapeRegExp(MEMORY_REVIEW_RUNS_ROOT)}/[A-Za-z0-9._-]+/drafts/([A-Za-z0-9._-]+)\\.md$`
);

export function memoryReviewRoleDraftPath(runId: string, role: VcmRoleName): string {
  return `${MEMORY_REVIEW_RUNS_ROOT}/${runId}/drafts/${role}.md`;
}

export function durableDocAssignmentReportPath(runId: string, assignmentId: string): string {
  return `${MEMORY_REVIEW_RUNS_ROOT}/${runId}/assignments/${assignmentId}/report.md`;
}

export function isMemoryProposalSubmissionPath(artifactPath: string, role: VcmRoleName): boolean {
  if (artifactPath === ARCHITECT_PLANNING_MEMORY_CANDIDATE_PATH) {
    return role === "architect";
  }
  return MEMORY_REVIEW_ROLE_DRAFT_PATTERN.exec(artifactPath)?.[1] === role;
}

export function architectPlanningCandidateSnapshotPath(runId: string): string {
  return `${MEMORY_REVIEW_RUNS_ROOT}/${runId}/sources/architect-planning.md`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
