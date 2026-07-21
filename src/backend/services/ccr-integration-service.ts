import type {
  CcrIntegrationStatus,
  UpdateCcrIntegrationRequest
} from "../../shared/types/app-settings.js";
import {
  CCR_GATEWAY_BASE_URL,
  CCR_GPT_MODEL_ID,
  CCR_GPT_SESSION_MODEL,
  createSessionModelOptions,
  isCcrSessionModel,
  type SessionModel
} from "../../shared/types/session.js";
import type { CcrGatewayAdapter, CcrGatewayProbeResult } from "../adapters/ccr-gateway-adapter.js";
import { VcmError } from "../errors.js";
import type { AppSettingsService } from "./app-settings-service.js";

export interface CcrIntegrationService {
  initialize(): Promise<void>;
  getStatus(): Promise<CcrIntegrationStatus>;
  updateSettings(input: UpdateCcrIntegrationRequest): Promise<CcrIntegrationStatus>;
  checkConnection(): Promise<CcrIntegrationStatus>;
  getLaunchEnvironment(model: SessionModel): Promise<NodeJS.ProcessEnv>;
}

export interface CcrIntegrationServiceDeps {
  settings: Pick<AppSettingsService, "getCcrIntegrationSettings" | "updateCcrIntegrationSettings">;
  gateway: CcrGatewayAdapter;
  now?: () => Date;
  cacheTtlMs?: number;
  baseEnv?: NodeJS.ProcessEnv;
}

const DEFAULT_CACHE_TTL_MS = 10_000;

interface CachedProbe {
  result: CcrGatewayProbeResult;
  checkedAt: string;
  checkedAtMs: number;
}

export function createCcrIntegrationService(deps: CcrIntegrationServiceDeps): CcrIntegrationService {
  const now = deps.now ?? (() => new Date());
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  let cachedProbe: CachedProbe | undefined;
  let inFlight: Promise<CachedProbe> | undefined;

  async function probe(force = false): Promise<CachedProbe> {
    const settings = await deps.settings.getCcrIntegrationSettings();
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
    inFlight = deps.gateway.probe(settings.apiKey).then((result) => {
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

  async function buildStatus(options: { refreshIfMissing?: boolean } = {}): Promise<CcrIntegrationStatus> {
    const settings = await deps.settings.getCcrIntegrationSettings();
    if (!settings.enabled) {
      return createStatus({
        enabled: false,
        apiKeyConfigured: Boolean(settings.apiKey),
        connectionState: "disabled",
        modelAvailable: false,
        error: settings.apiKey ? undefined : "Save a CCR API key before enabling CCR GPT models."
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
        modelAvailable: false
      });
    }
    return createStatus({
      enabled: true,
      apiKeyConfigured: true,
      connectionState: cachedProbe.result.connectionState,
      modelAvailable: cachedProbe.result.modelAvailable,
      checkedAt: cachedProbe.checkedAt,
      error: cachedProbe.result.error
    });
  }

  return {
    async initialize() {
      const settings = await deps.settings.getCcrIntegrationSettings();
      if (settings.enabled) {
        await probe(true);
      }
    },
    async getStatus() {
      return buildStatus({ refreshIfMissing: true });
    },
    async updateSettings(input) {
      if (input.apiKey !== undefined && typeof input.apiKey !== "string") {
        throw invalidSettingsError("CCR API key must be a string.");
      }
      if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
        throw invalidSettingsError("CCR enabled state must be a boolean.");
      }
      if (input.clearApiKey !== undefined && typeof input.clearApiKey !== "boolean") {
        throw invalidSettingsError("CCR clear-key state must be a boolean.");
      }
      const current = await deps.settings.getCcrIntegrationSettings();
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
      await deps.settings.updateCcrIntegrationSettings({
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
      const settings = await deps.settings.getCcrIntegrationSettings();
      if (!settings.enabled) {
        throw new VcmError({
          code: "CCR_DISABLED",
          message: "CCR GPT models are disabled.",
          statusCode: 409,
          hint: "Save the CCR API key and enable CCR GPT models before checking the connection."
        });
      }
      await probe(true);
      return buildStatus();
    },
    async getLaunchEnvironment(model) {
      if (!isCcrSessionModel(model)) {
        return {};
      }
      const settings = await deps.settings.getCcrIntegrationSettings();
      if (!settings.enabled) {
        throw new VcmError({
          code: "CCR_DISABLED",
          message: "CCR GPT models are disabled.",
          statusCode: 409,
          hint: "Enable CCR GPT models in VCM Settings before starting this session."
        });
      }
      const checked = await probe();
      if (checked.result.connectionState !== "available" || !checked.result.modelAvailable) {
        throw new VcmError({
          code: "CCR_MODEL_UNAVAILABLE",
          message: checked.result.error ?? `CCR model ${CCR_GPT_MODEL_ID} is unavailable.`,
          statusCode: 409,
          hint: "Check that host CCR is running on port 3456 and exposes GPT-5.6 Sol."
        });
      }

      const gatewayBaseUrl = checked.result.baseUrl ?? CCR_GATEWAY_BASE_URL;
      const gatewayHost = new URL(gatewayBaseUrl).hostname;
      const noProxy = mergeNoProxy(
        deps.baseEnv?.NO_PROXY ?? deps.baseEnv?.no_proxy ?? process.env.NO_PROXY ?? process.env.no_proxy,
        gatewayHost
      );
      return {
        ANTHROPIC_BASE_URL: gatewayBaseUrl,
        ANTHROPIC_API_BASE_URL: gatewayBaseUrl,
        CLAUDE_AGENT_API_BASE_URL: gatewayBaseUrl,
        ANTHROPIC_AUTH_TOKEN: undefined,
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_MODEL: CCR_GPT_MODEL_ID,
        CCR_CLAUDE_CODE_MODEL: CCR_GPT_MODEL_ID,
        CODEXL_CLAUDE_CODE_MODEL: CCR_GPT_MODEL_ID,
        ANTHROPIC_SMALL_FAST_MODEL: CCR_GPT_MODEL_ID,
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        NO_PROXY: noProxy,
        no_proxy: noProxy
      };
    }
  };
}

function createStatus(input: Omit<CcrIntegrationStatus, "modelOptions">): CcrIntegrationStatus {
  const reason = input.error
    ?? (input.enabled ? "CCR GPT-5.6 Sol is unavailable." : "Enable CCR GPT models in Settings.");
  return {
    ...input,
    modelOptions: createSessionModelOptions(input.enabled && input.modelAvailable, reason)
  };
}

function missingApiKeyError(): VcmError {
  return new VcmError({
    code: "CCR_API_KEY_MISSING",
    message: "CCR API key is not configured.",
    statusCode: 400,
    hint: "Save the CCR API key before enabling CCR GPT models."
  });
}

function invalidSettingsError(message: string): VcmError {
  return new VcmError({
    code: "CCR_SETTINGS_INVALID",
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
