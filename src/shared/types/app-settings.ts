export type ThemeMode = "system" | "light" | "dark";

export interface AppPreferences {
  themeMode: ThemeMode;
  roundCompletionAlerts: boolean;
}

export interface UpdateAppPreferencesRequest {
  themeMode?: ThemeMode;
  roundCompletionAlerts?: boolean;
}

export const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"] as const;
