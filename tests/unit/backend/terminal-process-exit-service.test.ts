import { describe, expect, it } from "vitest";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import type {
  TerminalProcessExitEvent,
  TerminalProcessExitListener
} from "../../../src/backend/runtime/terminal-runtime.js";
import { createTerminalProcessExitService } from "../../../src/backend/services/terminal-process-exit-service.js";

describe("terminal-process-exit-service", () => {
  it("stops the active workflow-role round after a real terminal process exit", async () => {
    const roundInputs: unknown[] = [];
    const record = createRoleSession("coder", "running");
    const service = createTerminalProcessExitService({
      runtime: {
        subscribeProcessExits() {
          return () => {};
        }
      },
      projectService: {
        async loadConfig() {
          return {
            version: 1,
            repoRoot: "/repo",
            defaultRoles: ["project-manager", "architect", "coder", "tester"],
            handoffRoot: ".ai/vcm/handoffs",
            stateRoot: ".ai/vcm",
            terminalBackend: "node-pty",
            claudeCommand: "claude"
          };
        }
      },
      taskService: {
        async loadTask() {
          return {
            version: 1,
            taskSlug: "demo-task",
            createdAt: "2026-07-25T00:00:00.000Z",
            updatedAt: "2026-07-25T00:00:00.000Z",
            repoRoot: "/repo",
            worktreePath: "/repo/.claude/worktrees/demo-task",
            branch: "task/demo-task",
            handoffDir: ".ai/vcm/handoffs",
            status: "running"
          };
        }
      },
      sessionService: {
        async recordTerminalProcessExit() {
          return { record, turnWasRunning: true };
        }
      },
      roundService: {
        async recordTerminalExit(input) {
          roundInputs.push(input);
          return {} as never;
        }
      }
    });

    await service.handleProcessExit(createExitEvent("coder"));

    expect(roundInputs).toEqual([{
      repoRoot: "/repo",
      stateRepoRoot: "/repo/.claude/worktrees/demo-task",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "coder"
    }]);
  });

  it("does not mutate Round state for an idle turn or a tool role", async () => {
    const roundInputs: unknown[] = [];
    const records = [
      { record: createRoleSession("coder", "idle"), turnWasRunning: false },
      { record: createRoleSession("translator", "running"), turnWasRunning: true }
    ];
    const service = createTerminalProcessExitService({
      runtime: {
        subscribeProcessExits() {
          return () => {};
        }
      },
      projectService: {
        async loadConfig() {
          throw new Error("project config must not be loaded");
        }
      },
      taskService: {
        async loadTask() {
          throw new Error("task must not be loaded");
        }
      },
      sessionService: {
        async recordTerminalProcessExit() {
          return records.shift();
        }
      },
      roundService: {
        async recordTerminalExit(input) {
          roundInputs.push(input);
          return {} as never;
        }
      }
    });

    await service.handleProcessExit(createExitEvent("coder"));
    await service.handleProcessExit(createExitEvent("translator"));

    expect(roundInputs).toEqual([]);
  });

  it("subscribes and unsubscribes exactly once", () => {
    let listener: TerminalProcessExitListener | undefined;
    let subscribeCount = 0;
    let unsubscribeCount = 0;
    const service = createTerminalProcessExitService({
      runtime: {
        subscribeProcessExits(next) {
          subscribeCount += 1;
          listener = next;
          return () => {
            unsubscribeCount += 1;
            listener = undefined;
          };
        }
      },
      projectService: {
        async loadConfig() {
          throw new Error("unused");
        }
      },
      taskService: {
        async loadTask() {
          throw new Error("unused");
        }
      },
      sessionService: {
        async recordTerminalProcessExit() {
          return undefined;
        }
      },
      roundService: {
        async recordTerminalExit() {
          return {} as never;
        }
      }
    });

    service.start();
    service.start();
    expect(subscribeCount).toBe(1);
    expect(listener).toBeDefined();

    service.stop();
    service.stop();
    expect(unsubscribeCount).toBe(1);
    expect(listener).toBeUndefined();
  });
});

function createRoleSession(
  role: RoleSessionRecord["role"],
  activityStatus: NonNullable<RoleSessionRecord["activityStatus"]>
): RoleSessionRecord {
  return {
    id: `terminal-${role}`,
    claudeSessionId: `claude-${role}`,
    taskSlug: "demo-task",
    role,
    status: "crashed",
    activityStatus,
    command: "claude",
    permissionMode: "bypassPermissions",
    cwd: "/repo/.claude/worktrees/demo-task",
    terminalBackend: "node-pty",
    updatedAt: "2026-07-25T00:00:00.000Z",
    exitCode: 1
  };
}

function createExitEvent(role: RoleSessionRecord["role"]): TerminalProcessExitEvent {
  return {
    session: {
      id: `terminal-${role}`,
      repoRoot: "/repo",
      taskSlug: "demo-task",
      role,
      status: "crashed",
      startedAt: "2026-07-25T00:00:00.000Z",
      exitCode: 1
    },
    exitCode: 1
  };
}
