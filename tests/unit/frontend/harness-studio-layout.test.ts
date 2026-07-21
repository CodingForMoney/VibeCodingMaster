import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Harness Studio layout", () => {
  it("keeps the complete left file list in one scroll viewport without shrinking expanded groups", async () => {
    const css = await readFile(new URL("../../../src/frontend/styles.css", import.meta.url), "utf8");
    const rule = css.match(/\.harness-studio-left-scroll\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(rule).toContain("grid-auto-rows: max-content");
    expect(rule).toContain("height: 100%");
    expect(rule).toContain("overflow-y: auto");
  });
});
