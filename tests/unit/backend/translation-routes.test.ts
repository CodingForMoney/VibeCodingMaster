import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { registerTranslationRoutes } from "../../../src/backend/api/translation-routes.js";
import type { ProjectService } from "../../../src/backend/services/project-service.js";
import type { TaskService } from "../../../src/backend/services/task-service.js";
import type { TranslationService } from "../../../src/backend/services/translation-service.js";

describe("translation routes", () => {
  it("does not expose legacy API translation settings routes", async () => {
    const app = Fastify({ logger: false });

    registerTranslationRoutes(app, {
      projectService: createProjectServiceThatShouldNotBeCalled(),
      taskService: {} as TaskService,
      translationService: createTranslationServiceStub()
    });

    await expectRouteStatus(app, "GET", "/api/translation/settings", 404);
    await expectRouteStatus(app, "PUT", "/api/translation/settings", 404);
    await expectRouteStatus(app, "GET", "/api/translation/prompts", 404);
    await expectRouteStatus(app, "POST", "/api/translation/test", 404);
    await app.close();
  });
});

async function expectRouteStatus(
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT",
  url: string,
  statusCode: number
) {
  const response = await app.inject({ method, url, payload: method === "PUT" ? {} : undefined });
  expect(response.statusCode).toBe(statusCode);
}

function createTranslationServiceStub(): TranslationService {
  return {
    async startSession() {
      throw new Error("not implemented");
    },
    async pollSessionEvents() {
      throw new Error("not implemented");
    },
    async pollTaskFeed() {
      throw new Error("not implemented");
    },
    async recordConversationBoundary() {
      return undefined;
    },
    async translateUserInput() {
      throw new Error("not implemented");
    },
    async sendTranslatedInput() {},
    subscribeToSession() {
      throw new Error("not implemented");
    },
    async clearSession() {},
    async stopSession() {},
    async stopTask() {},
    async retryTranslation() {
      throw new Error("not implemented");
    },
    async retryFailedTranslations() {
      return { failures: [] };
    },
    async ignoreTranslationFailures() {
      return { failures: [] };
    },
    async translateGatewayOutput() {
      throw new Error("not implemented");
    },
    getDiagnostics() {
      return {
        sessions: 0,
        transcriptWatchers: 0,
        listeners: 0
      };
    }
  };
}

function createProjectServiceThatShouldNotBeCalled(): ProjectService {
  return {
    async connectProject() {
      throw new Error("project service should not be used");
    },
    async getCurrentProject() {
      throw new Error("project service should not be used");
    },
    async getRecentRepositoryPaths() {
      throw new Error("project service should not be used");
    },
    async loadConfig() {
      throw new Error("project service should not be used");
    },
    async saveConfig() {
      throw new Error("project service should not be used");
    },
    getConfigPath() {
      throw new Error("project service should not be used");
    },
    getProjectDataRoot() {
      throw new Error("project service should not be used");
    }
  };
}
