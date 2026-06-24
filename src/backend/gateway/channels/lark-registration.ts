import type { GatewayLarkDomain } from "../../../shared/types/gateway.js";

export interface LarkRegistrationBeginResult {
  domain: GatewayLarkDomain;
  deviceCode: string;
  qrUrl: string;
  userCode: string | null;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export interface LarkRegistrationPollResult {
  status: "wait" | "confirmed" | "expired" | "failed";
  message?: string;
  appId?: string;
  appSecret?: string;
  domain?: GatewayLarkDomain;
  openId?: string | null;
  botName?: string | null;
  botOpenId?: string | null;
}

export interface LarkRegistrationClient {
  init(domain: GatewayLarkDomain): Promise<void>;
  begin(domain: GatewayLarkDomain): Promise<LarkRegistrationBeginResult>;
  poll(input: {
    domain: GatewayLarkDomain;
    deviceCode: string;
  }): Promise<LarkRegistrationPollResult>;
}

export interface LarkRegistrationClientDeps {
  fetch?: typeof fetch;
}

const ACCOUNTS_BASE_URLS: Record<GatewayLarkDomain, string> = {
  feishu: "https://accounts.feishu.cn",
  lark: "https://accounts.larksuite.com"
};
const OPEN_BASE_URLS: Record<GatewayLarkDomain, string> = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com"
};
const REGISTRATION_PATH = "/oauth/v1/app/registration";
const REQUEST_TIMEOUT_MS = 10_000;

export function createLarkRegistrationClient(deps: LarkRegistrationClientDeps = {}): LarkRegistrationClient {
  const fetchImpl = deps.fetch ?? fetch;

  async function postRegistration(domain: GatewayLarkDomain, body: Record<string, string>): Promise<Record<string, unknown>> {
    const url = `${ACCOUNTS_BASE_URLS[domain]}${REGISTRATION_PATH}`;
    const payload = await fetchJson(fetchImpl, url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(body)
    });
    return payload;
  }

  return {
    async init(domain) {
      const payload = await postRegistration(domain, { action: "init" });
      const data = responseData(payload);
      const methods = Array.isArray(data.supported_auth_methods)
        ? data.supported_auth_methods.filter((value): value is string => typeof value === "string")
        : [];
      if (!methods.includes("client_secret")) {
        throw new Error(`Lark QR setup does not support client_secret auth. Supported methods: ${methods.join(", ") || "none"}.`);
      }
    },
    async begin(domain) {
      const payload = await postRegistration(domain, {
        action: "begin",
        archetype: "PersonalAgent",
        auth_method: "client_secret",
        request_user_info: "open_id"
      });
      const data = responseData(payload);
      const deviceCode = stringOrNull(data.device_code);
      if (!deviceCode) {
        throw new Error("Lark QR setup did not return a device_code.");
      }
      const qrUrl = appendQrTrackingParams(stringOrNull(data.verification_uri_complete) ?? "");
      if (!qrUrl) {
        throw new Error("Lark QR setup did not return a QR URL.");
      }
      return {
        domain,
        deviceCode,
        qrUrl,
        userCode: stringOrNull(data.user_code),
        intervalSeconds: positiveNumberOr(data.interval, 5),
        expiresInSeconds: positiveNumberOr(data.expire_in, 600)
      };
    },
    async poll(input) {
      const payload = await postRegistration(input.domain, {
        action: "poll",
        device_code: input.deviceCode,
        tp: "ob_app"
      });
      const data = responseData(payload);
      const userInfo = isObject(data.user_info) ? data.user_info : {};
      const tenantBrand = stringOrNull(userInfo.tenant_brand);
      const domain = tenantBrand === "lark" ? "lark" : input.domain;
      const appId = stringOrNull(data.client_id);
      const appSecret = stringOrNull(data.client_secret);
      if (appId && appSecret) {
        const bot = await probeBot(fetchImpl, {
          appId,
          appSecret,
          domain
        });
        return {
          status: "confirmed",
          appId,
          appSecret,
          domain,
          openId: stringOrNull(userInfo.open_id),
          botName: bot.botName,
          botOpenId: bot.botOpenId
        };
      }

      const error = stringOrNull(data.error) ?? stringOrNull(payload.error);
      if (error === "expired_token") {
        return { status: "expired", message: "Lark QR setup expired. Start a new setup." };
      }
      if (error === "access_denied") {
        return { status: "failed", message: "Lark QR setup was denied." };
      }
      const errorDescription = stringOrNull(data.error_description)
        ?? stringOrNull(payload.error_description)
        ?? stringOrNull(data.message)
        ?? stringOrNull(payload.message)
        ?? stringOrNull(data.msg)
        ?? stringOrNull(payload.msg);
      return {
        status: "wait",
        message: error && error !== "authorization_pending"
          ? [error, errorDescription].filter(Boolean).join(": ")
          : undefined
      };
    }
  };
}

