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
  it("does not create task tool sessions when no resumable session exists", async () => {
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

  it("resumes existing task tool sessions and starts conversation translation listeners", async () => {
    const calls: string[] = [];
    const service = createCoordinator({
      calls,
      translator: projectToolSession("translator", "running"),
      harnessEngineer: projectToolSession("harness-engineer", "resumable"),
      roleSessions: [roleSession("project-manager")]
    });

    await service.reconcileProject("/repo", { taskSlug: "demo-task" });

    expect(calls).not.toContain("resume:translator:demo-task");
    expect(calls).toContain("resume:harness-engineer:demo-task");
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
    expect(calls).toContain("resume:translator:demo-task");
    expect(calls).toContain("translation-listener:project-manager:demo-task");
  });

  it("waits for Auto Memory before starting the automatic task retrospective", async () => {
    const calls: string[] = [];
    const service = createCoordinator({
      calls,
      autoTaskHarnessReviewEnabled: true,
      roundStopped: true,
      memoryReadiness: { ready: false, disposition: "pending" }
    });

    await service.reconcileProject("/repo", { taskSlug: "demo-task" });

    expect(calls).not.toContain("task-retrospective");
    expect(calls).toContain("memory-reconcile:auto");
  });

  it("starts the automatic task retrospective after Auto Memory completes", async () => {
    const calls: string[] = [];
    const service = createCoordinator({
      calls,
      autoTaskHarnessReviewEnabled: true,
      roundStopped: true,
      memoryReadiness: { ready: true, disposition: "completed" }
    });

    await service.reconcileProject("/repo", { taskSlug: "demo-task" });

    expect(calls).toContain("task-retrospective");
  });

  it("continues a manually requested Task Harness Review after memory completes", async () => {
    const calls: string[] = [];
    const service = createCoordinator({
      calls,
      roundStopped: true,
      memoryReadiness: { ready: true, disposition: "completed", trigger: "manual" }
    });

    await service.reconcileProject("/repo", { taskSlug: "demo-task" });

    expect(calls).toContain("memory-reconcile:none");
    expect(calls).toContain("task-retrospective");
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
  autoTaskHarnessReviewEnabled?: boolean;
  roundStopped?: boolean;
  memoryReadiness?: {
    ready: boolean;
    disposition: "pending" | "completed";
    trigger?: "manual" | "auto";
  };
}) {
  let translator = input.translator;
  let harnessEngineer = input.harnessEngineer;
  let translationEnabled = input.translationEnabled ?? true;
  return createRuntimeCoordinatorService({
    projectService: {
      async getCurrentProject() {
        return { repoRoot: "/repo" } as never;
      }
    },
    appSettings: {
      async getPreferences() {
        return {
          themeMode: "system",
          flowPauseAlerts: true,
          roleRetryEnabled: true,
          permissionRequestMode: "off",
          autoTaskHarnessReviewEnabled: input.autoTaskHarnessReviewEnabled ?? false,
          autoMemoryEnabled: false,
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
      async getRoleSession(_repoRoot, _taskSlug, role) {
        return role === "translator"
          ? translator
          : role === "harness-engineer"
            ? harnessEngineer
            : undefined;
      },
      async startRoleSession(_repoRoot, taskSlug, role) {
        input.calls.push(`start:${role}:${taskSlug}`);
        if (role === "translator") {
          translator = { ...(translator ?? projectToolSession("translator", "running")), taskSlug, status: "running" };
          return translator;
        }
        harnessEngineer = { ...(harnessEngineer ?? projectToolSession("harness-engineer", "running")), taskSlug, status: "running" };
        return harnessEngineer;
      },
      async resumeRoleSession(_repoRoot, taskSlug, role) {
        input.calls.push(`resume:${role}:${taskSlug}`);
        if (role === "translator") {
          translator = { ...(translator ?? projectToolSession("translator", "running")), taskSlug, status: "running" };
          return translator;
        }
        harnessEngineer = { ...(harnessEngineer ?? projectToolSession("harness-engineer", "running")), taskSlug, status: "running" };
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
        input.calls.push("task-retrospective");
        return {} as never;
      }
    },
    autoMemoryService: {
      async reconcileTask(request) {
        input.calls.push(`memory-reconcile:${request.requestTrigger ?? "none"}`);
        return {
          version: 1,
          status: "idle",
          files: [],
          runs: [],
          warnings: []
        } as const;
      },
      async getTaskRetrospectiveReadiness() {
        return input.memoryReadiness ?? { ready: true, disposition: "disabled" };
      }
    },
    roundService: {
      async getSessionRoundState() {
        return {
          taskSlug: "demo-task",
          status: input.roundStopped ? "stopped" : "running",
          ...(input.roundStopped ? { roundId: "round-1" } : {}),
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
    turnReconciler: {
      async reconcileTask() {
        input.calls.push("turn-reconcile");
        return { status: "inactive" };
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
