import { randomUUID } from "node:crypto";
import type {
  GatewayChannelAdapter,
  GatewayGetUpdatesResult,
  GatewayInboundMessage
} from "../gateway-channel.js";

interface LarkChannelOptions {
  domain?: "lark" | "feishu";
  loggerLevel?: unknown;
}

interface LarkConnectionState {
  key: string;
  wsClient: {
    close(params?: { force?: boolean }): void;
  } | null;
  client: {
    im: {
      v1: {
        message: {
          create(payload?: unknown): Promise<{ data?: { message_id?: string } } | null>;
        };
      };
    };
  } | null;
  queue: GatewayInboundMessage[];
  waiters: Array<() => void>;
  ready: Promise<void>;
  error: Error | null;
}

const DEFAULT_BASE_URL = "lark://open-platform";
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

export function createLarkChannel(options: LarkChannelOptions = {}): GatewayChannelAdapter {
  let connection: LarkConnectionState | null = null;

  async function ensureConnection(input: {
    appId: string;
    appSecret: string;
    domain: "lark" | "feishu";
  }): Promise<LarkConnectionState> {
    const key = `${input.domain}:${input.appId}:${input.appSecret}`;
    if (connection?.key === key) {
      return connection;
    }
    connection?.wsClient?.close({ force: true });

    const Lark = await import("@larksuiteoapi/node-sdk");
    const queue: GatewayInboundMessage[] = [];
    const waiters: Array<() => void> = [];
    const state: LarkConnectionState = {
      key,
      wsClient: null,
      client: null,
      queue,
      waiters,
      ready: Promise.resolve(),
      error: null
    };
    const client = new Lark.Client({
      appId: input.appId,
      appSecret: input.appSecret,
      domain: input.domain
    });
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        for (const update of parseLarkMessageEvent(data)) {
          queue.push(update);
        }
        while (waiters.length > 0) {
          waiters.shift()?.();
        }
      }
    });
    const ready = new Promise<void>((resolve, reject) => {
      const wsClient = new Lark.WSClient({
        appId: input.appId,
        appSecret: input.appSecret,
        domain: input.domain,
        source: "vcm-gateway",
        autoReconnect: true,
        loggerLevel: options.loggerLevel as never,
        onReady: () => resolve(),
        onError: (error: Error) => {
          state.error = error;
          reject(error);
          while (waiters.length > 0) {
            waiters.shift()?.();
          }
        }
      });
      state.wsClient = wsClient;
      state.client = client;
      void wsClient.start({ eventDispatcher: dispatcher }).catch((error: Error) => {
        state.error = error;
        reject(error);
        while (waiters.length > 0) {
          waiters.shift()?.();
        }
      });
    });
    state.ready = ready;
    connection = state;
    return state;
  }

  return {
    id: "lark",
    label: "Lark",
    defaultBaseUrl: DEFAULT_BASE_URL,
    supportsQrLogin: false,
    async getUpdates(input): Promise<GatewayGetUpdatesResult> {
      const appId = input.account.appId?.trim();
      const appSecret = input.account.appSecret?.trim();
      const domain = input.account.larkDomain ?? options.domain ?? "lark";
      if (!appId || !appSecret) {
        throw new Error("Lark App ID and App Secret are required.");
      }
      const state = await ensureConnection({ appId, appSecret, domain });
      await state.ready;
      if (state.error) {
        throw state.error;
      }
      const timeoutMs = input.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
      const updates = await waitForUpdates(state, timeoutMs, input.signal);
      if (input.signal?.aborted && connection === state) {
        connection = null;
      }
      return {
        cursor: new Date().toISOString(),
        timeoutMs,
        updates
      };
    },
    async sendText(input) {
      const appId = input.account.appId?.trim();
      const appSecret = input.account.appSecret?.trim();
      const domain = input.account.larkDomain ?? options.domain ?? "lark";
      if (!appId || !appSecret) {
        throw new Error("Lark App ID and App Secret are required.");
      }
      const state = await ensureConnection({ appId, appSecret, domain });
      await state.ready;
      if (!state.client) {
        throw new Error("Lark client is not initialized.");
      }
      const receiveId = input.chatId || input.account.homeChatId || input.toUserId;
      const receiveIdType = input.chatId || input.account.homeChatId ? "chat_id" : "open_id";
      if (!receiveId) {
        throw new Error("Lark send target is missing.");
      }
      const result = await state.client.im.v1.message.create({
        params: {
          receive_id_type: receiveIdType
        },
        data: {
          receive_id: receiveId,
          msg_type: "text",
          content: JSON.stringify({ text: input.text }),
          uuid: `vcm-gateway-${randomUUID()}`
        }
      });
      return result?.data?.message_id ?? `vcm-gateway-${randomUUID()}`;
    },
    isSessionExpiredError() {
      return false;
    }
  };
}

