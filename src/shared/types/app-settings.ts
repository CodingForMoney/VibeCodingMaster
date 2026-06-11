import { ROLE_NAMES } from "../constants.js";
import type { RoleName } from "./role.js";
import type { ClaudeModel, ClaudePermissionMode } from "./session.js";

export type ThemeMode = "system" | "light" | "dark";
export type PermissionRequestMode = "off" | "allowAll";

export interface RoleLaunchTemplateEntry {
  permissionMode: ClaudePermissionMode;
  model: ClaudeModel;
}

export interface LaunchTemplate {
  version: 1;
  roles: Record<RoleName, RoleLaunchTemplateEntry>;
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
  const roles = {} as Record<RoleName, RoleLaunchTemplateEntry>;
  for (const role of ROLE_NAMES) {
    roles[role] = {
      permissionMode: "default",
      model: "default"
    };
  }

  return {
    version: 1,
    roles,
    autoOrchestration: true,
    translationEnabled: true
  };
}
