import { randomUUID } from "node:crypto";
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

interface SdkQrCodeInfo {
  url: string;
  expireIn?: number;
}

interface SdkStatusChangeInfo {
  status?: string;
  interval?: number;
}

interface SdkRegisterAppResult {
  client_id?: string;
  client_secret?: string;
  user_info?: {
    open_id?: string;
    tenant_brand?: "feishu" | "lark";
  };
}

interface SdkRegisterAppOptions {
  domain?: string;
  larkDomain?: string;
  source?: string;
  signal?: AbortSignal;
  onQRCodeReady(info: SdkQrCodeInfo): void;
  onStatusChange?(info: SdkStatusChangeInfo): void;
}

type SdkRegisterApp = (options: SdkRegisterAppOptions) => Promise<SdkRegisterAppResult>;

export interface LarkRegistrationClientDeps {
  fetch?: typeof fetch;
  registerApp?: SdkRegisterApp;
}

interface ActiveRegistration {
  id: string;
  domain: GatewayLarkDomain;
  controller: AbortController;
  expiresAtMs: number;
  qrUrl: string;
  intervalSeconds: number;
  result: LarkRegistrationPollResult | null;
  message: string | undefined;
  promise: Promise<void>;
}

const ACCOUNTS_HOSTS: Record<GatewayLarkDomain, string> = {
  feishu: "accounts.feishu.cn",
  lark: "accounts.larksuite.com"
};
const OPEN_BASE_URLS: Record<GatewayLarkDomain, string> = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com"
};
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_REGISTRATION_EXPIRES_IN_SECONDS = 600;
const DEFAULT_REGISTRATION_INTERVAL_SECONDS = 5;

export function createLarkRegistrationClient(deps: LarkRegistrationClientDeps = {}): LarkRegistrationClient {
  const fetchImpl = deps.fetch ?? fetch;
  let registerAppPromise: Promise<SdkRegisterApp> | null = deps.registerApp ? Promise.resolve(deps.registerApp) : null;
  let active: ActiveRegistration | null = null;

  async function getRegisterApp(): Promise<SdkRegisterApp> {
    registerAppPromise ??= import("@larksuiteoapi/node-sdk").then((sdk) => {
      if (typeof sdk.registerApp !== "function") {
        throw new Error("Lark SDK does not expose registerApp.");
      }
      return sdk.registerApp as SdkRegisterApp;
    });
    return registerAppPromise;
  }

  return {
    async init() {
      await getRegisterApp();
    },
    async begin(domain) {
      active?.controller.abort();

      const registerApp = await getRegisterApp();
      const controller = new AbortController();
      const id = `lark-registration-${Date.now()}-${randomUUID()}`;
      const session: ActiveRegistration = {
        id,
        domain,
        controller,
        expiresAtMs: Date.now() + DEFAULT_REGISTRATION_EXPIRES_IN_SECONDS * 1000,
        qrUrl: "",
        intervalSeconds: DEFAULT_REGISTRATION_INTERVAL_SECONDS,
        result: null,
        message: undefined,
        promise: Promise.resolve()
      };
      active = session;

      let qrReadySettled = false;
      let resolveQrReady: (info: Required<SdkQrCodeInfo>) => void = () => undefined;
      let rejectQrReady: (error: Error) => void = () => undefined;
      const qrReady = new Promise<Required<SdkQrCodeInfo>>((resolve, reject) => {
        resolveQrReady = resolve;
        rejectQrReady = reject;
      });

      session.promise = (async () => {
        try {
          const result = await registerApp({
            domain: ACCOUNTS_HOSTS[domain],
            larkDomain: ACCOUNTS_HOSTS.lark,
            source: "vcm",
            signal: controller.signal,
            onQRCodeReady(info) {
              const qrUrl = info.url;
              const expireIn = positiveNumberOr(info.expireIn, DEFAULT_REGISTRATION_EXPIRES_IN_SECONDS);
              session.qrUrl = qrUrl;
              session.expiresAtMs = Date.now() + expireIn * 1000;
              if (!qrReadySettled) {
                qrReadySettled = true;
                resolveQrReady({ url: qrUrl, expireIn });
              }
            },
            onStatusChange(info) {
              session.message = formatSdkStatus(info);
            }
          });

          const appId = stringOrNull(result.client_id);
          const appSecret = stringOrNull(result.client_secret);
          const resultDomain = result.user_info?.tenant_brand === "lark" ? "lark" : domain;
          if (!appId || !appSecret) {
            session.result = {
              status: "failed",
              message: "Lark QR setup completed without app credentials."
            };
            return;
          }
          const bot = await probeBot(fetchImpl, {
            appId,
            appSecret,
            domain: resultDomain
          });
          session.result = {
            status: "confirmed",
            appId,
            appSecret,
            domain: resultDomain,
            openId: stringOrNull(result.user_info?.open_id),
            botName: bot.botName,
            botOpenId: bot.botOpenId
          };
        } catch (error) {
          const mapped = mapSdkError(error);
          session.result = mapped;
          if (!qrReadySettled) {
            qrReadySettled = true;
            rejectQrReady(new Error(mapped.message ?? "Lark QR setup failed."));
          }
        }
      })();

      const qrInfo = await qrReady;
      return {
        domain,
        deviceCode: id,
        qrUrl: qrInfo.url,
        userCode: extractUserCode(qrInfo.url),
        intervalSeconds: session.intervalSeconds,
        expiresInSeconds: qrInfo.expireIn
      };
    },
    async poll(input) {
      if (!active || active.id !== input.deviceCode) {
        return {
          status: "expired",
          message: "Lark QR setup session is no longer active. Start a new setup."
        };
      }
      if (active.result) {
        return active.result;
      }
      if (Date.now() > active.expiresAtMs) {
        active.controller.abort();
        active.result = {
          status: "expired",
          message: "Lark QR setup expired. Start a new setup."
        };
        return active.result;
      }
      return {
        status: "wait",
        message: active.message
      };
    }
  };
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
  const message = [
    stringOrNull(payload.error),
    stringOrNull(payload.error_description),
    stringOrNull(payload.message),
    stringOrNull(payload.msg),
    typeof payload.code === "number" || typeof payload.code === "string" ? `code ${payload.code}` : null
  ].filter(Boolean).join(": ");
  return message ? ` (${message})` : "";
}

function mapSdkError(error: unknown): LarkRegistrationPollResult {
  const code = isObject(error) ? stringOrNull(error.code) : null;
  const description = isObject(error) ? stringOrNull(error.description) : null;
  if (code === "expired_token") {
    return { status: "expired", message: "Lark QR setup expired. Start a new setup." };
  }
  if (code === "access_denied") {
    return { status: "failed", message: "Lark QR setup was denied." };
  }
  if (code === "abort") {
    return { status: "failed", message: "Lark QR setup was cancelled." };
  }
  if (error instanceof Error) {
    return { status: "failed", message: error.message };
  }
  return {
    status: "failed",
    message: description ?? (code ? `Lark QR setup failed: ${code}` : "Lark QR setup failed.")
  };
}

function formatSdkStatus(info: SdkStatusChangeInfo): string | undefined {
  if (info.status === "domain_switched") {
    return "Detected a Lark tenant; continuing setup on the Lark domain.";
  }
  if (info.status === "slow_down") {
    return info.interval
      ? `Lark requested slower setup polling; retrying every ${info.interval} seconds.`
      : "Lark requested slower setup polling.";
  }
  return undefined;
}

function extractUserCode(qrUrl: string): string | null {
  try {
    const value = new URL(qrUrl).searchParams.get("user_code");
    return stringOrNull(value);
  } catch {
    return null;
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
