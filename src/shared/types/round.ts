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

/**
 * Why the automated flow is paused/stalled.
 * - `stopped-no-next-turn`: a round ended and the auto flow did not start a new turn.
 * - `role-recovery-failed`: a role's CC recovery exhausted retries / is non-retryable.
 */
export type VcmFlowPauseReason =
  | "stopped-no-next-turn"
  | "role-recovery-failed";

/**
 * Authoritative flow-pause signal, owned by the backend (round-service). The
 * frontend consumes `paused` + `reason` to decide WHETHER and WHY to alert, and
 * keeps only the alert mechanics (dedupe, sound, viewing gating, wording). It must
 * NOT re-derive the pause decision from `status`/`roundId`/`roleRecovery`.
 * Present with `paused: true` when paused; omitted (or `paused: false`) otherwise.
 */
export interface VcmFlowPauseState {
  paused: boolean;
  reason?: VcmFlowPauseReason;
  /** Role the flow paused on (authoritative; e.g. the active role at pause). */
  role?: RoleName;
  /** When the pause condition began (e.g. stoppedAt / lastTurnEndedAt). */
  since?: string;
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
  /**
   * Authoritative flow-pause signal (backend-owned). Frontend consumes this
   * instead of deriving the pause decision from status/roundId/roleRecovery.
   */
  flowPause?: VcmFlowPauseState;
  roles: RoleName[];
  updatedAt: string;
}
