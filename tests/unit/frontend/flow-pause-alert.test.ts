import { describe, expect, it, vi } from "vitest";
import {
  getFlowPauseNotificationKey,
  observeGatewayInboundMessage,
  selectFlowPauseAlarmMode,
  selectFlowPauseAlertMessage,
  shouldShowFlowPauseNotice
} from "../../../src/frontend/state/flow-pause-alert.js";
import type { GatewayStatus } from "../../../src/shared/types/gateway.js";
import type { VcmSessionRoundState } from "../../../src/shared/types/round.js";

const BASE: VcmSessionRoundState = {
  taskSlug: "demo-task",
  status: "stopped",
  turnCount: 1,
  completedTurnCount: 1,
  totalRoundCount: 1,
  totalTurnCount: 1,
  totalCompletedTurnCount: 1,
  totalCcActiveMs: 0,
  currentRoundCcActiveMs: 0,
  roles: ["project-manager"],
  updatedAt: "2026-06-25T00:00:00.000Z"
};

describe("selectFlowPauseAlertMessage", () => {
  it("displays the backend pause notice without deriving workflow decisions", () => {
    const message = "No new turn started after project-manager stopped.";
    expect(selectFlowPauseAlertMessage({ ...BASE, flowPause: { paused: true, message } }, vi.fn())).toBe(message);
    expect(selectFlowPauseAlertMessage({ ...BASE, flowPause: { paused: false, message } }, vi.fn())).toBeNull();
  });
  it("returns null when the backend reports no pause", () => {
    const formatRecoveryFailure = vi.fn();
    expect(selectFlowPauseAlertMessage({ ...BASE }, formatRecoveryFailure)).toBeNull();
    expect(formatRecoveryFailure).not.toHaveBeenCalled();
  });

  it("returns null when flowPause is present but not paused", () => {
    const state: VcmSessionRoundState = { ...BASE, flowPause: { paused: false } };
    expect(selectFlowPauseAlertMessage(state, vi.fn())).toBeNull();
  });

  it("does not self-derive a pause from status/roundId/recovery without the authoritative signal", () => {
    // Old client logic would have treated this as paused (stopped + roundId + no
    // active recovery). Without flowPause.paused, the helper must NOT alert.
    const state: VcmSessionRoundState = {
      ...BASE,
      status: "stopped",
      roundId: "round_1",
      activeRole: "coder"
    };
    expect(selectFlowPauseAlertMessage(state, vi.fn())).toBeNull();
  });

  it("uses the stopped-no-next-turn wording from the authoritative signal", () => {
    const state: VcmSessionRoundState = {
      ...BASE,
      activeRole: "architect",
      flowPause: { paused: true, reason: "stopped-no-next-turn", role: "architect" }
    };
    expect(selectFlowPauseAlertMessage(state, vi.fn())).toBe("No new turn started after architect stopped.");
  });

  it("delegates the role-recovery-failed wording to the caller's formatter", () => {
    const recovery = {
      role: "coder" as const,
      status: "failed" as const,
      attempt: 20,
      maxAttempts: 20,
      lastFailureAt: "2026-06-25T00:00:00.000Z"
    };
    const state: VcmSessionRoundState = {
      ...BASE,
      activeRole: "coder",
      roleRecovery: recovery,
      flowPause: { paused: true, reason: "role-recovery-failed", role: "coder" }
    };
    const formatRecoveryFailure = vi.fn().mockReturnValue("CC retry failed for coder.");

    expect(selectFlowPauseAlertMessage(state, formatRecoveryFailure)).toBe("CC retry failed for coder.");
    expect(formatRecoveryFailure).toHaveBeenCalledWith(recovery, "coder");
  });

  it("falls back to the stopped wording when reason is role-recovery-failed but recovery is absent", () => {
    const state: VcmSessionRoundState = {
      ...BASE,
      activeRole: "tester",
      flowPause: { paused: true, reason: "role-recovery-failed", role: "tester" }
    };
    expect(selectFlowPauseAlertMessage(state, vi.fn())).toBe("No new turn started after tester stopped.");
  });

  it("uses a generic role label when the active role is unknown", () => {
    const state: VcmSessionRoundState = {
      ...BASE,
      activeRole: undefined,
      flowPause: { paused: true, reason: "stopped-no-next-turn" }
    };
    expect(selectFlowPauseAlertMessage(state, vi.fn())).toBe("No new turn started after role stopped.");
  });
});

