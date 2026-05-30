import { describe, expect, it } from "vitest";
import {
  classifyTranslationChunk,
  containsSensitiveToken,
  stripAnsiForTranslation
} from "../../../src/shared/validation/translation-classifier.js";

describe("translation-classifier", () => {
  it("strips ANSI before translation classification", () => {
    expect(stripAnsiForTranslation("\u001b[31mError\u001b[0m\r\n")).toBe("Error\n");
  });

  it("classifies prose, code, diff, and target-language chunks", () => {
    expect(classifyTranslationChunk("I will inspect the failing tests first.", "zh-CN").sourceKind).toBe("prose");
    expect(classifyTranslationChunk("```ts\nconst value = 1;\n```", "zh-CN").sourceKind).toBe("code");
    expect(classifyTranslationChunk("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@", "zh-CN").sourceKind).toBe("diff");
    expect(classifyTranslationChunk("我会先检查失败的测试。", "zh-CN").sourceKind).toBe("already-target-language");
  });

  it("detects sensitive tokens", () => {
    expect(containsSensitiveToken("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(classifyTranslationChunk("SECRET_TOKEN=abc123", "zh-CN").sourceKind).toBe("sensitive");
  });
});

