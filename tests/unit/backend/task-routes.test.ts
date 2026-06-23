import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerTaskRoutes } from "../../../src/backend/api/task-routes.js";
import type { RoleName, RoleStatus } from "../../../src/shared/types/role.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";

describe("task routes", () => {
  it("stops running role sessions before closing a task", async () => {
    const app = Fastify({ logger: false });
    const calls: string[] = [];
    const task = createTask({
      worktreePath: "/repo/.claude/worktrees/demo-task"
    });

    registerTaskRoutes(app, {
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
        async stopProjectTranslatorSession() {
          calls.push("stop:translator");
          return createSession("translator", "exited");
        },
        async stopProjectHarnessEngineerSession() {
          calls.push("stop:harness-engineer");
          return createSession("harness-engineer", "exited");
        }
      },
      statusService: {
        async getTaskStatus() {
          return {};
        }
      } as never,
      translationService: {
        async stopTask(repoRoot: string, taskSlug: string, options) {
          calls.push(`translation:${repoRoot}:${taskSlug}:${String(options?.clearCache)}`);
        }
      },
      roundService: {
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
      "stop:translator",
      "stop:harness-engineer",
      "translation:/repo/.claude/worktrees/demo-task:demo-task:true",
      "round:demo-task",
      "cleanup"
    ]);

    await app.close();
  });

  it("degrades task status when the backend hits the open-files limit", async () => {
    const app = Fastify({ logger: false });

    registerTaskRoutes(app, {
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
        async stopProjectTranslatorSession() {
          throw new Error("not used");
        },
        async stopProjectHarnessEngineerSession() {
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
      translationService: {
        async stopTask() {
          throw new Error("not used");
        }
      },
      roundService: {
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
});

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
