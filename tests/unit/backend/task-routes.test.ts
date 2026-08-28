import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerTaskRoutes } from "../../../src/backend/api/task-routes.js";
import type { RoleName, RoleStatus } from "../../../src/shared/types/role.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";

describe("task routes", () => {
  it("delegates task close to the backend close service", async () => {
    const app = Fastify({ logger: false });
    const calls: string[] = [];
    const task = createTask({
      worktreePath: "/repo/.claude/worktrees/demo-task"
    });

    registerTaskRoutes(app, {
      architectRestartService: notUsedArchitectRestartService(),
      roleStallDetector: notUsedRoleStallDetector(),
      taskLaunchService: notUsedTaskLaunchService(),
      projectService: {
        async getCurrentProject() {
          return {
            repoRoot: "/repo",
            branch: "main",
            isDirty: false,
            warnings: [],
            config: {
              version: 1,
              repoRoot: "/repo",
              defaultRoles: ["project-manager", "architect", "coder", "tester"],
              handoffRoot: ".ai/vcm/handoffs",
              stateRoot: ".ai/vcm",
              terminalBackend: "node-pty",
              claudeCommand: "claude"
            }
          };
        }
      } as never,
      taskService: {
        async listTasks() {
          return [];
        },
        async createTask() {
          return task;
        },
        async loadTask() {
          return task;
        }
      } as never,
      taskCloseService: {
        async closeTask() {
          calls.push("close");
          return {
            taskSlug: task.taskSlug,
            taskClosed: true as const,
            worktreeRemoved: true,
            branchDeleted: true,
            stateRemoved: true,
            removedWorktreePath: task.worktreePath,
            removedStatePaths: [],
            deletedBranch: task.branch,
            cleanedAt: "2026-05-31T00:00:00.000Z"
          };
        }
      },
      statusService: {
        async getTaskStatus() {
          return {};
        }
      } as never,
      messageService: {
        async listMessages() {
          return [];
        },
        async getOrchestrationState() {
          return {
            taskSlug: "demo-task",
            mode: "auto",
            updatedAt: "2026-05-31T00:00:00.000Z"
          };
        }
      } as never,
      roundService: {
        async getSessionRoundState() {
          throw new Error("not used");
        },
        stopTask(taskSlug: string) {
          calls.push(`round:${taskSlug}`);
        }
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/demo-task/cleanup",
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual(["close"]);

    await app.close();
  });

  it("degrades task status when the backend hits the open-files limit", async () => {
    const app = Fastify({ logger: false });

    registerTaskRoutes(app, {
      architectRestartService: notUsedArchitectRestartService(),
      roleStallDetector: notUsedRoleStallDetector(),
      taskLaunchService: notUsedTaskLaunchService(),
      projectService: {
        async getCurrentProject() {
          return {
            repoRoot: "/repo"
          };
        }
      } as never,
      taskService: {
        async listTasks() {
          return [];
        },
        async createTask() {
          return createTask();
        },
        async loadTask() {
          return createTask();
        },
        async cleanupTask() {
          throw new Error("not used");
        }
      } as never,
      taskCloseService: notUsedTaskCloseService(),
      statusService: {
        async getTaskStatus() {
          throw Object.assign(new Error("EMFILE: too many open files"), {
            code: "EMFILE"
          });
        }
      } as never,
      messageService: {
        async listMessages() {
          return [];
        },
        async getOrchestrationState() {
          return {
            taskSlug: "demo-task",
            mode: "auto",
            updatedAt: "2026-05-31T00:00:00.000Z"
          };
        }
      } as never,
      roundService: {
        async getSessionRoundState() {
          throw new Error("not used");
        },
        stopTask() {}
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/demo-task/status"
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.task.taskSlug).toBe("demo-task");
    expect(payload.sessions).toEqual([]);
    expect(payload.warnings[0]).toContain("open-files limit");
    await app.close();
  });

  it("one-click starts a task via the launch service with requireFreshStart", async () => {
    const app = Fastify({ logger: false });
    const calls: Array<{ repoRoot: string; taskSlug: string; requireFreshStart: boolean }> = [];
    const result = {
      taskSlug: "demo-task",
      orchestration: { taskSlug: "demo-task", mode: "auto" as const, updatedAt: "2026-05-31T00:00:00.000Z" },
      startedRoles: ["project-manager", "architect", "coder", "tester"] as RoleName[],
      sessions: [createSession("project-manager", "running")]
    };

    registerTaskRoutes(app, {
      architectRestartService: notUsedArchitectRestartService(),
      roleStallDetector: notUsedRoleStallDetector(),
      taskLaunchService: {
        async startTaskRoleSessions(repoRoot: string, input: { taskSlug: string; requireFreshStart: boolean }) {
          calls.push({ repoRoot, ...input });
          return result;
        }
      },
      projectService: {
        async getCurrentProject() {
          return { repoRoot: "/repo" };
        }
      } as never,
      taskService: {} as never,
      taskCloseService: notUsedTaskCloseService(),
      statusService: {} as never,
      messageService: {} as never,
      roundService: {
        async getSessionRoundState() {
          throw new Error("not used");
        },
        stopTask() {}
      } as never
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/demo-task/one-click-start",
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      taskSlug: "demo-task",
      orchestration: { mode: "auto" },
      startedRoles: ["project-manager", "architect", "coder", "tester"]
    });
    expect(calls).toEqual([{ repoRoot: "/repo", taskSlug: "demo-task", requireFreshStart: true }]);
    await app.close();
  });

  it("returns aggregated task workspace state", async () => {
    const app = Fastify({ logger: false });
    const task = createTask();
    let declaredWorkflow: Record<string, unknown> | undefined;
    let translationPending = true;

    registerTaskRoutes(app, {
      architectRestartService: {
        getState() {
          return {
            taskSlug: "demo-task",
            sessionId: "runtime-architect",
            status: "pending" as const
          };
        }
      },
      roleStallDetector: notUsedRoleStallDetector(),
      taskLaunchService: notUsedTaskLaunchService(),
      projectService: {
        async getCurrentProject() {
          return {
            repoRoot: "/repo"
          };
        },
        async loadConfig() {
          return {
            stateRoot: ".ai/vcm"
          };
        }
      } as never,
      taskService: {
        async listTasks() {
          return [];
        },
        async createTask() {
          return task;
        },
        async loadTask() {
          return task;
        },
        async cleanupTask() {
          throw new Error("not used");
        }
      } as never,
      taskCloseService: notUsedTaskCloseService(),
      statusService: {
        async getTaskStatus() {
          return {
            task,
            sessions: [createSession("architect", "running")],
            artifacts: { checks: [], paths: {} },
            warnings: []
          };
        }
      } as never,
      messageService: {
        async listMessages() {
          return [{
            id: "msg-1",
            taskSlug: "demo-task",
            fromRole: "project-manager",
            toRole: "architect",
            type: "task",
            body: "hello",
            artifactRefs: [],
            createdAt: "2026-05-31T00:00:00.000Z"
          }];
        },
        async getOrchestrationState() {
          return {
            taskSlug: "demo-task",
            mode: "auto",
            updatedAt: "2026-05-31T00:00:00.000Z"
          };
        }
      } as never,
      roundService: {
        async getSessionRoundState() {
          return {
            taskSlug: "demo-task",
            status: "stopped",
            roundId: "round-1",
            activeRole: "project-manager",
            lastTurnStartedAt: "2026-05-31T00:00:00.000Z",
            stoppedAt: "2026-05-31T00:00:01.000Z",
            turnCount: 1,
            completedTurnCount: 1,
            totalRoundCount: 1,
            totalTurnCount: 1,
            totalCompletedTurnCount: 1,
            totalCcActiveMs: 1000,
            currentRoundCcActiveMs: 1000,
            roles: ["project-manager"],
            flowPause: {
              paused: true,
              reason: "stopped-no-next-turn",
              role: "project-manager"
            },
            updatedAt: "2026-05-31T00:00:01.000Z"
          };
        },
        stopTask() {}
      } as never,
      translationService: {
        async shouldDelayFlowPauseNotification() {
          return translationPending;
        }
      },
      taskWorkflowService: {
        async getState() {
          return {
            version: 1 as const,
            taskSlug: "demo-task",
            revision: 2,
            declared: {
              flow: "code-change",
              step: "architect-planning",
              evidenceRefs: [],
              updatedBy: "project-manager" as const,
              updatedAt: "2026-05-31T00:00:00.000Z"
            },
            lastDispatch: null,
            warnings: [],
            updatedAt: "2026-05-31T00:00:00.000Z"
          };
        },
        async declare(_input, declaration) {
          declaredWorkflow = declaration;
          return {
            version: 1 as const,
            taskSlug: "demo-task",
            revision: 3,
            declared: {
              flow: "code-change",
              step: typeof declaration.step === "string" ? declaration.step : undefined,
              evidenceRefs: [],
              updatedBy: "project-manager" as const,
              updatedAt: "2026-05-31T00:00:00.000Z"
            },
            lastDispatch: null,
            warnings: [],
            updatedAt: "2026-05-31T00:00:00.000Z"
          };
        }
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/demo-task/workspace-state"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      taskStatus: {
        task: { taskSlug: "demo-task" },
        sessions: [{ role: "architect", status: "running" }]
      },
      messages: [{ id: "msg-1" }],
      orchestration: { mode: "auto" },
      roundState: { status: "stopped" },
      workflowState: {
        declared: { flow: "code-change", step: "architect-planning" }
      },
      architectRestart: {
        sessionId: "runtime-architect",
        status: "pending"
      }
    });
    expect(response.json().roundState).not.toHaveProperty("flowPause");

    translationPending = false;
    const releasedResponse = await app.inject({
      method: "GET",
      url: "/api/tasks/demo-task/workspace-state"
    });
    expect(releasedResponse.statusCode).toBe(200);
    expect(releasedResponse.json().roundState.flowPause).toMatchObject({
      paused: true,
      reason: "stopped-no-next-turn",
      role: "project-manager"
    });

    const updateResponse = await app.inject({
      method: "POST",
      url: "/api/tasks/demo-task/workflow-state",
      payload: { step: "awaiting-user", status: "awaiting-user" }
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(declaredWorkflow).toEqual({ step: "awaiting-user", status: "awaiting-user" });
    expect(updateResponse.json()).toMatchObject({
      declared: { step: "awaiting-user" }
    });
    await app.close();
  });
});

function notUsedTaskLaunchService() {
  return {
    async startTaskRoleSessions() {
      throw new Error("not used");
    }
  };
}

function notUsedArchitectRestartService() {
  return {
    getState() {
      return null;
    }
  };
}

function notUsedRoleStallDetector() {
  return {
    getWarning() {
      return null;
    },
    ignoreWarning() {
      throw new Error("not used");
    },
    async recoverWarning() {
      throw new Error("not used");
    }
  };
}

function notUsedTaskCloseService() {
  return {
    async closeTask() {
      throw new Error("not used");
    }
  };
}

function createTask(input: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    taskSlug: "demo-task",
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
    repoRoot: "/repo",
    worktreePath: "/repo/.claude/worktrees/demo-task",
    branch: "feature/demo-task",
    handoffDir: ".ai/vcm/handoffs",
    status: "running",
    cleanupStatus: "active",
    ...input
  };
}

function createSession(role: RoleName, status: RoleStatus): RoleSessionRecord {
  return {
    id: `runtime-${role}`,
    claudeSessionId: `claude-${role}`,
    transcriptPath: `/transcripts/${role}.jsonl`,
    taskSlug: "demo-task",
    role,
    status,
    command: `claude --agent ${role}`,
    permissionMode: "default",
    cwd: "/repo/.claude/worktrees/demo-task",
    terminalBackend: "node-pty",
    pid: status === "running" ? 123 : undefined,
    updatedAt: "2026-05-31T00:00:00.000Z",
    exitCode: null
  };
}
