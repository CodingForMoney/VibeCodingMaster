import { VCM_ROLE_NAMES } from "../constants.js";
import type { ToolRoleName, VcmRoleName } from "./role.js";
import type {
  ClaudePermissionMode,
  SessionEffort,
  SessionModel,
  SessionModelOption
} from "./session.js";

export type ThemeMode = "system" | "light" | "dark";
export type PermissionRequestMode = "off" | "allowAll";
export type TranslationTargetLanguage = "zh-CN" | "ja" | "ko" | "fr" | "de" | "es";
export type TranslationOutputMode = "round-final" | "pm-final-only" | "final-only" | "all";

export interface TranslationTargetLanguageOption {
  value: TranslationTargetLanguage;
  label: string;
}

export interface TranslationOutputModeOption {
  value: TranslationOutputMode;
  label: string;
}

export interface RoleLaunchTemplateEntry {
  permissionMode: ClaudePermissionMode;
  model: SessionModel;
  effort: SessionEffort;
}

export type CodexBridgeConnectionState =
  | "disabled"
  | "checking"
  | "available"
  | "unreachable"
  | "unauthorized"
  | "codex-auth-unavailable"
  | "not-codex-bridge"
  | "invalid-response";

export interface CodexBridgeIntegrationStatus {
  enabled: boolean;
  apiKeyConfigured: boolean;
  connectionState: CodexBridgeConnectionState;
  modelAvailable: boolean;
  checkedAt?: string;
  error?: string;
  modelOptions: SessionModelOption[];
}

export interface UpdateCodexBridgeIntegrationRequest {
  enabled?: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface LaunchTemplate {
  version: 1;
  roles: Record<VcmRoleName, RoleLaunchTemplateEntry>;
  autoOrchestration: boolean;
}

export type ToolSessionDefaults = Record<ToolRoleName, RoleLaunchTemplateEntry>;

export const ARCHITECT_WORKER_TYPES = ["evidence", "scaffold", "validation"] as const;
export type ArchitectWorkerType = typeof ARCHITECT_WORKER_TYPES[number];
// "inherit" runs the worker on the parent Architect Session's model.
export const ARCHITECT_WORKER_MODELS = ["inherit", "fable", "opus", "sonnet"] as const;
export type ArchitectWorkerModel = typeof ARCHITECT_WORKER_MODELS[number];
// "default" omits effort from the worker definition.
export const ARCHITECT_WORKER_EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"] as const;
export type ArchitectWorkerEffort = typeof ARCHITECT_WORKER_EFFORTS[number];

export interface ArchitectWorkerSetting {
  model: ArchitectWorkerModel;
  effort: ArchitectWorkerEffort;
}

export type ArchitectWorkerSettings = Record<ArchitectWorkerType, ArchitectWorkerSetting>;

// Workers run cheaper than the Architect that delegates to them: evidence reading
// still needs judgment, while scaffold and validation execution are mechanical.
export const DEFAULT_ARCHITECT_WORKER_SETTINGS: ArchitectWorkerSettings = {
  evidence: { model: "opus", effort: "high" },
  scaffold: { model: "sonnet", effort: "medium" },
  validation: { model: "sonnet", effort: "low" }
};

export function normalizeArchitectWorkerSettings(input: unknown): ArchitectWorkerSettings {
  const candidate = input && typeof input === "object" ? input as Partial<Record<ArchitectWorkerType, unknown>> : {};
  const normalized = {} as ArchitectWorkerSettings;
  for (const type of ARCHITECT_WORKER_TYPES) {
    const entry = candidate[type] && typeof candidate[type] === "object"
      ? candidate[type] as Partial<Record<keyof ArchitectWorkerSetting, unknown>>
      : {};
    const fallback = DEFAULT_ARCHITECT_WORKER_SETTINGS[type];
    normalized[type] = {
      model: ARCHITECT_WORKER_MODELS.includes(entry.model as ArchitectWorkerModel)
        ? entry.model as ArchitectWorkerModel
        : fallback.model,
      effort: ARCHITECT_WORKER_EFFORTS.includes(entry.effort as ArchitectWorkerEffort)
        ? entry.effort as ArchitectWorkerEffort
        : fallback.effort
    };
  }
  return normalized;
}

export interface AppPreferences {
  themeMode: ThemeMode;
  flowPauseAlerts: boolean;
  roleRetryEnabled: boolean;
  permissionRequestMode: PermissionRequestMode;
  autoTaskHarnessReviewEnabled: boolean;
  autoMemoryEnabled: boolean;
  translationEnabled: boolean;
  translationAutoSendEnabled: boolean;
  translationTargetLanguage: TranslationTargetLanguage;
  translationOutputMode: TranslationOutputMode;
  launchTemplate: LaunchTemplate;
  toolSessionDefaults: ToolSessionDefaults;
  architectWorkerSettings: ArchitectWorkerSettings;
}

export interface UpdateAppPreferencesRequest {
  themeMode?: ThemeMode;
  flowPauseAlerts?: boolean;
  roleRetryEnabled?: boolean;
  roundCompletionAlerts?: boolean;
  permissionRequestMode?: PermissionRequestMode;
  autoTaskHarnessReviewEnabled?: boolean;
  autoMemoryEnabled?: boolean;
  translationEnabled?: boolean;
  translationAutoSendEnabled?: boolean;
  translationTargetLanguage?: TranslationTargetLanguage;
  translationOutputMode?: TranslationOutputMode;
  launchTemplate?: LaunchTemplate;
  architectWorkerSettings?: ArchitectWorkerSettings;
}

export const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"] as const;
export const PERMISSION_REQUEST_MODES: readonly PermissionRequestMode[] = ["off", "allowAll"] as const;
export const DEFAULT_TRANSLATION_TARGET_LANGUAGE: TranslationTargetLanguage = "zh-CN";
export const DEFAULT_TRANSLATION_OUTPUT_MODE: TranslationOutputMode = "pm-final-only";
export const TRANSLATION_TARGET_LANGUAGE_OPTIONS: readonly TranslationTargetLanguageOption[] = [
  { value: "zh-CN", label: "Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "es", label: "Spanish" }
] as const;
export const TRANSLATION_OUTPUT_MODE_OPTIONS: readonly TranslationOutputModeOption[] = [
  { value: "round-final", label: "Round final reply" },
  { value: "pm-final-only", label: "PM final reply" },
  { value: "final-only", label: "Each role final reply" },
  { value: "all", label: "All replies" }
] as const;

export function createDefaultLaunchTemplate(): LaunchTemplate {
  const roles = {} as Record<VcmRoleName, RoleLaunchTemplateEntry>;
  for (const role of VCM_ROLE_NAMES) {
    roles[role] = {
      permissionMode: "bypassPermissions",
      model: "default",
      effort: "default"
    };
  }

  return {
    version: 1,
    roles,
    autoOrchestration: true
  };
}

export function createDefaultToolSessionDefaults(): ToolSessionDefaults {
  return {
    translator: {
      permissionMode: "bypassPermissions",
      model: "default",
      effort: "medium"
    },
    "harness-engineer": {
      permissionMode: "bypassPermissions",
      model: "default",
      effort: "medium"
    }
  };
}