describe("flow pause presentation", () => {
  it("does not revive historical alerts after refresh even when a pause message is present", () => {
    const state = { ...BASE, stoppedAt: "2026-09-09T00:00:00.000Z", flowPause: { paused: true } };
    const openedAt = Date.parse("2026-09-09T00:01:00.000Z");
    expect(shouldShowFlowPauseNotice(state, undefined, openedAt)).toBe(false);
    expect(shouldShowFlowPauseNotice({ ...state, flowPause: { paused: true, message: "No new turn started." } }, undefined, openedAt)).toBe(false);
    expect(shouldShowFlowPauseNotice(state, { status: "running" }, openedAt)).toBe(true);
  });
  it("always keeps the modal decision separate from the sound preference", () => {
    const pausedState: VcmSessionRoundState = {
      ...BASE,
      flowPause: { paused: true, reason: "stopped-no-next-turn", role: "project-manager" }
    };

    expect(selectFlowPauseAlertMessage(pausedState, vi.fn())).not.toBeNull();
    expect(selectFlowPauseAlarmMode(false)).toBe("none");
    expect(selectFlowPauseAlarmMode(true)).toBe("strong");
  });

  it("dismisses an existing pause only for a new inbound message while Gateway is enabled", () => {
    const initial = observeGatewayInboundMessage(
      { initialized: false, messageId: null },
      gatewayStatus({ enabled: true, lastGatewayInputMessageId: "old-message" })
    );
    expect(initial.dismissPauseAlert).toBe(false);

    const next = observeGatewayInboundMessage(
      initial.observation,
      gatewayStatus({ enabled: true, lastGatewayInputMessageId: "new-message" })
    );
    expect(next.dismissPauseAlert).toBe(true);

    expect(observeGatewayInboundMessage(next.observation, gatewayStatus({
      enabled: true,
      lastGatewayInputMessageId: "new-message"
    })).dismissPauseAlert).toBe(false);
    expect(observeGatewayInboundMessage(next.observation, gatewayStatus({
      enabled: false,
      lastGatewayInputMessageId: "newer-message"
    })).dismissPauseAlert).toBe(false);
  });
});

describe("getFlowPauseNotificationKey", () => {
  const SINCE = "2026-05-31T00:00:02.000Z";
  it("keys pauses on roundId:stoppedAt, so each genuine stop is a distinct alert", () => {
    const stoppedNoNextTurn: VcmSessionRoundState = {
      ...BASE,
      roundId: "round_1",
      stoppedAt: SINCE,
      activeRole: "coder",
      flowPause: { paused: true, reason: "stopped-no-next-turn", role: "coder" }
    };
    expect(getFlowPauseNotificationKey(stoppedNoNextTurn)).toBe(`round_1:${SINCE}`);

    const recoveryFailed: VcmSessionRoundState = {
      ...BASE,
      roundId: "round_1",
      stoppedAt: SINCE,
      activeRole: "coder",
      flowPause: { paused: true, reason: "role-recovery-failed", role: "coder" }
    };
    expect(getFlowPauseNotificationKey(recoveryFailed)).toBe(`round_1:${SINCE}`);

    const laterStop: VcmSessionRoundState = {
      ...stoppedNoNextTurn,
      roundId: "round_2",
      stoppedAt: "2026-05-31T00:05:00.000Z"
    };
    expect(getFlowPauseNotificationKey(laterStop)).not.toBe(getFlowPauseNotificationKey(stoppedNoNextTurn));
  });
});

function gatewayStatus(input: Pick<GatewayStatus, "enabled" | "lastGatewayInputMessageId">): GatewayStatus {
  return {
    version: 1,
    enabled: input.enabled,
    running: input.enabled,
    connectionEnabled: input.enabled,
    channel: "lark",
    translationEnabled: true,
    currentProjectId: "/repo",
    currentTaskSlug: "demo-task",
    targetRole: "project-manager",
    targetRoleSessionStatus: "running",
    binding: {
      accountId: null,
      baseUrl: "https://open.larksuite.com",
      boundUserId: "user-1",
      loginUserId: "user-1",
      tokenConfigured: false,
      appId: "app-1",
      appIdConfigured: true,
      appSecretConfigured: true,
      homeChatId: "chat-1"
    },
    pendingConfirmations: {},
    lastPollStatus: { state: "running" },
    lastMessageStatus: null,
    lastGatewayInputMessageId: input.lastGatewayInputMessageId,
    updatedAt: BASE.updatedAt
  };
}
