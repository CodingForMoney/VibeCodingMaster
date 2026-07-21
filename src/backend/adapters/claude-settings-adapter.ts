import { homedir } from "node:os";
import path from "node:path";
import type { FileSystemAdapter } from "./filesystem.js";

export interface ClaudeSettingsAdapter {
  restoreNativeSettings(): Promise<boolean>;
}

export interface ClaudeSettingsAdapterDeps {
  fs: FileSystemAdapter;
  settingsPath?: string;
  env?: NodeJS.ProcessEnv;
}

const CCR_ENV_KEYS = [
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_BASE_URL",
  "CLAUDE_AGENT_API_BASE_URL",
  "ANTHROPIC_MODEL",
  "CCR_CLAUDE_CODE_MODEL",
  "CODEXL_CLAUDE_CODE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL"
] as const;

export function createClaudeSettingsAdapter(deps: ClaudeSettingsAdapterDeps): ClaudeSettingsAdapter {
  const settingsPath = deps.settingsPath ?? resolveClaudeSettingsPath(deps.env ?? process.env);
  return {
    async restoreNativeSettings() {
      if (!(await deps.fs.pathExists(settingsPath))) {
        return false;
      }
      const current = await deps.fs.readJson<unknown>(settingsPath);
      const restored = restoreNativeClaudeSettings(current);
      if (!restored.changed) {
        return false;
      }
      await deps.fs.writeJsonAtomic(settingsPath, restored.settings);
      return true;
    }
  };
}

export function restoreNativeClaudeSettings(value: unknown): {
  changed: boolean;
  settings: Record<string, unknown>;
} {
  const settings = isObject(value) ? structuredClone(value) : {};
  const helperIsCcr = typeof settings.apiKeyHelper === "string"
    && settings.apiKeyHelper.includes(".claude-code-router");
  const env = isObject(settings.env) ? settings.env : undefined;
  const envUsesCcr = env
    ? ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_BASE_URL", "CLAUDE_AGENT_API_BASE_URL"]
        .some((key) => isCcrGatewayUrl(env[key]))
    : false;

  if (!helperIsCcr && !envUsesCcr) {
    return { changed: false, settings };
  }

  let changed = false;
  if (helperIsCcr) {
    delete settings.apiKeyHelper;
    changed = true;
  }
  if (env) {
    for (const key of CCR_ENV_KEYS) {
      if (key in env) {
        delete env[key];
        changed = true;
      }
    }
    if (Object.keys(env).length === 0) {
      delete settings.env;
    }
  }
  return { changed, settings };
}

function resolveClaudeSettingsPath(env: NodeJS.ProcessEnv): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(configDir ? path.resolve(configDir) : path.join(homedir(), ".claude"), "settings.json");
}

function isCcrGatewayUrl(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return url.port === "3456"
      && ["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
