import { describe, expect, it } from "vitest";
import { createTaskCloseService } from "../../../src/backend/services/task-close-service.js";
import type { CleanupTaskResult, TaskRecord } from "../../../src/shared/types/task.js";

const CLEANED_TASK: TaskRecord = {
  version: 1,
  taskSlug: "demo-task",
  title: "Demo task",
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T01:00:00.000Z",
  repoRoot: "/repo",
  worktreePath: "/repo/.claude/worktrees/demo-task",
  branch: "feature/demo-task",
  handoffDir: ".ai/vcm/handoffs",
  status: "stopped",
  cleanupStatus: "cleaned",
  cleanedAt: "2026-07-15T01:00:00.000Z"
};

describe("createTaskCloseService", () => {
  it("marks the task closed before best-effort cleanup and never blocks on cleanup failures", async () => {
    const calls: string[] = [];
    const service = createTaskCloseService({
      taskService: {
        async markTaskCleaned() {
          calls.push("mark-cleaned");
          return CLEANED_TASK;
        },
        async cleanupTask() {
          calls.push("cleanup-resources");
          return successfulCleanup({ warnings: ["worktree directory remained"] });
        }
      },
      sessionService: {
        async listRoleSessions() {
          calls.push("list-sessions");
          throw new Error("session registry unavailable");
        },
        async stopRoleSession() {
          throw new Error("not reached");
        }
      },
      translationService: {
        async stopTask() {
          calls.push("stop-translation");
          throw new Error("translation cleanup failed");
        }
      },
      roundService: {
        stopTask() {
          calls.push("stop-round");
          throw new Error("round cleanup failed");
        }
      }
    });

    const result = await service.closeTask("/repo", "demo-task");

    expect(result.taskClosed).toBe(true);
    expect(calls[0]).toBe("mark-cleaned");
    expect(calls.at(-1)).toBe("cleanup-resources");
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("session registry unavailable"),
      expect.stringContaining("translation cleanup failed"),
      expect.stringContaining("round cleanup failed"),
      "worktree directory remained"
    ]));
  });

  it("returns a successful logical close when physical resource cleanup throws", async () => {
    const service = createTaskCloseService({
      taskService: {
        async markTaskCleaned() {
          return CLEANED_TASK;
        },
        async cleanupTask() {
          throw new Error("filesystem unavailable");
        }
      },
      sessionService: emptyTaskSessions(),
      translationService: {
        async stopTask() {}
      },
      roundService: {
        stopTask() {}
      }
    });

    const result = await service.closeTask("/repo", "demo-task");

    expect(result).toMatchObject({
      taskSlug: "demo-task",
      taskClosed: true,
      worktreeRemoved: false,
      branchDeleted: false,
      stateRemoved: false
    });
    expect(result.warnings).toEqual([
      "Task was closed, but resource cleanup did not finish: filesystem unavailable"
    ]);
  });

  it("stops running workflow and tool sessions owned by the task", async () => {
    const stopped: string[] = [];
    const service = createTaskCloseService({
      taskService: {
        async markTaskCleaned() {
          return CLEANED_TASK;
        },
        async cleanupTask() {
          return successfulCleanup();
        }
      },
      sessionService: {
        async listRoleSessions() {
          return [
            { role: "project-manager", status: "running" },
            { role: "coder", status: "resumable" },
            { role: "translator", status: "running" },
            { role: "harness-engineer", status: "running" }
          ] as never;
        },
        async stopRoleSession(_repoRoot, _taskSlug, role) {
          stopped.push(role);
          return {} as never;
        }
      },
      translationService: {
        async stopTask() {}
      },
      roundService: {
        stopTask() {}
      }
    });

    await service.closeTask("/repo", "demo-task");

    expect(stopped).toEqual(["project-manager", "translator", "harness-engineer"]);
  });
});

function successfulCleanup(overrides: Partial<CleanupTaskResult> = {}): CleanupTaskResult {
  return {
    taskSlug: "demo-task",
    taskClosed: true,
    worktreeRemoved: true,
    branchDeleted: true,
    stateRemoved: true,
    removedWorktreePath: CLEANED_TASK.worktreePath,
    removedStatePaths: ["/state/demo-task.json"],
    deletedBranch: CLEANED_TASK.branch,
    cleanedAt: CLEANED_TASK.cleanedAt!,
    ...overrides
  };
}

function emptyTaskSessions() {
  return {
    async listRoleSessions() {
      return [];
    },
    async stopRoleSession() {
      throw new Error("not reached");
    }
  };
}
