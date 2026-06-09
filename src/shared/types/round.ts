import type { RoleName } from "./role.js";

export type VcmTaskRoundStatus =
  | "idle"
  | "active"
  | "settling"
  | "paused";

export interface VcmTaskRoundState {
  taskSlug: string;
  status: VcmTaskRoundStatus;
  roundId?: string;
  pauseId?: string;
  activeRole?: RoleName;
  startedAt?: string;
  lastPromptSubmittedAt?: string;
  lastStopAt?: string;
  settleDeadlineAt?: string;
  pausedAt?: string;
  runningSince?: string;
  roundSequence?: number;
  promptSubmitCount: number;
  stopCount: number;
  totalRoundCount: number;
  totalPromptSubmitCount: number;
  totalStopCount: number;
  totalCcActiveMs: number;
  currentRoundCcActiveMs: number;
  roles: RoleName[];
  updatedAt: string;
}
