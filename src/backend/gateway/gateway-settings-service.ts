import path from "node:path";
import type {
  GatewayChannel,
  GatewayLarkDomain,
  GatewayMessageStatus,
  GatewayPendingConfirmations,
  GatewayPollStatus,
  GatewayStatus,
  UpdateGatewaySettingsRequest
} from "../../shared/types/gateway.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import { resolveVcmDataDir } from "../vcm-data-dir.js";

export interface GatewaySettingsFile {
  version: 1;
  enabled: boolean;
  channel: GatewayChannel;
  translationEnabled: boolean;
  currentProjectId: string | null;
  currentTaskSlug: string | null;
  binding: GatewayBindingSettings;
  dedupe: {
    recentInboundMessageIds: string[];
  };
  pendingConfirmations: GatewayPendingConfirmations;
  pushCursors: Record<string, GatewayPushCursor>;
  latestPmReplies: Record<string, GatewayLatestPmReply>;
  lastPollStatus: GatewayPollStatus;
  lastMessageStatus: GatewayMessageStatus | null;
  updatedAt: string;
}

export interface GatewayBindingSettings {
  accountId: string | null;
  baseUrl: string;
  boundUserId: string | null;
  loginUserId: string | null;
  token: string | null;
  appId: string | null;
  appSecret: string | null;
  larkDomain: GatewayLarkDomain | null;
  larkOpenId: string | null;
  larkBotName: string | null;
  larkBotOpenId: string | null;
  homeChatId: string | null;
  pairingCode: string | null;
  pairingCodeExpiresAt: string | null;
  getUpdatesBuf: string;
  contextTokens: Record<string, string>;
  chatIds: Record<string, string>;
}

export interface GatewayPushCursor {
  lastTranscriptEventId: string | null;
  lastTranscriptTimestamp: string | null;
}

export interface GatewayLatestPmReply {
  repoRoot: string;
  taskSlug: string;
  sessionId: string;
  claudeSessionId: string;
  transcriptEventId: string | null;
  transcriptTimestamp: string | null;
  capturedAt: string;
  text: string;
  truncated: boolean;
}

export interface GatewaySettingsService {
  loadSettings(): Promise<GatewaySettingsFile>;
  updateSettings(input: UpdateGatewaySettingsRequest): Promise<GatewaySettingsFile>;
  saveSettings(settings: GatewaySettingsFile): Promise<GatewaySettingsFile>;
  resetBinding(): Promise<GatewaySettingsFile>;
  expose(settings: GatewaySettingsFile, running?: boolean): GatewayStatus;
  getSettingsPath(): string;
  getAuditPath(): string;
}

export interface GatewaySettingsServiceDeps {
  fs: FileSystemAdapter;
  settingsPath?: string;
  auditPath?: string;
  defaultChannel?: GatewayChannel;
  defaultBaseUrl?: string;
  now?: () => string;
}

interface NormalizeGatewaySettingsOptions {
  defaultChannel: GatewayChannel;
  defaultBaseUrl: string;
}

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_GATEWAY_CHANNEL: GatewayChannel = "weixin-ilink";
const MAX_DEDUPE_IDS = 1000;

