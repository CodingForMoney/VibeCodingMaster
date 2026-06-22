import { randomBytes, randomUUID } from "node:crypto";
import type { GatewayQrLoginStatus } from "../../../shared/types/gateway.js";

export interface WeixinIlinkAccount {
  accountId: string | null;
  baseUrl: string;
  token: string;
}

export interface WeixinIlinkQrLogin {
  qrcode: string;
  qrcodeUrl: string;
}

export interface WeixinIlinkQrStatus {
  status: GatewayQrLoginStatus;
  redirectHost?: string;
  accountId?: string;
  token?: string;
  baseUrl?: string;
  loginUserId?: string;
  raw?: unknown;
}

export interface WeixinIlinkUpdate {
  messageId: string;
  fromUserId: string;
  text: string;
  contextToken?: string;
  createdAt?: string;
  raw?: unknown;
}

export interface WeixinIlinkGetUpdatesResult {
  cursor: string;
  timeoutMs?: number;
  updates: WeixinIlinkUpdate[];
}

export interface WeixinIlinkChannel {
  startQrLogin(input: StartQrLoginInput): Promise<WeixinIlinkQrLogin>;
  checkQrLogin(input: CheckQrLoginInput): Promise<WeixinIlinkQrStatus>;
  getUpdates(input: GetUpdatesInput): Promise<WeixinIlinkGetUpdatesResult>;
  sendText(input: SendTextInput): Promise<string>;
}

export interface StartQrLoginInput {
  botType?: string;
  localTokenList?: string[];
}

export interface CheckQrLoginInput {
  baseUrl: string;
  qrcode: string;
  verifyCode?: string;
}

