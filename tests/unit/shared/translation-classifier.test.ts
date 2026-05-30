import { describe, expect, it } from "vitest";
import {
  classifyTranslationChunk,
  cleanClaudeOutputForTranslation,
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

  it("filters Claude Code tool noise before translation", () => {
    const cleaned = cleanClaudeOutputForTranslation([
      "\u001b[36m● Bash(npm test)\u001b[0m",
      "  ⎿  PASS tests/unit/example.test.ts",
      "",
      "I found the failing test and will update the parser.",
      "╭────────────╮",
      "│ esc to interrupt │"
    ].join("\n"));

    expect(cleaned).toBe("I found the failing test and will update the parser.");
    expect(classifyTranslationChunk(cleaned, "zh-CN").sourceKind).toBe("prose");
  });

  it("keeps multi-line assistant prose translatable instead of treating it as logs", () => {
    const text = [
      "I checked the implementation.",
      "",
      "- The settings file is loaded correctly.",
      "- The API key is preserved locally.",
      "- The recent repositories list is capped.",
      "- The migration path is covered by tests.",
      "",
      "Next I will verify the UI behavior."
    ].join("\n");

    expect(classifyTranslationChunk(text, "zh-CN").sourceKind).toBe("prose");
  });
});