function responseData(payload: Record<string, unknown>): Record<string, unknown> {
  return isObject(payload.data) ? payload.data : payload;
}

async function probeBot(
  fetchImpl: typeof fetch,
  input: { appId: string; appSecret: string; domain: GatewayLarkDomain }
): Promise<{ botName: string | null; botOpenId: string | null }> {
  try {
    const tokenPayload = await fetchJson(fetchImpl, `${OPEN_BASE_URLS[input.domain]}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        app_id: input.appId,
        app_secret: input.appSecret
      })
    });
    const accessToken = stringOrNull(tokenPayload.tenant_access_token);
    if (!accessToken) {
      return { botName: null, botOpenId: null };
    }
    const botPayload = await fetchJson(fetchImpl, `${OPEN_BASE_URLS[input.domain]}/open-apis/bot/v3/info`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      }
    });
    if (botPayload.code !== 0) {
      return { botName: null, botOpenId: null };
    }
    const bot = isObject(botPayload.bot)
      ? botPayload.bot
      : isObject(botPayload.data) && isObject(botPayload.data.bot)
        ? botPayload.data.bot
        : {};
    return {
      botName: stringOrNull(bot.app_name) ?? stringOrNull(bot.bot_name),
      botOpenId: stringOrNull(bot.open_id)
    };
  } catch {
    return { botName: null, botOpenId: null };
  }
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {}
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal
    });
    const text = await response.text();
    if (!text) {
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return {};
    }
    const payload = JSON.parse(text) as unknown;
    if (!isObject(payload)) {
      throw new Error("Lark setup response was not a JSON object.");
    }
    if (!response.ok && !payload.error) {
      throw new Error(`Lark QR setup request failed: ${response.status} ${response.statusText}${formatPayloadError(payload)}`);
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Lark QR setup request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function formatPayloadError(payload: Record<string, unknown>): string {
  const data = responseData(payload);
  const message = [
    stringOrNull(data.error) ?? stringOrNull(payload.error),
    stringOrNull(data.error_description) ?? stringOrNull(payload.error_description),
    stringOrNull(data.message) ?? stringOrNull(payload.message),
    stringOrNull(data.msg) ?? stringOrNull(payload.msg),
    typeof data.code === "number" || typeof data.code === "string" ? `code ${data.code}` : null,
    typeof payload.code === "number" || typeof payload.code === "string" ? `code ${payload.code}` : null
  ].filter(Boolean).join(": ");
  return message ? ` (${message})` : "";
}

function appendQrTrackingParams(value: string): string {
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value);
    url.searchParams.set("from", "hermes");
    url.searchParams.set("tp", "hermes");
    return url.toString();
  } catch {
    return `${value}${value.includes("?") ? "&" : "?"}from=hermes&tp=hermes`;
  }
}

function positiveNumberOr(input: unknown, fallback: number): number {
  return typeof input === "number" && Number.isFinite(input) && input > 0 ? input : fallback;
}

function stringOrNull(input: unknown): string | null {
  return typeof input === "string" && input.trim() ? input.trim() : null;
}

function isObject(input: unknown): input is Record<string, unknown> {
  return Boolean(input && typeof input === "object" && !Array.isArray(input));
}
