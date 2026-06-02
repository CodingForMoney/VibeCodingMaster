import { describe, expect, it } from "vitest";
import { ROLE_NAMES } from "../../../src/shared/constants.js";
import type { RoleName } from "../../../src/shared/types/role.js";
import type { VcmRoleTurnState } from "../../../src/shared/types/round.js";
import { createRoundService, evaluateTaskRoundState } from "../../../src/backend/services/round-service.js";

describe("round-service", () => {
  it("stays active while any role is still answering", () => {
    const state = evaluateTaskRoundState({
      taskSlug: "demo-task",
      updatedAt: "2026-05-31T00:00:04.000Z",
      pendingRouteCount: 0,
      roleStates: roleStates({
        coder: {
          status: "idle",
          lastAnswerEndedAt: "2026-05-31T00:00:02.000Z"
        },
        "project-manager": {
          status: "answering"
        }
      })
    });

    expect(state).toMatchObject({
      taskSlug: "demo-task",
      status: "active",
      activeRole: "project-manager"
    });
    expect(state.completionId).toBeUndefined();
  });

  it("completes a role chain only after the final active role reaches hook Stop", () => {
    const state = evaluateTaskRoundState({
      taskSlug: "demo-task",
      updatedAt: "2026-05-31T00:00:05.000Z",
      pendingRouteCount: 0,
      roleStates: roleStates({
        coder: {
          status: "idle",
          lastAnswerEndedAt: "2026-05-31T00:00:02.000Z"
        },
        "project-manager": {
          status: "idle",
          lastAnswerEndedAt: "2026-05-31T00:00:05.000Z"
        }
      })
    });

    expect(state).toMatchObject({
      status: "completed",
      activeRole: "project-manager",
      completedAt: "2026-05-31T00:00:05.000Z",
      completionId: "direct:project-manager:2026-05-31T00:00:05.000Z"
    });
  });

  it("does not complete while pending route files still need delivery", () => {
    const state = evaluateTaskRoundState({
      taskSlug: "demo-task",
      updatedAt: "2026-05-31T00:00:05.000Z",
      pendingRouteCount: 1,
      roleStates: roleStates({
        "project-manager": {
          status: "idle",
          lastAnswerEndedAt: "2026-05-31T00:00:05.000Z"
        }
      })
    });

    expect(state).toMatchObject({
      status: "active",
      activeRole: "project-manager"
    });
    expect(state.completionId).toBeUndefined();
  });

  it("can complete a direct role answer even when no VCM messages were involved", () => {
    const state = evaluateTaskRoundState({
      taskSlug: "demo-task",
      updatedAt: "2026-05-31T00:00:05.000Z",
      pendingRouteCount: 0,
      roleStates: roleStates({
        "project-manager": {
          status: "idle",
          lastAnswerEndedAt: "2026-05-31T00:00:05.000Z"
        }
      })
    });

    expect(state).toMatchObject({
      status: "completed",
      activeRole: "project-manager",
      completionId: "direct:project-manager:2026-05-31T00:00:05.000Z"
    });
  });

  it("builds round state from hook-driven role session activity", () => {
    const service = createRoundService({
      now: () => "2026-06-01T00:00:06.000Z"
    });

    const state = service.getTaskRoundState({
      taskSlug: "demo-task",
      pendingRouteCount: 0,
      sessions: [{
        id: "session-coder",
        claudeSessionId: "claude-coder",
        taskSlug: "demo-task",
        role: "coder",
        status: "running",
        activityStatus: "idle",
        command: "claude --agent coder",
        permissionMode: "default",
        cwd: "/repo",
        terminalBackend: "node-pty",
        logPath: ".ai/vcm/handoffs/logs/coder.log",
        updatedAt: "2026-06-01T00:00:05.000Z",
        lastPromptSubmittedAt: "2026-06-01T00:00:03.000Z",
        lastStopAt: "2026-06-01T00:00:05.000Z",
        lastHookEventAt: "2026-06-01T00:00:05.000Z"
      }]
    });

    expect(state).toMatchObject({
      status: "completed",
      activeRole: "coder",
      completionId: "direct:coder:2026-06-01T00:00:05.000Z",
      completedAt: "2026-06-01T00:00:05.000Z"
    });
    expect(state.roles.find((role) => role.role === "coder")).toMatchObject({
      status: "idle",
      lastAnswerEndedAt: "2026-06-01T00:00:05.000Z"
    });
  });
});

function roleStates(overrides: Partial<Record<RoleName, Partial<VcmRoleTurnState>>>): VcmRoleTurnState[] {
  return ROLE_NAMES.map((role) => ({
    role,
    status: "unknown",
    pendingToolUseCount: 0,
    ...overrides[role]
  }));
}