export function createGatewaySettingsService(deps: GatewaySettingsServiceDeps): GatewaySettingsService {
  const dataDir = resolveVcmDataDir();
  const settingsPath = deps.settingsPath ?? path.join(dataDir, "gateway", "settings.json");
  const auditPath = deps.auditPath ?? path.join(dataDir, "gateway", "audit.jsonl");
  const now = deps.now ?? (() => new Date().toISOString());
  const normalizeOptions: NormalizeGatewaySettingsOptions = {
    defaultChannel: deps.defaultChannel ?? DEFAULT_GATEWAY_CHANNEL,
    defaultBaseUrl: deps.defaultBaseUrl ?? DEFAULT_BASE_URL
  };
  let cachedSettings: GatewaySettingsFile | null = null;

  async function loadSettings(): Promise<GatewaySettingsFile> {
    if (cachedSettings) {
      return cachedSettings;
    }
    if (!(await deps.fs.pathExists(settingsPath))) {
      cachedSettings = normalizeSettings({}, now(), normalizeOptions);
      await saveSettings(cachedSettings);
      return cachedSettings;
    }
    cachedSettings = normalizeSettings(await deps.fs.readJson<Partial<GatewaySettingsFile>>(settingsPath), now(), normalizeOptions);
    return cachedSettings;
  }

  async function saveSettings(settings: GatewaySettingsFile): Promise<GatewaySettingsFile> {
    cachedSettings = normalizeSettings(settings, now(), normalizeOptions);
    await deps.fs.writeJsonAtomic(settingsPath, cachedSettings);
    return cachedSettings;
  }

  return {
    loadSettings,
    async updateSettings(input) {
      const current = await loadSettings();
      return saveSettings({
        ...current,
        enabled: input.enabled ?? current.enabled,
        channel: input.channel ?? current.channel,
        translationEnabled: input.translationEnabled ?? current.translationEnabled,
        currentProjectId: input.currentProjectId !== undefined ? normalizeNullableString(input.currentProjectId) : current.currentProjectId,
        currentTaskSlug: input.currentTaskSlug !== undefined ? normalizeNullableString(input.currentTaskSlug) : current.currentTaskSlug,
        binding: {
          ...current.binding,
          baseUrl: input.baseUrl !== undefined
            ? normalizeBaseUrl(input.baseUrl, normalizeOptions.defaultBaseUrl)
            : current.binding.baseUrl
        },
        updatedAt: now()
      });
    },
    saveSettings,
    async resetBinding() {
      const current = await loadSettings();
      return saveSettings({
        ...current,
        enabled: false,
        binding: {
          ...createDefaultBinding(normalizeOptions.defaultBaseUrl),
          baseUrl: current.binding.baseUrl || normalizeOptions.defaultBaseUrl,
          appId: current.binding.appId,
          appSecret: current.binding.appSecret,
          larkDomain: current.binding.larkDomain,
          larkOpenId: current.binding.larkOpenId,
          larkBotName: current.binding.larkBotName,
          larkBotOpenId: current.binding.larkBotOpenId,
          homeChatId: current.binding.homeChatId
        },
        dedupe: {
          recentInboundMessageIds: []
        },
        pushCursors: {},
        latestPmReplies: current.latestPmReplies,
        lastPollStatus: {
          state: "idle"
        },
        lastMessageStatus: null,
        updatedAt: now()
      });
    },
    expose(settings, running = false) {
      return {
        version: 1,
        enabled: settings.enabled,
        running,
        channel: settings.channel,
        translationEnabled: settings.translationEnabled,
        currentProjectId: settings.currentProjectId,
        currentTaskSlug: settings.currentTaskSlug,
        binding: {
          accountId: settings.binding.accountId,
          baseUrl: settings.binding.baseUrl,
          boundUserId: settings.binding.boundUserId,
          loginUserId: settings.binding.loginUserId,
          tokenConfigured: Boolean(settings.binding.token),
          appId: settings.binding.appId,
          appIdConfigured: Boolean(settings.binding.appId),
          appSecretConfigured: Boolean(settings.binding.appSecret),
          larkDomain: settings.binding.larkDomain,
          larkOpenId: settings.binding.larkOpenId,
          larkBotName: settings.binding.larkBotName,
          larkBotOpenId: settings.binding.larkBotOpenId,
          homeChatId: settings.binding.homeChatId,
          pairingCodeExpiresAt: settings.binding.pairingCodeExpiresAt
        },
        pendingConfirmations: settings.pendingConfirmations,
        lastPollStatus: settings.lastPollStatus,
        lastMessageStatus: settings.lastMessageStatus,
        updatedAt: settings.updatedAt
      };
    },
    getSettingsPath() {
      return settingsPath;
    },
    getAuditPath() {
      return auditPath;
    }
  };
}

