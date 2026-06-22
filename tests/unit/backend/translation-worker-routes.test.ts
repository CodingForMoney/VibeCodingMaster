import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerTranslationWorkerRoutes } from "../../../src/backend/api/translation-worker-routes.js";
import type { TranslationWorkerService } from "../../../src/backend/services/translation-worker-service.js";
import type { ProjectService } from "../../../src/backend/services/project-service.js";

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
      } as TranslationWorkerService
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
