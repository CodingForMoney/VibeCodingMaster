import { describe, expect, it } from "vitest";
import type { DispatchableRole } from "../../../src/shared/types/role.js";
import type { TerminalRuntime } from "../../../src/backend/runtime/terminal-runtime.js";
import { createCommandDispatcher } from "../../../src/backend/services/command-dispatcher.js";

describe("createCommandDispatcher", () => {
  it("writes only a short role-command instruction to runtime", async () => {
    const writes: string[] = [];
    const runtime = {
      write(_sessionId: string, data: string) {
        writes.push(data);
      }
    } as TerminalRuntime;
    const dispatcher = createCommandDispatcher({
      runtime,
      sessionService: {
        getRoleSession() {
          return {
            id: "session_architect",
            taskSlug: "demo-task",
            role: "architect",
            status: "running",
            command: "claude --agent architect",
            permissionMode: "default",
            cwd: "/repo",
            terminalBackend: "node-pty",
            logPath: ".ai/handoffs/demo-task/logs/architect.log",
            updatedAt: "2026-05-29T00:00:00.000Z"
          };
        }
      } as never,
      taskService: {
        async loadTask() {
          return {
            version: 1,
            taskSlug: "demo-task",
            createdAt: "2026-05-29T00:00:00.000Z",
            updatedAt: "2026-05-29T00:00:00.000Z",
            repoRoot: "/repo",
            branch: "feature",
            handoffDir: ".ai/handoffs/demo-task",
            status: "created"
          };
        }
      } as never,
      artifactService: {
        async readRoleCommand() {
          return "# long command body";
        },
        async resolveRoleCommandPath() {
          return ".ai/handoffs/demo-task/role-commands/architect.md";
        }
      } as never
    });

    const result = await dispatcher.dispatchRoleCommand({
      repoRoot: "/repo",
      taskSlug: "demo-task",
      role: "architect" as DispatchableRole
    });

    expect(result.instruction).toBe("Please read and execute the role command at: .ai/handoffs/demo-task/role-commands/architect.md");
    expect(writes).toEqual([`${result.instruction}\r`]);
    expect(writes[0]).not.toContain("long command body");
  });
});
