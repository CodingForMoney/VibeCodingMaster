import path from "node:path";
import type {
  GatewayChannel,
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
  getUpdatesBuf: string;
  contextTokens: Record<string, string>;
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
  now?: () => string;
}

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const MAX_DEDUPE_IDS = 1000;

export function createGatewaySettingsService(deps: GatewaySettingsServiceDeps): GatewaySettingsService {
  const dataDir = resolveVcmDataDir();
  const settingsPath = deps.settingsPath ?? path.join(dataDir, "gateway", "settings.json");
  const auditPath = deps.auditPath ?? path.join(dataDir, "gateway", "audit.jsonl");
  const now = deps.now ?? (() => new Date().toISOString());
  let cachedSettings: GatewaySettingsFile | null = null;

  async function loadSettings(): Promise<GatewaySettingsFile> {
    if (cachedSettings) {
      return cachedSettings;
    }
    if (!(await deps.fs.pathExists(settingsPath))) {
      cachedSettings = normalizeSettings({}, now());
      await saveSettings(cachedSettings);
      return cachedSettings;
    }
    cachedSettings = normalizeSettings(await deps.fs.readJson<Partial<GatewaySettingsFile>>(settingsPath), now());
    return cachedSettings;
  }

  async function saveSettings(settings: GatewaySettingsFile): Promise<GatewaySettingsFile> {
    cachedSettings = normalizeSettings(settings, now());
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
        translationEnabled: input.translationEnabled ?? current.translationEnabled,
        currentProjectId: input.currentProjectId !== undefined ? normalizeNullableString(input.currentProjectId) : current.currentProjectId,
        currentTaskSlug: input.currentTaskSlug !== undefined ? normalizeNullableString(input.currentTaskSlug) : current.currentTaskSlug,
        updatedAt: now()
      });
    },
    saveSettings,
    async resetBinding() {
      const current = await loadSettings();
      return saveSettings({
        ...current,
        enabled: false,
        binding: createDefaultBinding(),
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
          tokenConfigured: Boolean(settings.binding.token)
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

export function normalizeSettings(input: Partial<GatewaySettingsFile>, timestamp: string): GatewaySettingsFile {
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
    channel: "weixin-ilink",
    translationEnabled: input.translationEnabled !== false,
    currentProjectId: normalizeNullableString(input.currentProjectId),
    currentTaskSlug: normalizeNullableString(input.currentTaskSlug),
    binding: {
      ...createDefaultBinding(),
      accountId: normalizeNullableString(bindingInput.accountId),
      baseUrl: normalizeBaseUrl(bindingInput.baseUrl),
      boundUserId: normalizeNullableString(bindingInput.boundUserId),
      loginUserId: normalizeNullableString(bindingInput.loginUserId),
      token: normalizeNullableString(bindingInput.token),
      getUpdatesBuf: typeof bindingInput.getUpdatesBuf === "string" ? bindingInput.getUpdatesBuf : "",
      contextTokens: isObject(bindingInput.contextTokens)
        ? normalizeStringRecord(bindingInput.contextTokens)
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

function createDefaultBinding(): GatewayBindingSettings {
  return {
    accountId: null,
    baseUrl: DEFAULT_BASE_URL,
    boundUserId: null,
    loginUserId: null,
    token: null,
    getUpdatesBuf: "",
    contextTokens: {}
  };
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

function normalizeBaseUrl(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) {
    return DEFAULT_BASE_URL;
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
