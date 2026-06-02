import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { AppPreferences, ThemeMode } from "../../shared/types/app-settings.js";
import type { ProjectConfig } from "../../shared/types/project.js";
import type { TranslationSecretSettings, TranslationSettings } from "../../shared/types/translation.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";

export interface StoredTranslationConfig {
  settings: Partial<TranslationSettings>;
  secrets: TranslationSecretSettings;
}

export interface AppSettingsFile {
  version: 1;
  preferences: AppPreferences;
  translation?: StoredTranslationConfig;
  recentRepositoryPaths: string[];
}

export interface AppProjectIndexEntry {
  projectId: string;
  repoRoot: string;
  configPath: string;
  lastOpenedAt: string;
}

export interface AppProjectIndexFile {
  version: 1;
  projects: AppProjectIndexEntry[];
}

export interface AppSettingsService {
  loadSettings(): Promise<AppSettingsFile>;
  getPreferences(): Promise<AppPreferences>;
  updatePreferences(input: Partial<AppPreferences>): Promise<AppPreferences>;
  updateTranslationConfig(config: StoredTranslationConfig): Promise<StoredTranslationConfig>;
  getTranslationConfig(): Promise<StoredTranslationConfig | undefined>;
  getRecentRepositoryPaths(): Promise<string[]>;
  recordRecentRepositoryPath(repoRoot: string): Promise<string[]>;
  loadProjectIndex(): Promise<AppProjectIndexFile>;
  loadProjectConfig(repoRoot: string): Promise<Partial<ProjectConfig> | undefined>;
  saveProjectConfig(config: ProjectConfig): Promise<ProjectConfig>;
  getSettingsPath(): string;
  getProjectIndexPath(): string;
  getProjectConfigPath(repoRoot: string): string;
}

export interface AppSettingsServiceDeps {
  fs: FileSystemAdapter;
  settingsPath?: string;
}

const MAX_RECENT_REPOSITORIES = 5;

export function createAppSettingsService(deps: AppSettingsServiceDeps): AppSettingsService {
  const settingsPath = deps.settingsPath ?? path.join(homedir(), ".vcm", "settings.json");
  const settingsRoot = path.dirname(settingsPath);
  const projectIndexPath = path.join(settingsRoot, "projects", "index.json");
  let cachedSettings: AppSettingsFile | null = null;
  let cachedProjectIndex: AppProjectIndexFile | null = null;

  async function loadSettings(): Promise<AppSettingsFile> {
    if (cachedSettings) {
      return cachedSettings;
    }

    let raw: Partial<AppSettingsFile> = {};
    let shouldSave = false;
    if (await deps.fs.pathExists(settingsPath)) {
      raw = await deps.fs.readJson<Partial<AppSettingsFile>>(settingsPath);
    } else {
      shouldSave = true;
    }

    cachedSettings = normalizeSettingsFile(raw);
    if (shouldSave) {
      await saveSettings(cachedSettings);
    }
    return cachedSettings;
  }

  async function saveSettings(settings: AppSettingsFile): Promise<void> {
    cachedSettings = settings;
    await deps.fs.writeJsonAtomic(settingsPath, settings);
  }

  async function loadProjectIndex(): Promise<AppProjectIndexFile> {
    if (cachedProjectIndex) {
      return cachedProjectIndex;
    }

    if (await deps.fs.pathExists(projectIndexPath)) {
      cachedProjectIndex = normalizeProjectIndexFile(
        await deps.fs.readJson<Partial<AppProjectIndexFile>>(projectIndexPath)
      );
    } else {
      cachedProjectIndex = { version: 1, projects: [] };
      await saveProjectIndex(cachedProjectIndex);
    }
    return cachedProjectIndex;
  }

  async function saveProjectIndex(index: AppProjectIndexFile): Promise<void> {
    cachedProjectIndex = normalizeProjectIndexFile(index);
    await deps.fs.writeJsonAtomic(projectIndexPath, cachedProjectIndex);
  }

  function getProjectConfigPath(repoRoot: string): string {
    return path.join(settingsRoot, "projects", getProjectId(repoRoot), "config.json");
  }

  return {
    loadSettings,
    async getPreferences() {
      return (await loadSettings()).preferences;
    },
    async updatePreferences(input) {
      const current = await loadSettings();
      const preferences = normalizePreferences({
        ...current.preferences,
        ...input
      });
      await saveSettings({
        ...current,
        preferences
      });
      return preferences;
    },
    async updateTranslationConfig(config) {
      const current = await loadSettings();
      const translation = normalizeTranslationConfig(config) ?? { settings: {}, secrets: {} };
      await saveSettings({
        ...current,
        translation
      });
      return translation;
    },
    async getTranslationConfig() {
      return (await loadSettings()).translation;
    },
    async getRecentRepositoryPaths() {
      return (await loadSettings()).recentRepositoryPaths;
    },
    async recordRecentRepositoryPath(repoRoot) {
      const normalizedPath = repoRoot.trim();
      if (!normalizedPath) {
        return (await loadSettings()).recentRepositoryPaths;
      }

      const current = await loadSettings();
      const recentRepositoryPaths = normalizeRecentRepositoryPaths([
        normalizedPath,
        ...current.recentRepositoryPaths
      ]);
      await saveSettings({
        ...current,
        recentRepositoryPaths
      });
      return recentRepositoryPaths;
    },
    loadProjectIndex,
    async loadProjectConfig(repoRoot) {
      const configPath = getProjectConfigPath(repoRoot);
      if (!(await deps.fs.pathExists(configPath))) {
        return undefined;
      }
      return deps.fs.readJson<Partial<ProjectConfig>>(configPath);
    },
    async saveProjectConfig(config) {
      const configPath = getProjectConfigPath(config.repoRoot);
      await deps.fs.writeJsonAtomic(configPath, config);

      const projectId = getProjectId(config.repoRoot);
      const current = await loadProjectIndex();
      const projects = [
        {
          projectId,
          repoRoot: config.repoRoot,
          configPath,
          lastOpenedAt: new Date().toISOString()
        },
        ...current.projects.filter((entry) => entry.projectId !== projectId)
      ];
      await saveProjectIndex({
        version: 1,
        projects
      });
      return config;
    },
    getSettingsPath() {
      return settingsPath;
    },
    getProjectIndexPath() {
      return projectIndexPath;
    },
    getProjectConfigPath
  };
}

