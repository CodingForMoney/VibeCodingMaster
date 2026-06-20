import { VCM_ROLE_NAMES } from "../constants.js";
import type { VcmRoleName } from "./role.js";
import type { ClaudeModel, ClaudePermissionMode, SessionEffort } from "./session.js";

export type ThemeMode = "system" | "light" | "dark";
export type PermissionRequestMode = "off" | "allowAll";
export type TranslationTargetLanguage = "zh-CN" | "ja" | "ko" | "fr" | "de" | "es";
export type TranslationOutputMode = "final-only" | "all";

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
  model: ClaudeModel;
  effort: SessionEffort;
}

export interface LaunchTemplate {
  version: 1;
  roles: Record<VcmRoleName, RoleLaunchTemplateEntry>;
  autoOrchestration: boolean;
}

export interface AppPreferences {
  themeMode: ThemeMode;
  flowPauseAlerts: boolean;
  permissionRequestMode: PermissionRequestMode;
  translationEnabled: boolean;
  translationAutoSendEnabled: boolean;
  translationTargetLanguage: TranslationTargetLanguage;
  translationOutputMode: TranslationOutputMode;
  launchTemplate: LaunchTemplate;
}

export interface UpdateAppPreferencesRequest {
  themeMode?: ThemeMode;
  flowPauseAlerts?: boolean;
  roundCompletionAlerts?: boolean;
  permissionRequestMode?: PermissionRequestMode;
  translationEnabled?: boolean;
  translationAutoSendEnabled?: boolean;
  translationTargetLanguage?: TranslationTargetLanguage;
  translationOutputMode?: TranslationOutputMode;
  launchTemplate?: LaunchTemplate;
}

export const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"] as const;
export const PERMISSION_REQUEST_MODES: readonly PermissionRequestMode[] = ["off", "allowAll"] as const;
export const DEFAULT_TRANSLATION_TARGET_LANGUAGE: TranslationTargetLanguage = "zh-CN";
export const DEFAULT_TRANSLATION_OUTPUT_MODE: TranslationOutputMode = "final-only";
export const TRANSLATION_TARGET_LANGUAGE_OPTIONS: readonly TranslationTargetLanguageOption[] = [
  { value: "zh-CN", label: "Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "es", label: "Spanish" }
] as const;
export const TRANSLATION_OUTPUT_MODE_OPTIONS: readonly TranslationOutputModeOption[] = [
  { value: "final-only", label: "Final summary" },
  { value: "all", label: "All output" }
] as const;

export function createDefaultLaunchTemplate(): LaunchTemplate {
  const roles = {} as Record<VcmRoleName, RoleLaunchTemplateEntry>;
  for (const role of VCM_ROLE_NAMES) {
    roles[role] = {
      permissionMode: "default",
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
