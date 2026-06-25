import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { VcmSessionRoundState } from "../../../src/shared/types/round.js";

// app.tsx transitively imports xterm-backed views that touch browser globals at
// module load and cannot evaluate in the node test environment. Stub them so the
// presentational banner can be rendered to markup in isolation.
vi.mock("../../../src/frontend/terminal/xterm-view.js", () => ({
  XtermView: () => null
}));

const { AwaitUserBanner } = await import("../../../src/frontend/app.js");

const BASE: VcmSessionRoundState = {
  taskSlug: "demo-task",
  status: "running",
  turnCount: 1,
  completedTurnCount: 1,
  totalRoundCount: 1,
  totalTurnCount: 1,
  totalCompletedTurnCount: 1,
  totalCcActiveMs: 0,
  currentRoundCcActiveMs: 0,
  roles: ["project-manager"],
  updatedAt: "2026-06-25T00:00:00.000Z"
};

function render(roundState: VcmSessionRoundState | null): string {
  return renderToStaticMarkup(createElement(AwaitUserBanner, { roundState }));
}

describe("AwaitUserBanner", () => {
  it("renders nothing when there is no awaiting-user pause", () => {
    expect(render(null)).toBe("");
    expect(render({ ...BASE, flowPause: { paused: true, reason: "stopped-no-next-turn", role: "coder" } })).toBe("");
  });

  it("renders the awaiting role and captured message", () => {
    const markup = render({
      ...BASE,
      flowPause: {
        paused: true,
        reason: "awaiting-user",
        role: "project-manager",
        message: "Confirm the rollout window."
      }
    });
    expect(markup).toContain("Project Manager is waiting for your decision");
    expect(markup).toContain("Confirm the rollout window.");
  });

  it("shows a truncation hint when the message was truncated", () => {
    const markup = render({
      ...BASE,
      flowPause: {
        paused: true,
        reason: "awaiting-user",
        role: "project-manager",
        message: "partial",
        messageTruncated: true
      }
    });
    expect(markup).toContain("Message truncated");
  });

  it("renders a fallback line when no message was captured", () => {
    const markup = render({
      ...BASE,
      flowPause: { paused: true, reason: "awaiting-user", role: "project-manager" }
    });
    expect(markup).toContain("Open the project-manager session");
  });

  it("escapes message text so no HTML can be injected", () => {
    const markup = render({
      ...BASE,
      flowPause: {
        paused: true,
        reason: "awaiting-user",
        role: "project-manager",
        message: "<img src=x onerror=alert(1)>"
      }
    });
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