export function getProjectId(repoRoot: string): string {
  return createHash("sha256")
    .update(path.resolve(repoRoot))
    .digest("hex")
    .slice(0, 16);
}

function normalizeProjectIndexFile(input: Partial<AppProjectIndexFile>): AppProjectIndexFile {
  const rawProjects = Array.isArray(input.projects) ? input.projects : [];
  const projects: AppProjectIndexEntry[] = [];
  const seen = new Set<string>();

  for (const value of rawProjects) {
    if (!isObject(value)) {
      continue;
    }
    const projectId = typeof value.projectId === "string" ? value.projectId.trim() : "";
    const repoRoot = typeof value.repoRoot === "string" ? value.repoRoot.trim() : "";
    const configPath = typeof value.configPath === "string" ? value.configPath.trim() : "";
    const lastOpenedAt = typeof value.lastOpenedAt === "string" ? value.lastOpenedAt.trim() : "";
    if (!projectId || !repoRoot || !configPath || seen.has(projectId)) {
      continue;
    }
    seen.add(projectId);
    projects.push({
      projectId,
      repoRoot,
      configPath,
      lastOpenedAt: lastOpenedAt || new Date(0).toISOString()
    });
  }

  return {
    version: 1,
    projects
  };
}

function normalizeSettingsFile(input: Partial<AppSettingsFile>): AppSettingsFile {
  return {
    version: 1,
    preferences: normalizePreferences(input.preferences),
    translation: normalizeTranslationConfig(input.translation),
    recentRepositoryPaths: normalizeRecentRepositoryPaths(input.recentRepositoryPaths)
  };
}

function normalizePreferences(input: unknown): AppPreferences {
  const candidate = isObject(input) ? input : {};
  return {
    themeMode: normalizeThemeMode(candidate.themeMode),
    roundCompletionAlerts: candidate.roundCompletionAlerts !== false
  };
}

function normalizeThemeMode(input: unknown): ThemeMode {
  if (input === "light" || input === "dark" || input === "system") {
    return input;
  }
  return "system";
}

function normalizeTranslationConfig(input: unknown): StoredTranslationConfig | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const candidate = input as Partial<StoredTranslationConfig>;
  const rawSettings = isObject(candidate.settings) ? candidate.settings as Partial<TranslationSettings> : {};
  const rawSecrets = isObject(candidate.secrets) ? candidate.secrets as TranslationSecretSettings : {};
  const { apiKey: settingsApiKey, ...settings } = rawSettings;
  const apiKey = rawSecrets.apiKey ?? settingsApiKey;
  return {
    settings,
    secrets: {
      ...rawSecrets,
      ...(apiKey !== undefined ? { apiKey } : {})
    }
  };
}

function normalizeRecentRepositoryPaths(input: unknown): string[] {
  const paths = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of paths) {
    if (typeof value !== "string") {
      continue;
    }
    const repoPath = value.trim();
    if (!repoPath || seen.has(repoPath)) {
      continue;
    }
    seen.add(repoPath);
    normalized.push(repoPath);
    if (normalized.length >= MAX_RECENT_REPOSITORIES) {
      break;
    }
  }

  return normalized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
