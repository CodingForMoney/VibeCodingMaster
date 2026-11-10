import { describe, expect, it } from "vitest";
import { detectUsageLimit, parseUsageLimitReset } from "../../../src/backend/services/usage-limit.js";

// 17:32 in Singapore, when Claude Code reported this message on a real task.
const NOW = new Date("2026-10-26T09:32:33.097Z");
const SESSION_LIMIT = "You've hit your session limit · resets 5:50pm (Asia/Singapore)";

describe("detectUsageLimit", () => {
  it("recognizes Claude Code's session-limit message reported as rate_limit", () => {
    expect(detectUsageLimit({ error: "rate_limit", errorDetails: "429", lastAssistantMessage: SESSION_LIMIT }, NOW)).toEqual({
      message: SESSION_LIMIT,
      resetAt: "2026-10-26T09:50:00.000Z"
    });
  });

  it("recognizes a limit message without a reset time", () => {
    expect(detectUsageLimit({ error: "rate_limit", lastAssistantMessage: "Claude usage limit reached." }, NOW)).toEqual({
      message: "Claude usage limit reached.",
      resetAt: undefined
    });
  });

  it("leaves short-term throttling and other errors to the normal retry", () => {
    expect(detectUsageLimit({ error: "rate_limit", errorDetails: "429 Too Many Requests", lastAssistantMessage: "API Error: Rate limit reached" }, NOW))
      .toBeUndefined();
    expect(detectUsageLimit({ error: "overloaded", lastAssistantMessage: SESSION_LIMIT }, NOW)).toBeUndefined();
  });
});

describe("parseUsageLimitReset", () => {
  it("uses the next occurrence of the stated time in its time zone", () => {
    expect(parseUsageLimitReset(SESSION_LIMIT, NOW)).toBe("2026-10-26T09:50:00.000Z");
    expect(parseUsageLimitReset(SESSION_LIMIT, new Date("2026-10-26T10:00:00.000Z"))).toBe("2026-10-27T09:50:00.000Z");
  });

  it("reads a dated reset across a daylight-saving change", () => {
    expect(parseUsageLimitReset("You've hit your weekly limit · resets Nov 2, 9am (America/Los_Angeles)", NOW))
      .toBe("2026-11-02T17:00:00.000Z");
    expect(parseUsageLimitReset("resets 17:05 (UTC)", NOW)).toBe("2026-10-26T17:05:00.000Z");
  });

  it("returns nothing it cannot place", () => {
    expect(parseUsageLimitReset("You've hit your session limit", NOW)).toBeUndefined();
    expect(parseUsageLimitReset("resets 5:50pm (Mars/Olympus_Mons)", NOW)).toBeUndefined();
    expect(parseUsageLimitReset("resets 13pm (UTC)", NOW)).toBeUndefined();
    expect(parseUsageLimitReset("resets Dec 30, 9am (UTC)", NOW)).toBeUndefined();
  });
});
