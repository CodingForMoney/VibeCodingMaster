import type { GatewayStatus } from "../../shared/types/gateway.js";
import type { VcmRoleRecoveryState, VcmRoundStatus, VcmSessionRoundState } from "../../shared/types/round.js";

export interface GatewayInboundObservation {
  initialized: boolean;
  messageId: string | null;
}

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
  const roleLabel = roundState.flowPause.role ?? roundState.activeRole ?? "role";
  const recovery = roundState.roleRecovery;
  if (roundState.flowPause.reason === "role-recovery-failed" && recovery) {
    return formatRecoveryFailure(recovery, roleLabel);
  }
  return roundState.flowPause.message ?? `No new turn started after ${roleLabel} stopped.`;
}

/**
 * Stable identity for one flow-pause alert, used by the GUI to fire the modal and
 * alarm once per stopped round.
 */
export function getFlowPauseNotificationKey(roundState: VcmSessionRoundState): string {
  const roundKey = roundState.roundId ?? roundState.startedAt ?? roundState.taskSlug;
  const stoppedKey = roundState.stoppedAt ?? roundState.lastTurnEndedAt ?? "stopped";
  return `${roundKey}:${stoppedKey}`;
}

export function shouldShowFlowPauseNotice(
  roundState: VcmSessionRoundState,
  previousObservation: { status: VcmRoundStatus } | undefined,
  taskViewStartedAtMs: number | undefined
): boolean {
  if (roundState.flowPause?.paused && roundState.flowPause.message) return true;
  if (previousObservation?.status === "running") return true;
  const stoppedAtMs = Date.parse(roundState.stoppedAt ?? roundState.lastTurnEndedAt ?? "");
  return Boolean(taskViewStartedAtMs && Number.isFinite(stoppedAtMs) && stoppedAtMs > taskViewStartedAtMs);
}

export function selectFlowPauseAlarmMode(soundEnabled: boolean): "none" | "strong" {
  return soundEnabled ? "strong" : "none";
}

export function observeGatewayInboundMessage(
  current: GatewayInboundObservation,
  status: GatewayStatus | null
): { observation: GatewayInboundObservation; dismissPauseAlert: boolean } {
  if (!status) {
    return { observation: current, dismissPauseAlert: false };
  }

  const messageId = status.lastGatewayInputMessageId ?? null;
  if (!current.initialized) {
    return {
      observation: { initialized: true, messageId },
      dismissPauseAlert: false
    };
  }

  return {
    observation: { initialized: true, messageId },
    dismissPauseAlert: Boolean(status.enabled && messageId && messageId !== current.messageId)
  };
}
