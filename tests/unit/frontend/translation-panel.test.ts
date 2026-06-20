import { describe, expect, it } from "vitest";
import {
  extractTranslatedComposerDraft,
  formatTranslatedComposerDraft,
  hasTranslatedComposerDraft
} from "../../../src/frontend/components/translation-panel.js";

describe("translation-panel composer draft", () => {
  it("keeps the source text and appends the translated draft", () => {
    const draft = formatTranslatedComposerDraft(
      "请检查失败的测试。\n",
      "Please inspect the failing test."
    );

    expect(draft).toBe("请检查失败的测试。\n\n--- Translation ---\nPlease inspect the failing test.");
    expect(hasTranslatedComposerDraft(draft)).toBe(true);
    expect(extractTranslatedComposerDraft(draft)).toBe("Please inspect the failing test.");
  });

  it("falls back to the full composer text when no draft separator exists", () => {
    expect(hasTranslatedComposerDraft("Run tests.")).toBe(false);
    expect(extractTranslatedComposerDraft("Run tests.")).toBe("Run tests.");
  });
});
