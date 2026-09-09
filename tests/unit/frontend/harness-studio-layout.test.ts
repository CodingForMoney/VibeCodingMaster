import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HarnessStudioModal, type HarnessStudioModalProps } from "../../../src/frontend/components/harness-studio-modal.js";

vi.mock("../../../src/frontend/terminal/xterm-view.js", () => ({ XtermView: () => null }));

describe("Harness Studio layout", () => {
  it("shows assignment errors as visible text and offers only the assignment retry", () => {
    const noop = () => {};
    const props: HarnessStudioModalProps = {
      open: true, effort: "medium", model: "default", modelOptions: [], permissionMode: "default",
      taskSlug: "task", bootstrapStatus: null, engineerSession: null, status: null, feedbackState: null,
      memoryState: {
        version: 1, status: "failed", files: [], runs: [], warnings: [],
        active: {
          runId: "run", taskSlug: "task", status: "failed", finalAcceptanceHash: "hash",
          createdAt: "2026-09-09", updatedAt: "2026-09-09", trigger: "manual", drafts: [],
          error: "Memory was applied, but documentation failed.",
          assignments: [{
            id: "doc-1", runId: "run", sourceMemoryPath: "CLAUDE.md", sourceEntry: "Fact",
            content: "Fact", reason: "Durable", evidence: ["src/test.ts"], targetPath: "docs/ARCHITECTURE.md",
            status: "failed", owner: "architect", reportPath: "report.md",
            error: "Reported commit does not modify docs/ARCHITECTURE.md.",
            createdAt: "2026-09-09", updatedAt: "2026-09-09"
          }]
        }
      },
      onClose: noop, onEffortChange: noop, onModelChange: noop, onPermissionModeChange: noop,
      onEngineerResume: noop, onEngineerRestart: noop, onEngineerStart: noop, onEngineerStop: noop,
      onEngineerNotifyHarnessUpdated: noop, onSendFeedback: noop, onOpenRepositoryDiff: noop,
      onReviewTaskHarness: noop, onRefresh: noop, onMemoryStateChange: noop
    };
    const html = renderToStaticMarkup(createElement(HarnessStudioModal, props));
    expect(html).toContain('<p class="warnings">Reported commit does not modify docs/ARCHITECTURE.md.</p>');
    expect(html).toContain("Memory was applied, but documentation failed.");
    expect(html.match(/>Retry<\/button>/g)).toHaveLength(1);
  });

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
