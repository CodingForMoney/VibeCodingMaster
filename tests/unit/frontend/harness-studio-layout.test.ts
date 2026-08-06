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

  it("renders backend-owned code intelligence status in the scrollable Harness list", async () => {
    const component = await readFile(new URL("../../../src/frontend/components/harness-studio-modal.tsx", import.meta.url), "utf8");

    expect(component).toContain('title="Code Intelligence"');
    expect(component).toContain("status?.codeIntelligence?.languages");
    expect(component).toContain('language.state === "server_runnable"');
    expect(component).toContain('language.error ?? "Server runnable; workspace readiness is checked in each role session."');
  });
});
