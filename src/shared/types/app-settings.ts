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

export type CcrConnectionState =
  | "disabled"
  | "checking"
  | "available"
  | "unreachable"
  | "unauthorized"
  | "not-ccr"
  | "invalid-response";

export interface CcrIntegrationStatus {
  enabled: boolean;
  apiKeyConfigured: boolean;
  connectionState: CcrConnectionState;
  modelAvailable: boolean;
  checkedAt?: string;
  error?: string;
  modelOptions: SessionModelOption[];
}

export interface UpdateCcrIntegrationRequest {
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
