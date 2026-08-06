export const STRICT_NONE_VALUE = "None.";

export const ARCHITECTURE_BRIEF_STATUSES = ["interviewing", "confirmed"] as const;
export const ARCHITECTURE_EVIDENCE_STATUSES = ["incomplete", "complete"] as const;
export const PLANNING_PROGRESS_STATUSES = ["active", "complete"] as const;
export const ARCHITECTURE_PLAN_RESULTS = [
  "complete",
  "incomplete",
  "user clarification required"
] as const;
export const CODER_COMPLETION_DECISIONS = ["ready_for_review", "incomplete", "failed"] as const;
export const ARCHITECT_DEBUG_STATUSES = ["pending", "completed"] as const;
export const ARCHITECTURE_DIAGNOSIS_DISPOSITIONS = [
  "analysis completed",
  "diagnosis implementation completed",
  "user clarification required"
] as const;
export const TEST_RESULTS = ["pass", "fail", "incomplete"] as const;
export const TEST_INFRASTRUCTURE_STATUSES = [
  "none",
  "repair-required",
  "repaired",
  "production-change-required"
] as const;
export const L3_REQUIRED_VALUES = ["yes", "no"] as const;
export const L3_ACTIONS = ["run-existing", "updated", "added"] as const;
export const DOCS_SYNC_DECISIONS = ["synced", "unchanged", "blocked"] as const;
export const FINAL_ACCEPTANCE_DECISIONS = [
  "accepted",
  "accepted-with-known-risks",
  "needs-coder-follow-up",
  "needs-architect-follow-up",
  "needs-docs-sync",
  "blocked-by-user-decision"
] as const;

export function renderArtifactOptions(values: readonly string[]): string {
  return values.join("|");
}
