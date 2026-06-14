import { VCM_ROLE_NAMES } from "../constants.js";
import type { VcmRoleName } from "./role.js";
import type { ClaudeModel, ClaudePermissionMode, SessionEffort } from "./session.js";

export type ThemeMode = "system" | "light" | "dark";
export type PermissionRequestMode = "off" | "allowAll";

export interface RoleLaunchTemplateEntry {
  permissionMode: ClaudePermissionMode;
  model: ClaudeModel;
  effort: SessionEffort;
}

export interface LaunchTemplate {
  version: 1;
  roles: Record<VcmRoleName, RoleLaunchTemplateEntry>;
  autoOrchestration: boolean;
  translationEnabled: boolean;
}

export interface AppPreferences {
  themeMode: ThemeMode;
  flowPauseAlerts: boolean;
  permissionRequestMode: PermissionRequestMode;
  launchTemplate: LaunchTemplate;
}

export interface UpdateAppPreferencesRequest {
  themeMode?: ThemeMode;
  flowPauseAlerts?: boolean;
  roundCompletionAlerts?: boolean;
  permissionRequestMode?: PermissionRequestMode;
  launchTemplate?: LaunchTemplate;
}

export const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"] as const;
export const PERMISSION_REQUEST_MODES: readonly PermissionRequestMode[] = ["off", "allowAll"] as const;

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
    autoOrchestration: true,
    translationEnabled: true
  };
}
