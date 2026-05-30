import type { RoleName } from "../../shared/types/role.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
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
import type { TranslationProvider } from "../adapters/translation-provider.js";
import { TranslationProviderError } from "../adapters/translation-provider.js";
import { VcmError } from "../errors.js";
import type { TerminalRuntime, Unsubscribe } from "../runtime/terminal-runtime.js";
import type { SessionRegistry } from "../runtime/session-registry.js";
import type { AppSettingsService } from "./app-settings-service.js";
import {
  type ClaudeTranscriptEvent,
  type ClaudeTranscriptService
} from "./claude-transcript-service.js";
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

const TRANSCRIPT_REPLAY_GRACE_MS = 5000;

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
    const state = getState(sessionId);
    if (state.seenTranscriptIds.has(event.id)) {
      return;
    }
    state.seenTranscriptIds.add(event.id);

    if (event.kind === "text") {
      state.lastAssistantText = event.text;
    }

    const { settings } = await loadConfig();
    if (!settings.enabled || !settings.translateOutput) {
      return;
    }

    if (event.kind === "text") {
      await processClaudeOutputText(sessionId, event.text, event.id);
      return;
    }

    if (event.kind === "question" || event.kind === "todo" || event.kind === "agent") {
      await processClaudeOutputText(sessionId, formatStructuredTranscriptEvent(event), event.id);
      return;
    }

    if (event.kind === "tool_use" || event.kind === "tool_result") {
      await pushPreservedTranscriptEntry(sessionId, event.id, formatRawTranscriptEvent(event));
    }
  }

  async function processClaudeOutputText(sessionId: string, rawText: string, entryId?: string): Promise<void> {
    const session = deps.runtime.getSession(sessionId);
    const roleSession = deps.sessionRegistry.get(sessionId);
    if (!session && !roleSession) {
      return;
    }

    const { settings, secrets } = await loadConfig();
    if (!rawText.trim()) {
      return;
    }
    const text = rawText;

    const baseEntry: TranslationEntry = {
      ...createEntry({
        taskSlug: roleSession?.taskSlug ?? session!.taskSlug,
        role: roleSession?.role ?? session!.role,
        direction: "cc-output-to-user",
        sourceKind: "prose",
        sourceText: text,
        settings,
        status: "translating",
        contextUsed: false,
        id: entryId
      }),
      translationStartedAt: now()
    };

    pushEntry(sessionId, baseEntry);

    const queue = queues.getQueue(sessionId);
    await queue.enqueue(async () => {
      emit(sessionId, { type: "translation-status", status: "translating" });

      try {
        const prompt = buildTranslationPrompt({
          direction: "cc-output-to-user",
          text,
          sourceKind: "prose",
          settings
        });
        const result = await deps.provider.translate({
          settings,
          secrets,
          systemPrompt: prompt.systemPrompt,
          userPrompt: prompt.userPrompt
        });
        const completed = {
          ...baseEntry,
          status: "translated" as TranslationStatus,
          translatedText: result.text,
          completedAt: now(),
          tokenUsage: result.tokenUsage
        };
        replaceEntry(sessionId, completed);
        getState(sessionId).lastAssistantText = text;
        emit(sessionId, { type: "translation-status", status: "ready" });
      } catch (error) {
        const failed = {
          ...baseEntry,
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

  async function pushPreservedTranscriptEntry(sessionId: string, entryId: string, sourceText: string): Promise<void> {
    const session = deps.runtime.getSession(sessionId);
    const roleSession = deps.sessionRegistry.get(sessionId);
    if (!session && !roleSession) {
      return;
    }

    const { settings } = await loadConfig();
    const queue = queues.getQueue(sessionId);
    await queue.enqueue(async () => {
      const entry = createEntry({
        taskSlug: roleSession?.taskSlug ?? session!.taskSlug,
        role: roleSession?.role ?? session!.role,
        direction: "cc-output-to-user",
        sourceKind: "tool-output",
        sourceText,
        settings,
        status: "preserved",
        contextUsed: false,
        id: entryId,
        translatedText: sourceText,
        completedAt: now()
      });
      pushEntry(sessionId, entry);
    });
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
    id?: string;
    translatedText?: string;
    completedAt?: string;
  }): TranslationEntry {
    return {
      id: input.id ?? id(),
      taskSlug: input.taskSlug,
      role: input.role,
      direction: input.direction,
      sourceKind: input.sourceKind,
      sourceLanguage: input.direction === "user-input-to-english" ? input.settings.sourceLanguage : "en",
      targetLanguage: input.direction === "user-input-to-english" ? "en" : input.settings.targetLanguage,
      sourceText: input.sourceText,
      translatedText: input.translatedText ?? "",
      status: input.status,
      contextUsed: input.contextUsed,
      createdAt: now(),
      completedAt: input.completedAt,
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
      const entry: TranslationEntry = {
        ...createEntry({
          taskSlug: input.taskSlug,
          role: input.role,
          direction: "user-input-to-english",
          sourceKind: "prose",
          sourceText: input.text,
          settings,
          status: "translating",
          contextUsed: Boolean(contextText)
        }),
        translationStartedAt: now()
      };
      if (roleSession) {
        pushEntry(roleSession.id, entry);
      }

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
          replaceEntry(roleSession.id, completed);
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
          replaceEntry(roleSession.id, failed);
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
      const roleSession = deps.sessionRegistry.get(sessionId);
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
          const replaySince = getTranscriptReplaySince(roleSession);
          state.unsubscribeTranscript = deps.transcripts.subscribeToRoleSession(roleSession, (event) => {
            void handleTranscriptEvent(sessionId, event).catch((error) => {
              emit(sessionId, {
                type: "translation-error",
                message: error instanceof Error ? error.message : "Translation failed."
              });
            });
          }, {
            onError(error) {
              emit(sessionId, {
                type: "translation-error",
                message: error.message
              });
            },
            replaySince
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
    deps.runtime.write(record.id, formatTerminalSubmit(text));
  }
}

export function formatTerminalSubmit(text: string): string {
  return `${text.replace(/[\r\n]+$/g, "")}\r`;
}

function getTranscriptReplaySince(roleSession: RoleSessionRecord): string | undefined {
  const rawTimestamp = roleSession.startedAt ?? roleSession.updatedAt;
  const timestampMs = Date.parse(rawTimestamp);
  if (!Number.isFinite(timestampMs)) {
    return undefined;
  }
  return new Date(Math.max(0, timestampMs - TRANSCRIPT_REPLAY_GRACE_MS)).toISOString();
}

function formatStructuredTranscriptEvent(event: Extract<ClaudeTranscriptEvent, { kind: "question" | "todo" | "agent" }>): string {
  if (event.kind === "question") {
    return event.question.questions.map((question, index) => {
      const title = question.header ? `${question.header}: ${question.question}` : question.question;
      const options = question.options.map((option) => {
        const preview = option.preview ? `\n  Preview: ${option.preview}` : "";
        return `- ${option.label}: ${option.description}${preview}`;
      });
      return [`AskUserQuestion ${index + 1}`, title, `Multi-select: ${question.multiSelect ? "yes" : "no"}`, "Options:", ...options]
        .filter(Boolean)
        .join("\n");
    }).join("\n\n");
  }

  if (event.kind === "todo") {
    return [
      "TodoWrite plan",
      ...event.todo.todos.map((todo) => {
        const text = todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content;
        return `- [${todo.status}] ${text}`;
      })
    ].join("\n");
  }

  return [
    `Agent dispatch${event.agent.subagent_type ? `: ${event.agent.subagent_type}` : ""}`,
    event.agent.description ? `Description: ${event.agent.description}` : "",
    event.agent.prompt ? `Prompt:\n${event.agent.prompt}` : ""
  ].filter(Boolean).join("\n");
}

function formatRawTranscriptEvent(event: Extract<ClaudeTranscriptEvent, { kind: "tool_use" | "tool_result" }>): string {
  if (event.kind === "tool_use") {
    return `● ${event.toolUse.name}(${formatUnknown(event.toolUse.input)})`;
  }

  const errorPrefix = event.toolResult.isError ? "[error] " : "";
  return `⎿ ${errorPrefix}${formatUnknown(event.toolResult.content)}`;
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
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
