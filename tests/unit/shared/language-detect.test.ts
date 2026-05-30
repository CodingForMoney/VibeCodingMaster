import { describe, expect, it } from "vitest";
import { cjkRatio, isProbablyCjk, shouldSkipForTargetLanguage } from "../../../src/shared/validation/language-detect.js";

describe("language-detect", () => {
  it("computes CJK ratio while ignoring ASCII punctuation", () => {
    expect(cjkRatio("继续，按你说的改")).toBeGreaterThan(0.8);
    expect(cjkRatio("Continue with the plan")).toBe(0);
  });

  it("detects CJK content and skips it for Chinese target language", () => {
    expect(isProbablyCjk("调用 fetch() 时保留错误信息")).toBe(true);
    expect(shouldSkipForTargetLanguage("我会先检查失败的测试。", "zh-CN")).toBe(true);
    expect(shouldSkipForTargetLanguage("I will inspect the failing tests.", "zh-CN")).toBe(false);
  });
});

