import path from "node:path";
import type { RoleName } from "../../shared/types/role.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import type {
  PollTranslationSessionResult,
  SendTranslatedInputRequest,
  StartTranslationSessionResult,
  TranslateUserInputRequest,
  TranslateUserInputResult,
  TranslationEntry,
  TranslationPromptKey,
  TranslationPromptPreview,
  TranslationProviderTestResult,
  TranslationSecretSettings,
  TranslationSessionEvent,
  TranslationSessionStatus,
  TranslationSettings,
  TranslationSourceKind,
  TranslationStatus,
  TranslationWsMessage
} from "../../shared/types/translation.js";
import { TRANSLATION_PROMPT_KEYS } from "../../shared/types/translation.js";
import type { TranslationProvider } from "../adapters/translation-provider.js";
import { TranslationProviderError } from "../adapters/translation-provider.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import { VcmError } from "../errors.js";
import type { TerminalRuntime, Unsubscribe } from "../runtime/terminal-runtime.js";
import type { SessionRegistry } from "../runtime/session-registry.js";
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import type { AppSettingsService } from "./app-settings-service.js";
import {
  type ClaudeTranscriptEvent,
  type ClaudeTranscriptService
} from "./claude-transcript-service.js";
import type { ProjectService } from "./project-service.js";
import type { SessionService } from "./session-service.js";
import { buildTranslationPrompt, getTranslationPromptPreviews, parseTranslationWarning } from "./translation-prompts.js";
import { createTranslationQueueRegistry } from "./translation-queue.js";

export interface TranslationService {
  getSettings(): Promise<TranslationSettings>;
  updateSettings(input: Partial<TranslationSettings>, secrets?: TranslationSecretSettings): Promise<TranslationSettings>;
  getPromptPreviews(): Promise<TranslationPromptPreview[]>;
  testProvider(): Promise<TranslationProviderTestResult>;
  startSession(input: StartTranslationSessionServiceInput): Promise<StartTranslationSessionResult>;
  pollSessionEvents(sessionId: string, after: number, limit?: number): Promise<PollTranslationSessionResult>;
  translateUserInput(input: TranslateUserInputServiceInput): Promise<TranslateUserInputResult>;
  sendTranslatedInput(input: SendTranslatedInputServiceInput): Promise<void>;
  subscribeToSession(sessionId: string, listener: TranslationEventListener): Unsubscribe;
  clearSession(sessionId: string): Promise<void>;
  stopSession(sessionId: string, options?: StopTranslationSessionOptions): Promise<void>;
  stopTask(repoRoot: string, taskSlug: string, options?: StopTranslationSessionOptions): Promise<void>;
  retryTranslation(sessionId: string, translationId: string): Promise<TranslationEntry>;
}

export interface StartTranslationSessionServiceInput {
  repoRoot: string;
  taskRepoRoot?: string;
  taskSlug: string;
  role: RoleName;
}

export interface TranslateUserInputServiceInput extends TranslateUserInputRequest {
  repoRoot: string;
  taskRepoRoot?: string;
  taskSlug: string;
  role: RoleName;
}

export interface SendTranslatedInputServiceInput extends SendTranslatedInputRequest {
  repoRoot: string;
  taskRepoRoot?: string;
  taskSlug: string;
  role: RoleName;
}

export type TranslationEventListener = (message: TranslationWsMessage) => void;

export interface StopTranslationSessionOptions {
  clearCache?: boolean;
}

export interface TranslationServiceDeps {
  provider: TranslationProvider;
  runtime: TerminalRuntime;
  sessionRegistry: Pick<SessionRegistry, "get">;
  transcripts: ClaudeTranscriptService;
  sessionService: SessionService;
  fs?: FileSystemAdapter;
  projectService?: Pick<ProjectService, "loadConfig">;
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
  status: TranslationSessionStatus;
  events: TranslationSessionEvent[];
  nextSeq: number;
  repoRoot?: string;
  taskSlug?: string;
  role?: RoleName;
  cachePath?: string;
  cacheLoaded?: boolean;
  persistChain?: Promise<void>;
}

