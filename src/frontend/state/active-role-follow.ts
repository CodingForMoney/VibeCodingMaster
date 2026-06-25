import type { VcmOrchestrationMode } from "../../shared/types/message.js";
import type { RoleName } from "../../shared/types/role.js";
import type { VcmRoundStatus } from "../../shared/types/round.js";

export interface AutoFollowRoleInput {
  /** Current orchestration mode for the task; auto-follow only applies to `auto`. */
  mode: VcmOrchestrationMode | undefined;
  /** Authoritative round status; the active role is only meaningful while running. */
  status: VcmRoundStatus;
  /** Authoritative role the round set at turn start. */
  activeRole: RoleName | undefined;
  /** Last role this follower already switched to, for dedupe. */
  lastFollowedRole: RoleName | undefined;
}

/**
 * Decide which role tab the GUI should follow from the authoritative round state.
 *
 * Returns the role to switch to, or `undefined` to leave the current tab alone.
 * Auto-follow only happens in `auto` orchestration mode while a turn is running,
 * and only when the active role actually changed since the last follow — so it
 * does not re-switch every poll and does not steal a user's manual tab focus
 * (manual focus survives until the round itself moves to a different role).
 */
export function selectAutoFollowRole(input: AutoFollowRoleInput): RoleName | undefined {
  if (input.mode !== "auto" || input.status !== "running") {
    return undefined;
  }
  if (!input.activeRole || input.activeRole === input.lastFollowedRole) {
    return undefined;
  }
  return input.activeRole;
}
