import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createAppSettingsService, type AppSettingsFile } from "../../../src/backend/services/app-settings-service.js";

describe("app-settings-service", () => {
  it("creates settings.json and migrates the legacy translation config", async () => {
    const fs = createMemoryFs();
    await fs.writeJsonAtomic("/translation.json", {
      settings: {
        apiKey: "sk-old-settings-key",
        model: "cheap-translator"
      },
      secrets: {
        apiKey: "sk-local-test"
      }
    });
    const service = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
      legacyTranslationPath: "/translation.json"
    });

    const settings = await service.loadSettings();
    const stored = await fs.readJson<AppSettingsFile>("/settings.json");

    expect(settings.translation?.settings.model).toBe("cheap-translator");
    expect(settings.translation?.secrets.apiKey).toBe("sk-local-test");
    expect(stored.translation?.secrets.apiKey).toBe("sk-local-test");
    expect(stored.translation?.settings.apiKey).toBeUndefined();
    expect(stored.recentRepositoryPaths).toEqual([]);
  });

  it("keeps the five most recent repository paths with newest first", async () => {
    const fs = createMemoryFs();
    const service = createAppSettingsService({
      fs,
      settingsPath: "/settings.json",
      legacyTranslationPath: "/translation.json"
    });

    await service.recordRecentRepositoryPath("/repo/one");
    await service.recordRecentRepositoryPath("/repo/two");
    await service.recordRecentRepositoryPath("/repo/three");
    await service.recordRecentRepositoryPath("/repo/four");
    await service.recordRecentRepositoryPath("/repo/five");
    await service.recordRecentRepositoryPath("/repo/six");
    await service.recordRecentRepositoryPath("/repo/three");

    expect(await service.getRecentRepositoryPaths()).toEqual([
      "/repo/three",
      "/repo/six",
      "/repo/five",
      "/repo/four",
      "/repo/two"
    ]);
  });
});

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