export function normalizeSettings(
  input: Partial<GatewaySettingsFile>,
  timestamp: string,
  options: NormalizeGatewaySettingsOptions = {
    defaultChannel: DEFAULT_GATEWAY_CHANNEL,
    defaultBaseUrl: DEFAULT_BASE_URL
  }
): GatewaySettingsFile {
  const bindingInput = isObject(input.binding) ? input.binding as Partial<GatewayBindingSettings> : {};
  const dedupeInput = isObject(input.dedupe) ? input.dedupe as Partial<GatewaySettingsFile["dedupe"]> : {};
  const pendingInput = isObject(input.pendingConfirmations)
    ? input.pendingConfirmations as GatewayPendingConfirmations
    : {};
  const pushCursors = isObject(input.pushCursors) ? input.pushCursors as Record<string, GatewayPushCursor> : {};
  const latestPmReplies = isObject(input.latestPmReplies)
    ? input.latestPmReplies as Record<string, GatewayLatestPmReply>
    : {};

  return {
    version: 1,
    enabled: input.enabled === true,
    channel: normalizeGatewayChannel(input.channel, options.defaultChannel),
    translationEnabled: input.translationEnabled !== false,
    currentProjectId: normalizeNullableString(input.currentProjectId),
    currentTaskSlug: normalizeNullableString(input.currentTaskSlug),
    binding: {
      ...createDefaultBinding(options.defaultBaseUrl),
      accountId: normalizeNullableString(bindingInput.accountId),
      baseUrl: normalizeBaseUrl(bindingInput.baseUrl, options.defaultBaseUrl),
      boundUserId: normalizeNullableString(bindingInput.boundUserId),
      loginUserId: normalizeNullableString(bindingInput.loginUserId),
      token: normalizeNullableString(bindingInput.token),
      appId: normalizeNullableString(bindingInput.appId),
      appSecret: normalizeNullableString(bindingInput.appSecret),
      larkDomain: normalizeLarkDomain(bindingInput.larkDomain),
      larkOpenId: normalizeNullableString(bindingInput.larkOpenId),
      larkBotName: normalizeNullableString(bindingInput.larkBotName),
      larkBotOpenId: normalizeNullableString(bindingInput.larkBotOpenId),
      homeChatId: normalizeNullableString(bindingInput.homeChatId),
      pairingCode: normalizeNullableString(bindingInput.pairingCode),
      pairingCodeExpiresAt: normalizeNullableString(bindingInput.pairingCodeExpiresAt),
      getUpdatesBuf: typeof bindingInput.getUpdatesBuf === "string" ? bindingInput.getUpdatesBuf : "",
      contextTokens: isObject(bindingInput.contextTokens)
        ? normalizeStringRecord(bindingInput.contextTokens)
        : {},
      chatIds: isObject(bindingInput.chatIds)
        ? normalizeStringRecord(bindingInput.chatIds)
        : {}
    },
    dedupe: {
      recentInboundMessageIds: Array.isArray(dedupeInput.recentInboundMessageIds)
        ? dedupeInput.recentInboundMessageIds.filter((value): value is string => typeof value === "string").slice(-MAX_DEDUPE_IDS)
        : []
    },
    pendingConfirmations: {
      closeTask: normalizeCloseTaskConfirmation(pendingInput.closeTask)
    },
    pushCursors: normalizePushCursors(pushCursors),
    latestPmReplies: normalizeLatestPmReplies(latestPmReplies),
    lastPollStatus: normalizePollStatus(input.lastPollStatus),
    lastMessageStatus: normalizeMessageStatus(input.lastMessageStatus),
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : timestamp
  };
}

function createDefaultBinding(defaultBaseUrl = DEFAULT_BASE_URL): GatewayBindingSettings {
  return {
    accountId: null,
    baseUrl: defaultBaseUrl,
    boundUserId: null,
    loginUserId: null,
    token: null,
    appId: null,
    appSecret: null,
    larkDomain: null,
    larkOpenId: null,
    larkBotName: null,
    larkBotOpenId: null,
    homeChatId: null,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    getUpdatesBuf: "",
    contextTokens: {},
    chatIds: {}
  };
}

