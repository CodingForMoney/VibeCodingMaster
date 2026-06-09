import { describe, expect, it } from "vitest";
import {
  buildTranslationPrompt,
  getBaseTranslationPrompt,
  getTranslationPromptPreviews,
  resolveTranslationSystemPrompt
} from "../../../src/backend/services/translation-prompts.js";
import type { TranslationSettings } from "../../../src/shared/types/translation.js";

const settings: TranslationSettings = {
  version: 1,
  enabled: true,
  providerType: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  model: "cheap-model",
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  workingLanguage: "en",
  inputMode: "review-before-send",
  translateOutput: true,
  translateUserInput: true,
  contextEnabled: false,
  preserveTechnicalTokens: true,
  skipCjkText: true,
  redactSecrets: true,
  requestTimeoutMs: 120000,
  temperature: 0.1
};

describe("translation-prompts", () => {
  it("uses built-in prompts by default", () => {
    expect(resolveTranslationSystemPrompt("zh-to-en", settings)).toBe(
      getBaseTranslationPrompt("zh-to-en", settings)
    );
  });

  it("uses user prompt overrides when configured", () => {
    const overridden: TranslationSettings = {
      ...settings,
      prompts: {
        "zh-to-en": "CUSTOM PROMPT"
      }
    };

    const prompt = buildTranslationPrompt({
      direction: "user-input-to-english",
      text: "继续",
      settings: overridden
    });

    expect(prompt.systemPrompt).toBe("CUSTOM PROMPT");
    expect(prompt.userPrompt).toBe("继续");
  });

  it("exposes active and built-in prompt previews", () => {
    const previews = getTranslationPromptPreviews({
      ...settings,
      prompts: {
        "en-to-zh": "CUSTOM OUTPUT PROMPT"
      }
    });

    const outputPreview = previews.find((preview) => preview.key === "en-to-zh");
    expect(outputPreview?.defaultPrompt).toContain("Claude Code (an AI coding assistant CLI) replies in English");
    expect(outputPreview?.userPrompt).toBe("CUSTOM OUTPUT PROMPT");
    expect(outputPreview?.customized).toBe(true);
  });
});
