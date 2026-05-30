import path from "node:path";
import { homedir } from "node:os";
import type { TranslationSecretSettings, TranslationSettings } from "../../shared/types/translation.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";

export interface StoredTranslationConfig {
  settings: Partial<TranslationSettings>;
  secrets: TranslationSecretSettings;
}

export interface AppSettingsFile {
  version: 1;
  translation?: StoredTranslationConfig;
  recentRepositoryPaths: string[];
}

export interface AppSettingsService {
  loadSettings(): Promise<AppSettingsFile>;
  updateTranslationConfig(config: StoredTranslationConfig): Promise<StoredTranslationConfig>;
  getTranslationConfig(): Promise<StoredTranslationConfig | undefined>;
  getRecentRepositoryPaths(): Promise<string[]>;
  recordRecentRepositoryPath(repoRoot: string): Promise<string[]>;
  getSettingsPath(): string;
}

export interface AppSettingsServiceDeps {
  fs: FileSystemAdapter;
  settingsPath?: string;
  legacyTranslationPath?: string;
}

const MAX_RECENT_REPOSITORIES = 5;

export function createAppSettingsService(deps: AppSettingsServiceDeps): AppSettingsService {
  const settingsPath = deps.settingsPath ?? path.join(homedir(), ".vibe-coding-master", "settings.json");
  const legacyTranslationPath = deps.legacyTranslationPath
    ?? path.join(homedir(), ".vibe-coding-master", "translation.json");
  let cachedSettings: AppSettingsFile | null = null;

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

    if (!raw.translation && await deps.fs.pathExists(legacyTranslationPath)) {
      raw = {
        ...raw,
        translation: normalizeTranslationConfig(
          await deps.fs.readJson<Partial<StoredTranslationConfig>>(legacyTranslationPath)
        )
      };
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

  return {
    loadSettings,
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
    getSettingsPath() {
      return settingsPath;
    }
  };
}

function normalizeSettingsFile(input: Partial<AppSettingsFile>): AppSettingsFile {
  return {
    version: 1,
    translation: normalizeTranslationConfig(input.translation),
    recentRepositoryPaths: normalizeRecentRepositoryPaths(input.recentRepositoryPaths)
  };
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
