import type { RoleName } from "../../shared/types/role.js";
import type {
  SendTranslatedInputRequest,
  TranslateUserInputRequest,
  TranslateUserInputResult,
  TranslationEntry,
  TranslationPromptKey,
  TranslationPromptPreview,
  TranslationProviderTestResult,
  TranslationSecretSettings,
  TranslationSettings,
  TranslationSourceKind,
  TranslationStatus,
  TranslationWsMessage
} from "../../shared/types/translation.js";
import { TRANSLATION_PROMPT_KEYS } from "../../shared/types/translation.js";
import {
  classifyTranslationChunk,
  shouldTranslateSourceKind
} from "../../shared/validation/translation-classifier.js";
import type { TranslationProvider } from "../adapters/translation-provider.js";
import { TranslationProviderError } from "../adapters/translation-provider.js";
import { VcmError } from "../errors.js";
import type { TerminalRuntime, Unsubscribe } from "../runtime/terminal-runtime.js";
import type { SessionRegistry } from "../runtime/session-registry.js";
import type { AppSettingsService } from "./app-settings-service.js";
import type { ClaudeTranscriptEvent, ClaudeTranscriptService } from "./claude-transcript-service.js";
import type { SessionService } from "./session-service.js";
import { buildTranslationPrompt, getTranslationPromptPreviews, parseTranslationWarning } from "./translation-prompts.js";
import { createTranslationQueueRegistry } from "./translation-queue.js";

export interface TranslationService {
  getSettings(): Promise<TranslationSettings>;
  updateSettings(input: Partial<TranslationSettings>, secrets?: TranslationSecretSettings): Promise<TranslationSettings>;
  getPromptPreviews(): Promise<TranslationPromptPreview[]>;
  testProvider(): Promise<TranslationProviderTestResult>;
  translateUserInput(input: TranslateUserInputServiceInput): Promise<TranslateUserInputResult>;
  sendTranslatedInput(input: SendTranslatedInputServiceInput): Promise<void>;
  subscribeToSession(sessionId: string, listener: TranslationEventListener): Unsubscribe;
  clearSession(sessionId: string): void;
  retryTranslation(sessionId: string, translationId: string): Promise<TranslationEntry>;
}

export interface TranslateUserInputServiceInput extends TranslateUserInputRequest {
  repoRoot: string;
  taskSlug: string;
  role: RoleName;
}

export interface SendTranslatedInputServiceInput extends SendTranslatedInputRequest {
  repoRoot: string;
  taskSlug: string;
  role: RoleName;
}

export type TranslationEventListener = (message: TranslationWsMessage) => void;

export interface TranslationServiceDeps {
  provider: TranslationProvider;
  runtime: TerminalRuntime;
  sessionRegistry: Pick<SessionRegistry, "get">;
  transcripts: ClaudeTranscriptService;
  sessionService: SessionService;
  appSettings: Pick<AppSettingsService, "getTranslationConfig" | "updateTranslationConfig">;
  now?: () => string;
  id?: () => string;
}

interface StoredTranslationConfig {
  settings: TranslationSettings;
  secrets: TranslationSecretSettings;
}

interface SessionState {
  listeners: Set<TranslationEventListener>;
  unsubscribeTranscript?: Unsubscribe;
  hasReplayedTranscriptOutput: boolean;
  seenTranscriptIds: Set<string>;
  entries: TranslationEntry[];
  lastAssistantText?: string;
}

const DEFAULT_SETTINGS: TranslationSettings = {
  version: 1,
  enabled: false,
  providerType: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  workingLanguage: "en",
  inputMode: "review-before-send",
  translateOutput: true,
  translateUserInput: true,
  contextEnabled: true,
  preserveTechnicalTokens: true,
  skipCjkText: true,
  redactSecrets: true,
  requestTimeoutMs: 15000,
  temperature: 0.1
};

