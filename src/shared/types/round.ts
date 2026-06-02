import type { RoleName } from "./role.js";

export type VcmRoleTurnStatus =
  | "unknown"
  | "idle"
  | "answering"
  | "using_tools"
  | "waiting_user"
  | "abnormal";

export type VcmTaskRoundStatus =
  | "idle"
  | "active"
  | "waiting_user"
  | "completed";

export interface VcmRoleTurnState {
  role: RoleName;
  sessionId?: string;
  status: VcmRoleTurnStatus;
  pendingToolUseCount: number;
  lastActivityAt?: string;
  lastAnswerEndedAt?: string;
  reason?: string;
}

export interface VcmTaskRoundState {
  taskSlug: string;
  status: VcmTaskRoundStatus;
  activeRole?: RoleName;
  completionId?: string;
  completedAt?: string;
  pendingRouteCount: number;
  roles: VcmRoleTurnState[];
  updatedAt: string;
}
