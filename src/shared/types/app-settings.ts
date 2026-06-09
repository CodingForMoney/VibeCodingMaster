export type ThemeMode = "system" | "light" | "dark";

export interface AppPreferences {
  themeMode: ThemeMode;
  flowPauseAlerts: boolean;
}

export interface UpdateAppPreferencesRequest {
  themeMode?: ThemeMode;
  flowPauseAlerts?: boolean;
  roundCompletionAlerts?: boolean;
}

export const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"] as const;
