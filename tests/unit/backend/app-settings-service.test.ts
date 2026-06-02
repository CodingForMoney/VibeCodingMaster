import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import {
  createAppSettingsService,
  getProjectId,
  type AppProjectIndexFile,
  type AppSettingsFile
} from "../../../src/backend/services/app-settings-service.js";

describe("app-settings-service", () => {
  it("creates an empty settings.json when no settings exist", async () => {
    const fs = createMemoryFs();
    const service = createAppSettingsService({
      fs,
      settingsPath: "/settings.json"
    });

    const settings = await service.loadSettings();
    const stored = await fs.readJson<AppSettingsFile>("/settings.json");

    expect(settings).toEqual({
      version: 1,
      preferences: {
        themeMode: "system",
        roundCompletionAlerts: true
      },
      translation: undefined,
      recentRepositoryPaths: []
    });
    expect(stored).toEqual(settings);
  });

  it("stores app preferences with system theme as the default", async () => {
    const fs = createMemoryFs();
    const service = createAppSettingsService({
      fs,
      settingsPath: "/settings.json"
    });

    await expect(service.getPreferences()).resolves.toEqual({
      themeMode: "system",
      roundCompletionAlerts: true
    });
    await expect(service.updatePreferences({
      themeMode: "dark",
      roundCompletionAlerts: false
    })).resolves.toEqual({
      themeMode: "dark",
      roundCompletionAlerts: false
    });

    const stored = await fs.readJson<AppSettingsFile>("/settings.json");
    expect(stored.preferences).toEqual({
      themeMode: "dark",
      roundCompletionAlerts: false
    });
  });

  it("keeps the five most recent repository paths with newest first", async () => {
    const fs = createMemoryFs();
    const service = createAppSettingsService({
      fs,
      settingsPath: "/settings.json"
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

  it("stores project config under ~/.vcm projects state", async () => {
    const fs = createMemoryFs();
    const service = createAppSettingsService({
      fs,
      settingsPath: "/home/.vcm/settings.json"
    });
    const repoRoot = "/workspace/project";
    const projectId = getProjectId(repoRoot);

    await service.saveProjectConfig({
      version: 1,
      repoRoot,
      defaultRoles: ["project-manager", "architect", "coder", "reviewer"],
      handoffRoot: ".ai/vcm/handoffs",
      stateRoot: ".ai/vcm",
      terminalBackend: "node-pty",
      claudeCommand: "claude-custom"
    });

    await expect(fs.readJson(`/home/.vcm/projects/${projectId}/config.json`)).resolves.toMatchObject({
      repoRoot,
      stateRoot: ".ai/vcm",
      claudeCommand: "claude-custom"
    });
    await expect(service.loadProjectConfig(repoRoot)).resolves.toMatchObject({
      claudeCommand: "claude-custom"
    });

    const index = await fs.readJson<AppProjectIndexFile>("/home/.vcm/projects/index.json");
    expect(index.projects[0]).toMatchObject({
      projectId,
      repoRoot,
      configPath: `/home/.vcm/projects/${projectId}/config.json`
    });
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
