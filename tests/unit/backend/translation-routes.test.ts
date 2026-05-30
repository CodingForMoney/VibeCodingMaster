import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerTranslationRoutes } from "../../../src/backend/api/translation-routes.js";
import type { ProjectService } from "../../../src/backend/services/project-service.js";
import type { TaskService } from "../../../src/backend/services/task-service.js";
import type { TranslationService } from "../../../src/backend/services/translation-service.js";
import type { TranslationSecretSettings, TranslationSettings } from "../../../src/shared/types/translation.js";

const settings: TranslationSettings = {
  version: 1,
  enabled: false,
  providerType: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  workingLanguage: "en",
  inputMode: "review-before-send",
  translateOutput: true,
  translateUserInput: true,
  contextEnabled: true,
  preserveTechnicalTokens: true,
  skipCjkText: true,
  redactSecrets: true,
  requestTimeoutMs: 15000,
  temperature: 0.1
};

describe("translation routes", () => {
  it("saves global translation settings and API keys without requiring a connected project", async () => {
    let savedSettings: Partial<TranslationSettings> | undefined;
    let savedSecrets: TranslationSecretSettings | undefined;
    const app = Fastify({ logger: false });

    registerTranslationRoutes(app, {
      projectService: createProjectServiceThatShouldNotBeCalled(),
      taskService: {} as TaskService,
      translationService: {
        async getSettings() {
          return settings;
        },
        async updateSettings(input, secrets) {
          savedSettings = input;
          savedSecrets = secrets;
          return { ...settings, ...input };
        },
        async getPromptPreviews() {
          return [];
        },
        async testProvider() {
          return { ok: true, model: settings.model, elapsedMs: 1 };
        },
        async translateUserInput() {
          throw new Error("not implemented");
        },
        async sendTranslatedInput() {},
        subscribeToSession() {
          throw new Error("not implemented");
        },
        clearSession() {},
        async retryTranslation() {
          throw new Error("not implemented");
        }
      } satisfies TranslationService
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/translation/settings",
      payload: {
        enabled: true,
        apiKey: "sk-local-test",
        model: "cheap-translator"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(savedSettings).toMatchObject({
      enabled: true,
      model: "cheap-translator"
    });
    expect(savedSecrets).toEqual({ apiKey: "sk-local-test" });
    await app.close();
  });

  it("returns prompt previews without requiring a connected project", async () => {
    const app = Fastify({ logger: false });

    registerTranslationRoutes(app, {
      projectService: createProjectServiceThatShouldNotBeCalled(),
      taskService: {} as TaskService,
      translationService: {
        async getSettings() {
          return settings;
        },
        async updateSettings() {
          return settings;
        },
        async getPromptPreviews() {
          return [{
            key: "zh-to-en",
            label: "zh-to-en",
            defaultPrompt: "DEFAULT",
            userPrompt: "USER",
            customized: true
          }];
        },
        async testProvider() {
          return { ok: true, model: settings.model, elapsedMs: 1 };
        },
        async translateUserInput() {
          throw new Error("not implemented");
        },
        async sendTranslatedInput() {},
        subscribeToSession() {
          throw new Error("not implemented");
        },
        clearSession() {},
        async retryTranslation() {
          throw new Error("not implemented");
        }
      } satisfies TranslationService
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/translation/prompts"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{
      key: "zh-to-en",
      label: "zh-to-en",
      defaultPrompt: "DEFAULT",
      userPrompt: "USER",
      customized: true
    }]);
    await app.close();
  });
});

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
    }
  };
}
