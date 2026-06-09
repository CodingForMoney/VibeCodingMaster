import { describe, expect, it } from "vitest";
import {
  buildChatCompletionsUrl,
  createOpenAiCompatibleTranslationProvider,
  parseOpenAiUsage
} from "../../../src/backend/adapters/translation-provider.js";
import type { TranslationSettings } from "../../../src/shared/types/translation.js";

const settings: TranslationSettings = {
  version: 1,
  enabled: true,
  providerType: "openai-compatible",
  baseUrl: "https://api.example.com/v1/",
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

describe("translation-provider", () => {
  it("builds OpenAI-compatible chat completions URLs", () => {
    expect(buildChatCompletionsUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1/chat/completions");
  });

  it("parses OpenAI token usage", () => {
    expect(parseOpenAiUsage({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 })).toEqual({
      input: 3,
      output: 4,
      total: 7
    });
  });

  it("sends model, messages, temperature, and auth header", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const provider = createOpenAiCompatibleTranslationProvider(async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({
        choices: [{ message: { content: "translated" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      }), { status: 200 });
    });

    const result = await provider.translate({
      settings,
      secrets: { apiKey: "secret" },
      systemPrompt: "system",
      userPrompt: "user"
    });

    expect(result.text).toBe("translated");
    expect(captured?.url).toBe("https://api.example.com/v1/chat/completions");
    expect((captured?.init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(String(captured?.init.body))).toMatchObject({
      model: "cheap-model",
      temperature: 0.1,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" }
      ]
    });
  });
});