export interface GetUpdatesInput {
  account: WeixinIlinkAccount;
  cursor?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SendTextInput {
  account: WeixinIlinkAccount;
  toUserId: string;
  contextToken?: string;
  text: string;
}

export interface WeixinIlinkChannelOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  channelVersion?: string;
  botAgent?: string;
  appId?: string;
  routeTag?: string;
  apiTimeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_BOT_TYPE = "3";
const DEFAULT_CHANNEL_VERSION = "2.4.3";
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const SESSION_EXPIRED_ERRCODE = -14;
const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
const MESSAGE_ITEM_TEXT = 1;

export function createWeixinIlinkChannel(options: WeixinIlinkChannelOptions = {}): WeixinIlinkChannel {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const channelVersion = options.channelVersion ?? DEFAULT_CHANNEL_VERSION;
  const botAgent = options.botAgent ?? "vcm-gateway/0.1.0";
  const appId = options.appId ?? "bot";
  const apiTimeoutMs = options.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS;

  function buildBaseInfo() {
    return {
      channel_version: channelVersion,
      bot_agent: botAgent
    };
  }

  function buildIlinkAppHeaders() {
    const headers: Record<string, string> = {
      "iLink-App-Id": appId,
      "iLink-App-ClientVersion": String(buildClientVersion(channelVersion))
    };
    if (options.routeTag) {
      headers.SKRouteTag = options.routeTag;
    }
    return headers;
  }

  function buildJsonHeaders(token?: string) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin(),
      ...buildIlinkAppHeaders()
    };
    if (token?.trim()) {
      headers.Authorization = `Bearer ${token.trim()}`;
    }
    return headers;
  }

  async function fetchJson(input: {
    method: "GET" | "POST";
    requestBaseUrl: string;
    endpoint: string;
    token?: string;
    body?: unknown;
    timeoutMs?: number;
    label: string;
    signal?: AbortSignal;
    jsonHeaders?: boolean;
  }): Promise<Record<string, unknown>> {
    const controller = input.timeoutMs !== undefined ? new AbortController() : undefined;
    const timeout = controller ? setTimeout(() => controller.abort(), input.timeoutMs) : undefined;
    const combinedSignal = combineSignals(controller?.signal, input.signal);
    const url = new URL(input.endpoint, ensureTrailingSlash(input.requestBaseUrl));

    try {
      const response = await fetchImpl(url, {
        method: input.method,
        headers: input.jsonHeaders === false ? buildIlinkAppHeaders() : buildJsonHeaders(input.token),
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: combinedSignal.signal
      });
      const rawText = await response.text();
      if (!response.ok) {
        throw new Error(`${input.label} HTTP ${response.status}: ${rawText}`);
      }
      return rawText ? JSON.parse(rawText) as Record<string, unknown> : {};
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      combinedSignal.cleanup();
    }
  }

  async function post(input: {
    requestBaseUrl: string;
    endpoint: string;
    token?: string;
    body?: unknown;
    timeoutMs?: number;
    label: string;
    signal?: AbortSignal;
  }) {
    return fetchJson({
      method: "POST",
      requestBaseUrl: input.requestBaseUrl,
      endpoint: input.endpoint,
      token: input.token,
      body: input.body,
      timeoutMs: input.timeoutMs ?? apiTimeoutMs,
      label: input.label,
      signal: input.signal
    });
  }

  async function get(input: {
    requestBaseUrl: string;
    endpoint: string;
    timeoutMs?: number;
    label: string;
  }) {
    return fetchJson({
      method: "GET",
      requestBaseUrl: input.requestBaseUrl,
      endpoint: input.endpoint,
      timeoutMs: input.timeoutMs ?? apiTimeoutMs,
      label: input.label,
      jsonHeaders: false
    });
  }

  return {
    async startQrLogin(input) {
      const payload = await post({
        requestBaseUrl: baseUrl,
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(input.botType ?? DEFAULT_BOT_TYPE)}`,
        body: {
          local_token_list: input.localTokenList ?? []
        },
        label: "get_bot_qrcode"
      });
      const qrcode = stringOrUndefined(payload.qrcode);
      const qrcodeUrl = stringOrUndefined(payload.qrcode_img_content);
      if (!qrcode || !qrcodeUrl) {
        throw new Error("get_bot_qrcode did not return qrcode/qrcode_img_content.");
      }
      return { qrcode, qrcodeUrl };
    },
    async checkQrLogin(input) {
      let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(input.qrcode)}`;
      if (input.verifyCode?.trim()) {
        endpoint += `&verify_code=${encodeURIComponent(input.verifyCode.trim())}`;
      }
      const payload = await get({
        requestBaseUrl: input.baseUrl,
        endpoint,
        timeoutMs: 35_000,
        label: "get_qrcode_status"
      });
      const status = normalizeQrStatus(payload.status);
      return {
        status,
        redirectHost: stringOrUndefined(payload.redirect_host),
        accountId: stringOrUndefined(payload.ilink_bot_id),
        token: stringOrUndefined(payload.bot_token),
        baseUrl: stringOrUndefined(payload.baseurl),
        loginUserId: stringOrUndefined(payload.ilink_user_id),
        raw: payload
      };
    },
    async getUpdates(input) {
      const payload = await post({
        requestBaseUrl: input.account.baseUrl,
        endpoint: "ilink/bot/getupdates",
        token: input.account.token,
        timeoutMs: input.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
        label: "getupdates",
        signal: input.signal,
        body: {
          get_updates_buf: input.cursor ?? "",
          base_info: buildBaseInfo()
        }
      });
      assertIlinkOk(payload, "getupdates");
      const cursor = stringOrUndefined(payload.get_updates_buf) ?? input.cursor ?? "";
      const timeoutMs = typeof payload.longpolling_timeout_ms === "number"
        ? payload.longpolling_timeout_ms
        : undefined;
      const messages = Array.isArray(payload.msgs) ? payload.msgs : [];
      return {
        cursor,
        timeoutMs,
        updates: messages.flatMap(parseUpdate)
      };
    },
    async sendText(input) {
      const clientId = `vcm-gateway-${randomUUID()}`;
      const payload = await post({
        requestBaseUrl: input.account.baseUrl,
        endpoint: "ilink/bot/sendmessage",
        token: input.account.token,
        label: "sendmessage",
        body: {
          msg: {
            from_user_id: "",
            to_user_id: input.toUserId,
            client_id: clientId,
            message_type: MESSAGE_TYPE_BOT,
            message_state: MESSAGE_STATE_FINISH,
            item_list: [
              {
                type: MESSAGE_ITEM_TEXT,
                text_item: {
                  text: input.text
                }
              }
            ],
            context_token: input.contextToken || undefined
          },
          base_info: buildBaseInfo()
        }
      });
      assertIlinkOk(payload, "sendmessage");
      return clientId;
    }
  };
}

