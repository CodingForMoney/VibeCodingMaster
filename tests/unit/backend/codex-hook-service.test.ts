import { describe, expect, it } from "vitest";
import { createCodexHookService } from "../../../src/backend/services/codex-hook-service.js";
import type { ProjectService } from "../../../src/backend/services/project-service.js";
import type { SessionService } from "../../../src/backend/services/session-service.js";

describe("createCodexHookService", () => {
  it("forwards Codex Translator hooks to the translation queue", async () => {
    const calls: string[] = [];
    const service = createCodexHookService({
      projectService: createProjectServiceStub(),
      sessionService: {
        async recordProjectTranslatorHookEvent(_repoRoot, input) {
          calls.push(`session:${input.eventName}:codex-translator:${input.sessionId}`);
          return {
            id: "runtime_codex_translator",
            claudeSessionId: input.sessionId ?? "codex_translator_session",
            transcriptPath: input.transcriptPath,
            taskSlug: "__project__",
            role: "codex-translator",
            status: "running",
            activityStatus: input.eventName === "Stop" ? "idle" : "running",
            command: "codex",
            permissionMode: "default",
            cwd: input.cwd ?? "/repo/.ai/codex-translator",
            terminalBackend: "node-pty",
            updatedAt: "2026-06-14T00:00:00.000Z"
          };
        }
      } as Pick<SessionService, "recordProjectTranslatorHookEvent">,
      codexTranslationService: {
        async handleCodexHook(repoRoot, eventName, taskSlug) {
          calls.push(`translation:${repoRoot}:${eventName}:${taskSlug}`);
        }
      }
    });

    const result = await service.handleStopHook({
      taskSlug: "demo-task",
      role: "codex-translator",
      event: {
        hook_event_name: "Stop",
        session_id: "codex_translator_session"
      }
    });

    expect(result).toMatchObject({
      ok: true,
      eventName: "Stop",
      role: "codex-translator",
      sessionUpdated: true
    });
    expect(calls).toEqual([
      "session:Stop:codex-translator:codex_translator_session",
      "translation:/repo:Stop:demo-task"
    ]);
  });

  it("rejects non-Codex roles", async () => {
    const service = createCodexHookService({
      projectService: createProjectServiceStub(),
      sessionService: {} as Pick<SessionService, "recordProjectTranslatorHookEvent">
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
