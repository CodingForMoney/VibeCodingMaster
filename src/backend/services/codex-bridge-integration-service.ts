import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CodexBridgeIntegrationStatus,
  UpdateCodexBridgeIntegrationRequest
} from "../../shared/types/app-settings.js";
import {
  CODEX_BRIDGE_AUTO_COMPACT_PERCENT,
  CODEX_BRIDGE_AUTO_COMPACT_WINDOW_TOKENS,
  CODEX_BRIDGE_BASE_URL,
  CODEX_BRIDGE_EFFECTIVE_CONTEXT_TOKENS,
  createSessionModelOptions,
  getCodexBridgeModelId,
  isCodexBridgeSessionModel,
  type CodexBridgeModelDescriptor,
  type SessionModel
} from "../../shared/types/session.js";
import type {
  CodexBridgeAdapter,
  CodexBridgeProbeResult
} from "../adapters/codex-bridge-adapter.js";
import { VcmError } from "../errors.js";
import { resolveVcmDataDir } from "../vcm-data-dir.js";
import type { AppSettingsService } from "./app-settings-service.js";

export interface CodexBridgeIntegrationService {
  initialize(): Promise<void>;
  getStatus(): Promise<CodexBridgeIntegrationStatus>;
  updateSettings(input: UpdateCodexBridgeIntegrationRequest): Promise<CodexBridgeIntegrationStatus>;
  checkConnection(): Promise<CodexBridgeIntegrationStatus>;
  getLaunchEnvironment(model: SessionModel): Promise<NodeJS.ProcessEnv>;
  getLaunchSettingsOverride(model: SessionModel): Promise<Record<string, unknown> | undefined>;
}

export interface CodexBridgeIntegrationServiceDeps {
  settings: Pick<
    AppSettingsService,
    "getCodexBridgeIntegrationSettings" | "updateCodexBridgeIntegrationSettings"
  >;
  bridge: CodexBridgeAdapter;
  now?: () => Date;
  cacheTtlMs?: number;
  baseEnv?: NodeJS.ProcessEnv;
  configDir?: string;
  apiKeyHelperPath?: string;
}

const DEFAULT_CACHE_TTL_MS = 10_000;
const DEFAULT_API_KEY_HELPER_PATH = fileURLToPath(
  new URL("../../../scripts/codex-bridge-api-key-helper.mjs", import.meta.url)
);

interface CachedProbe {
  result: CodexBridgeProbeResult;
  checkedAt: string;
  checkedAtMs: number;
}

