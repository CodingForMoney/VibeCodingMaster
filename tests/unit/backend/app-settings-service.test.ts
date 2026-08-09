import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultLaunchTemplate,
  createDefaultToolSessionDefaults,
  type AppPreferences
} from "../../../src/shared/types/app-settings.js";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import {
  createAppSettingsService,
  getProjectId,
  type AppProjectIndexFile,
  type AppSettingsFile
} from "../../../src/backend/services/app-settings-service.js";

describe("app-settings-service", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses VCM_DATA_DIR for the default app settings root", () => {
    vi.stubEnv("VCM_DATA_DIR", "/workspace/.ai/vcm");
    const service = createAppSettingsService({
      fs: createMemoryFs()
    });

    expect(service.getSettingsPath()).toBe("/workspace/.ai/vcm/settings.json");
    expect(service.getProjectIndexPath()).toBe("/workspace/.ai/vcm/projects/index.json");
    expect(service.getProjectConfigPath("/workspace/project")).toMatch(/^\/workspace\/\.ai\/vcm\/projects\/.+\/config\.json$/);
  });

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
      codexBridge: {
        version: 1,
        enabled: false,
        apiKey: ""
      },
      preferences: createDefaultPreferences(),
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

    await expect(service.getPreferences()).resolves.toEqual(createDefaultPreferences());
    await expect(service.updatePreferences({
      themeMode: "dark",
      flowPauseAlerts: false,
      roleRetryEnabled: false,
      permissionRequestMode: "allowAll",
      autoTaskHarnessReviewEnabled: true,
      autoMemoryEnabled: true,
      translationEnabled: true,
      translationAutoSendEnabled: true,
      translationTargetLanguage: "ja",
      translationOutputMode: "all"
    })).resolves.toEqual(createDefaultPreferences({
      themeMode: "dark",
      flowPauseAlerts: false,
      roleRetryEnabled: false,
      permissionRequestMode: "allowAll",
      autoTaskHarnessReviewEnabled: true,
      autoMemoryEnabled: true,
      translationEnabled: true,
      translationAutoSendEnabled: true,
      translationTargetLanguage: "ja",
      translationOutputMode: "all"
    }));

    const stored = await fs.readJson<AppSettingsFile>("/settings.json");
    expect(stored.preferences).toEqual(createDefaultPreferences({
      themeMode: "dark",
      flowPauseAlerts: false,
      roleRetryEnabled: false,
      permissionRequestMode: "allowAll",
      autoTaskHarnessReviewEnabled: true,
      autoMemoryEnabled: true,
      translationEnabled: true,
      translationAutoSendEnabled: true,
      translationTargetLanguage: "ja",
      translationOutputMode: "all"
    }));
  });

  it("stores the role launch template", async () => {
    const fs = createMemoryFs();
    const service = createAppSettingsService({
      fs,
      settingsPath: "/settings.json"
    });
    const launchTemplate = createDefaultLaunchTemplate();
    launchTemplate.autoOrchestration = false;
    launchTemplate.roles.coder = {
      permissionMode: "bypassPermissions",
      model: "claude-opus-4-8",
      effort: "high"
    };

    await expect(service.updatePreferences({ launchTemplate })).resolves.toEqual(createDefaultPreferences({
      launchTemplate
    }));

    const stored = await fs.readJson<AppSettingsFile>("/settings.json");
    expect(stored.preferences.launchTemplate).toEqual(launchTemplate);
  });

  it("uses independent tool Session defaults when settings do not contain them", async () => {
    const defaults = createDefaultPreferences();
    const { toolSessionDefaults: _toolSessionDefaults, ...legacyPreferences } = defaults;
    const fs = createMemoryFs({
      "/settings.json": {
        version: 1,
        preferences: legacyPreferences,
        recentRepositoryPaths: []
      }
    });
    const service = createAppSettingsService({ fs, settingsPath: "/settings.json" });

    const preferences = await service.getPreferences();

    expect(preferences.toolSessionDefaults.translator).toEqual({
      permissionMode: "bypassPermissions",
      model: "default",
      effort: "medium"
    });
    expect(preferences.toolSessionDefaults["harness-engineer"]).toEqual({
      permissionMode: "bypassPermissions",
      model: "default",
      effort: "medium"
    });
  });

  it("updates one tool Session default without changing the launch template", async () => {
    const fs = createMemoryFs();
    const service = createAppSettingsService({ fs, settingsPath: "/settings.json" });
    const launchTemplate = createDefaultLaunchTemplate();

    await expect(service.updateToolSessionDefaults("translator", {
      permissionMode: "plan",
      model: "sonnet",
      effort: "high"
    })).resolves.toEqual({
      permissionMode: "plan",
      model: "sonnet",
      effort: "high"
    });

    const stored = await fs.readJson<AppSettingsFile>("/settings.json");
    expect(stored.preferences.launchTemplate).toEqual(launchTemplate);
    expect(stored.preferences.toolSessionDefaults).toEqual({
      ...createDefaultToolSessionDefaults(),
      translator: {
        permissionMode: "plan",
        model: "sonnet",
        effort: "high"
      }
    });
  });

  it("stores Codex Bridge credentials globally and preserves namespaced launch models", async () => {
    const fs = createMemoryFs();
    const service = createAppSettingsService({ fs, settingsPath: "/settings.json" });
    const launchTemplate = createDefaultLaunchTemplate();
    launchTemplate.roles.architect.model = "codex-bridge:gpt-5.5";

    await expect(service.updateCodexBridgeIntegrationSettings({ apiKey: "local-secret", enabled: true }))
      .resolves.toEqual({ version: 1, apiKey: "local-secret", enabled: true });
    await service.updatePreferences({ launchTemplate });

    const stored = await fs.readJson<AppSettingsFile>("/settings.json");
    expect(stored.codexBridge).toEqual({ version: 1, apiKey: "local-secret", enabled: true });
    expect(stored.preferences.launchTemplate.roles.architect.model).toBe("codex-bridge:gpt-5.5");
  });

  it("protects the global settings file with owner-only permissions", async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "vcm-settings-mode-"));
    const settingsPath = path.join(tempRoot, "settings.json");
    try {
      const service = createAppSettingsService({
        fs: createNodeFileSystemAdapter(),
        settingsPath
      });
      await service.updateCodexBridgeIntegrationSettings({ apiKey: "local-secret" });

      const stat = await fsPromises.stat(settingsPath);
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("migrates the old round completion alert preference", async () => {
    const fs = createMemoryFs({
      "/settings.json": {
        version: 1,
        preferences: {
          themeMode: "dark",
          roundCompletionAlerts: false
        },
        recentRepositoryPaths: []
      }
    });
    const service = createAppSettingsService({
      fs,
      settingsPath: "/settings.json"
    });

    await expect(service.getPreferences()).resolves.toEqual(createDefaultPreferences({
      themeMode: "dark",
      flowPauseAlerts: false,
      permissionRequestMode: "off"
    }));
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

  it("stores project config under app-local projects state", async () => {
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
      defaultRoles: ["project-manager", "architect", "coder", "tester"],
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

  it("stores Gate Review Gate switches in settings.json", async () => {
    const fs = createMemoryFs();
    const service = createAppSettingsService({
      fs,
      settingsPath: "/home/.vcm/settings.json"
    });
    const repoRoot = "/workspace/project";

    await expect(service.getGateReviewSettings(repoRoot, "demo-task")).resolves.toEqual({
      enabled: false,
      requiredGates: []
    });

    await expect(service.updateGateReviewSettings(repoRoot, "demo-task", [
      "code-diff",
      "architecture-plan",
      "code-diff",
      "final-diff" as never
    ])).resolves.toEqual({
      enabled: true,
      requiredGates: ["architecture-plan", "code-diff"]
    });

    const stored = await fs.readJson<AppSettingsFile>("/home/.vcm/settings.json");
    expect(stored.gateReview).toMatchObject({
      requiredGates: ["architecture-plan", "code-diff"]
    });
    expect(stored.gateReview).not.toHaveProperty("projects");
    await expect(service.getGateReviewSettings("/workspace/another-project", "another-task")).resolves.toEqual({
      enabled: true,
      requiredGates: ["architecture-plan", "code-diff"]
    });
  });
});

function createDefaultPreferences(overrides: Partial<AppPreferences> = {}): AppPreferences {
  return {
    themeMode: "system",
    flowPauseAlerts: true,
    roleRetryEnabled: true,
    permissionRequestMode: "off",
    autoTaskHarnessReviewEnabled: false,
    autoMemoryEnabled: false,
    translationEnabled: false,
    translationAutoSendEnabled: false,
    translationTargetLanguage: "zh-CN",
    translationOutputMode: "pm-final-only",
    launchTemplate: createDefaultLaunchTemplate(),
    toolSessionDefaults: createDefaultToolSessionDefaults(),
    ...overrides
  };
}

function createMemoryFs(initialFiles: Record<string, unknown> = {}): FileSystemAdapter {
  const files = new Map<string, string>(
    Object.entries(initialFiles).map(([targetPath, value]) => [
      targetPath,
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`
    ])
  );
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
