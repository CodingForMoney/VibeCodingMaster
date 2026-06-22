export const GATE_REVIEW_GATES = [
  "architecture-plan",
  "validation-adequacy",
  "final-diff"
] as const;

export type GateReviewGate = typeof GATE_REVIEW_GATES[number];

export type GateReviewDecision =
  | "approve"
  | "request_changes";

export type GateReviewSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low";

export type GateReviewGateStatus =
  | "disabled"
  | "not_required"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "overridden";

export type GateReviewRequestStatus =
  | "disabled"
  | "not_required"
  | "already_approved"
  | "running"
  | "started"
  | "failed_to_start";

export type GateReviewCallbackStatus =
  | "not_sent"
  | "sent"
  | "skipped"
  | "failed";

export interface GateReviewFinding {
  severity: GateReviewSeverity;
  title: string;
  file?: string;
  line?: number;
  evidence: string;
  expected: string;
  gap: string;
  risk: string;
}

export interface GateReviewGateRecord {
  gate: GateReviewGate;
  required: boolean;
  status: GateReviewGateStatus;
  decision?: GateReviewDecision;
  reportPath: string;
  promptPath: string;
  requestId?: string;
  requestPath?: string;
  inputHash?: string;
  summary?: string;
  findings?: GateReviewFinding[];
  error?: string;
  exceptionReason?: string;
  requestedAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  callbackStatus?: GateReviewCallbackStatus;
  callbackError?: string;
}

export interface GateReviewIndex {
  version: 1;
  enabled: boolean;
  activeGate: GateReviewGate | null;
  gates: Record<GateReviewGate, GateReviewGateRecord>;
  updatedAt: string;
}

export interface GateReviewRequestResult {
  status: GateReviewRequestStatus;
  gate: GateReviewGate;
  record: GateReviewGateRecord;
  message?: string;
}

export interface GateReviewSettingsUpdateRequest {
  gates: Partial<Record<GateReviewGate, boolean>>;
}

export interface GateReviewExceptionRequest {
  reason: string;
}

export interface GateReviewReport {
  gate: GateReviewGate;
  requestId?: string;
  decision: GateReviewDecision;
  summary?: string;
  findings: GateReviewFinding[];
  reportPath: string;
  content: string;
  parsedAt: string;
}
