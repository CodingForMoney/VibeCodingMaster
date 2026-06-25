import { describe, expect, it } from "vitest";
import { createTaskLaunchService, type TaskLaunchServiceDeps, type OneClickStartPartialFailure } from "../../../src/backend/services/task-launch-service.js";
import { VcmError } from "../../../src/backend/errors.js";
import { createDefaultLaunchTemplate } from "../../../src/shared/types/app-settings.js";
import type { RoleName, RoleStatus } from "../../../src/shared/types/role.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";

const REPO_ROOT = "/repo";
const TASK_SLUG = "demo-task";
const WORKTREE = "/repo/.claude/worktrees/demo-task";
const NOW = "2026-06-25T00:00:00.000Z";
const CORE_ROLES: RoleName[] = ["project-manager", "architect", "coder", "reviewer"];

describe("task-launch-service", () => {
  it("starts the full roster, sets the orchestration mode, and returns sessions", async () => {
    const events: string[] = [];
    const service = createTaskLaunchService(createDeps({ events }));

    const result = await service.startTaskRoleSessions(REPO_ROOT, {
      taskSlug: TASK_SLUG,
      requireFreshStart: true
    });

    expect(result.taskSlug).toBe(TASK_SLUG);
    expect(result.orchestration).toMatchObject({ taskSlug: TASK_SLUG, mode: "auto" });
    expect(result.startedRoles).toEqual(CORE_ROLES);
    expect(result.sessions.map((session) => session.role)).toEqual(CORE_ROLES);
    expect(events).toEqual([
      "mode:auto",
      "start:project-manager",
      "start:architect",
      "start:coder",
      "start:reviewer"
    ]);
  });

  it("includes gate-reviewer when gate review is enabled", async () => {
    const service = createTaskLaunchService(createDeps({ gateReviewEnabled: true }));

    const result = await service.startTaskRoleSessions(REPO_ROOT, {
      taskSlug: TASK_SLUG,
      requireFreshStart: true
    });

    expect(result.startedRoles).toEqual([...CORE_ROLES, "gate-reviewer"]);
  });

  it("sets manual mode when the launch template disables auto orchestration", async () => {
    const template = createDefaultLaunchTemplate();
    template.autoOrchestration = false;
    const service = createTaskLaunchService(createDeps({ launchTemplate: template }));

    const result = await service.startTaskRoleSessions(REPO_ROOT, {
      taskSlug: TASK_SLUG,
      requireFreshStart: true
    });

    expect(result.orchestration.mode).toBe("manual");
  });

  it("rejects with a 409 precondition when requireFreshStart and a role session exists", async () => {
    const service = createTaskLaunchService(createDeps({
      existingSessions: [createSession("architect", "running")]
    }));

    await expect(service.startTaskRoleSessions(REPO_ROOT, {
      taskSlug: TASK_SLUG,
      requireFreshStart: true
    })).rejects.toMatchObject({
      code: "TASK_ONE_CLICK_REQUIRES_FRESH_START",
      statusCode: 409
    });
  });

  it("tolerates existing sessions when requireFreshStart is false (gateway path)", async () => {
    const service = createTaskLaunchService(createDeps({
      existingSessions: [createSession("project-manager", "running")]
    }));

    const result = await service.startTaskRoleSessions(REPO_ROOT, {
      taskSlug: TASK_SLUG,
      requireFreshStart: false
    });

    expect(result.startedRoles).toEqual(CORE_ROLES);
  });

  it("skips a running role and resumes a role that has a prior claude session", async () => {
    const events: string[] = [];
    const service = createTaskLaunchService(createDeps({
      events,
      existing: {
        "project-manager": createSession("project-manager", "running"),
        architect: { ...createSession("architect", "exited"), claudeSessionId: "claude-architect" }
      }
    }));

    const result = await service.startTaskRoleSessions(REPO_ROOT, {
      taskSlug: TASK_SLUG,
      requireFreshStart: false
    });

    expect(result.startedRoles).toEqual(CORE_ROLES);
    expect(events).toEqual([
      "mode:auto",
      "resume:architect",
      "start:coder",
      "start:reviewer"
    ]);
  });

  it("throws TASK_ONE_CLICK_PARTIAL_START with started + failed roles on a per-role failure", async () => {
    const service = createTaskLaunchService(createDeps({ failOnRole: "coder" }));

    let thrown: unknown;
    try {
      await service.startTaskRoleSessions(REPO_ROOT, { taskSlug: TASK_SLUG, requireFreshStart: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(VcmError);
    const error = thrown as VcmError;
    expect(error.code).toBe("TASK_ONE_CLICK_PARTIAL_START");
    expect(error.statusCode).toBe(409);
    expect(error.message).toBe("coder failed to start.");
    const details = error.details as OneClickStartPartialFailure;
    expect(details.failedRole).toBe("coder");
    expect(details.startedRoles).toEqual(["project-manager", "architect"]);
  });
});

interface DepsOptions {
  events?: string[];
  gateReviewEnabled?: boolean;
  launchTemplate?: ReturnType<typeof createDefaultLaunchTemplate>;
  existingSessions?: RoleSessionRecord[];
  existing?: Partial<Record<RoleName, RoleSessionRecord>>;
  failOnRole?: RoleName;
}

function createDeps(options: DepsOptions = {}): TaskLaunchServiceDeps {
  const events = options.events ?? [];
  const template = options.launchTemplate ?? createDefaultLaunchTemplate();
  const existing = options.existing ?? {};
  const startedSessions: RoleSessionRecord[] = [];

  return {
    projectService: {
      async loadConfig() {
        return { stateRoot: ".ai/vcm" } as never;
      }
    },
    taskService: {
      async loadTask() {
        return createTaskRecord();
      }
    },
    appSettings: {
      async getPreferences() {
        return { launchTemplate: template } as never;
      },
      async getGateReviewSettings() {
        return { enabled: Boolean(options.gateReviewEnabled), requiredGates: [] } as never;
      }
    },
    sessionService: {
      async getRoleSession(_repoRoot: string, _taskSlug: string, role: RoleName) {
        return existing[role];
      },
      async listRoleSessions() {
        return [...(options.existingSessions ?? []), ...startedSessions];
      },
      async startRoleSession(_repoRoot: string, _taskSlug: string, role: RoleName) {
        if (options.failOnRole === role) {
          throw new Error(`boom:${role}`);
        }
        events.push(`start:${role}`);
        const session = createSession(role, "running");
        startedSessions.push(session);
        return session;
      },
      async resumeRoleSession(_repoRoot: string, _taskSlug: string, role: RoleName) {
        if (options.failOnRole === role) {
          throw new Error(`boom:${role}`);
        }
        events.push(`resume:${role}`);
        const session = createSession(role, "running");
        startedSessions.push(session);
        return session;
      }
    } as never,
    messageService: {
      async updateOrchestrationState(input: { taskSlug: string; mode?: "auto" | "manual" }) {
        events.push(`mode:${input.mode}`);
        return { taskSlug: input.taskSlug, mode: input.mode ?? "auto", updatedAt: NOW };
      }
    } as never
  };
}

function createTaskRecord(): TaskRecord {
  return {
    version: 1,
    taskSlug: TASK_SLUG,
    createdAt: NOW,
    updatedAt: NOW,
    repoRoot: REPO_ROOT,
    worktreePath: WORKTREE,
    branch: "feature/demo-task",
    handoffDir: ".ai/vcm/handoffs",
    status: "created"
  };
}

function createSession(role: RoleName, status: RoleStatus): RoleSessionRecord {
  return {
    id: `runtime-${role}`,
    taskSlug: TASK_SLUG,
    role,
    status,
    command: `claude --agent ${role}`,
    permissionMode: "default",
    cwd: WORKTREE,
    terminalBackend: "node-pty",
    updatedAt: NOW,
    exitCode: null
  };
}
