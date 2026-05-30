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
  contextEnabled: true,
  preserveTechnicalTokens: true,
  skipCjkText: true,
  redactSecrets: true,
  maxChunkChars: 4000,
  requestTimeoutMs: 15000,
  temperature: 0.1
};

describe("translation-prompts", () => {
  it("uses built-in prompts by default", () => {
    expect(resolveTranslationSystemPrompt("user-input-to-english", settings)).toBe(
      getBaseTranslationPrompt("user-input-to-english", settings)
    );
  });

  it("uses user prompt overrides when configured", () => {
    const overridden: TranslationSettings = {
      ...settings,
      prompts: {
        "user-input-to-english": "CUSTOM PROMPT"
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
        "cc-output-to-user": "CUSTOM OUTPUT PROMPT"
      }
    });

    const outputPreview = previews.find((preview) => preview.key === "cc-output-to-user");
    expect(outputPreview?.baseSystemPrompt).toContain("Claude Code output");
    expect(outputPreview?.activeSystemPrompt).toBe("CUSTOM OUTPUT PROMPT");
    expect(outputPreview?.customized).toBe(true);
  });
});