type TranslationSessionEventInput =
  | { type: "entry"; entry: TranslationEntry }
  | { type: "status"; status: TranslationSessionStatus }
  | { type: "error"; id?: string; message: string };

const DEFAULT_SETTINGS: TranslationSettings = {
  version: 1,
  enabled: true,
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
        entries: [],
        status: "ready",
        events: [],
        nextSeq: 1
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

  function publishEntry(sessionId: string, entry: TranslationEntry): void {
    appendEvent(sessionId, { type: "entry", entry });
    emit(sessionId, { type: "translation-entry", entry });
  }

  function publishStatus(sessionId: string, status: TranslationSessionStatus): void {
    const state = getState(sessionId);
    state.status = status;
    appendEvent(sessionId, { type: "status", status });
    emit(sessionId, { type: "translation-status", status });
  }

  function publishError(sessionId: string, message: string, id?: string): void {
    const state = getState(sessionId);
    state.status = "failed";
    appendEvent(sessionId, { type: "error", id, message });
    emit(sessionId, { type: "translation-error", id, message });
  }

  function appendEvent(
    sessionId: string,
    input: TranslationSessionEventInput
  ): TranslationSessionEvent {
    const state = getState(sessionId);
    const event = {
      ...input,
      seq: state.nextSeq++,
      createdAt: now()
    } as TranslationSessionEvent;
    state.events.push(event);
    void persistEvents(state);
    return event;
  }

  async function prepareCache(input: {
    repoRoot: string;
    taskSlug: string;
    role: RoleName;
    sessionId: string;
  }): Promise<SessionState> {
    const state = getState(input.sessionId);
    state.repoRoot = input.repoRoot;
    state.taskSlug = input.taskSlug;
    state.role = input.role;

    if (!deps.fs || !deps.projectService) {
      return state;
    }

    const config = await deps.projectService.loadConfig(input.repoRoot);
    const cachePath = getTranslationCachePath(input.repoRoot, config.stateRoot, input.taskSlug, input.role, input.sessionId);
    state.cachePath = cachePath;

    if (!state.cacheLoaded) {
      await loadCachedEvents(state);
      state.cacheLoaded = true;
    }

    await deps.fs.ensureDir(path.dirname(cachePath));
    return state;
  }

  async function loadCachedEvents(state: SessionState): Promise<void> {
    if (!deps.fs || !state.cachePath || state.events.length > 0 || !(await deps.fs.pathExists(state.cachePath))) {
      return;
    }

    const text = await deps.fs.readText(state.cachePath);
    const events: TranslationSessionEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        events.push(JSON.parse(line) as TranslationSessionEvent);
      } catch {
        // Ignore corrupt cache lines; transcript tailing remains the source of truth.
      }
    }

    state.events = events.sort((left, right) => left.seq - right.seq);
    state.nextSeq = Math.max(state.nextSeq, ...state.events.map((event) => event.seq + 1), 1);
    for (const event of state.events) {
      if (event.type === "entry") {
        state.entries = upsertEntry(state.entries, event.entry);
      } else if (event.type === "status") {
        state.status = event.status;
      } else if (event.type === "error") {
        state.status = "failed";
      }
    }
  }

  async function persistEvents(state: SessionState): Promise<void> {
    if (!deps.fs || !state.cachePath) {
      return;
    }

    const write = async () => {
      const text = state.events.map((event) => JSON.stringify(event)).join("\n");
      await deps.fs!.writeText(state.cachePath!, text ? `${text}\n` : "");
    };
    state.persistChain = (state.persistChain ?? Promise.resolve()).catch(() => undefined).then(write);
    await state.persistChain;
  }

  async function compactEventsBefore(state: SessionState, nextCursor: number): Promise<void> {
    const normalizedCursor = Math.max(1, Math.floor(nextCursor));
    const beforeCount = state.events.length;
    state.events = state.events.filter((event) => event.seq >= normalizedCursor);
    if (beforeCount !== state.events.length) {
      await persistEvents(state);
    }
  }

  function startTranscriptTail(roleSession: RoleSessionRecord): void {
    const state = getState(roleSession.id);
    if (state.unsubscribeTranscript) {
      return;
    }

    const replaySince = getTranscriptReplaySince(roleSession);
    state.unsubscribeTranscript = deps.transcripts.subscribeToRoleSession(roleSession, (event) => {
      void handleTranscriptEvent(roleSession.id, event).catch((error) => {
        publishError(roleSession.id, error instanceof Error ? error.message : "Translation failed.");
      });
    }, {
      onError(error) {
        publishError(roleSession.id, error.message);
      },
      onPoll(checkedAt) {
        emit(roleSession.id, { type: "translation-poll", checkedAt });
      },
      replaySince
    });
  }

  async function handleTranscriptEvent(sessionId: string, event: ClaudeTranscriptEvent): Promise<void> {
    const state = getState(sessionId);
    if (state.seenTranscriptIds.has(event.id)) {
      return;
    }

    const config = await loadConfig();
    const { settings } = config;

    let displayed = false;
    if (event.kind === "text") {
      displayed = processClaudeOutputText(sessionId, event.text, config, event.id);
      if (displayed) {
        state.lastAssistantText = event.text;
      }
    } else if (event.kind === "question" || event.kind === "todo" || event.kind === "agent") {
      displayed = processClaudeOutputText(sessionId, formatStructuredTranscriptEvent(event), config, event.id);
    } else if (event.kind === "tool_use" || event.kind === "tool_result") {
      displayed = pushPreservedTranscriptEntry(sessionId, event.id, formatRawTranscriptEvent(event), settings);
    }

    if (displayed) {
      state.seenTranscriptIds.add(event.id);
    }
  }

  function processClaudeOutputText(
    sessionId: string,
    rawText: string,
    config: StoredTranslationConfig,
    entryId?: string
  ): boolean {
    const session = deps.runtime.getSession(sessionId);
    const roleSession = deps.sessionRegistry.get(sessionId);
    if (!session && !roleSession) {
      return false;
    }

    const { settings, secrets } = config;
    if (!rawText.trim()) {
      return false;
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
    void queue.enqueue(async () => {
      publishStatus(sessionId, "translating");

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
        publishStatus(sessionId, "ready");
      } catch (error) {
        const failed = {
          ...baseEntry,
          status: "failed" as TranslationStatus,
          error: error instanceof Error ? error.message : "Translation failed.",
          completedAt: now()
        };
        replaceEntry(sessionId, failed);
        publishStatus(sessionId, "failed");
      }
    }).catch((error) => {
      publishError(sessionId, error instanceof Error ? error.message : "Translation failed.");
    });
    return true;
  }

  function pushEntry(sessionId: string, entry: TranslationEntry): void {
    getState(sessionId).entries.push(entry);
    publishEntry(sessionId, entry);
  }

  function pushPreservedTranscriptEntry(
    sessionId: string,
    entryId: string,
    sourceText: string,
    settings: TranslationSettings
  ): boolean {
    const session = deps.runtime.getSession(sessionId);
    const roleSession = deps.sessionRegistry.get(sessionId);
    if (!session && !roleSession) {
      return false;
    }

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
    return true;
  }

  function replaceEntry(sessionId: string, entry: TranslationEntry): void {
    const state = getState(sessionId);
    state.entries = state.entries.map((current) => current.id === entry.id ? entry : current);
    publishEntry(sessionId, entry);
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

  async function stopSessionInternal(sessionId: string, options: StopTranslationSessionOptions = {}): Promise<void> {
    const state = sessionStates.get(sessionId);
    if (!state) {
      return;
    }
    if (state.unsubscribeTranscript) {
      state.unsubscribeTranscript();
      state.unsubscribeTranscript = undefined;
    }
    queues.clearQueue(sessionId);
    if (options.clearCache && state.cachePath && deps.fs?.removePath) {
      await deps.fs.removePath(state.cachePath, { force: true });
      state.events = [];
      state.entries = [];
      state.nextSeq = 1;
    }
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
    async startSession(input) {
      const roleSession = await deps.sessionService.getRoleSession(input.repoRoot, input.taskSlug, input.role);
      if (!roleSession || roleSession.status !== "running") {
        throw new VcmError({
          code: "SESSION_NOT_RUNNING",
          message: `${input.role} session is not running.`,
          statusCode: 409
        });
      }

      const state = await prepareCache({
        repoRoot: input.taskRepoRoot ?? input.repoRoot,
        taskSlug: input.taskSlug,
        role: input.role,
        sessionId: roleSession.id
      });
      startTranscriptTail(roleSession);
      return {
        sessionId: roleSession.id,
        status: state.status,
        nextCursor: 1
      };
    },
    async pollSessionEvents(sessionId, after, limit = 200) {
      const state = getState(sessionId);
      const cursor = Number.isFinite(after) ? Math.max(1, Math.floor(after)) : 1;
      const maxEvents = Math.min(Math.max(1, Math.floor(limit)), 500);
      await compactEventsBefore(state, cursor);
      const events = state.events
        .filter((event) => event.seq >= cursor)
        .slice(0, maxEvents);
      const nextCursor = events.length > 0 ? (events.at(-1)?.seq ?? cursor) + 1 : cursor;
      return {
        sessionId,
        status: state.status,
        nextCursor,
        events
      };
    },
    async translateUserInput(input) {
      const { settings, secrets } = await loadConfig();
      if (!input.text.trim()) {
        throw new VcmError({
          code: "TRANSLATION_INPUT_EMPTY",
          message: "Translation input cannot be empty.",
          statusCode: 400
        });
      }

      const roleSession = await deps.sessionService.getRoleSession(input.repoRoot, input.taskSlug, input.role);
      if (roleSession) {
        await prepareCache({
          repoRoot: input.taskRepoRoot ?? input.repoRoot,
          taskSlug: input.taskSlug,
          role: input.role,
          sessionId: roleSession.id
        });
      }
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
          startTranscriptTail(roleSession);
        }
      }

      void loadConfig().then(({ settings }) => {
        listener({ type: "translation-status", status: "ready" });
      });

      return () => {
        state.listeners.delete(listener);
      };
    },
    async clearSession(sessionId) {
      const state = getState(sessionId);
      state.entries = [];
      state.events = [];
      state.nextSeq = 1;
      queues.clearQueue(sessionId);
      await persistEvents(state);
    },
    async stopSession(sessionId, options = {}) {
      await stopSessionInternal(sessionId, options);
    },
    async stopTask(repoRoot, taskSlug, options = {}) {
      for (const [sessionId, state] of sessionStates) {
        if (state.repoRoot === repoRoot && state.taskSlug === taskSlug) {
          await stopSessionInternal(sessionId, options);
        }
      }
      if (options.clearCache && deps.fs?.removePath && deps.projectService) {
        const config = await deps.projectService.loadConfig(repoRoot);
        await deps.fs.removePath(path.join(repoRoot, config.stateRoot, "translation", taskSlug), {
          recursive: true,
          force: true
        });
      }
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
      const config = await loadConfig();
      processClaudeOutputText(sessionId, original.sourceText, config);
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
    await submitTerminalInput(deps.runtime, record.id, text);
  }
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

function upsertEntry(entries: TranslationEntry[], entry: TranslationEntry): TranslationEntry[] {
  const index = entries.findIndex((current) => current.id === entry.id);
  if (index === -1) {
    return [...entries, entry];
  }

  return entries.map((current) => current.id === entry.id ? entry : current);
}

function getTranslationCachePath(
  repoRoot: string,
  stateRoot: string,
  taskSlug: string,
  role: RoleName,
  sessionId: string
): string {
  return path.join(repoRoot, stateRoot, "translation", taskSlug, role, `${sessionId}.jsonl`);
}

function normalizeSettings(input: Partial<TranslationSettings>): TranslationSettings {
  const { apiKey: _apiKey, ...settings } = input;
    return {
      ...DEFAULT_SETTINGS,
      ...settings,
      version: 1,
      enabled: true,
      providerType: "openai-compatible",
      workingLanguage: "en",
      inputMode: "review-before-send",
      translateOutput: true,
      translateUserInput: true,
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
