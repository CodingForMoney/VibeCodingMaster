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
  // Use the authoritative pause role (set by the backend at pause time), not the
  // live activeRole: for a sticky awaiting-user decision the round may have
  // advanced under another role (e.g. gate-reviewer), but the alert must still
  // name the role the flow is actually waiting on.
  const roleLabel = roundState.flowPause.role ?? roundState.activeRole ?? "role";
  const recovery = roundState.roleRecovery;
  if (roundState.flowPause.reason === "role-recovery-failed" && recovery) {
    return formatRecoveryFailure(recovery, roleLabel);
  }
  return `No new turn started after ${roleLabel} stopped.`;
}
