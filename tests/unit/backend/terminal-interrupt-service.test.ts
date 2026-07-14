import { describe, expect, it } from "vitest";
import { createTerminalInterruptService } from "../../../src/backend/services/terminal-interrupt-service.js";
import type { TerminalRuntime, TerminalSession } from "../../../src/backend/runtime/terminal-runtime.js";

describe("createTerminalInterruptService", () => {
  it("marks a VCM role idle and interrupts the active round", async () => {
    const calls: string[] = [];
    const service = createTerminalInterruptService({
      runtime: createRuntime({
        id: "session_1",
        repoRoot: "/repo",
        taskSlug: "demo-task",
        role: "coder",
        status: "running",
        startedAt: "2026-06-27T00:00:00.000Z"
      }),
      projectService: {
        async getCurrentProject() {
          return null;
        },
        async loadConfig() {
          return { stateRoot: ".ai/vcm" };
        }
      } as never,
      taskService: {
        async loadTask() {
          return {
            taskSlug: "demo-task",
            worktreePath: "/repo/.claude/worktrees/demo-task"
          };
        }
      } as never,
      sessionService: {
        async markTerminalSessionActivityIdle(_repoRoot, sessionId) {
          calls.push(`idle:${sessionId}`);
          return undefined;
        }
      },
      roundService: {
        async recordManualInterrupt(input) {
          calls.push(`round:${input.taskSlug}:${input.role}:${input.stateRepoRoot}`);
          return {} as never;
        }
      }
    });

    await service.handleManualInterrupt("session_1");

    expect(calls).toEqual([
      "idle:session_1",
      "round:demo-task:coder:/repo/.claude/worktrees/demo-task"
    ]);
  });

  it("marks project tool sessions idle without touching the VCM round", async () => {
    const calls: string[] = [];
    const service = createTerminalInterruptService({
      runtime: createRuntime({
        id: "session_1",
        repoRoot: "/repo",
        taskSlug: "__project__",
        role: "translator",
        status: "running",
        startedAt: "2026-06-27T00:00:00.000Z"
      }),
      projectService: {
        async getCurrentProject() {
          return null;
        },
        async loadConfig() {
          throw new Error("should not load config");
        }
      } as never,
      taskService: {
        async loadTask() {
          throw new Error("should not load task");
        }
      } as never,
      sessionService: {
        async markTerminalSessionActivityIdle(_repoRoot, sessionId) {
          calls.push(`idle:${sessionId}`);
          return undefined;
        }
      },
      roundService: {
        async recordManualInterrupt() {
          throw new Error("should not interrupt round");
        }
      }
    });

    await service.handleManualInterrupt("session_1");

    expect(calls).toEqual(["idle:session_1"]);
  });
});

function createRuntime(session: TerminalSession): TerminalRuntime {
  return {
    async createSession() {
      return session;
    },
    getSession(sessionId) {
      return session.id === sessionId ? session : undefined;
    },
    getSessionByRole() {
      return undefined;
    },
    listSessions() {
      return [session];
    },
    write() {},
    resize() {},
    async stop() {},
    async restart() {
      return session;
    },
    subscribe() {
      return () => {};
    }
  };
}