export function createCodexBridgeIntegrationService(
  deps: CodexBridgeIntegrationServiceDeps
): CodexBridgeIntegrationService {
  const now = deps.now ?? (() => new Date());
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const baseEnv = deps.baseEnv ?? process.env;
  const configDir = deps.configDir ?? path.join(resolveVcmDataDir(baseEnv), "claude", "codex-bridge");
  let cachedProbe: CachedProbe | undefined;
  let inFlight: Promise<CachedProbe> | undefined;

  async function probe(force = false): Promise<CachedProbe> {
    const settings = await deps.settings.getCodexBridgeIntegrationSettings();
    if (!settings.apiKey) {
      throw missingApiKeyError();
    }
    const currentTime = now();
    if (!force && cachedProbe && currentTime.getTime() - cachedProbe.checkedAtMs <= cacheTtlMs) {
      return cachedProbe;
    }
    if (inFlight) {
      return inFlight;
    }
    inFlight = deps.bridge.probe(settings.apiKey).then((result) => {
      const checkedAtDate = now();
      cachedProbe = {
        result,
        checkedAt: checkedAtDate.toISOString(),
        checkedAtMs: checkedAtDate.getTime()
      };
      return cachedProbe;
    }).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  async function buildStatus(
    options: { refreshIfMissing?: boolean } = {}
  ): Promise<CodexBridgeIntegrationStatus> {
    const settings = await deps.settings.getCodexBridgeIntegrationSettings();
    if (!settings.enabled) {
      return createStatus({
        enabled: false,
        apiKeyConfigured: Boolean(settings.apiKey),
        connectionState: "disabled",
        modelAvailable: false,
        models: [],
        error: settings.apiKey ? undefined : "Save a Codex Bridge API key before enabling Codex models."
      });
    }
    if (!cachedProbe && options.refreshIfMissing) {
      await probe();
    }
    if (!cachedProbe) {
      return createStatus({
        enabled: true,
        apiKeyConfigured: true,
        connectionState: "checking",
        modelAvailable: false,
        models: []
      });
    }
    return createStatus({
      enabled: true,
      apiKeyConfigured: true,
      connectionState: cachedProbe.result.connectionState,
      modelAvailable: cachedProbe.result.modelAvailable,
      models: cachedProbe.result.models,
      checkedAt: cachedProbe.checkedAt,
      error: cachedProbe.result.error
    });
  }

  return {
    async initialize() {
      const settings = await deps.settings.getCodexBridgeIntegrationSettings();
      if (settings.enabled) {
        await probe(true);
      }
    },
    async getStatus() {
      return buildStatus({ refreshIfMissing: true });
    },
    async updateSettings(input) {
      if (input.apiKey !== undefined && typeof input.apiKey !== "string") {
        throw invalidSettingsError("Codex Bridge API key must be a string.");
      }
      if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
        throw invalidSettingsError("Codex Bridge enabled state must be a boolean.");
      }
      if (input.clearApiKey !== undefined && typeof input.clearApiKey !== "boolean") {
        throw invalidSettingsError("Codex Bridge clear-key state must be a boolean.");
      }
      const current = await deps.settings.getCodexBridgeIntegrationSettings();
      const clearApiKey = input.clearApiKey === true;
      const nextApiKey = clearApiKey
        ? ""
        : input.apiKey === undefined
          ? current.apiKey
          : input.apiKey.trim();
      const nextEnabled = clearApiKey ? false : input.enabled ?? current.enabled;
      if (nextEnabled && !nextApiKey) {
        throw missingApiKeyError();
      }
      await deps.settings.updateCodexBridgeIntegrationSettings({
        enabled: nextEnabled,
        apiKey: nextApiKey
      });
      if (clearApiKey || !nextEnabled) {
        cachedProbe = undefined;
        return buildStatus();
      }
      if (input.apiKey !== undefined || input.enabled === true) {
        cachedProbe = undefined;
        await probe(true);
      }
      return buildStatus();
    },
    async checkConnection() {
      const settings = await deps.settings.getCodexBridgeIntegrationSettings();
      if (!settings.enabled) {
        throw new VcmError({
          code: "CODEX_BRIDGE_DISABLED",
          message: "Codex Bridge models are disabled.",
          statusCode: 409,
          hint: "Save the Codex Bridge API key and enable Codex models before checking the connection."
        });
      }
      await probe(true);
      return buildStatus();
    },
    async getLaunchEnvironment(model) {
      if (!isCodexBridgeSessionModel(model)) {
        return buildNativeLaunchEnvironment(baseEnv);
      }
      const settings = await deps.settings.getCodexBridgeIntegrationSettings();
      if (!settings.enabled) {
        throw new VcmError({
          code: "CODEX_BRIDGE_DISABLED",
          message: "Codex Bridge models are disabled.",
          statusCode: 409,
          hint: "Enable Codex Bridge in VCM Settings before starting this session."
        });
      }
      const checked = await probe();
      const modelId = getCodexBridgeModelId(model);
      const modelAvailable = checked.result.models.some((available) => available.id === modelId);
      if (checked.result.connectionState !== "available" || !modelAvailable) {
        throw new VcmError({
          code: "CODEX_BRIDGE_MODEL_UNAVAILABLE",
          message: checked.result.error ?? `Codex Bridge model ${modelId} is unavailable.`,
          statusCode: 409,
          hint: "Check Codex Bridge on port 3456, refresh its Codex login, and verify the selected model."
        });
      }

      const bridgeBaseUrl = checked.result.baseUrl ?? CODEX_BRIDGE_BASE_URL;
      const bridgeHost = new URL(bridgeBaseUrl).hostname;
      const noProxy = mergeNoProxy(
        deps.baseEnv?.NO_PROXY ?? deps.baseEnv?.no_proxy ?? process.env.NO_PROXY ?? process.env.no_proxy,
        bridgeHost
      );
      return {
        ANTHROPIC_BASE_URL: bridgeBaseUrl,
        ANTHROPIC_API_BASE_URL: bridgeBaseUrl,
        CLAUDE_AGENT_API_BASE_URL: bridgeBaseUrl,
        ANTHROPIC_AUTH_TOKEN: undefined,
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_MODEL: modelId,
        CODEX_BRIDGE_CLAUDE_MODEL: modelId,
        ANTHROPIC_SMALL_FAST_MODEL: modelId,
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        CLAUDE_CODE_SUBAGENT_MODEL: modelId,
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(CODEX_BRIDGE_EFFECTIVE_CONTEXT_TOKENS),
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CODEX_BRIDGE_AUTO_COMPACT_WINDOW_TOKENS),
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(CODEX_BRIDGE_AUTO_COMPACT_PERCENT),
        CLAUDE_CONFIG_DIR: configDir,
        NO_PROXY: noProxy,
        no_proxy: noProxy
      };
    },
    async getLaunchSettingsOverride(model) {
      if (!isCodexBridgeSessionModel(model)) {
        return undefined;
      }
      return {
        apiKeyHelper: buildApiKeyHelperCommand(deps.apiKeyHelperPath ?? DEFAULT_API_KEY_HELPER_PATH)
      };
    }
  };
}

