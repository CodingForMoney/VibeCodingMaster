import type { RoleName } from "./role.js";

export type VcmRoundStatus =
  | "running"
  | "stopped";

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
  roles: RoleName[];
  updatedAt: string;
}
