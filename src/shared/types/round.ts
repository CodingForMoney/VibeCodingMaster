import type { RoleName } from "./role.js";

export type VcmRoundStatus =
  | "running"
  | "stopped";

export type VcmRoleRecoveryStatus =
  | "waiting"
  | "retrying"
  | "failed";

export interface VcmRoleRecoveryState {
  role: RoleName;
  status: VcmRoleRecoveryStatus;
  attempt: number;
  maxAttempts: number;
  lastFailureAt: string;
  error?: string;
  errorDetails?: string;
  lastAssistantMessage?: string;
  retryable?: boolean;
  nextRetryAt?: string;
  lastRetryAt?: string;
  failedAt?: string;
}

export interface VcmSessionRoundState {
  taskSlug: string;
  status: VcmRoundStatus;
  roundId?: string;
  activeRole?: RoleName;
  startedAt?: string;
  lastTurnStartedAt?: string;
  lastTurnEndedAt?: string;
  settleDeadlineAt?: string;
  stoppedAt?: string;
  activeTurnStartedAt?: string;
  roundSequence?: number;
  turnCount: number;
  completedTurnCount: number;
  totalRoundCount: number;
  totalTurnCount: number;
  totalCompletedTurnCount: number;
  totalCcActiveMs: number;
  currentRoundCcActiveMs: number;
  roleRecovery?: VcmRoleRecoveryState;
  roles: RoleName[];
  updatedAt: string;
}
