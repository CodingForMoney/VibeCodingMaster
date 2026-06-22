import path from "node:path";
import { createHash } from "node:crypto";
import { VCM_ROLE_NAMES } from "../../shared/constants.js";
import { GATE_REVIEW_GATES, type GateReviewGate } from "../../shared/types/gate-review.js";
import {
  createDefaultLaunchTemplate,
  DEFAULT_TRANSLATION_OUTPUT_MODE,
  DEFAULT_TRANSLATION_TARGET_LANGUAGE,
  TRANSLATION_OUTPUT_MODE_OPTIONS,
  TRANSLATION_TARGET_LANGUAGE_OPTIONS,
  type AppPreferences,
  type LaunchTemplate,
  type PermissionRequestMode,
  type RoleLaunchTemplateEntry,
  type TranslationOutputMode,
  type TranslationTargetLanguage,
  type ThemeMode
} from "../../shared/types/app-settings.js";
import type { ProjectConfig } from "../../shared/types/project.js";
import type { VcmRoleName } from "../../shared/types/role.js";
import {
  CLAUDE_MODEL_OPTIONS,
  SESSION_EFFORT_OPTIONS,
  type ClaudeModel,
  type ClaudePermissionMode,
  type SessionEffort
} from "../../shared/types/session.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import { resolveVcmDataDir } from "../vcm-data-dir.js";

