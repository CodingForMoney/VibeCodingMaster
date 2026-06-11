export type GatewayChannel = "weixin-ilink";

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
  translationEnabled?: boolean;
  currentProjectId?: string | null;
  currentTaskSlug?: string | null;
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
