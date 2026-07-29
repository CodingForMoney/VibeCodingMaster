export const MEMORY_REVIEW_ROOT = ".ai/vcm/memory-review";
export const MEMORY_REVIEW_RUNS_ROOT = `${MEMORY_REVIEW_ROOT}/runs`;
export const MEMORY_REVIEW_STATE_PATH = `${MEMORY_REVIEW_ROOT}/state.json`;
export const ARCHITECT_PLANNING_MEMORY_CANDIDATE_PATH =
  `${MEMORY_REVIEW_ROOT}/candidates/architect/planning.md`;

export function architectPlanningCandidateSnapshotPath(runId: string): string {
  return `${MEMORY_REVIEW_RUNS_ROOT}/${runId}/sources/architect-planning.md`;
}
