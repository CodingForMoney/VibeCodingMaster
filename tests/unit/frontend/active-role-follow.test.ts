import { describe, expect, it } from "vitest";
import { selectAutoFollowRole } from "../../../src/frontend/state/active-role-follow.js";

describe("selectAutoFollowRole", () => {
  it("follows the active role in auto mode when it changed since the last follow", () => {
    expect(selectAutoFollowRole({
      mode: "auto",
      status: "running",
      activeRole: "architect",
      lastFollowedRole: "project-manager"
    })).toBe("architect");
  });

  it("follows the active role on the first observation (no prior follow)", () => {
    expect(selectAutoFollowRole({
      mode: "auto",
      status: "running",
      activeRole: "coder",
      lastFollowedRole: undefined
    })).toBe("coder");
  });

  it("dedupes when the active role matches the last followed role", () => {
    expect(selectAutoFollowRole({
      mode: "auto",
      status: "running",
      activeRole: "architect",
      lastFollowedRole: "architect"
    })).toBeUndefined();
  });

  it("does not auto-switch in manual orchestration mode", () => {
    expect(selectAutoFollowRole({
      mode: "manual",
      status: "running",
      activeRole: "reviewer",
      lastFollowedRole: "project-manager"
    })).toBeUndefined();
  });

  it("does not auto-switch when the mode is unknown", () => {
    expect(selectAutoFollowRole({
      mode: undefined,
      status: "running",
      activeRole: "reviewer",
      lastFollowedRole: "project-manager"
    })).toBeUndefined();
  });

  it("does not switch when no turn is running", () => {
    expect(selectAutoFollowRole({
      mode: "auto",
      status: "stopped",
      activeRole: "reviewer",
      lastFollowedRole: "project-manager"
    })).toBeUndefined();
  });

  it("does not switch when there is no active role", () => {
    expect(selectAutoFollowRole({
      mode: "auto",
      status: "running",
      activeRole: undefined,
      lastFollowedRole: "project-manager"
    })).toBeUndefined();
  });

  it("follows a gate-reviewer turn like any other role in auto mode", () => {
    expect(selectAutoFollowRole({
      mode: "auto",
      status: "running",
      activeRole: "gate-reviewer",
      lastFollowedRole: "reviewer"
    })).toBe("gate-reviewer");
  });
});
