import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerTranslationWorkerRoutes } from "../../../src/backend/api/translation-worker-routes.js";
import type { TranslationWorkerService } from "../../../src/backend/services/translation-worker-service.js";
import type { ProjectService } from "../../../src/backend/services/project-service.js";
import type { SessionService } from "../../../src/backend/services/session-service.js";
import type { TranslationService } from "../../../src/backend/services/translation-service.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";

describe("translation worker routes", () => {
  it("browses source files for the current project", async () => {
    const calls: unknown[] = [];
    const app = Fastify({ logger: false });
    registerTranslationWorkerRoutes(app, {
      projectService: createProjectServiceStub(),
      translationWorkerService: {
        async browseSourceFiles(repoRoot, input) {
          calls.push({ repoRoot, input });
          return {
            currentPath: input?.path ?? "",
            query: input?.query,
            entries: [],
            truncated: false
          };
        }
      } as TranslationWorkerService,
      sessionService: createSessionServiceStub(),
      translationService: createTranslationServiceStub()
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/translation/source-files?path=docs&query=white&limit=25"
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([{
      repoRoot: "/repo",
      input: {
        path: "docs",
        query: "white",
        limit: 25
      }
    }]);
    await app.close();
  });

  it("clears Translator translation state before restarting the task Translator session", async () => {
    const calls: string[] = [];
    const session = createRoleSessionRecord({ id: "translator-runtime-old" });
    const app = Fastify({ logger: false });
    registerTranslationWorkerRoutes(app, {
      projectService: createProjectServiceStub(),
      translationWorkerService: {} as TranslationWorkerService,
      sessionService: createSessionServiceStub({
        async getRoleSession() {
          return session;
        },
        async restartRoleSession() {
          calls.push("restartRoleSession");
          return createRoleSessionRecord({ id: "translator-runtime-new" });
        }
      }),
      translationService: createTranslationServiceStub({
        async stopSession(sessionId, options) {
          calls.push(`stopSession:${sessionId}:${options?.clearCache === true ? "clear" : "keep"}`);
        }
      })
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/translation/session/restart",
      payload: { taskSlug: "demo-task" }
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      "stopSession:translator-runtime-old:clear",
      "restartRoleSession"
    ]);
    await app.close();
  });

  it("clears Translator translation state when stopping the task Translator session", async () => {
    const calls: string[] = [];
    const session = createRoleSessionRecord({ id: "translator-runtime-old" });
    const app = Fastify({ logger: false });
    registerTranslationWorkerRoutes(app, {
      projectService: createProjectServiceStub(),
      translationWorkerService: {} as TranslationWorkerService,
      sessionService: createSessionServiceStub({
        async stopRoleSession() {
          calls.push("stopRoleSession");
          return session;
        }
      }),
      translationService: createTranslationServiceStub({
        async stopSession(sessionId, options) {
          calls.push(`stopSession:${sessionId}:${options?.clearCache === true ? "clear" : "keep"}`);
        }
      })
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/translation/session/stop",
      payload: { taskSlug: "demo-task" }
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      "stopRoleSession",
      "stopSession:translator-runtime-old:keep"
    ]);
    await app.close();
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
          defaultRoles: ["project-manager", "architect", "coder", "tester"],
          handoffRoot: ".ai/vcm/handoffs",
          stateRoot: ".ai/vcm",
          terminalBackend: "node-pty",
          claudeCommand: "claude"
        },
        warnings: []
      };
    },
    async loadConfig() {
      throw new Error("not used");
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

function createSessionServiceStub(overrides: Partial<SessionService> = {}): Pick<
  SessionService,
  | "getRoleSession"
  | "startRoleSession"
  | "resumeRoleSession"
  | "restartRoleSession"
  | "stopRoleSession"
> {
  return {
    async getRoleSession() {
      return undefined;
    },
    async startRoleSession() {
      return createRoleSessionRecord();
    },
    async resumeRoleSession() {
      return createRoleSessionRecord();
    },
    async restartRoleSession() {
      return createRoleSessionRecord();
    },
    async stopRoleSession() {
      return createRoleSessionRecord();
    },
    ...overrides
  };
}

function createTranslationServiceStub(overrides: Partial<TranslationService> = {}): Pick<TranslationService, "stopSession"> {
  return {
    async stopSession() {},
    ...overrides
  };
}

function createRoleSessionRecord(overrides: Partial<RoleSessionRecord> = {}): RoleSessionRecord {
  return {
    id: "translator-runtime",
    claudeSessionId: "translator-claude",
    taskSlug: "demo-task",
    role: "translator",
    status: "running",
    activityStatus: "idle",
    command: "claude",
    permissionMode: "bypassPermissions",
    model: "default",
    effort: "medium",
    cwd: "/repo",
    terminalBackend: "node-pty",
    updatedAt: "2026-06-24T00:00:00.000Z",
    ...overrides
  };
}
