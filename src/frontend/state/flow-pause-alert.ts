import type { VcmRoleRecoveryState, VcmSessionRoundState } from "../../shared/types/round.js";

/**
 * Derive the flow-pause alert message from the AUTHORITATIVE backend signal
 * (`roundState.flowPause`). Returns `null` when the backend reports the flow is
 * not paused — the frontend no longer re-derives the pause decision from
 * `status` / `roundId` / `roleRecovery`. The recovery-failure wording is
 * delegated to the caller so message formatting ownership stays in the GUI.
 */
export function selectFlowPauseAlertMessage(
  roundState: VcmSessionRoundState,
  formatRecoveryFailure: (recovery: VcmRoleRecoveryState, roleLabel: string) => string
): string | null {
  if (!roundState.flowPause?.paused) {
    return null;
  }
  // Await-user is surfaced by the persistent banner (SCF-108), not by this
  // transient alert, so the two never double-alert.
  if (roundState.flowPause.reason === "awaiting-user") {
    return null;
  }
  const roleLabel = roundState.activeRole ?? "role";
  const recovery = roundState.roleRecovery;
  if (roundState.flowPause.reason === "role-recovery-failed" && recovery) {
    return formatRecoveryFailure(recovery, roleLabel);
  }
  return `No new turn started after ${roleLabel} stopped.`;
}