async function waitForUpdates(
  state: LarkConnectionState,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<GatewayInboundMessage[]> {
  if (state.queue.length > 0) {
    return state.queue.splice(0);
  }
  if (signal?.aborted) {
    state.wsClient?.close({ force: true });
    return [];
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) {
        state.waiters.splice(index, 1);
      }
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const waiter = finish;
    timeout = setTimeout(finish, timeoutMs);
    state.waiters.push(waiter);
    signal?.addEventListener("abort", finish, { once: true });
  });
  if (state.error) {
    throw state.error;
  }
  if (signal?.aborted) {
    state.wsClient?.close({ force: true });
    return [];
  }
  return state.queue.splice(0);
}

function parseLarkMessageEvent(data: unknown): GatewayInboundMessage[] {
  if (!isObject(data)) {
    return [];
  }
  const event = isObject(data.event) ? data.event : data;
  if (!isObject(event)) {
    return [];
  }
  const message = isObject(event.message) ? event.message : {};
  const sender = isObject(event.sender) ? event.sender : {};
  const senderId = isObject(sender.sender_id) ? sender.sender_id : {};
  const fromUserId = stringOrUndefined(senderId.open_id)
    ?? stringOrUndefined(senderId.user_id)
    ?? stringOrUndefined(senderId.union_id);
  const messageId = stringOrUndefined(message.message_id);
  const chatId = stringOrUndefined(message.chat_id);
  const chatType = stringOrUndefined(message.chat_type);
  const rawText = extractTextContent(message.content);
  if (!fromUserId || !messageId || !rawText.trim()) {
    return [];
  }
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const isDirect = chatType === "p2p";
  if (!isDirect && mentions.length === 0) {
    return [];
  }
  const text = stripMentionTokens(rawText, mentions);
  if (!text.trim()) {
    return [];
  }
  const createdAt = normalizeLarkTimestamp(message.create_time);
  return [{
    messageId,
    fromUserId,
    chatId,
    chatType: isDirect ? "dm" : "group",
    text,
    createdAt,
    raw: data
  }];
}

function extractTextContent(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }
  try {
    const parsed = JSON.parse(input) as unknown;
    if (isObject(parsed) && typeof parsed.text === "string") {
      return parsed.text;
    }
  } catch {
    return input;
  }
  return input;
}

function stripMentionTokens(text: string, mentions: unknown[]): string {
  let out = text;
  for (const mention of mentions) {
    if (!isObject(mention)) {
      continue;
    }
    const key = stringOrUndefined(mention.key);
    if (key) {
      out = out.replaceAll(key, "");
    }
  }
  return out.replace(/<at\b[^>]*>.*?<\/at>/g, "").trim();
}

function normalizeLarkTimestamp(input: unknown): string | undefined {
  const raw = stringOrUndefined(input);
  if (!raw) {
    return undefined;
  }
  const timestamp = Number.parseInt(raw, 10);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return new Date(timestamp).toISOString();
}

function stringOrUndefined(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input.trim() : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
