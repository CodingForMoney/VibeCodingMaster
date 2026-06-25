import { describe, expect, it, vi } from "vitest";
import { selectFlowPauseAlertMessage } from "../../../src/frontend/state/flow-pause-alert.js";
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
      activeRole: "reviewer",
      flowPause: { paused: true, reason: "role-recovery-failed", role: "reviewer" }
    };
    expect(selectFlowPauseAlertMessage(state, vi.fn())).toBe("No new turn started after reviewer stopped.");
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
