import { describe, expect, it } from "vitest";
import {
  formatRoleRecoveryFailureMessage,
  formatRoleRecoveryNotice,
  selectActiveRoleRecovery
} from "../../../src/frontend/state/role-recovery-notice.js";
import type { VcmRoleRecoveryState } from "../../../src/shared/types/round.js";

const NOW_MS = Date.parse("2026-10-26T09:32:33.000Z");

function recovery(overrides: Partial<VcmRoleRecoveryState>): VcmRoleRecoveryState {
  return {
    role: "coder",
    status: "waiting",
    attempt: 2,
    maxAttempts: 20,
    lastFailureAt: "2026-10-26T09:32:33.000Z",
    error: "overloaded",
    ...overrides
  };
}

describe("role recovery notices", () => {
  it("shows the latest role still being retried even when another role's recovery failed", () => {
    const failed = recovery({ role: "architect", status: "failed", lastFailureAt: "2026-10-26T09:40:00.000Z" });
    const older = recovery({ role: "coder", lastFailureAt: "2026-10-26T09:30:00.000Z" });
    const newer = recovery({ role: "tester", status: "retrying", lastFailureAt: "2026-10-26T09:35:00.000Z" });

    expect(selectActiveRoleRecovery({ roleRecovery: failed, roleRecoveries: [failed, older, newer] })).toBe(newer);
    expect(selectActiveRoleRecovery({ roleRecovery: failed, roleRecoveries: [failed] })).toBeUndefined();
    expect(selectActiveRoleRecovery({ roleRecovery: older })).toBe(older);
  });

  it("shows a usage-limit wait with its reset instead of a retry count", () => {
    const waiting = recovery({
      attempt: 0,
      error: "rate_limit",
      waitReason: "usage-limit",
      limitResetAt: "2026-10-26T09:50:00.000Z",
      nextRetryAt: "2026-10-26T09:52:00.000Z"
    });
    const notice = formatRoleRecoveryNotice(waiting, NOW_MS);
    expect(notice).toMatch(/^Claude 额度已用完 · Coder 暂停 · 预计 .+ 恢复 · 20 分钟后自动继续$/);
    expect(notice).not.toContain("第 0/20 次");

    expect(formatRoleRecoveryNotice({ ...waiting, limitResetAt: undefined, nextRetryAt: "2026-10-26T12:32:33.000Z" }, NOW_MS))
      .toBe("Claude 额度已用完 · Coder 暂停 · 恢复时间未知 · 约 3 小时后自动继续");
    expect(formatRoleRecoveryNotice({ ...waiting, status: "retrying" }, NOW_MS)).toBe("Claude 额度应已恢复，正在继续 Coder");
    expect(formatRoleRecoveryFailureMessage({ ...waiting, status: "failed" }, "coder"))
      .toBe("The Claude usage limit for coder did not reset within eight days of waiting.");
  });

  it("keeps the retry count for other failures", () => {
    expect(formatRoleRecoveryNotice(recovery({ nextRetryAt: "2026-10-26T09:34:33.000Z" }), NOW_MS))
      .toBe("CC 出错，重试中 Coder · overloaded · 第 2/20 次 · 2 分钟后");
    expect(formatRoleRecoveryFailureMessage(recovery({ status: "failed", attempt: 20 }), "coder"))
      .toBe("CC retry failed after 20 attempts for coder · overloaded.");
  });
});
