import type { CodexBridgeConnectionState } from "../../shared/types/app-settings.js";
import {
  CODEX_BRIDGE_BASE_URLS,
  type CodexBridgeModelDescriptor
} from "../../shared/types/session.js";

export interface CodexBridgeProbeResult {
  connectionState: Exclude<CodexBridgeConnectionState, "disabled" | "checking">;
  modelAvailable: boolean;
  models: CodexBridgeModelDescriptor[];
  baseUrl?: string;
  error?: string;
}

export interface CodexBridgeAdapter {
  probe(apiKey: string): Promise<CodexBridgeProbeResult>;
}

export interface CodexBridgeAdapterDeps {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;

export function createCodexBridgeAdapter(
  deps: CodexBridgeAdapterDeps = {}
): CodexBridgeAdapter {
  const baseUrls = (deps.baseUrl ? [deps.baseUrl] : CODEX_BRIDGE_BASE_URLS)
    .map((baseUrl) => baseUrl.replace(/\/+$/, ""));
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async probe(apiKey) {
      const failures: CodexBridgeProbeResult[] = [];
      for (const baseUrl of baseUrls) {
        const result = await probeEndpoint(fetchImpl, baseUrl, apiKey, timeoutMs);
        if (result.baseUrl) {
          return result;
        }
        failures.push(result);
      }
      return combineProbeFailures(baseUrls, failures);
    }
  };
}

async function probeEndpoint(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  apiKey: string,
  timeoutMs: number
): Promise<CodexBridgeProbeResult> {
  try {
    const health = await requestJson(fetchImpl, `${baseUrl}/health`, timeoutMs);
    if (!health.response.ok) {
      return invalidResponse(`Codex Bridge health check at ${baseUrl} returned HTTP ${health.response.status}.`);
    }
    if (!isCodexBridgeHealth(health.payload)) {
      return {
        connectionState: "not-codex-bridge",
        modelAvailable: false,
        models: [],
        error: `${baseUrl} did not identify as Codex Bridge.`
      };
    }

    const headers = {
      authorization: `Bearer ${apiKey}`,
      "user-agent": "VibeCodingMaster"
    };
    const auth = await requestJson(fetchImpl, `${baseUrl}/auth/status`, timeoutMs, headers);
    if (auth.response.status === 401 || auth.response.status === 403) {
      return {
        connectionState: "unauthorized",
        modelAvailable: false,
        models: [],
        baseUrl,
        error: "Codex Bridge rejected the configured API key."
      };
    }
    if (!auth.response.ok) {
      return invalidResponse(
        responseError("Codex Bridge auth status", baseUrl, auth.response, auth.payload),
        baseUrl
      );
    }
    const authState = readAuthState(auth.payload);
    if (!authState) {
      return invalidResponse("Codex Bridge returned an invalid /auth/status response.", baseUrl);
    }
    if (authState.state !== "ready") {
      return {
        connectionState: "codex-auth-unavailable",
        modelAvailable: false,
        models: [],
        baseUrl,
        error: authState.message
          ?? `Codex authentication is ${authState.state}. Open Codex or run codex login, then retry.`
      };
    }

    const modelsResponse = await requestJson(fetchImpl, `${baseUrl}/v1/models`, timeoutMs, headers);
    if (!modelsResponse.response.ok) {
      const code = readErrorCode(modelsResponse.payload);
      const connectionState = code?.startsWith("CODEX_AUTH_")
        ? "codex-auth-unavailable"
        : modelsResponse.response.status === 401 || modelsResponse.response.status === 403
          ? "unauthorized"
          : "invalid-response";
      return {
        connectionState,
        modelAvailable: false,
        models: [],
        baseUrl,
        error: responseError("Codex Bridge model discovery", baseUrl, modelsResponse.response, modelsResponse.payload)
      };
    }

    const models = readModelDescriptors(modelsResponse.payload);
    if (!models) {
      return invalidResponse("Codex Bridge returned an invalid /v1/models response.", baseUrl);
    }
    return {
      connectionState: "available",
      modelAvailable: models.length > 0,
      models,
      baseUrl,
      ...(models.length > 0 ? {} : { error: "Codex Bridge did not expose any models." })
    };
  } catch (error) {
    const timedOut = isAbortError(error);
    return {
      connectionState: "unreachable",
      modelAvailable: false,
      models: [],
      error: timedOut
        ? `Codex Bridge connection timed out after ${timeoutMs} ms at ${baseUrl}.`
        : `Codex Bridge could not be reached from the VCM backend at ${baseUrl}. Reason: ${errorMessage(error)}`
    };
  }
}

function combineProbeFailures(
  baseUrls: string[],
  failures: CodexBridgeProbeResult[]
): CodexBridgeProbeResult {
  const lastFailure = failures.at(-1);
  return {
    connectionState: lastFailure?.connectionState ?? "unreachable",
    modelAvailable: false,
    models: [],
    error: `Codex Bridge was not found at ${baseUrls.join(" or ")}. ${failures
      .map((failure) => failure.error)
      .filter(Boolean)
      .join(" ")}`.trim()
  };
}

async function requestJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {}
): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...headers
      },
      signal: controller.signal
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
}

function isCodexBridgeHealth(value: unknown): boolean {
  return isObject(value)
    && value.status === "ok"
    && value.service === "codex-bridge";
}

function readAuthState(value: unknown): { state: string; message?: string } | undefined {
  if (!isObject(value) || typeof value.state !== "string" || !value.state.trim()) {
    return undefined;
  }
  return {
    state: value.state.trim(),
    ...(typeof value.message === "string" && value.message.trim()
      ? { message: value.message.trim() }
      : {})
  };
}

function readModelDescriptors(value: unknown): CodexBridgeModelDescriptor[] | undefined {
  if (!isObject(value) || !Array.isArray(value.data)) {
    return undefined;
  }
  const models: CodexBridgeModelDescriptor[] = [];
  for (const item of value.data) {
    if (!isObject(item) || typeof item.id !== "string" || !item.id.trim()) {
      return undefined;
    }
    models.push({
      id: item.id.trim(),
      ...(typeof item.display_name === "string" && item.display_name.trim()
        ? { displayName: item.display_name.trim() }
        : {})
    });
  }
  return models;
}

function responseError(
  operation: string,
  baseUrl: string,
  response: Response,
  payload: unknown
): string {
  const message = readErrorMessage(payload);
  return `${operation} at ${baseUrl} returned HTTP ${response.status}.${message ? ` Reason: ${message}` : ""}`;
}

function readErrorCode(value: unknown): string | undefined {
  return isObject(value)
    && isObject(value.error)
    && typeof value.error.code === "string"
    ? value.error.code
    : undefined;
}

function readErrorMessage(value: unknown): string | undefined {
  return isObject(value)
    && isObject(value.error)
    && typeof value.error.message === "string"
    ? value.error.message
    : undefined;
}

function invalidResponse(error: string, baseUrl?: string): CodexBridgeProbeResult {
  return {
    connectionState: "invalid-response",
    modelAvailable: false,
    models: [],
    ...(baseUrl ? { baseUrl } : {}),
    error
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