export function createTranslationService(deps: TranslationServiceDeps): TranslationService {
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? (() => `tr_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  const queues = createTranslationQueueRegistry();
  const sessionStates = new Map<string, SessionState>();
  let cachedConfig: StoredTranslationConfig | null = null;

  async function loadConfig(): Promise<StoredTranslationConfig> {
    if (cachedConfig) {
      return cachedConfig;
    }
    const storedConfig = await deps.appSettings.getTranslationConfig();
    if (!storedConfig) {
      cachedConfig = { settings: DEFAULT_SETTINGS, secrets: {} };
      return cachedConfig;
    }

    const rawSettings: Partial<TranslationSettings> = storedConfig.settings ?? {};
    const apiKey = storedConfig.secrets?.apiKey ?? rawSettings.apiKey;
    cachedConfig = {
      settings: normalizeSettings(rawSettings),
      secrets: {
        ...(storedConfig.secrets ?? {}),
        ...(apiKey !== undefined ? { apiKey } : {})
      }
    };
    return cachedConfig;
  }

  async function saveConfig(config: StoredTranslationConfig): Promise<void> {
    cachedConfig = config;
    await deps.appSettings.updateTranslationConfig(config);
  }

  function getState(sessionId: string): SessionState {
    let state = sessionStates.get(sessionId);
    if (!state) {
      state = {
        listeners: new Set(),
        hasReplayedTranscriptOutput: false,
        seenTranscriptIds: new Set(),
        entries: []
      };
      sessionStates.set(sessionId, state);
    }
    return state;
  }

  function emit(sessionId: string, message: TranslationWsMessage): void {
    const state = getState(sessionId);
    for (const listener of state.listeners) {
      listener(message);
    }
  }

  async function handleTranscriptEvent(sessionId: string, event: ClaudeTranscriptEvent): Promise<void> {
    if (event.kind !== "text" || event.stopReason === "tool_use") {
      return;
    }

    const state = getState(sessionId);
    if (state.seenTranscriptIds.has(event.id)) {
      return;
    }
    state.seenTranscriptIds.add(event.id);

    const { settings } = await loadConfig();
    if (!settings.enabled || !settings.translateOutput) {
      return;
    }
    await processClaudeOutputText(sessionId, event.text);
  }

  async function processClaudeOutputText(sessionId: string, rawText: string): Promise<void> {
    const session = deps.runtime.getSession(sessionId);
    const roleSession = deps.sessionRegistry.get(sessionId);
    if (!session && !roleSession) {
      return;
    }

    const { settings, secrets } = await loadConfig();
    const classified = classifyTranslationChunk(rawText, settings.targetLanguage);
    if (classified.sourceKind === "sensitive" || classified.sourceKind === "already-target-language") {
      return;
    }

    if (!shouldTranslateSourceKind(classified.sourceKind)) {
      return;
    }

    const baseEntry = createEntry({
      taskSlug: roleSession?.taskSlug ?? session!.taskSlug,
      role: roleSession?.role ?? session!.role,
      direction: "cc-output-to-user",
      sourceKind: classified.sourceKind,
      sourceText: classified.text,
      settings,
      status: "queued",
      contextUsed: false
    });

    pushEntry(sessionId, baseEntry);

    const queue = queues.getQueue(sessionId);
    await queue.enqueue(async () => {
      const translatingEntry = {
        ...baseEntry,
        status: "translating" as TranslationStatus,
        translationStartedAt: now()
      };
      replaceEntry(sessionId, translatingEntry);
      emit(sessionId, { type: "translation-status", status: "translating" });

      try {
        const prompt = buildTranslationPrompt({
          direction: "cc-output-to-user",
          text: classified.text,
          sourceKind: classified.sourceKind,
          settings
        });
        const result = await deps.provider.translate({
          settings,
          secrets,
          systemPrompt: prompt.systemPrompt,
          userPrompt: prompt.userPrompt
        });
        const completed = {
          ...translatingEntry,
          status: "translated" as TranslationStatus,
          translatedText: result.text,
          completedAt: now(),
          tokenUsage: result.tokenUsage
        };
        replaceEntry(sessionId, completed);
        getState(sessionId).lastAssistantText = classified.text;
        emit(sessionId, { type: "translation-status", status: "ready" });
      } catch (error) {
        const failed = {
          ...translatingEntry,
          status: "failed" as TranslationStatus,
          error: error instanceof Error ? error.message : "Translation failed.",
          completedAt: now()
        };
        replaceEntry(sessionId, failed);
        emit(sessionId, { type: "translation-status", status: "failed" });
      }
    });
  }

  function pushEntry(sessionId: string, entry: TranslationEntry): void {
    getState(sessionId).entries.push(entry);
    emit(sessionId, { type: "translation-entry", entry });
  }

  function replaceEntry(sessionId: string, entry: TranslationEntry): void {
    const state = getState(sessionId);
    state.entries = state.entries.map((current) => current.id === entry.id ? entry : current);
    emit(sessionId, { type: "translation-entry", entry });
  }

  function createEntry(input: {
    taskSlug: string;
    role: RoleName;
    direction: TranslationEntry["direction"];
    sourceKind: TranslationSourceKind;
    sourceText: string;
    settings: TranslationSettings;
    status: TranslationStatus;
    contextUsed: boolean;
  }): TranslationEntry {
    return {
      id: id(),
      taskSlug: input.taskSlug,
      role: input.role,
      direction: input.direction,
      sourceKind: input.sourceKind,
      sourceLanguage: input.direction === "user-input-to-english" ? input.settings.sourceLanguage : "en",
      targetLanguage: input.direction === "user-input-to-english" ? "en" : input.settings.targetLanguage,
      sourceText: input.sourceText,
      translatedText: "",
      status: input.status,
      contextUsed: input.contextUsed,
      createdAt: now(),
      provider: input.settings.providerType,
      model: input.settings.model
    };
  }

  return {
    async getSettings() {
      const { settings, secrets } = await loadConfig();
      return exposeSettings(settings, secrets);
    },
    async updateSettings(input, secrets) {
      const current = await loadConfig();
      const next = {
        settings: normalizeSettings({ ...current.settings, ...input }),
        secrets: {
          ...current.secrets,
          ...(secrets?.apiKey !== undefined ? { apiKey: secrets.apiKey } : {})
        }
      };
      await saveConfig(next);
      return exposeSettings(next.settings, next.secrets);
    },
    async getPromptPreviews() {
      const { settings } = await loadConfig();
      return getTranslationPromptPreviews(settings);
    },
    async testProvider() {
      const { settings, secrets } = await loadConfig();
      return deps.provider.testConnection(settings, secrets);
    },
    async translateUserInput(input) {
      const { settings, secrets } = await loadConfig();
      if (!settings.enabled || !settings.translateUserInput) {
        throw new VcmError({
          code: "TRANSLATION_DISABLED",
          message: "Translation input is disabled.",
          statusCode: 409
        });
      }
      if (!input.text.trim()) {
        throw new VcmError({
          code: "TRANSLATION_INPUT_EMPTY",
          message: "Translation input cannot be empty.",
          statusCode: 400
        });
      }

      const roleSession = await deps.sessionService.getRoleSession(input.repoRoot, input.taskSlug, input.role);
      const sessionState = roleSession ? getState(roleSession.id) : undefined;
      const contextText = settings.contextEnabled && input.useContext !== false
        ? sessionState?.lastAssistantText
        : undefined;
      const prompt = buildTranslationPrompt({
        direction: "user-input-to-english",
        text: input.text,
        contextText,
        settings
      });
      const entry = createEntry({
        taskSlug: input.taskSlug,
        role: input.role,
        direction: "user-input-to-english",
        sourceKind: "prose",
        sourceText: input.text,
        settings,
        status: "translating",
        contextUsed: Boolean(contextText)
      });

      try {
        const result = await deps.provider.translate({
          settings,
          secrets,
          systemPrompt: prompt.systemPrompt,
          userPrompt: prompt.userPrompt
        });
        const parsed = prompt.parseWarning ? parseTranslationWarning(result.text) : { text: result.text };
        const completed: TranslationEntry = {
          ...entry,
          status: "translated",
          translatedText: parsed.text,
          warning: parsed.warning,
          completedAt: now(),
          tokenUsage: result.tokenUsage
        };
        if (roleSession) {
          pushEntry(roleSession.id, completed);
        }

        const mode = input.mode ?? settings.inputMode;
        const shouldSend = input.send === true && mode === "auto-send" && !parsed.warning;
        if (shouldSend) {
          await writeToCurrentRole(input.repoRoot, input.taskSlug, input.role, parsed.text);
        }

        return {
          translation: completed,
          englishPreview: parsed.text,
          contextUsed: Boolean(contextText),
          requiresReview: mode === "review-before-send" || Boolean(parsed.warning),
          sent: shouldSend
        };
      } catch (error) {
        const failed: TranslationEntry = {
          ...entry,
          status: "failed",
          error: normalizeTranslationError(error),
          completedAt: now()
        };
        if (roleSession) {
          pushEntry(roleSession.id, failed);
        }
        throw new VcmError({
          code: "TRANSLATION_FAILED",
          message: failed.error ?? "Translation failed.",
          statusCode: 502
        });
      }
    },
    async sendTranslatedInput(input) {
      await writeToCurrentRole(input.repoRoot, input.taskSlug, input.role, input.englishText);
    },
    subscribeToSession(sessionId, listener) {
      const session = deps.runtime.getSession(sessionId);
      const roleSession = deps.sessionRegistry?.get(sessionId);
      if (!session && !roleSession) {
        throw new VcmError({
          code: "SESSION_MISSING",
          message: `Terminal session does not exist: ${sessionId}`,
          statusCode: 404
        });
      }

      const state = getState(sessionId);
      state.listeners.add(listener);
      for (const entry of state.entries) {
        listener({ type: "translation-entry", entry });
      }

      if (!state.unsubscribeTranscript) {
        if (!roleSession) {
          listener({
            type: "translation-error",
            message: "Claude transcript watcher is unavailable for this session."
          });
        } else {
          const replayLastN = state.hasReplayedTranscriptOutput ? 0 : 1;
          state.hasReplayedTranscriptOutput = true;
          state.unsubscribeTranscript = deps.transcripts.subscribeToRoleSession(roleSession, (event) => {
            void handleTranscriptEvent(sessionId, event).catch((error) => {
              emit(sessionId, {
                type: "translation-error",
                message: error instanceof Error ? error.message : "Translation failed."
              });
            });
          }, {
            replayLastN,
            onError(error) {
              emit(sessionId, {
                type: "translation-error",
                message: error.message
              });
            }
          });
        }
      }

      void loadConfig().then(({ settings }) => {
        listener({ type: "translation-status", status: settings.enabled ? "ready" : "paused" });
      });

      return () => {
        state.listeners.delete(listener);
        if (state.listeners.size === 0 && state.unsubscribeTranscript) {
          state.unsubscribeTranscript();
          state.unsubscribeTranscript = undefined;
        }
      };
    },
    clearSession(sessionId) {
      const state = getState(sessionId);
      state.entries = [];
      queues.clearQueue(sessionId);
    },
    async retryTranslation(sessionId, translationId) {
      const state = getState(sessionId);
      const original = state.entries.find((entry) => entry.id === translationId);
      if (!original) {
        throw new VcmError({
          code: "TRANSLATION_ENTRY_MISSING",
          message: `Translation entry not found: ${translationId}`,
          statusCode: 404
        });
      }
      if (original.direction !== "cc-output-to-user") {
        throw new VcmError({
          code: "TRANSLATION_RETRY_UNSUPPORTED",
          message: "Only Claude Code output translation entries can be retried.",
          statusCode: 400
        });
      }
      await processClaudeOutputText(sessionId, original.sourceText);
      return state.entries[state.entries.length - 1] ?? original;
    }
  };

  async function writeToCurrentRole(repoRoot: string, taskSlug: string, role: RoleName, text: string): Promise<void> {
    const record = await deps.sessionService.getRoleSession(repoRoot, taskSlug, role);
    if (!record || record.status !== "running") {
      throw new VcmError({
        code: "SESSION_NOT_RUNNING",
        message: `${role} session is not running.`,
        statusCode: 409
      });
    }
    deps.runtime.write(record.id, text.endsWith("\r") || text.endsWith("\n") ? text : `${text}\r`);
  }
}

function normalizeSettings(input: Partial<TranslationSettings>): TranslationSettings {
  const { apiKey: _apiKey, ...settings } = input;
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    version: 1,
    providerType: "openai-compatible",
    workingLanguage: "en",
    requestTimeoutMs: clampNumber(input.requestTimeoutMs, 3000, 120000, DEFAULT_SETTINGS.requestTimeoutMs),
    temperature: clampNumber(input.temperature, 0, 1, DEFAULT_SETTINGS.temperature),
    prompts: normalizePromptMap(input.prompts)
  };
}

function exposeSettings(settings: TranslationSettings, secrets: TranslationSecretSettings): TranslationSettings {
  return {
    ...settings,
    apiKey: secrets.apiKey ?? ""
  };
}

function normalizePromptMap(
  input: TranslationSettings["prompts"]
): TranslationSettings["prompts"] {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const prompts: TranslationSettings["prompts"] = {};
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = normalizePromptKey(key);
    if (normalizedKey && typeof value === "string" && value.trim()) {
      prompts[normalizedKey] = value;
    }
  }

  return Object.keys(prompts).length > 0 ? prompts : undefined;
}

function normalizePromptKey(key: string): TranslationPromptKey | undefined {
  if (TRANSLATION_PROMPT_KEYS.includes(key as TranslationPromptKey)) {
    return key as TranslationPromptKey;
  }

  if (key === "user-input-to-english") {
    return "zh-to-en";
  }
  if (key === "user-input-to-english-with-context") {
    return "zh-to-en-with-context";
  }
  if (key === "cc-output-to-user") {
    return "en-to-zh";
  }
  return undefined;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeTranslationError(error: unknown): string {
  if (error instanceof TranslationProviderError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : "Translation failed.";
}