function normalizeGatewayChannel(input: unknown, fallback: GatewayChannel): GatewayChannel {
  return input === "weixin-ilink" || input === "lark" ? input : fallback;
}

function normalizeLarkDomain(input: unknown): GatewayLarkDomain | null {
  return input === "lark" || input === "feishu" ? input : null;
}

function normalizeCloseTaskConfirmation(input: unknown): GatewayPendingConfirmations["closeTask"] {
  if (!isObject(input)) {
    return null;
  }
  const taskSlug = normalizeNullableString(input.taskSlug);
  const createdAt = normalizeNullableString(input.createdAt);
  const expiresAt = normalizeNullableString(input.expiresAt);
  if (!taskSlug || !createdAt || !expiresAt) {
    return null;
  }
  return { taskSlug, createdAt, expiresAt };
}

function normalizePushCursors(input: Record<string, GatewayPushCursor>): Record<string, GatewayPushCursor> {
  const out: Record<string, GatewayPushCursor> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isObject(value)) {
      continue;
    }
    out[key] = {
      lastTranscriptEventId: normalizeNullableString(value.lastTranscriptEventId),
      lastTranscriptTimestamp: normalizeNullableString(value.lastTranscriptTimestamp)
    };
  }
  return out;
}

function normalizeLatestPmReplies(input: Record<string, GatewayLatestPmReply>): Record<string, GatewayLatestPmReply> {
  const out: Record<string, GatewayLatestPmReply> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isObject(value)) {
      continue;
    }
    const repoRoot = normalizeNullableString(value.repoRoot);
    const taskSlug = normalizeNullableString(value.taskSlug);
    const sessionId = normalizeNullableString(value.sessionId);
    const claudeSessionId = normalizeNullableString(value.claudeSessionId);
    const capturedAt = normalizeNullableString(value.capturedAt);
    const text = normalizeNullableString(value.text);
    if (!repoRoot || !taskSlug || !sessionId || !claudeSessionId || !capturedAt || !text) {
      continue;
    }
    out[key] = {
      repoRoot,
      taskSlug,
      sessionId,
      claudeSessionId,
      transcriptEventId: normalizeNullableString(value.transcriptEventId),
      transcriptTimestamp: normalizeNullableString(value.transcriptTimestamp),
      capturedAt,
      text,
      truncated: value.truncated === true
    };
  }
  return out;
}

function normalizePollStatus(input: unknown): GatewayPollStatus {
  if (!isObject(input)) {
    return { state: "idle" };
  }
  const state = input.state === "running" || input.state === "error" || input.state === "expired"
    ? input.state
    : "idle";
  return {
    state,
    checkedAt: normalizeNullableString(input.checkedAt) ?? undefined,
    error: normalizeNullableString(input.error) ?? undefined
  };
}

function normalizeMessageStatus(input: unknown): GatewayMessageStatus | null {
  if (!isObject(input)) {
    return null;
  }
  return {
    checkedAt: normalizeNullableString(input.checkedAt) ?? undefined,
    direction: input.direction === "inbound" || input.direction === "outbound" ? input.direction : undefined,
    command: normalizeNullableString(input.command) ?? undefined,
    result: input.result === "ok" || input.result === "ignored" || input.result === "error" ? input.result : undefined,
    preview: normalizeNullableString(input.preview) ?? undefined,
    error: normalizeNullableString(input.error) ?? undefined
  };
}

function normalizeBaseUrl(input: unknown, fallback = DEFAULT_BASE_URL): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) {
    return fallback;
  }
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw.replace(/\/+$/, "");
  }
  return `https://${raw.replace(/\/+$/, "")}`;
}

function normalizeNullableString(input: unknown): string | null {
  return typeof input === "string" && input.trim() ? input.trim() : null;
}

function normalizeStringRecord(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
