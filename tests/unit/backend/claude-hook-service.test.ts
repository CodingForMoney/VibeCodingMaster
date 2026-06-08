import { describe, expect, it } from "vitest";
import { createClaudeHookService } from "../../../src/backend/services/claude-hook-service.js";
import type { MessageService } from "../../../src/backend/services/message-service.js";
import type { ProjectService } from "../../../src/backend/services/project-service.js";
import type { SessionService } from "../../../src/backend/services/session-service.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";

describe("createClaudeHookService", () => {
  it("marks UserPromptSubmit activity running and confirms delivered VCM messages", async () => {
    const calls: string[] = [];
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async recordClaudeHookEvent(_repoRoot, input) {
          calls.push(`session:${input.eventName}:${input.role}:${input.claudeSessionId}`);
          return {
            id: "runtime_coder",
            claudeSessionId: "claude_coder",
            taskSlug: input.taskSlug,
            role: input.role,
            status: "running",
            activityStatus: "running",
            command: "claude --agent coder",
            permissionMode: "default",
            cwd: "/repo",
            terminalBackend: "node-pty",
            logPath: ".ai/vcm/handoffs/logs/coder.log",
            updatedAt: "2026-06-01T00:00:00.000Z"
          };
        }
      } as SessionService,
      messageService: {
        async confirmPromptSubmitted(input) {
          calls.push(`confirm:${input.taskSlug}:${input.role}:${input.prompt?.includes("msg_123")}`);
          return {
            id: "msg_123",
            taskSlug: input.taskSlug,
            fromRole: "project-manager",
            toRole: input.role,
            type: "task",
            body: "Do it.",
            artifactRefs: [],
            createdAt: "2026-06-01T00:00:00.000Z",
            deliveredAt: "2026-06-01T00:00:00.000Z",
            acceptedAt: "2026-06-01T00:00:01.000Z"
          };
        }
      } as MessageService
    });

    const result = await service.handleHook({
      taskSlug: "demo-task",
      role: "coder",
      event: {
        hook_event_name: "UserPromptSubmit",
        session_id: "claude_coder",
        prompt: "[VCM MESSAGE]\nid: msg_123\n[/VCM MESSAGE]"
      }
    });

    expect(result).toMatchObject({
      ok: true,
      eventName: "UserPromptSubmit",
      sessionUpdated: true,
      dispatchedCount: 0,
      acceptedMessageId: "msg_123"
    });
    expect(calls).toEqual([
      "session:UserPromptSubmit:coder:claude_coder",
      "confirm:demo-task:coder:true"
    ]);
  });

  it("marks Stop activity idle and scans pending route files", async () => {
    const calls: string[] = [];
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async recordClaudeHookEvent(_repoRoot, input) {
          calls.push(`session:${input.eventName}:${input.role}:${input.claudeSessionId}`);
          return {
            id: "runtime_coder",
            claudeSessionId: "claude_coder",
            taskSlug: input.taskSlug,
            role: input.role,
            status: "running",
            activityStatus: "idle",
            command: "claude --agent coder",
            permissionMode: "default",
            cwd: "/repo",
            terminalBackend: "node-pty",
            logPath: ".ai/vcm/handoffs/logs/coder.log",
            updatedAt: "2026-06-01T00:00:00.000Z"
          };
        }
      } as SessionService,
      messageService: {
        async scanAndDispatchPendingRouteFiles(input) {
          calls.push(`scan:${input.taskSlug}:${input.stoppedRole}:${input.handoffDir}:${input.stateRepoRoot}`);
          return [
            {
              delivered: true,
              requiresUserApproval: false,
              clearedRouteFile: true,
              message: {
                id: "msg_123",
                taskSlug: input.taskSlug,
                fromRole: "coder",
                toRole: "project-manager",
                type: "result",
                body: "Done.",
                artifactRefs: [],
                createdAt: "2026-06-01T00:00:00.000Z"
              }
            }
          ];
        }
      } as MessageService
    });

    const result = await service.handleStopHook({
      taskSlug: "demo-task",
      role: "coder",
      event: {
        hook_event_name: "Stop",
        session_id: "claude_coder",
        transcript_path: "/Users/sheldon/.claude/projects/demo/claude_coder.jsonl"
      }
    });

    expect(result).toMatchObject({
      ok: true,
      eventName: "Stop",
      sessionUpdated: true,
      dispatchedCount: 1
    });
    expect(calls).toEqual([
      "session:Stop:coder:claude_coder",
      "scan:demo-task:coder:.ai/vcm/handoffs:/repo"
    ]);
  });
});

function createProjectServiceStub(): ProjectService {
  return {
    async getCurrentProject() {
      return {
        repoRoot: "/repo",
        branch: "main",
        isDirty: false,
        config: {
          version: 1,
          repoRoot: "/repo",
          defaultRoles: ["project-manager", "architect", "coder", "reviewer"],
          handoffRoot: ".ai/vcm/handoffs",
          stateRoot: ".ai/vcm",
          terminalBackend: "node-pty",
          claudeCommand: "claude"
        },
        warnings: []
      };
    },
    async loadConfig() {
      return {
        version: 1,
        repoRoot: "/repo",
        defaultRoles: ["project-manager", "architect", "coder", "reviewer"],
        handoffRoot: ".ai/vcm/handoffs",
        stateRoot: ".ai/vcm",
        terminalBackend: "node-pty",
        claudeCommand: "claude"
      };
    },
    getProjectDataRoot() {
      return "/home/.vcm/projects/demo";
    },
    getConfigPath() {
      return "/home/.vcm/projects/demo/config.json";
    },
    async connectProject() {
      throw new Error("not used");
    },
    async getRecentRepositoryPaths() {
      return [];
    },
    async saveConfig() {
      throw new Error("not used");
    }
  };
}

function createTaskServiceStub() {
  return {
    async loadTask(): Promise<TaskRecord> {
      return {
        version: 1,
        taskSlug: "demo-task",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        repoRoot: "/repo",
        branch: "feature/demo-task",
        handoffDir: ".ai/vcm/handoffs",
        status: "running"
      };
    }
  } as never;
}
