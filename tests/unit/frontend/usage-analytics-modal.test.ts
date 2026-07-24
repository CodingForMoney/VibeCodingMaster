import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TaskUsageAnalyticsReport } from "../../../src/shared/types/usage-analytics.js";
import { UsageAnalyticsContent } from "../../../src/frontend/components/usage-analytics-modal.js";

describe("UsageAnalyticsContent", () => {
  it("renders task, role, and model usage summaries", () => {
    const report: TaskUsageAnalyticsReport = {
      version: 1,
      taskSlug: "demo",
      updatedAt: "2026-07-22T08:00:00.000Z",
      totals: totals(1_500, 120, 1_000, 300, 0.125, 4, 3),
      byRole: [
        { role: "project-manager", ...totals(500, 40, 300, 100, 0.025, 2, 2) },
        { role: "architect", ...totals(1_000, 80, 700, 200, 0.1, 2, 1) }
      ],
      byModel: [
        { model: "claude-opus-5", ...totals(1_500, 120, 1_000, 300, 0.125, 4, 3) }
      ]
    };

    const html = renderToStaticMarkup(createElement(UsageAnalyticsContent, { report }));

    expect(html).toContain("Task Summary");
    expect(html).toContain("Usage by Role");
    expect(html).toContain("Project Manager");
    expect(html).toContain("Architect");
    expect(html).toContain("Usage by Model");
    expect(html).toContain("claude-opus-5");
    expect(html).toContain("1,500");
    expect(html).toContain("$0.1250");
  });
});

function totals(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  costUsd: number,
  requestCount: number,
  sessionCount: number
) {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd,
    requestCount,
    sessionCount
  };
}
