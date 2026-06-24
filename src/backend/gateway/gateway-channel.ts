import type { GatewayChannel, GatewayQrLoginStatus } from "../../shared/types/gateway.js";

export interface GatewayChannelAccount {
  accountId: string | null;
  baseUrl: string;
  token?: string | null;
  appId?: string | null;
  appSecret?: string | null;
  homeChatId?: string | null;
}

export interface GatewayChannelQrLogin {
  qrcode: string;
  qrcodeUrl: string;
}

export interface GatewayChannelQrStatus {
  status: GatewayQrLoginStatus;
  redirectHost?: string;
  accountId?: string;
  token?: string;
  baseUrl?: string;
  loginUserId?: string;
  boundUserId?: string;
  raw?: unknown;
}

export interface GatewayInboundMessage {
  messageId: string;
  fromUserId: string;
  text: string;
  chatId?: string;
  chatType?: "dm" | "group";
  contextToken?: string;
  createdAt?: string;
  raw?: unknown;
}

export interface GatewayGetUpdatesResult {
  cursor: string;
  timeoutMs?: number;
  updates: GatewayInboundMessage[];
}

export interface GatewayChannelAdapter {
  id: GatewayChannel;
  label: string;
  defaultBaseUrl: string;
  supportsQrLogin?: boolean;
  startQrLogin?(input: GatewayStartQrLoginInput): Promise<GatewayChannelQrLogin>;
  checkQrLogin?(input: GatewayCheckQrLoginInput): Promise<GatewayChannelQrStatus>;
  getUpdates(input: GatewayGetUpdatesInput): Promise<GatewayGetUpdatesResult>;
  sendText(input: GatewaySendTextInput): Promise<string>;
  isSessionExpiredError?(error: unknown): boolean;
}

export interface GatewayStartQrLoginInput {
  localTokenList?: string[];
}

export interface GatewayCheckQrLoginInput {
  baseUrl: string;
  qrcode: string;
  verifyCode?: string;
}

export interface GatewayGetUpdatesInput {
  account: GatewayChannelAccount;
  cursor?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GatewaySendTextInput {
  account: GatewayChannelAccount;
  toUserId: string;
  chatId?: string;
  chatType?: "dm" | "group";
  contextToken?: string;
  text: string;
}

export interface GatewayChannelRegistry {
  defaultChannel: GatewayChannelAdapter;
  get(channel: GatewayChannel): GatewayChannelAdapter;
}

export function createGatewayChannelRegistry(channels: GatewayChannelAdapter[]): GatewayChannelRegistry {
  if (channels.length === 0) {
    throw new Error("At least one gateway channel must be registered.");
  }
  const byId = new Map<GatewayChannel, GatewayChannelAdapter>();
  for (const channel of channels) {
    byId.set(channel.id, channel);
  }
  const defaultChannel = channels[0] as GatewayChannelAdapter;
  return {
    defaultChannel,
    get(channel) {
      return byId.get(channel) ?? defaultChannel;
    }
  };
}
