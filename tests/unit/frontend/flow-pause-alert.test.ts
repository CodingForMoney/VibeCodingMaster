import { describe, expect, it, vi } from "vitest";
import { getFlowPauseNotificationKey, selectFlowPauseAlertMessage } from "../../../src/frontend/state/flow-pause-alert.js";
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

  it("surfaces awaiting-user through the modal wording (await-user banner removed)", () => {
    const formatRecoveryFailure = vi.fn();
    const state: VcmSessionRoundState = {
      ...BASE,
      activeRole: "project-manager",
      flowPause: {
        paused: true,
        reason: "awaiting-user",
        role: "project-manager",
        message: "Need your call on the rollout."
      }
    };
    expect(selectFlowPauseAlertMessage(state, formatRecoveryFailure)).toBe(
      "No new turn started after project-manager stopped."
    );
    expect(formatRecoveryFailure).not.toHaveBeenCalled();
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

// Single-fire guard for the GUI alert dedup key (gate Finding 2). The GUI fires the
// flow-pause modal + alarm once per distinct key; these pin the keying contract that
// makes a sticky awaiting-user decision alert exactly once while still re-alerting on
// a genuinely new decision, and leaves non-sticky pauses on their per-stop identity.
describe("getFlowPauseNotificationKey", () => {
  const SINCE = "2026-05-31T00:00:02.000Z";

  it("keys a sticky awaiting-user decision on its stable `since`, so a round cycle dedups to ONE alert", () => {
    // Same pending decision (`since`), but the round identity has advanced under a
    // helper role (new roundId + new stoppedAt) — exactly the running->stopped cycle.
    const firstStop: VcmSessionRoundState = {
      ...BASE,
      roundId: "round_1",
      stoppedAt: SINCE,
      activeRole: "project-manager",
      flowPause: { paused: true, reason: "awaiting-user", role: "project-manager", since: SINCE }
    };
    const reStopAfterCycle: VcmSessionRoundState = {
      ...BASE,
      roundId: "round_2",
      stoppedAt: "2026-05-31T01:01:02.000Z",
      activeRole: "gate-reviewer",
      flowPause: { paused: true, reason: "awaiting-user", role: "project-manager", since: SINCE }
    };

    // Stable key across the cycle => the alert effect dedups => single fire.
    // (Reverting the awaiting-user key branch makes these fall back to the advancing
    // roundId:stoppedAt — `round_1:...` vs `round_2:...` — failing this assertion.)
    expect(getFlowPauseNotificationKey(firstStop)).toBe(`awaiting-user:${SINCE}`);
    expect(getFlowPauseNotificationKey(reStopAfterCycle)).toBe(getFlowPauseNotificationKey(firstStop));
  });

  it("re-keys when a genuinely new awaiting-user decision arrives (`since` changes)", () => {
    // Identical round identity, different decision anchor — proves the dedup keys on
    // `since`, not the round. (On revert both would share roundId:stoppedAt and key
    // identically, failing this `not.toBe`.)
    const base = {
      ...BASE,
      roundId: "round_1",
      stoppedAt: SINCE,
      activeRole: "project-manager"
    } satisfies VcmSessionRoundState;
    const firstDecision: VcmSessionRoundState = {
      ...base,
      flowPause: { paused: true, reason: "awaiting-user", role: "project-manager", since: SINCE }
    };
    const newDecision: VcmSessionRoundState = {
      ...base,
      flowPause: { paused: true, reason: "awaiting-user", role: "project-manager", since: "2026-05-31T05:00:00.000Z" }
    };

    expect(getFlowPauseNotificationKey(newDecision)).not.toBe(getFlowPauseNotificationKey(firstDecision));
    expect(getFlowPauseNotificationKey(newDecision)).toBe("awaiting-user:2026-05-31T05:00:00.000Z");
  });

  it("keys non-sticky pauses on roundId:stoppedAt, so each genuine stop is a distinct alert", () => {
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
