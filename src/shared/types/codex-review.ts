export const CODEX_REVIEW_GATES = [
  "architecture-plan",
  "validation-adequacy",
  "final-diff"
] as const;

export type CodexReviewGate = typeof CODEX_REVIEW_GATES[number];

export type CodexReviewDecision =
  | "approve"
  | "request_changes";

export type CodexReviewSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low";

export type CodexReviewGateStatus =
  | "disabled"
  | "not_required"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "overridden";

export type CodexReviewRequestStatus =
  | "disabled"
  | "not_required"
  | "already_approved"
  | "running"
  | "started"
  | "failed_to_start";

export type CodexReviewCallbackStatus =
  | "not_sent"
  | "sent"
  | "skipped"
  | "failed";

export interface CodexReviewFinding {
  severity: CodexReviewSeverity;
  title: string;
  file?: string;
  line?: number;
  evidence: string;
  expected: string;
  gap: string;
  risk: string;
}

export interface CodexReviewGateRecord {
  gate: CodexReviewGate;
  required: boolean;
  status: CodexReviewGateStatus;
  decision?: CodexReviewDecision;
  reportPath: string;
  promptPath: string;
  requestId?: string;
  requestPath?: string;
  inputHash?: string;
  summary?: string;
  findings?: CodexReviewFinding[];
  error?: string;
  exceptionReason?: string;
  requestedAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  callbackStatus?: CodexReviewCallbackStatus;
  callbackError?: string;
}

export interface CodexReviewIndex {
  version: 1;
  enabled: boolean;
  activeGate: CodexReviewGate | null;
  gates: Record<CodexReviewGate, CodexReviewGateRecord>;
  updatedAt: string;
}

export interface CodexReviewRequestResult {
  status: CodexReviewRequestStatus;
  gate: CodexReviewGate;
  record: CodexReviewGateRecord;
  message?: string;
}

export interface CodexReviewSettingsUpdateRequest {
  gates: Partial<Record<CodexReviewGate, boolean>>;
}

export interface CodexReviewExceptionRequest {
  reason: string;
}

export interface CodexReviewReport {
  gate: CodexReviewGate;
  requestId?: string;
  decision: CodexReviewDecision;
  summary?: string;
  findings: CodexReviewFinding[];
  reportPath: string;
  content: string;
  parsedAt: string;
}
