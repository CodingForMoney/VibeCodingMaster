import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import type { TranslationProvider } from "../../../src/backend/adapters/translation-provider.js";
import type { TerminalRuntime } from "../../../src/backend/runtime/terminal-runtime.js";
import { createAppSettingsService, type AppSettingsFile } from "../../../src/backend/services/app-settings-service.js";
import type { SessionService } from "../../../src/backend/services/session-service.js";
import { createTranslationService } from "../../../src/backend/services/translation-service.js";

describe("translation-service", () => {
  it("saves API keys locally and returns them to the local settings UI", async () => {
    const fs = createMemoryFs();
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
      legacySettingsPath: "/old-settings.json",
      legacyTranslationPath: "/translation.json"
    });
    const service = createTranslationService({
      appSettings,
      provider: createProviderStub(),
      runtime: {} as TerminalRuntime,
      sessionService: {} as SessionService
    });

    const saved = await service.updateSettings({ enabled: true }, { apiKey: "sk-local-test" });
    const reloaded = await service.getSettings();
    const stored = await fs.readJson<AppSettingsFile>("/settings.json");

    expect(saved.apiKey).toBe("sk-local-test");
    expect(reloaded.apiKey).toBe("sk-local-test");
    expect(stored.translation?.secrets.apiKey).toBe("sk-local-test");
    expect(stored.translation?.settings.apiKey).toBeUndefined();
  });

  it("migrates API keys from the legacy translation config file", async () => {
    const fs = createMemoryFs();
    await fs.writeJsonAtomic("/translation.json", {
      settings: {
        apiKey: "sk-old-local-test"
      },
      secrets: {}
    });
    const appSettings = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
      legacySettingsPath: "/old-settings.json",
      legacyTranslationPath: "/translation.json"
    });
    const service = createTranslationService({
      appSettings,
      provider: createProviderStub(),
      runtime: {} as TerminalRuntime,
      sessionService: {} as SessionService
    });

    const settings = await service.getSettings();
    const stored = await fs.readJson<AppSettingsFile>("/settings.json");

    expect(settings.apiKey).toBe("sk-old-local-test");
    expect(stored.translation?.settings.apiKey).toBeUndefined();
    expect(stored.translation?.secrets.apiKey).toBe("sk-old-local-test");
  });
});

function createProviderStub(): TranslationProvider {
  return {
    async testConnection(settings) {
      return { ok: true, model: settings.model, elapsedMs: 1 };
    },
    async translate() {
      return { text: "translated", elapsedMs: 1 };
    }
  };
}

function createMemoryFs(): FileSystemAdapter {
  const files = new Map<string, string>();
  return {
    async pathExists(targetPath) {
      return files.has(targetPath);
    },
    async ensureDir() {},
    async readDir() {
      return [];
    },
    async readText(targetPath) {
      const value = files.get(targetPath);
      if (value === undefined) {
        throw new Error(`missing ${targetPath}`);
      }
      return value;
    },
    async writeText(targetPath, content) {
      files.set(targetPath, content);
    },
    async appendText(targetPath, content) {
      files.set(targetPath, `${files.get(targetPath) ?? ""}${content}`);
    },
    async readJson(targetPath) {
      return JSON.parse(await this.readText(targetPath));
    },
    async writeJson(targetPath, value) {
      await this.writeText(targetPath, `${JSON.stringify(value, null, 2)}\n`);
    },
    async writeJsonAtomic(targetPath, value) {
      await this.writeJson(targetPath, value);
    },
    async ensureFile(targetPath, content) {
      if (files.has(targetPath)) {
        return false;
      }
      files.set(targetPath, content);
      return true;
    }
  };
}
