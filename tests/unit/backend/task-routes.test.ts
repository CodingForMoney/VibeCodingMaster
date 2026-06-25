import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerTaskRoutes } from "../../../src/backend/api/task-routes.js";
import type { RoleName, RoleStatus } from "../../../src/shared/types/role.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";

describe("task routes", () => {
  it("stops task role sessions and moves project tool sessions before closing a task", async () => {
    const app = Fastify({ logger: false });
    const calls: string[] = [];
    const task = createTask({
      worktreePath: "/repo/.claude/worktrees/demo-task"
    });

    registerTaskRoutes(app, {
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
              defaultRoles: ["project-manager", "architect", "coder", "reviewer"],
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
        },
        async cleanupTask() {
          calls.push("cleanup");
          return {
            taskSlug: "demo-task",
            removedWorktreePath: task.worktreePath,
            removedStatePaths: [],
            deletedBranch: task.branch,
            cleanedAt: "2026-05-31T00:00:00.000Z"
          };
        }
      } as never,
      sessionService: {
        async listRoleSessions() {
          calls.push("list-sessions");
          return [
            createSession("architect", "running"),
            createSession("coder", "resumable"),
            createSession("reviewer", "running")
          ];
        },
        async stopRoleSession(_repoRoot: string, _taskSlug: string, role: RoleName) {
          calls.push(`stop:${role}`);
          return createSession(role, "exited");
        },
        async moveProjectTranslatorSessionToSafeCwd() {
          calls.push("move-safe:translator");
          return createSession("translator", "running");
        },
        async moveProjectHarnessEngineerSessionToSafeCwd() {
          calls.push("move-safe:harness-engineer");
          return createSession("harness-engineer", "running");
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
      translationService: {
        async stopTask(repoRoot: string, taskSlug: string, options) {
          calls.push(`translation:${repoRoot}:${taskSlug}:${String(options?.clearCache)}`);
        }
      },
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
    expect(calls).toEqual([
      "list-sessions",
      "stop:architect",
      "stop:reviewer",
      "move-safe:translator",
      "move-safe:harness-engineer",
      "translation:/repo/.claude/worktrees/demo-task:demo-task:true",
      "round:demo-task",
      "cleanup"
    ]);

    await app.close();
  });

  it("degrades task status when the backend hits the open-files limit", async () => {
    const app = Fastify({ logger: false });

    registerTaskRoutes(app, {
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
      sessionService: {
        async listRoleSessions() {
          return [];
        },
        async stopRoleSession() {
          throw new Error("not used");
        },
        async moveProjectTranslatorSessionToSafeCwd() {
          throw new Error("not used");
        },
        async moveProjectHarnessEngineerSessionToSafeCwd() {
          throw new Error("not used");
        }
      },
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
      translationService: {
        async stopTask() {
          throw new Error("not used");
        }
      },
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
      startedRoles: ["project-manager", "architect", "coder", "reviewer"] as RoleName[],
      sessions: [createSession("project-manager", "running")]
    };

    registerTaskRoutes(app, {
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
      sessionService: {} as never,
      statusService: {} as never,
      messageService: {} as never,
      translationService: {
        async stopTask() {
          throw new Error("not used");
        }
      },
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
      startedRoles: ["project-manager", "architect", "coder", "reviewer"]
    });
    expect(calls).toEqual([{ repoRoot: "/repo", taskSlug: "demo-task", requireFreshStart: true }]);
    await app.close();
  });

  it("returns aggregated task workspace state", async () => {
    const app = Fastify({ logger: false });
    const task = createTask();

    registerTaskRoutes(app, {
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
      sessionService: {
        async listRoleSessions() {
          return [];
        },
        async stopRoleSession() {
          throw new Error("not used");
        },
        async moveProjectTranslatorSessionToSafeCwd() {
          throw new Error("not used");
        },
        async moveProjectHarnessEngineerSessionToSafeCwd() {
          throw new Error("not used");
        }
      },
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
      translationService: {
        async stopTask() {
          throw new Error("not used");
        }
      },
      roundService: {
        async getSessionRoundState() {
          return {
            taskSlug: "demo-task",
            status: "running",
            turnCount: 1,
            completedTurnCount: 0,
            totalRoundCount: 1,
            totalTurnCount: 1,
            totalCompletedTurnCount: 0,
            totalCcActiveMs: 1000,
            currentRoundCcActiveMs: 1000,
            roles: ["architect"],
            updatedAt: "2026-05-31T00:00:00.000Z"
          };
        },
        stopTask() {}
      } as never
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
      roundState: { status: "running" }
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