const BRIDGE_BASE_URL_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_BASE_URL",
  "CLAUDE_AGENT_API_BASE_URL"
] as const;

const BRIDGE_MODEL_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL"
] as const;

const BRIDGE_ONLY_ENV_KEYS = [
  "CODEX_BRIDGE_CLAUDE_MODEL",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"
] as const;

export function buildNativeLaunchEnvironment(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  let inheritedBridgeTakeover = false;

  if (baseEnv.CLAUDE_CONFIG_DIR?.trim()) {
    environment.CLAUDE_CONFIG_DIR = baseEnv.CLAUDE_CONFIG_DIR.trim();
  }

  for (const key of BRIDGE_BASE_URL_KEYS) {
    if (isCodexBridgeUrl(baseEnv[key])) {
      environment[key] = undefined;
      inheritedBridgeTakeover = true;
    }
  }
  for (const key of BRIDGE_MODEL_KEYS) {
    if (isCodexBridgeModelName(baseEnv[key], baseEnv.CODEX_BRIDGE_CLAUDE_MODEL)) {
      environment[key] = undefined;
      inheritedBridgeTakeover = true;
    }
  }
  for (const key of BRIDGE_ONLY_ENV_KEYS) {
    if (baseEnv[key] !== undefined) {
      environment[key] = undefined;
      inheritedBridgeTakeover = true;
    }
  }
  if (inheritedBridgeTakeover) {
    environment.ANTHROPIC_AUTH_TOKEN = undefined;
    environment.ANTHROPIC_API_KEY = undefined;
  }
  return environment;
}

function isCodexBridgeUrl(value: string | undefined): boolean {
  if (!value) {
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

function isCodexBridgeModelName(value: string | undefined, bridgeModel: string | undefined): boolean {
  return Boolean(value && bridgeModel && value === bridgeModel);
}

function createStatus(input: Omit<CodexBridgeIntegrationStatus, "modelOptions"> & {
  models: readonly CodexBridgeModelDescriptor[];
}): CodexBridgeIntegrationStatus {
  const { models, ...status } = input;
  const reason = input.error
    ?? (input.enabled ? "Codex Bridge models are unavailable." : "Enable Codex Bridge in Settings.");
  return {
    ...status,
    modelOptions: createSessionModelOptions(
      models,
      input.enabled && input.modelAvailable ? undefined : reason
    )
  };
}

function missingApiKeyError(): VcmError {
  return new VcmError({
    code: "CODEX_BRIDGE_API_KEY_MISSING",
    message: "Codex Bridge API key is not configured.",
    statusCode: 400,
    hint: "Save the Codex Bridge API key before enabling Codex models."
  });
}

function invalidSettingsError(message: string): VcmError {
  return new VcmError({
    code: "CODEX_BRIDGE_SETTINGS_INVALID",
    message,
    statusCode: 400
  });
}

export function mergeNoProxy(current: string | undefined, host: string): string {
  const values = (current ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.includes(host)) {
    values.push(host);
  }
  return values.join(",");
}

export function buildApiKeyHelperCommand(helperPath: string): string {
  if (process.platform === "win32") {
    return `${JSON.stringify(process.execPath)} ${JSON.stringify(helperPath)}`;
  }
  return `${quotePosixShell(process.execPath)} ${quotePosixShell(helperPath)}`;
}

function quotePosixShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
