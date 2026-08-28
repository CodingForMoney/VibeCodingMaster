import { describe, expect, it } from "vitest";
import {
  ensureVcmMemoryBlock,
  readVcmMemoryHostFrame,
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

  it("keeps host framing independent from memory content and whitespace", () => {
    const original = "Before\n\n<VCM-memory>\nOld\n</VCM-memory>\n\nAfter\n";
    const changedInside = "Before\n\n<VCM-memory>\nNew fact\n\n\n</VCM-memory>\n\nAfter\n";

    expect(readVcmMemoryHostFrame(changedInside)).toEqual(readVcmMemoryHostFrame(original));
  });

  it("requires exactly one valid memory block when reading host framing", () => {
    expect(readVcmMemoryHostFrame("No memory block here.\n")).toBeUndefined();
    expect(() => readVcmMemoryHostFrame([
      "<VCM-memory>",
      "One",
      "</VCM-memory>",
      "<VCM-memory>",
      "Two",
      "</VCM-memory>"
    ].join("\n"))).toThrow("exactly one valid <VCM-memory> section");
  });
});