function parseUpdate(raw: unknown): WeixinIlinkUpdate[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const message = raw as Record<string, unknown>;
  const fromUserId = stringOrUndefined(message.from_user_id);
  if (!fromUserId) {
    return [];
  }
  if (message.message_type === MESSAGE_TYPE_BOT) {
    return [];
  }
  if (message.message_type !== undefined && message.message_type !== MESSAGE_TYPE_USER) {
    return [];
  }
  const text = extractText(message);
  if (!text.trim()) {
    return [];
  }
  const messageId = String(message.message_id ?? message.client_id ?? `${fromUserId}:${String(message.create_time_ms ?? "")}`);
  const createdAt = typeof message.create_time_ms === "number"
    ? new Date(message.create_time_ms).toISOString()
    : undefined;
  return [{
    messageId,
    fromUserId,
    text,
    contextToken: stringOrUndefined(message.context_token),
    createdAt,
    raw: message
  }];
}

function extractText(message: Record<string, unknown>): string {
  const parts: string[] = [];
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const candidate = item as Record<string, unknown>;
    const textItem = candidate.text_item as Record<string, unknown> | undefined;
    const voiceItem = candidate.voice_item as Record<string, unknown> | undefined;
    const text = stringOrUndefined(textItem?.text) ?? stringOrUndefined(voiceItem?.text);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function assertIlinkOk(payload: Record<string, unknown>, label: string): void {
  const ret = typeof payload.ret === "number" ? payload.ret : undefined;
  const errcode = typeof payload.errcode === "number" ? payload.errcode : undefined;
  if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
    const code = ret ?? errcode;
    const message = stringOrUndefined(payload.errmsg) ?? `${label} failed`;
    if (code === SESSION_EXPIRED_ERRCODE) {
      throw new Error(`iLink session expired: ${message}`);
    }
    throw new Error(`${label} failed ret=${String(ret)} errcode=${String(errcode)} ${message}`);
  }
}

function normalizeQrStatus(value: unknown): GatewayQrLoginStatus {
  switch (value) {
    case "wait":
    case "scaned":
    case "need_verifycode":
    case "verify_code_blocked":
    case "expired":
    case "scaned_but_redirect":
    case "binded_redirect":
    case "confirmed":
      return value;
    default:
      return "failed";
  }
}

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return DEFAULT_BASE_URL;
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/\/+$/, "");
  }
  return `https://${trimmed.replace(/\/+$/, "")}`;
}

function ensureTrailingSlash(input: string): string {
  return input.endsWith("/") ? input : `${input}/`;
}

function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

function combineSignals(first: AbortSignal | undefined, second: AbortSignal | undefined): {
  signal?: AbortSignal;
  cleanup(): void;
} {
  if (!first) {
    return {
      signal: second,
      cleanup() {}
    };
  }
  if (!second) {
    return {
      signal: first,
      cleanup() {}
    };
  }
  if (first === second) {
    return {
      signal: first,
      cleanup() {}
    };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  first.addEventListener("abort", abort, { once: true });
  second.addEventListener("abort", abort, { once: true });
  if (first.aborted || second.aborted) {
    controller.abort();
  }
  return {
    signal: controller.signal,
    cleanup() {
      first.removeEventListener("abort", abort);
      second.removeEventListener("abort", abort);
    }
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
