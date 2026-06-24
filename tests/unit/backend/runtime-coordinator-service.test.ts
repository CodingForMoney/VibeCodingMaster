import { describe, expect, it } from "vitest";
import { createRuntimeCoordinatorService } from "../../../src/backend/services/runtime-coordinator-service.js";
import type { RoleName } from "../../../src/shared/types/role.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";

const TASK: TaskRecord = {
  version: 1,
  taskSlug: "demo-task",
  title: "Demo task",
  createdAt: "2026-06-24T00:00:00.000Z",
  updatedAt: "2026-06-24T00:00:00.000Z",
  repoRoot: "/repo",
  worktreePath: "/repo/.claude/worktrees/demo-task",
  branch: "feature/demo-task",
  handoffDir: ".ai/vcm/handoffs",
  status: "running",
  cleanupStatus: "active"
};

describe("createRuntimeCoordinatorService", () => {
  it("does not create project tool sessions when no resumable session exists", async () => {
    const calls: string[] = [];
    const service = createCoordinator({
      calls,
      translator: undefined,
      harnessEngineer: undefined,
      translationEnabled: true
    });

    await service.reconcileProject("/repo", { taskSlug: "demo-task" });

    expect(calls).not.toContain("ensure:translator");
    expect(calls).not.toContain("ensure:harness-engineer");
  });

  it("ensures existing project tool sessions and starts conversation translation listeners", async () => {
    const calls: string[] = [];
    const service = createCoordinator({
      calls,
      translator: projectToolSession("translator", "running"),
      harnessEngineer: projectToolSession("harness-engineer", "resumable"),
      roleSessions: [roleSession("project-manager")]
    });

    await service.reconcileProject("/repo", { taskSlug: "demo-task" });

    expect(calls).toContain("ensure:translator:demo-task");
    expect(calls).toContain("ensure:harness-engineer:demo-task");
    expect(calls).toContain("translation-listener:project-manager:demo-task");
  });

  it("uses preferences restored by Gateway status before reconciling translation", async () => {
    const calls: string[] = [];
    const service = createCoordinator({
      calls,
      translator: projectToolSession("translator", "resumable"),
      harnessEngineer: projectToolSession("harness-engineer", "running"),
      roleSessions: [roleSession("project-manager")],
      translationEnabled: false,
      gatewayEnablesTranslationRuntime: true
    });

    await service.reconcileProject("/repo", { taskSlug: "demo-task" });

    expect(calls).toContain("gateway-status");
    expect(calls).toContain("ensure:translator:demo-task");
    expect(calls).toContain("translation-listener:project-manager:demo-task");
  });
});

function createCoordinator(input: {
  calls: string[];
  translator?: RoleSessionRecord;
  harnessEngineer?: RoleSessionRecord;
  roleSessions?: RoleSessionRecord[];
  translationEnabled?: boolean;
  gatewayEnablesTranslationRuntime?: boolean;
  harnessInitialized?: boolean;
}) {
  let translator = input.translator;
  let harnessEngineer = input.harnessEngineer;
  let translationEnabled = input.translationEnabled ?? true;
  return createRuntimeCoordinatorService({
    appSettings: {
      async getPreferences() {
        return {
          themeMode: "system",
          flowPauseAlerts: true,
          roleRetryEnabled: true,
          permissionRequestMode: "off",
          autoTaskHarnessReviewEnabled: false,
          translationEnabled,
          translationAutoSendEnabled: false,
          translationTargetLanguage: "zh-CN",
          translationOutputMode: "pm-final-only",
          launchTemplate: {
            version: 1,
            autoOrchestration: true,
            roles: {} as never
          }
        };
      }
    },
    taskService: {
      async listTasks() {
        return [TASK];
      }
    },
    sessionService: {
      async getProjectTranslatorSession() {
        return translator;
      },
      async ensureProjectTranslatorSession(_repoRoot, request = {}) {
        input.calls.push(`ensure:translator:${request.taskSlug ?? ""}`);
        translator = { ...(translator ?? projectToolSession("translator", "running")), status: "running" };
        return translator;
      },
      async getProjectHarnessEngineerSession() {
        return harnessEngineer;
      },
      async ensureProjectHarnessEngineerSession(_repoRoot, request = {}) {
        input.calls.push(`ensure:harness-engineer:${request.taskSlug ?? ""}`);
        harnessEngineer = { ...(harnessEngineer ?? projectToolSession("harness-engineer", "running")), status: "running" };
        return harnessEngineer;
      },
      async listRoleSessions() {
        return input.roleSessions ?? [];
      }
    },
    translationService: {
      async startSession(request) {
        input.calls.push(`translation-listener:${request.role}:${request.taskSlug}`);
        return {
          sessionId: `session-${request.role}`,
          status: "ready",
          nextCursor: 1
        };
      },
      async stopTask(_repoRoot, taskSlug) {
        input.calls.push(`translation-stop:${taskSlug}`);
      }
    },
    harnessService: {
      async getHarnessStatus() {
        return {
          version: 1,
          harnessRevision: 1,
          initialized: input.harnessInitialized ?? true,
          files: [],
          needsApply: false,
          plannedChanges: [],
          warnings: []
        };
      }
    },
    harnessFeedbackService: {
      async startTaskRetrospective() {
        throw new Error("unexpected retrospective");
      }
    },
    roundService: {
      async getSessionRoundState() {
        return {
          taskSlug: "demo-task",
          status: "running",
          turnCount: 0,
          completedTurnCount: 0,
          totalRoundCount: 0,
          totalTurnCount: 0,
          totalCompletedTurnCount: 0,
          totalCcActiveMs: 0,
          currentRoundCcActiveMs: 0,
          roles: [],
          updatedAt: "2026-06-24T00:00:00.000Z"
        };
      }
    },
    gatewayService: {
      async getStatus() {
        input.calls.push("gateway-status");
        if (input.gatewayEnablesTranslationRuntime) {
          translationEnabled = true;
        }
        return null as never;
      }
    },
    async getStateRoot() {
      return ".ai/vcm";
    }
  });
}

function projectToolSession(role: RoleName, status: RoleSessionRecord["status"]): RoleSessionRecord {
  return {
    id: `session-${role}`,
    claudeSessionId: `claude-${role}`,
    taskSlug: "__project__",
    role,
    status,
    activityStatus: "idle",
    command: "claude",
    permissionMode: "bypassPermissions",
    model: "default",
    effort: "default",
    cwd: "/repo",
    terminalBackend: "node-pty",
    startedAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z"
  };
}

function roleSession(role: RoleName): RoleSessionRecord {
  return {
    ...projectToolSession(role, "running"),
    id: `role-session-${role}`,
    claudeSessionId: `role-claude-${role}`,
    taskSlug: "demo-task",
    role,
    cwd: TASK.worktreePath
  };
}
