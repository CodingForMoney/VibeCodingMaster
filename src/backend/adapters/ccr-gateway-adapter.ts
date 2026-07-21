import {
  CCR_GATEWAY_BASE_URL,
  CCR_GPT_MODEL_ID
} from "../../shared/types/session.js";
import type { CcrConnectionState } from "../../shared/types/app-settings.js";

export interface CcrGatewayProbeResult {
  connectionState: Exclude<CcrConnectionState, "disabled" | "checking">;
  modelAvailable: boolean;
  error?: string;
}

export interface CcrGatewayAdapter {
  probe(apiKey: string): Promise<CcrGatewayProbeResult>;
}

export interface CcrGatewayAdapterDeps {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const CCR_ENCODED_MODEL_PREFIX = "anthropic/claude-ccr-h";

interface CcrModelDescriptor {
  id: string;
  displayName?: string;
}

export function createCcrGatewayAdapter(deps: CcrGatewayAdapterDeps = {}): CcrGatewayAdapter {
  const baseUrl = (deps.baseUrl ?? CCR_GATEWAY_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async probe(apiKey) {
      try {
        const root = await requestJson(fetchImpl, `${baseUrl}/`, timeoutMs);
        if (!root.response.ok) {
          return invalidResponse(`CCR gateway root returned HTTP ${root.response.status}.`);
        }
        if (!isCcrGateway(root.payload)) {
          return {
            connectionState: "not-ccr",
            modelAvailable: false,
            error: `The fixed CCR endpoint ${baseUrl} did not identify a Claude Code Router gateway.`
          };
        }

        const models = await requestJson(fetchImpl, `${baseUrl}/v1/models`, timeoutMs, {
          authorization: `Bearer ${apiKey}`,
          "user-agent": "Claude Code"
        });
        if (models.response.status === 401 || models.response.status === 403) {
          return {
            connectionState: "unauthorized",
            modelAvailable: false,
            error: "CCR rejected the configured API key."
          };
        }
        if (!models.response.ok) {
          return invalidResponse(`CCR model discovery returned HTTP ${models.response.status}.`);
        }

        const modelDescriptors = readModelDescriptors(models.payload);
        if (!modelDescriptors) {
          return invalidResponse("CCR returned an invalid /v1/models response.");
        }
        const modelAvailable = modelDescriptors.some(isRequiredModel);
        return {
          connectionState: "available",
          modelAvailable,
          ...(modelAvailable
            ? {}
            : { error: `CCR does not expose the required model ${CCR_GPT_MODEL_ID}.` })
        };
      } catch (error) {
        const timedOut = isAbortError(error);
        return {
          connectionState: "unreachable",
          modelAvailable: false,
          error: timedOut
            ? `CCR connection timed out after ${timeoutMs} ms at ${baseUrl}.`
            : `CCR could not be reached from the VCM container backend at ${baseUrl}. Reason: ${errorMessage(error)}`
        };
      }
    }
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

function isCcrGateway(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }
  return value.name === "claude-code-router"
    || value.plugin === "claude-code-router"
    || value.core === "next-ai-gateway";
}

function readModelDescriptors(value: unknown): CcrModelDescriptor[] | undefined {
  if (!isObject(value) || !Array.isArray(value.data)) {
    return undefined;
  }
  const models: CcrModelDescriptor[] = [];
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

function isRequiredModel(model: CcrModelDescriptor): boolean {
  if (model.id === CCR_GPT_MODEL_ID) {
    return true;
  }
  const target = normalizeModelName(CCR_GPT_MODEL_ID);
  return normalizeModelName(model.displayName) === target
    || normalizeModelName(decodeCcrModelId(model.id)) === target;
}

function decodeCcrModelId(modelId: string): string | undefined {
  if (!modelId.startsWith(CCR_ENCODED_MODEL_PREFIX)) {
    return undefined;
  }
  const encoded = modelId.slice(CCR_ENCODED_MODEL_PREFIX.length);
  if (!encoded || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(encoded)) {
    return undefined;
  }
  return Buffer.from(encoded, "hex").toString("utf8");
}

function normalizeModelName(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function invalidResponse(error: string): CcrGatewayProbeResult {
  return {
    connectionState: "invalid-response",
    modelAvailable: false,
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
