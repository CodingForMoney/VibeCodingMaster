import { describe, expect, it } from "vitest";
import { createDefaultLaunchTemplate } from "../../../src/shared/types/app-settings.js";
import { buildOneClickRoleLaunches } from "../../../src/frontend/state/one-click-start.js";

describe("buildOneClickRoleLaunches", () => {
  it("starts the four Claude Code roles by default", () => {
    const template = createDefaultLaunchTemplate();
    template.roles.coder = {
      permissionMode: "bypassPermissions",
      model: "opus",
      effort: "high"
    };

    expect(buildOneClickRoleLaunches(template, { gateReviewerEnabled: false })).toEqual([
      {
        role: "project-manager",
        permissionMode: "default",
        model: "default",
        effort: "default"
      },
      {
        role: "architect",
        permissionMode: "default",
        model: "default",
        effort: "default"
      },
      {
        role: "coder",
        permissionMode: "bypassPermissions",
        model: "opus",
        effort: "high"
      },
      {
        role: "reviewer",
        permissionMode: "default",
        model: "default",
        effort: "default"
      }
    ]);
  });

  it("adds Gate Reviewer when Gate review gates are enabled", () => {
    const launches = buildOneClickRoleLaunches(createDefaultLaunchTemplate(), {
      gateReviewerEnabled: true
    });

    expect(launches.map((launch) => launch.role)).toEqual([
      "project-manager",
      "architect",
      "coder",
      "reviewer",
      "gate-reviewer"
    ]);
    expect(launches.at(-1)).toEqual({
      role: "gate-reviewer",
      permissionMode: "default",
      model: "default",
      effort: "default"
    });
  });
});
