export type GatewayChannel = "weixin-ilink" | "lark";
export type GatewayLarkDomain = "lark" | "feishu";

export type GatewayQrLoginStatus =
  | "idle"
  | "wait"
  | "scaned"
  | "need_verifycode"
  | "verify_code_blocked"
  | "expired"
  | "scaned_but_redirect"
  | "binded_redirect"
  | "confirmed"
  | "failed";

export interface GatewayBindingStatus {
  accountId: string | null;
  baseUrl: string;
  boundUserId: string | null;
  loginUserId: string | null;
  tokenConfigured: boolean;
  appId: string | null;
  appIdConfigured: boolean;
  appSecretConfigured: boolean;
  larkDomain?: GatewayLarkDomain | null;
  larkOpenId?: string | null;
  larkBotName?: string | null;
  larkBotOpenId?: string | null;
  homeChatId: string | null;
}

export interface GatewayPollStatus {
  state: "idle" | "running" | "error" | "expired";
  checkedAt?: string;
  error?: string;
}

export interface GatewayMessageStatus {
  checkedAt?: string;
  direction?: "inbound" | "outbound";
  command?: string;
  result?: "ok" | "ignored" | "error";
  preview?: string;
  error?: string;
}

export interface GatewayPendingConfirmations {
  closeTask?: {
    taskSlug: string;
    createdAt: string;
    expiresAt: string;
  } | null;
}

export interface GatewayStatus {
  version: 1;
  enabled: boolean;
  running: boolean;
  channel: GatewayChannel;
  translationEnabled: boolean;
  currentProjectId: string | null;
  currentTaskSlug: string | null;
  binding: GatewayBindingStatus;
  pendingConfirmations: GatewayPendingConfirmations;
  lastPollStatus: GatewayPollStatus;
  lastMessageStatus: GatewayMessageStatus | null;
  updatedAt: string;
}

export interface UpdateGatewaySettingsRequest {
  enabled?: boolean;
  channel?: GatewayChannel;
  translationEnabled?: boolean;
  currentProjectId?: string | null;
  currentTaskSlug?: string | null;
  baseUrl?: string | null;
}

export interface StartGatewayQrLoginResult {
  status: GatewayQrLoginStatus;
  qrcode: string;
  qrcodeUrl: string;
  expiresAt: string;
}

export interface CheckGatewayQrLoginRequest {
  verifyCode?: string;
}

export interface CheckGatewayQrLoginResult {
  status: GatewayQrLoginStatus;
  qrcodeUrl?: string;
  accountId?: string;
  boundUserId?: string | null;
  loginUserId?: string | null;
  message?: string;
}

export type GatewayLarkRegistrationStatus = "wait" | "confirmed" | "expired" | "failed";

export interface StartGatewayLarkRegistrationResult {
  status: "wait";
  qrUrl: string;
  userCode: string | null;
  expiresAt: string;
  intervalSeconds: number;
}

export interface CheckGatewayLarkRegistrationResult {
  status: GatewayLarkRegistrationStatus;
  message?: string;
  appIdConfigured?: boolean;
  appSecretConfigured?: boolean;
  larkDomain?: GatewayLarkDomain;
  larkOpenId?: string | null;
  larkBotName?: string | null;
  larkBotOpenId?: string | null;
  gatewayStatus?: GatewayStatus;
}

export interface BindGatewayLarkAppRequest {
  appId: string;
  appSecret: string;
  larkDomain?: GatewayLarkDomain;
}
