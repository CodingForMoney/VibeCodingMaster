import { describe, expect, it } from "vitest";
import {
  formatRoleRecoveryFailureMessage,
  formatRoleRecoveryNotice
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
