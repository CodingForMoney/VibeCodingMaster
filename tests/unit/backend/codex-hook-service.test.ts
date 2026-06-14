import { describe, expect, it } from "vitest";
import { createCodexHookService } from "../../../src/backend/services/codex-hook-service.js";
import type { ProjectService } from "../../../src/backend/services/project-service.js";
import type { RoundService } from "../../../src/backend/services/round-service.js";
import type { SessionService } from "../../../src/backend/services/session-service.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";

describe("createCodexHookService", () => {
  it("records Codex Reviewer UserPromptSubmit in session and round state", async () => {
    const calls: string[] = [];
    const service = createCodexHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async recordRoleHookEvent(_repoRoot, input) {
          calls.push([
            "session",
            input.eventName,
            input.role,
            input.sessionId,
            input.transcriptPath,
            input.cwd,
            String(input.allowSessionMismatch)
          ].join(":"));
          return {
            id: "runtime_codex",
            claudeSessionId: input.sessionId ?? "codex_session",
            transcriptPath: input.transcriptPath,
            taskSlug: input.taskSlug,
            role: input.role,
            status: "running",
            activityStatus: "running",
            command: "codex",
            permissionMode: "default",
            cwd: input.cwd ?? "/repo/.ai/codex",
            terminalBackend: "node-pty",
            logPath: ".ai/vcm/handoffs/logs/codex-reviewer.log",
            updatedAt: "2026-06-14T00:00:00.000Z"
          };
        }
      } as Pick<SessionService, "recordRoleHookEvent">,
      roundService: {
        async recordRoleTurnEvent(input) {
          calls.push(`round:${input.eventName}:${input.role}:${input.stateRepoRoot}:${input.stateRoot}`);
          return {} as never;
        }
      } as Pick<RoundService, "recordRoleTurnEvent">
    });

    const result = await service.handleHook({
      taskSlug: "demo-task",
      role: "codex-reviewer",
      event: {
        hook_event_name: "UserPromptSubmit",
        session_id: "codex_session_123",
        transcript_path: "/Users/sheldon/.codex/sessions/rollout.jsonl",
        cwd: "/repo/.ai/codex",
        prompt: "Review the gate."
      }
    });

    expect(result).toMatchObject({
      ok: true,
      eventName: "UserPromptSubmit",
      role: "codex-reviewer",
      sessionUpdated: true
    });
    expect(calls).toEqual([
      "session:UserPromptSubmit:codex-reviewer:codex_session_123:/Users/sheldon/.codex/sessions/rollout.jsonl:/repo/.ai/codex:true",
      "round:UserPromptSubmit:codex-reviewer:/repo/.claude/worktrees/demo-task:.ai/vcm"
    ]);
  });

  it("records Codex Reviewer Stop and returns a non-blocking result", async () => {
    const calls: string[] = [];
    const service = createCodexHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {
        async recordRoleHookEvent(_repoRoot, input) {
          calls.push(`session:${input.eventName}:${input.role}:${input.sessionId}`);
          return undefined;
        }
      } as Pick<SessionService, "recordRoleHookEvent">,
      roundService: {
        async recordRoleTurnEvent(input) {
          calls.push(`round:${input.eventName}:${input.role}`);
          return {} as never;
        }
      } as Pick<RoundService, "recordRoleTurnEvent">
    });

    const result = await service.handleStopHook({
      taskSlug: "demo-task",
      role: "codex-reviewer",
      event: {
        hook_event_name: "Stop",
        session_id: "codex_session_123",
        last_assistant_message: "OK"
      }
    });

    expect(result).toMatchObject({
      ok: true,
      eventName: "Stop",
      role: "codex-reviewer",
      sessionUpdated: false
    });
    expect(calls).toEqual([
      "session:Stop:codex-reviewer:codex_session_123",
      "round:Stop:codex-reviewer"
    ]);
  });

  it("rejects non-Codex Reviewer roles", async () => {
    const service = createCodexHookService({
      projectService: createProjectServiceStub(),
      taskService: createTaskServiceStub(),
      sessionService: {} as Pick<SessionService, "recordRoleHookEvent">,
      roundService: {} as Pick<RoundService, "recordRoleTurnEvent">
    });

    await expect(service.handleHook({
      taskSlug: "demo-task",
      role: "project-manager" as never,
      event: { hook_event_name: "UserPromptSubmit" }
    })).rejects.toMatchObject({
      code: "CODEX_HOOK_ROLE_INVALID"
    });
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
        createdAt: "2026-06-14T00:00:00.000Z",
        updatedAt: "2026-06-14T00:00:00.000Z",
        repoRoot: "/repo",
        branch: "feature/demo-task",
        worktreePath: "/repo/.claude/worktrees/demo-task",
        handoffDir: ".ai/vcm/handoffs",
        status: "running"
      };
    }
  } as never;
}
