import { describe, expect, it } from "vitest";
import { createClaudeHookService } from "../../../src/backend/services/claude-hook-service.js";
import type { MessageService } from "../../../src/backend/services/message-service.js";
import type { ProjectService } from "../../../src/backend/services/project-service.js";
import type { RoundService, RoundSettleGuard } from "../../../src/backend/services/round-service.js";
import type { SessionService } from "../../../src/backend/services/session-service.js";
import type { TranslationService } from "../../../src/backend/services/translation-service.js";
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
      } as MessageService,
      roundService: {
        async recordClaudeHookEvent(input) {
          calls.push(`round:${input.eventName}:${input.role}`);
          return {} as never;
        }
      } as RoundService,
      translationService: {
        async recordConversationBoundary(input) {
          calls.push(`boundary:${input.boundaryKind}:${input.role}:${input.sessionId}`);
          return undefined;
        }
      } as Pick<TranslationService, "recordConversationBoundary">,
      appSettings: createAppSettingsStub()
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
      "round:UserPromptSubmit:coder",
      "boundary:start:coder:runtime_coder",
      "confirm:demo-task:coder:true"
    ]);
  });

  it("marks Stop activity idle and scans pending route files", async () => {
    const calls: string[] = [];
    let capturedSettleGuard: RoundSettleGuard | undefined;
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
        async listPendingRouteFiles(input) {
          calls.push(`list:${input.taskSlug}:${input.handoffDir}:${input.stateRepoRoot}`);
          return [
            {
              path: ".ai/vcm/handoffs/messages/coder-project-manager.md",
              fromRole: "coder",
              toRole: "project-manager",
              type: "result",
              body: "Done.",
              artifactRefs: [],
              exists: true,
              pending: true
            }
          ];
        },
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
      } as MessageService,
      roundService: {
        async recordClaudeHookEvent(input) {
          calls.push(`round:${input.eventName}:${input.role}`);
          capturedSettleGuard = input.settleGuard;
          return {} as never;
        }
      } as RoundService,
      translationService: {
        async recordConversationBoundary(input) {
          calls.push(`boundary:${input.boundaryKind}:${input.role}:${input.sessionId}`);
          return undefined;
        }
      } as Pick<TranslationService, "recordConversationBoundary">,
      appSettings: createAppSettingsStub("allowAll")
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
      "round:Stop:coder",
      "boundary:end:coder:runtime_coder",
      "scan:demo-task:coder:.ai/vcm/handoffs:/repo"
    ]);

    calls.length = 0;
    const settleDecision = await capturedSettleGuard?.({
      stateRepoRoot: "/repo",
      stateRoot: ".ai/vcm",
      taskSlug: "demo-task",
      role: "coder",
      roundId: "round_1",
      settleDeadlineAt: "2026-06-01T00:00:10.000Z"
    });
    expect(settleDecision).toMatchObject({ action: "continue" });
    expect(calls).toEqual([
      "list:demo-task:.ai/vcm/handoffs:/repo",
      "scan:demo-task:undefined:.ai/vcm/handoffs:/repo"
    ]);
  });

  it("allows Claude Code PermissionRequest hooks when the setting is allow all", async () => {
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {} as SessionService,
      messageService: {} as MessageService,
      roundService: {} as RoundService,
      translationService: {} as Pick<TranslationService, "recordConversationBoundary">,
      appSettings: createAppSettingsStub("allowAll")
    });

    await expect(service.handlePermissionRequestHook({
      taskSlug: "demo-task",
      role: "coder",
      event: {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: {
          command: "npm test"
        }
      }
    })).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow"
        }
      }
    });
  });

  it("leaves Claude Code PermissionRequest hooks untouched when the setting is off", async () => {
    const service = createClaudeHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {} as SessionService,
      messageService: {} as MessageService,
      roundService: {} as RoundService,
      translationService: {} as Pick<TranslationService, "recordConversationBoundary">,
      appSettings: createAppSettingsStub("off")
    });

    await expect(service.handlePermissionRequestHook({
      taskSlug: "demo-task",
      role: "coder",
      event: {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: {
          command: "npm test"
        }
      }
    })).resolves.toBeUndefined();
  });
});

function createAppSettingsStub(permissionRequestMode: "off" | "allowAll" = "off") {
  return {
    async getPreferences() {
      return {
        themeMode: "system",
        flowPauseAlerts: true,
        permissionRequestMode
      };
    }
  };
}

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
