import { describe, expect, it } from "vitest";
import {
  ensureVcmMemoryBlock,
  readVcmMemoryBlock,
  replaceVcmMemoryBlock
} from "../../../src/backend/templates/harness/memory-block.js";

describe("VCM memory blocks", () => {
  it("inserts memory before the fixed managed block", () => {
    const content = ensureVcmMemoryBlock("# CLAUDE.md\n\n<!-- VCM:BEGIN version=1 -->\nRules\n<!-- VCM:END -->\n");

    expect(content.indexOf("<VCM-memory>")).toBeLessThan(content.indexOf("<!-- VCM:BEGIN"));
    expect(readVcmMemoryBlock(content)).toBe("No accumulated project memory yet.\n");
  });

  it("ignores tag names mentioned inside rule prose", () => {
    const content = [
      "# CLAUDE.md",
      "",
      "<VCM-memory>",
      "Use backend state as the source of truth.",
      "</VCM-memory>",
      "",
      "<!-- VCM:BEGIN version=1 -->",
      "Treat every `<VCM-memory>` block as read-only.",
      "<!-- VCM:END -->",
      ""
    ].join("\n");

    expect(readVcmMemoryBlock(content)).toBe("Use backend state as the source of truth.\n");
  });

  it("replaces only memory content", () => {
    const content = "Before\n\n<VCM-memory>\nOld\n</VCM-memory>\n\nAfter\n";

    expect(replaceVcmMemoryBlock(content, "New fact\n")).toBe(
      "Before\n\n<VCM-memory>\nNew fact\n</VCM-memory>\n\nAfter\n"
    );
  });
});