export interface AppSettingsFile {
  version: 1;
  preferences: AppPreferences;
  gateReview?: AppGateReviewSettingsState;
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

export interface AppGateReviewSettingsState {
  version: 1;
  requiredGates: GateReviewGate[];
  updatedAt: string;
}

export interface AppGateReviewSettings {
  enabled: boolean;
  requiredGates: GateReviewGate[];
}

export interface AppSettingsService {
  loadSettings(): Promise<AppSettingsFile>;
  getPreferences(): Promise<AppPreferences>;
  updatePreferences(input: Partial<AppPreferences>): Promise<AppPreferences>;
  getRecentRepositoryPaths(): Promise<string[]>;
  recordRecentRepositoryPath(repoRoot: string): Promise<string[]>;
  loadProjectIndex(): Promise<AppProjectIndexFile>;
  loadProjectConfig(repoRoot: string): Promise<Partial<ProjectConfig> | undefined>;
  saveProjectConfig(config: ProjectConfig): Promise<ProjectConfig>;
  getGateReviewSettings(repoRoot: string, taskSlug: string): Promise<AppGateReviewSettings>;
  updateGateReviewSettings(repoRoot: string, taskSlug: string, requiredGates: GateReviewGate[]): Promise<AppGateReviewSettings>;
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
  const settingsPath = deps.settingsPath ?? path.join(resolveVcmDataDir(), "settings.json");
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
    async getGateReviewSettings() {
      const settings = await loadSettings();
      const requiredGates = normalizeGateReviewGates(settings.gateReview?.requiredGates);
      return {
        enabled: requiredGates.length > 0,
        requiredGates
      };
    },
    async updateGateReviewSettings(_repoRoot, _taskSlug, requiredGates) {
      const current = await loadSettings();
      const normalizedRequiredGates = normalizeGateReviewGates(requiredGates);
      const timestamp = new Date().toISOString();
      const nextGateReview: AppGateReviewSettingsState = {
        version: 1,
        requiredGates: normalizedRequiredGates,
        updatedAt: timestamp
      };
      await saveSettings({
        ...current,
        gateReview: normalizeGateReviewSettingsState(nextGateReview)
      });
      return {
        enabled: normalizedRequiredGates.length > 0,
        requiredGates: normalizedRequiredGates
      };
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

function normalizeGateReviewSettingsState(input: unknown): AppGateReviewSettingsState | undefined {
  if (!isObject(input)) {
    return undefined;
  }

  return {
    version: 1,
    requiredGates: normalizeGateReviewGates(input.requiredGates),
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : new Date(0).toISOString()
  };
}

function normalizeGateReviewGates(input: unknown): GateReviewGate[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const gates: GateReviewGate[] = [];
  for (const value of input) {
    if (!GATE_REVIEW_GATES.includes(value as GateReviewGate) || gates.includes(value as GateReviewGate)) {
      continue;
    }
    gates.push(value as GateReviewGate);
  }
  return GATE_REVIEW_GATES.filter((gate) => gates.includes(gate));
}

function normalizeSettingsFile(input: Partial<AppSettingsFile>): AppSettingsFile {
  const settings: AppSettingsFile = {
    version: 1,
    preferences: normalizePreferences(input.preferences),
    recentRepositoryPaths: normalizeRecentRepositoryPaths(input.recentRepositoryPaths)
  };
  const gateReview = normalizeGateReviewSettingsState(input.gateReview);
  if (gateReview) {
    settings.gateReview = gateReview;
  }
  return settings;
}

function normalizePreferences(input: unknown): AppPreferences {
  const candidate = isObject(input) ? input : {};
  const rawFlowPauseAlerts = "flowPauseAlerts" in candidate
    ? candidate.flowPauseAlerts
    : candidate.roundCompletionAlerts;
  return {
    themeMode: normalizeThemeMode(candidate.themeMode),
    flowPauseAlerts: rawFlowPauseAlerts !== false,
    permissionRequestMode: normalizePermissionRequestMode(candidate.permissionRequestMode),
    translationEnabled: candidate.translationEnabled === true,
    translationAutoSendEnabled: candidate.translationAutoSendEnabled === true,
    translationTargetLanguage: normalizeTranslationTargetLanguage(candidate.translationTargetLanguage),
    translationOutputMode: normalizeTranslationOutputMode(candidate.translationOutputMode),
    launchTemplate: normalizeLaunchTemplate(candidate.launchTemplate)
  };
}

function normalizeThemeMode(input: unknown): ThemeMode {
  if (input === "light" || input === "dark" || input === "system") {
    return input;
  }
  return "system";
}

function normalizePermissionRequestMode(input: unknown): PermissionRequestMode {
  if (input === "allowAll") {
    return input;
  }
  return "off";
}

function normalizeTranslationTargetLanguage(input: unknown): TranslationTargetLanguage {
  const option = TRANSLATION_TARGET_LANGUAGE_OPTIONS.find((current) => current.value === input);
  return option?.value ?? DEFAULT_TRANSLATION_TARGET_LANGUAGE;
}

function normalizeTranslationOutputMode(input: unknown): TranslationOutputMode {
  const option = TRANSLATION_OUTPUT_MODE_OPTIONS.find((current) => current.value === input);
  return option?.value ?? DEFAULT_TRANSLATION_OUTPUT_MODE;
}

function normalizeLaunchTemplate(input: unknown): LaunchTemplate {
  const defaults = createDefaultLaunchTemplate();
  if (!isObject(input)) {
    return defaults;
  }

  const rawRoles = isObject(input.roles) ? input.roles : {};
  const roles = {} as Record<VcmRoleName, RoleLaunchTemplateEntry>;
  for (const role of VCM_ROLE_NAMES) {
    roles[role] = normalizeRoleLaunchTemplateEntry(rawRoles[role], defaults.roles[role]);
  }

  return {
    version: 1,
    roles,
    autoOrchestration: input.autoOrchestration !== false
  };
}

function normalizeRoleLaunchTemplateEntry(
  input: unknown,
  fallback: RoleLaunchTemplateEntry
): RoleLaunchTemplateEntry {
  const candidate = isObject(input) ? input : {};
  return {
    permissionMode: normalizeClaudePermissionMode(candidate.permissionMode, fallback.permissionMode),
    model: normalizeClaudeModel(candidate.model, fallback.model),
    effort: normalizeSessionEffort(candidate.effort, fallback.effort)
  };
}

function normalizeClaudePermissionMode(
  input: unknown,
  fallback: ClaudePermissionMode
): ClaudePermissionMode {
  if (input === "bypassPermissions" || input === "default") {
    return input;
  }
  return fallback;
}

function normalizeClaudeModel(input: unknown, fallback: ClaudeModel): ClaudeModel {
  if (typeof input !== "string") {
    return fallback;
  }
  const model = CLAUDE_MODEL_OPTIONS.find((option) => option.value === input);
  return model?.value ?? fallback;
}

function normalizeSessionEffort(input: unknown, fallback: SessionEffort): SessionEffort {
  if (typeof input !== "string") {
    return fallback;
  }
  const effort = SESSION_EFFORT_OPTIONS.find((option) => option.value === input);
  return effort?.value ?? fallback;
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
