import { describe, expect, it } from "vitest";
import { createRuntimeCoordinatorService } from "../../../src/backend/services/runtime-coordinator-service.js";
import {
  createDefaultLaunchTemplate,
  createDefaultToolSessionDefaults,
  type RoleLaunchTemplateEntry
} from "../../../src/shared/types/app-settings.js";
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
  it("creates fresh task tool sessions when no session exists", async () => {
    const calls: string[] = [];
    const launches: ToolLaunchCall[] = [];
    const service = createCoordinator({
      calls,
      launches,
      translator: undefined,
      harnessEngineer: undefined,
      translationEnabled: true,
      toolLaunchOptions: {
        translator: {
          permissionMode: "plan",
          model: "sonnet",
          effort: "high"
        },
        "harness-engineer": {
          permissionMode: "default",
          model: "fable",
          effort: "xhigh"
        }
      }
    });

    await service.reconcileProject("/repo", { taskSlug: "demo-task" });

    expect(calls).toContain("start:translator:demo-task");
    expect(calls).toContain("start:harness-engineer:demo-task");
    expect(launches).toEqual(expect.arrayContaining([
      {
        operation: "start",
        role: "translator",
        options: {
          permissionMode: "plan",
          model: "sonnet",
          effort: "high"
        }
      },
      {
        operation: "start",
        role: "harness-engineer",
        options: {
          permissionMode: "default",
          model: "fable",
          effort: "xhigh"
        }
      }
    ]));
  });

  it("runs full task tool reconciliation when the backend coordinator starts", async () => {
    const calls: string[] = [];
    const service = createCoordinator({
      calls,
      translator: undefined,
      harnessEngineer: undefined,
      translationEnabled: true
    });

    service.start();
    await waitForCall(calls, "start:translator:demo-task");
    await waitForCall(calls, "start:harness-engineer:demo-task");
    service.stop();
  });

  it("resumes existing task tool sessions and starts conversation translation listeners", async () => {
    const calls: string[] = [];
    const launches: ToolLaunchCall[] = [];
    const service = createCoordinator({
      calls,
      launches,
      translator: projectToolSession("translator", "running"),
      harnessEngineer: projectToolSession("harness-engineer", "resumable"),
      roleSessions: [roleSession("project-manager")],
      toolLaunchOptions: {
        "harness-engineer": {
          permissionMode: "plan",
          model: "fable",
          effort: "xhigh"
        }
      }
    });

    await service.reconcileProject("/repo", { taskSlug: "demo-task" });

    expect(calls).not.toContain("resume:translator:demo-task");
    expect(calls).toContain("resume:harness-engineer:demo-task");
    expect(calls).toContain("translation-listener:project-manager:demo-task");
    expect(launches).toContainEqual({
      operation: "resume",
      role: "harness-engineer",
      options: {
        permissionMode: "bypassPermissions",
        model: "default",
        effort: "default"
      }
    });
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

  it("starts the automatic task retrospective after Auto Memory proposals are ready", async () => {
    const calls: string[] = [];
    const service = createCoordinator({
      calls,
      autoTaskHarnessReviewEnabled: true,
      roundStopped: true,
      memoryReadiness: { ready: true, disposition: "reviewing" }
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
  launches?: ToolLaunchCall[];
  translator?: RoleSessionRecord;
  harnessEngineer?: RoleSessionRecord;
  roleSessions?: RoleSessionRecord[];
  translationEnabled?: boolean;
  gatewayEnablesTranslationRuntime?: boolean;
  harnessInitialized?: boolean;
  autoTaskHarnessReviewEnabled?: boolean;
  roundStopped?: boolean;
  toolLaunchOptions?: Partial<Record<"translator" | "harness-engineer", RoleLaunchTemplateEntry>>;
  memoryReadiness?: {
    ready: boolean;
    disposition: "pending" | "completed";
    trigger?: "manual" | "auto";
  };
}) {
  let translator = input.translator;
  let harnessEngineer = input.harnessEngineer;
  let translationEnabled = input.translationEnabled ?? true;
  const toolSessionDefaults = createDefaultToolSessionDefaults();
  for (const [role, options] of Object.entries(input.toolLaunchOptions ?? {})) {
    toolSessionDefaults[role as "translator" | "harness-engineer"] = options;
  }
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
          launchTemplate: createDefaultLaunchTemplate(),
          toolSessionDefaults
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
      async startRoleSession(_repoRoot, taskSlug, role, options) {
        input.calls.push(`start:${role}:${taskSlug}`);
        if (role === "translator" || role === "harness-engineer") {
          input.launches?.push({ operation: "start", role, options: pickLaunchOptions(options) });
        }
        if (role === "translator") {
          translator = { ...(translator ?? projectToolSession("translator", "running")), taskSlug, status: "running" };
          return translator;
        }
        harnessEngineer = { ...(harnessEngineer ?? projectToolSession("harness-engineer", "running")), taskSlug, status: "running" };
        return harnessEngineer;
      },
      async resumeRoleSession(_repoRoot, taskSlug, role, options) {
        input.calls.push(`resume:${role}:${taskSlug}`);
        if (role === "translator" || role === "harness-engineer") {
          input.launches?.push({ operation: "resume", role, options: pickLaunchOptions(options) });
        }
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
      async completeWaitingTaskRetrospective() {
        return false;
      },
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
    setInterval() {
      return "runtime-coordinator-timer";
    },
    clearInterval() {},
    async getStateRoot() {
      return ".ai/vcm";
    }
  });
}

interface ToolLaunchCall {
  operation: "start" | "resume";
  role: "translator" | "harness-engineer";
  options: RoleLaunchTemplateEntry;
}

function pickLaunchOptions(input: {
  permissionMode?: RoleLaunchTemplateEntry["permissionMode"];
  model?: RoleLaunchTemplateEntry["model"];
  effort?: RoleLaunchTemplateEntry["effort"];
}): RoleLaunchTemplateEntry {
  return {
    permissionMode: input.permissionMode ?? "default",
    model: input.model ?? "default",
    effort: input.effort ?? "default"
  };
}

async function waitForCall(calls: string[], expected: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (calls.includes(expected)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${expected}. Calls: ${calls.join(", ")}`);
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
