import type { VcmRoleName } from "./role.js";

export type RoleStallPhase =
  | "awaiting-model"
  | "tool-running"
  | "awaiting-permission"
  | "subagent-running"
  | "compacting";

export interface RoleStallWarning {
  id: string;
  taskSlug: string;
  role: VcmRoleName;
  sessionId: string;
  runtimeSessionToken?: string;
  roundId: string;
  phase: RoleStallPhase;
  phaseStartedAt: string;
  detectedAt: string;
  toolUseId?: string;
  toolName?: string;
}

export interface RoleStallActionResult {
  ok: true;
  warning: RoleStallWarning | null;
}
