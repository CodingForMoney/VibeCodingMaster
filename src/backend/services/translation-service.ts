import path from "node:path";
import type { RoleName } from "../../shared/types/role.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import type {
  TranslationDiagnostics
} from "../../shared/types/diagnostics.js";
import type {
  CodexConversationTranslationJob,
  PollTranslationSessionResult,
  SendTranslatedInputRequest,
  StartTranslationSessionResult,
  TranslateUserInputRequest,
  TranslateUserInputResult,
  TranslationConversationBoundaryKind,
  TranslationEntry,
  TranslationFailureItem,
  TranslationFailuresResult,
  TranslationInputMode,
  TranslationSessionEvent,
  TranslationSessionStatus,
  TranslationSourceKind,
  TranslationStatus,
  TranslationWsMessage
} from "../../shared/types/translation.js";
import { TRANSLATION_ENTRY_RETENTION_LIMIT } from "../../shared/types/translation.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import { VcmError } from "../errors.js";
import type { TerminalRuntime, Unsubscribe } from "../runtime/terminal-runtime.js";
import type { SessionRegistry } from "../runtime/session-registry.js";
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import type { AppSettingsService } from "./app-settings-service.js";
import type { TranslationOutputMode } from "../../shared/types/app-settings.js";
import {
  type ClaudeTranscriptEvent,
  type ClaudeTranscriptService
} from "./claude-transcript-service.js";
import type { CodexTranslationService } from "./codex-translation-service.js";
import type { ProjectService } from "./project-service.js";
import type { SessionService } from "./session-service.js";
import { createTranslationQueueRegistry } from "./translation-queue.js";

export interface TranslationService {
  startSession(input: StartTranslationSessionServiceInput): Promise<StartTranslationSessionResult>;
  pollSessionEvents(sessionId: string, after: number, limit?: number): Promise<PollTranslationSessionResult>;
  recordConversationBoundary(input: RecordTranslationConversationBoundaryInput): Promise<TranslationEntry | undefined>;
  translateUserInput(input: TranslateUserInputServiceInput): Promise<TranslateUserInputResult>;
  sendTranslatedInput(input: SendTranslatedInputServiceInput): Promise<void>;
  subscribeToSession(sessionId: string, listener: TranslationEventListener): Unsubscribe;
  clearSession(sessionId: string): Promise<void>;
  stopSession(sessionId: string, options?: StopTranslationSessionOptions): Promise<void>;
  stopTask(repoRoot: string, taskSlug: string, options?: StopTranslationSessionOptions): Promise<void>;
  retryTranslation(sessionId: string, translationId: string): Promise<TranslationEntry>;
  retryFailedTranslations(sessionId: string): Promise<TranslationFailuresResult>;
  ignoreTranslationFailures(sessionId: string): Promise<TranslationFailuresResult>;
  translateGatewayOutput(input: TranslateGatewayOutputInput): Promise<string>;
  getDiagnostics(): TranslationDiagnostics;
}

export interface StartTranslationSessionServiceInput {
  repoRoot: string;
  taskRepoRoot?: string;
  taskSlug: string;
  role: RoleName;
}

export interface RecordTranslationConversationBoundaryInput {
  repoRoot: string;
  taskRepoRoot?: string;
  taskSlug: string;
  role: RoleName;
  sessionId: string;
  boundaryKind: TranslationConversationBoundaryKind;
  occurredAt?: string;
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

export interface TranslateGatewayOutputInput {
  repoRoot: string;
  taskSlug: string;
  role: RoleName;
  text: string;
}

export interface TranslationServiceDeps {
  runtime: TerminalRuntime;
  sessionRegistry: Pick<SessionRegistry, "get">;
  transcripts: ClaudeTranscriptService;
  sessionService: SessionService;
  codexTranslationService?: Pick<CodexTranslationService, "createConversationJob" | "validateConversationResult" | "getState">;
  fs?: FileSystemAdapter;
  projectService?: Pick<ProjectService, "loadConfig">;
  appSettings: Pick<AppSettingsService, "getPreferences">;
  now?: () => string;
  id?: () => string;
  outputBatchDelayMs?: number;
}

interface TranslationRuntimeConfig {
  sourceLanguage: string;
  targetLanguage: string;
  inputMode: TranslationInputMode;
  outputMode: TranslationOutputMode;
  contextEnabled: boolean;
  requestTimeoutMs: number;
}

interface SessionState {
  listeners: Set<TranslationEventListener>;
  unsubscribeTranscript?: Unsubscribe;
  seenTranscriptIds: Set<string>;
  entries: TranslationEntry[];
  failures: Map<string, TranslationFailureItem>;
  outputBatch?: PendingOutputTranslationBatch;
  lastAssistantText?: string;
  status: TranslationSessionStatus;
  events: TranslationSessionEvent[];
  nextSeq: number;
  repoRoot?: string;
  baseRepoRoot?: string;
  taskSlug?: string;
  role?: RoleName;
  cachePath?: string;
  cacheLoaded?: boolean;
  persistChain?: Promise<void>;
}

interface PendingOutputTranslation {
  entry: TranslationEntry;
  repoRoot?: string;
  sourceLanguage: string;
  targetLanguage: string;
  config: TranslationRuntimeConfig;
}

interface PendingOutputTranslationBatch {
  timer?: ReturnType<typeof setTimeout>;
  items: PendingOutputTranslation[];
}

type TranslationSessionEventInput =
  | { type: "entry"; entry: TranslationEntry }
  | { type: "status"; status: TranslationSessionStatus }
  | { type: "error"; id?: string; message: string }
  | { type: "failures"; failures: TranslationFailureItem[] };

const TRANSLATION_SOURCE_LANGUAGE = "auto";
const TRANSLATION_INPUT_MODE: TranslationInputMode = "review-before-send";
const TRANSLATION_CONTEXT_ENABLED = false;
const TRANSLATION_TIMEOUT_MS = 120000;
const TRANSLATION_PROVIDER = "codex";
const TRANSLATION_MODEL = "codex-translator";
const OUTPUT_TRANSLATION_BATCH_DELAY_MS = 10000;

const TRANSCRIPT_REPLAY_GRACE_MS = 5000;

export function createTranslationService(deps: TranslationServiceDeps): TranslationService {
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? (() => `tr_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  const outputBatchDelayMs = Math.max(0, deps.outputBatchDelayMs ?? OUTPUT_TRANSLATION_BATCH_DELAY_MS);
  const queues = createTranslationQueueRegistry();
  const sessionStates = new Map<string, SessionState>();

  async function loadConfig(): Promise<TranslationRuntimeConfig> {
    const preferences = await deps.appSettings.getPreferences();
    return {
      sourceLanguage: TRANSLATION_SOURCE_LANGUAGE,
      targetLanguage: preferences.translationTargetLanguage,
      inputMode: TRANSLATION_INPUT_MODE,
      outputMode: preferences.translationOutputMode,
      contextEnabled: TRANSLATION_CONTEXT_ENABLED,
      requestTimeoutMs: TRANSLATION_TIMEOUT_MS
    };
  }

  function getState(sessionId: string): SessionState {
    let state = sessionStates.get(sessionId);
    if (!state) {
      state = {
        listeners: new Set(),
        seenTranscriptIds: new Set(),
        entries: [],
        failures: new Map(),
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

  function publishFailures(sessionId: string): void {
    const failures = getFailureItems(getState(sessionId));
    appendEvent(sessionId, { type: "failures", failures });
    emit(sessionId, { type: "translation-failures", failures });
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
    baseRepoRoot?: string;
    taskSlug: string;
    role: RoleName;
    sessionId: string;
  }): Promise<SessionState> {
    const state = getState(input.sessionId);
    state.repoRoot = input.repoRoot;
    state.baseRepoRoot = input.baseRepoRoot ?? input.repoRoot;
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
      pruneTranslationEntries(input.sessionId);
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
      } else if (event.type === "failures") {
        state.failures = new Map(event.failures.map((failure) => [failure.translationId, failure]));
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

    let displayed = false;
    if (event.kind === "text") {
      const shouldTranslate = config.outputMode === "all" || event.stopReason === "end_turn";
      displayed = shouldTranslate
        ? processClaudeOutputText(sessionId, event.text, config, event.id, {
          flushImmediately: event.stopReason === "end_turn"
        })
        : pushPreservedProseEntry(sessionId, event.id, event.text, config);
      if (displayed && shouldTranslate) {
        state.lastAssistantText = event.text;
      }
    } else if (event.kind === "question" || event.kind === "todo" || event.kind === "agent") {
      const formatted = formatStructuredTranscriptEvent(event);
      displayed = config.outputMode === "all"
        ? processClaudeOutputText(sessionId, formatted, config, event.id)
        : pushPreservedProseEntry(sessionId, event.id, formatted, config);
    } else if (event.kind === "tool_use" || event.kind === "tool_result") {
      displayed = pushPreservedTranscriptEntry(sessionId, event.id, formatRawTranscriptEvent(event), config);
    }

    if (displayed) {
      state.seenTranscriptIds.add(event.id);
    }
  }

  function processClaudeOutputText(
    sessionId: string,
    rawText: string,
    config: TranslationRuntimeConfig,
    entryId?: string,
    options: { flushImmediately?: boolean } = {}
  ): boolean {
    return startClaudeOutputTranslation(sessionId, rawText, config, {
      entryId,
      replaceExisting: false,
      flushImmediately: options.flushImmediately === true
    }) !== undefined;
  }

  function startClaudeOutputTranslation(
    sessionId: string,
    rawText: string,
    config: TranslationRuntimeConfig,
    options: {
      entryId?: string;
      replaceExisting: boolean;
      flushImmediately?: boolean;
    }
  ): TranslationEntry | undefined {
    const session = deps.runtime.getSession(sessionId);
    const roleSession = deps.sessionRegistry.get(sessionId);
    if (!session && !roleSession) {
      return undefined;
    }

    if (!rawText.trim()) {
      return undefined;
    }
    const text = rawText;

    const baseEntry: TranslationEntry = {
      ...createEntry({
        taskSlug: roleSession?.taskSlug ?? session!.taskSlug,
        role: roleSession?.role ?? session!.role,
        direction: "cc-output-to-user",
        sourceKind: "prose",
        sourceText: text,
        config,
        status: "queued",
        contextUsed: false,
        id: options.entryId
      })
    };

    if (options.replaceExisting) {
      replaceEntry(sessionId, baseEntry);
    } else {
      pushEntry(sessionId, baseEntry);
    }

    scheduleClaudeOutputTranslation(sessionId, {
      entry: baseEntry,
      repoRoot: getState(sessionId).baseRepoRoot ?? roleSession?.cwd,
      sourceLanguage: "en",
      targetLanguage: config.targetLanguage,
      config
    }, options.replaceExisting || options.flushImmediately === true ? 0 : outputBatchDelayMs);
    return baseEntry;
  }

  function scheduleClaudeOutputTranslation(
    sessionId: string,
    pending: PendingOutputTranslation,
    delayMs: number
  ): void {
    const state = getState(sessionId);
    if (!state.outputBatch) {
      state.outputBatch = { items: [] };
    }
    state.outputBatch.items.push(pending);
    if (state.outputBatch.timer) {
      clearTimeout(state.outputBatch.timer);
      state.outputBatch.timer = undefined;
    }
    if (delayMs <= 0) {
      void flushClaudeOutputTranslations(sessionId).catch((error) => {
        publishError(sessionId, error instanceof Error ? error.message : "Translation failed.");
      });
      return;
    }
    state.outputBatch.timer = setTimeout(() => {
      void flushClaudeOutputTranslations(sessionId).catch((error) => {
        publishError(sessionId, error instanceof Error ? error.message : "Translation failed.");
      });
    }, delayMs);
  }

  async function flushClaudeOutputTranslations(sessionId: string): Promise<void> {
    const state = getState(sessionId);
    const batch = state.outputBatch;
    if (!batch || batch.items.length === 0) {
      return;
    }
    if (batch.timer) {
      clearTimeout(batch.timer);
    }
    state.outputBatch = undefined;
    const items = batch.items;
    const queue = queues.getQueue(sessionId);
    void queue.enqueue(async () => {
      publishStatus(sessionId, "translating");
      for (const item of items) {
        replaceEntry(sessionId, {
          ...item.entry,
          status: "translating",
          translationStartedAt: now()
        });
      }

      let hasFailure = false;
      try {
        const jobs: Array<{ item: PendingOutputTranslation; job: CodexConversationTranslationJob }> = [];
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index]!;
          const job = await createCodexConversationJob({
            repoRoot: item.repoRoot,
            taskSlug: item.entry.taskSlug,
            role: item.entry.role,
            direction: "cc-output-to-user",
            text: item.entry.sourceText,
            sourceKind: "prose",
            sourceLanguage: item.sourceLanguage,
            targetLanguage: item.targetLanguage,
            config: item.config,
            deferDispatch: index < items.length - 1
          });
          jobs.push({ item, job });
        }

        for (const { item, job } of jobs) {
          try {
            const result = await waitForCodexConversationResult(item.repoRoot!, job, item.config.requestTimeoutMs);
            const completed = {
              ...item.entry,
              status: "translated" as TranslationStatus,
              translatedText: result.translatedText,
              translationStartedAt: item.entry.translationStartedAt ?? now(),
              completedAt: now()
            };
            replaceEntry(sessionId, completed);
            clearFailure(sessionId, completed.id);
            getState(sessionId).lastAssistantText = item.entry.sourceText;
          } catch (error) {
            hasFailure = true;
            markOutputTranslationFailed(sessionId, item.entry, error);
          }
        }
      } catch (error) {
        hasFailure = true;
        for (const item of items) {
          markOutputTranslationFailed(sessionId, item.entry, error);
        }
      }
      publishStatus(sessionId, hasFailure ? "failed" : "ready");
    }).catch((error) => {
      publishError(sessionId, error instanceof Error ? error.message : "Translation failed.");
    });
  }

  function markOutputTranslationFailed(sessionId: string, entry: TranslationEntry, error: unknown): void {
    const failed = {
      ...entry,
      status: "failed" as TranslationStatus,
      error: error instanceof Error ? error.message : "Translation failed.",
      completedAt: now()
    };
    replaceEntry(sessionId, failed);
    recordFailure(sessionId, failed);
  }

  function pushEntry(sessionId: string, entry: TranslationEntry): void {
    getState(sessionId).entries.push(entry);
    pruneTranslationEntries(sessionId, new Set([entry.id]));
    publishEntry(sessionId, entry);
  }

  function upsertAndPublishEntry(sessionId: string, entry: TranslationEntry): void {
    const state = getState(sessionId);
    state.entries = upsertEntry(state.entries, entry);
    pruneTranslationEntries(sessionId, new Set([entry.id]));
    publishEntry(sessionId, entry);
  }

  function pushPreservedTranscriptEntry(
    sessionId: string,
    entryId: string,
    sourceText: string,
    config: TranslationRuntimeConfig
  ): boolean {
    return pushPreservedOutputEntry(sessionId, entryId, sourceText, "tool-output", config);
  }

  function pushPreservedProseEntry(
    sessionId: string,
    entryId: string,
    sourceText: string,
    config: TranslationRuntimeConfig
  ): boolean {
    return pushPreservedOutputEntry(sessionId, entryId, sourceText, "prose", config);
  }

  function pushPreservedOutputEntry(
    sessionId: string,
    entryId: string,
    sourceText: string,
    sourceKind: TranslationSourceKind,
    config: TranslationRuntimeConfig
  ): boolean {
    if (!sourceText.trim()) {
      return false;
    }

    const session = deps.runtime.getSession(sessionId);
    const roleSession = deps.sessionRegistry.get(sessionId);
    if (!session && !roleSession) {
      return false;
    }

    const entry = createEntry({
      taskSlug: roleSession?.taskSlug ?? session!.taskSlug,
      role: roleSession?.role ?? session!.role,
      direction: "cc-output-to-user",
      sourceKind,
      sourceText,
      config,
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
    state.entries = upsertEntry(state.entries, entry);
    pruneTranslationEntries(sessionId, new Set([entry.id]));
    publishEntry(sessionId, entry);
  }

  function recordFailure(sessionId: string, entry: TranslationEntry): void {
    if (!isRetryableFailedEntry(entry)) {
      return;
    }

    const state = getState(sessionId);
    const existing = state.failures.get(entry.id);
    state.failures.set(entry.id, {
      translationId: entry.id,
      sessionId,
      taskSlug: entry.taskSlug,
      role: entry.role,
      sourceText: entry.sourceText,
      error: entry.error ?? "Translation failed.",
      failedAt: entry.completedAt ?? now(),
      retryCount: existing?.retryCount ?? 0,
      lastRetryAt: existing?.lastRetryAt
    });
    publishFailures(sessionId);
  }

  function clearFailure(sessionId: string, translationId: string): void {
    const state = getState(sessionId);
    if (state.failures.delete(translationId)) {
      publishFailures(sessionId);
    }
  }

  function pruneTranslationEntries(sessionId: string, protectedIds = new Set<string>()): void {
    const state = getState(sessionId);
    const overflow = state.entries.length - TRANSLATION_ENTRY_RETENTION_LIMIT;
    if (overflow <= 0) {
      return;
    }

    const removedIds = new Set<string>();
    for (const entry of state.entries) {
      if (removedIds.size >= overflow) {
        break;
      }
      if (protectedIds.has(entry.id) || isActiveTranslationEntry(entry)) {
        continue;
      }
      removedIds.add(entry.id);
    }
    if (removedIds.size === 0) {
      return;
    }

    state.entries = state.entries.filter((entry) => !removedIds.has(entry.id));
    state.events = pruneTranslationEntryEvents(state.events, removedIds);
    void persistEvents(state);

    let failuresChanged = false;
    for (const entryId of removedIds) {
      failuresChanged = state.failures.delete(entryId) || failuresChanged;
    }
    if (failuresChanged) {
      publishFailures(sessionId);
    }
  }

  function markFailureRetrying(sessionId: string, failure: TranslationFailureItem): TranslationFailureItem {
    const retrying: TranslationFailureItem = {
      ...failure,
      retryCount: failure.retryCount + 1,
      lastRetryAt: now()
    };
    getState(sessionId).failures.set(failure.translationId, retrying);
    return retrying;
  }

  function retryOneTranslation(
    sessionId: string,
    original: TranslationEntry,
    config: TranslationRuntimeConfig
  ): TranslationEntry {
    const state = getState(sessionId);
    const existingFailure = state.failures.get(original.id) ?? {
      translationId: original.id,
      sessionId,
      taskSlug: original.taskSlug,
      role: original.role,
      sourceText: original.sourceText,
      error: original.error ?? "Translation failed.",
      failedAt: original.completedAt ?? now(),
      retryCount: 0
    };
    markFailureRetrying(sessionId, existingFailure);
    const retrying = startClaudeOutputTranslation(sessionId, original.sourceText, config, {
      entryId: original.id,
      replaceExisting: true
    });
    if (!retrying) {
      throw new VcmError({
        code: "TRANSLATION_RETRY_UNSUPPORTED",
        message: "Translation entry cannot be retried.",
        statusCode: 400
      });
    }
    return retrying;
  }

  function createEntry(input: {
    taskSlug: string;
    role: RoleName;
    direction: TranslationEntry["direction"];
    sourceKind: TranslationSourceKind;
    sourceText: string;
    config: TranslationRuntimeConfig;
    status: TranslationStatus;
    contextUsed: boolean;
    id?: string;
    translatedText?: string;
    completedAt?: string;
    boundaryKind?: TranslationConversationBoundaryKind;
    conversationTurn?: number;
    occurredAt?: string;
  }): TranslationEntry {
    return {
      id: input.id ?? id(),
      taskSlug: input.taskSlug,
      role: input.role,
      direction: input.direction,
      sourceKind: input.sourceKind,
      sourceLanguage: input.direction === "user-input-to-english" ? input.config.sourceLanguage : "en",
      targetLanguage: input.direction === "user-input-to-english" ? "en" : input.config.targetLanguage,
      sourceText: input.sourceText,
      translatedText: input.translatedText ?? "",
      status: input.status,
      contextUsed: input.contextUsed,
      boundaryKind: input.boundaryKind,
      conversationTurn: input.conversationTurn,
      occurredAt: input.occurredAt,
      createdAt: now(),
      completedAt: input.completedAt,
      provider: TRANSLATION_PROVIDER,
      model: TRANSLATION_MODEL
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
    if (state.outputBatch?.timer) {
      clearTimeout(state.outputBatch.timer);
    }
    state.outputBatch = undefined;
    queues.clearQueue(sessionId);
    if (options.clearCache && state.cachePath && deps.fs?.removePath) {
      await deps.fs.removePath(state.cachePath, { force: true });
      state.events = [];
      state.entries = [];
      state.nextSeq = 1;
    }
  }

  return {
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
        baseRepoRoot: input.repoRoot,
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
    async recordConversationBoundary(input) {
      const config = await loadConfig();
      const state = await prepareCache({
        repoRoot: input.taskRepoRoot ?? input.repoRoot,
        baseRepoRoot: input.repoRoot,
        taskSlug: input.taskSlug,
        role: input.role,
        sessionId: input.sessionId
      });
      const conversationTurn = resolveConversationBoundaryTurn(state, input.boundaryKind);
      if (conversationTurn === undefined) {
        return undefined;
      }

      const entryId = `boundary:${input.sessionId}:${conversationTurn}:${input.boundaryKind}`;
      const existing = state.entries.find((entry) => entry.id === entryId);
      if (existing) {
        return existing;
      }

      const occurredAt = input.occurredAt ?? now();
      const sourceText = formatConversationBoundaryText(input.boundaryKind, conversationTurn, occurredAt);
      const entry = createEntry({
        taskSlug: input.taskSlug,
        role: input.role,
        direction: "cc-output-to-user",
        sourceKind: "conversation-boundary",
        sourceText,
        config,
        status: "preserved",
        contextUsed: false,
        id: entryId,
        translatedText: sourceText,
        completedAt: occurredAt,
        boundaryKind: input.boundaryKind,
        conversationTurn,
        occurredAt
      });
      upsertAndPublishEntry(input.sessionId, entry);
      return entry;
    },
    async translateUserInput(input) {
      const config = await loadConfig();
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
          baseRepoRoot: input.repoRoot,
          taskSlug: input.taskSlug,
          role: input.role,
          sessionId: roleSession.id
        });
      }
      const sessionState = roleSession ? getState(roleSession.id) : undefined;
      const contextText = config.contextEnabled && input.useContext !== false
        ? sessionState?.lastAssistantText
        : undefined;
      const entry: TranslationEntry = {
        ...createEntry({
          taskSlug: input.taskSlug,
          role: input.role,
          direction: "user-input-to-english",
          sourceKind: "prose",
          sourceText: input.text,
          config,
          status: "translating",
          contextUsed: Boolean(contextText)
        }),
        translationStartedAt: now()
      };
      if (roleSession) {
        pushEntry(roleSession.id, entry);
      }

      try {
        const translation = await translateText({
          repoRoot: input.repoRoot,
          taskSlug: input.taskSlug,
          role: input.role,
          direction: "user-input-to-english",
          text: input.text,
          sourceKind: "prose",
          sourceLanguage: config.sourceLanguage,
          targetLanguage: "en",
          contextText,
          config
        });
        const completed: TranslationEntry = {
          ...entry,
          status: "translated",
          translatedText: translation.text,
          warning: translation.warning,
          completedAt: now()
        };
        if (roleSession) {
          replaceEntry(roleSession.id, completed);
        }

        const mode = input.mode ?? config.inputMode;
        const shouldSend = input.send === true && mode === "auto-send" && !translation.warning;
        if (shouldSend) {
          await writeToCurrentRole(input.repoRoot, input.taskSlug, input.role, translation.text);
        }

        return {
          translation: completed,
          englishPreview: translation.text,
          contextUsed: Boolean(contextText),
          requiresReview: mode === "review-before-send" || Boolean(translation.warning),
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
      listener({ type: "translation-failures", failures: getFailureItems(state) });

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

      listener({ type: "translation-status", status: "ready" });

      return () => {
        state.listeners.delete(listener);
        if (state.listeners.size === 0 && state.unsubscribeTranscript) {
          state.unsubscribeTranscript();
          state.unsubscribeTranscript = undefined;
        }
      };
    },
    async clearSession(sessionId) {
      const state = getState(sessionId);
      state.entries = [];
      state.failures.clear();
      state.events = [];
      state.nextSeq = 1;
      if (state.outputBatch?.timer) {
        clearTimeout(state.outputBatch.timer);
      }
      state.outputBatch = undefined;
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
      if (!isRetryableFailedEntry(original)) {
        throw new VcmError({
          code: "TRANSLATION_RETRY_UNSUPPORTED",
          message: "Only failed Claude Code output prose translation entries can be retried.",
          statusCode: 400
        });
      }
      const config = await loadConfig();
      const retrying = retryOneTranslation(sessionId, original, config);
      publishFailures(sessionId);
      return retrying;
    },
    async retryFailedTranslations(sessionId) {
      const state = getState(sessionId);
      const failures = getFailureItems(state);
      const config = await loadConfig();
      let changed = false;

      for (const failure of failures) {
        const original = state.entries.find((entry) => entry.id === failure.translationId);
        if (!original || !isRetryableFailedEntry(original)) {
          state.failures.delete(failure.translationId);
          changed = true;
          continue;
        }
        retryOneTranslation(sessionId, original, config);
        changed = true;
      }

      if (changed) {
        publishFailures(sessionId);
      }
      return { failures: getFailureItems(state) };
    },
    async ignoreTranslationFailures(sessionId) {
      const state = getState(sessionId);
      if (state.failures.size > 0) {
        state.failures.clear();
        publishFailures(sessionId);
      }
      return { failures: [] };
    },
    async translateGatewayOutput(input) {
      const config = await loadConfig();
      const translation = await translateText({
        repoRoot: input.repoRoot,
        taskSlug: input.taskSlug,
        role: input.role,
        direction: "cc-output-to-user",
        text: input.text,
        sourceKind: "prose",
        sourceLanguage: "en",
        targetLanguage: config.targetLanguage,
        config
      });
      return translation.text.trim();
    },
    getDiagnostics() {
      let transcriptWatchers = 0;
      let listeners = 0;
      for (const state of sessionStates.values()) {
        if (state.unsubscribeTranscript) {
          transcriptWatchers += 1;
        }
        listeners += state.listeners.size;
      }
      return {
        sessions: sessionStates.size,
        transcriptWatchers,
        listeners
      };
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

  async function translateText(input: {
    repoRoot?: string;
    taskSlug: string;
    role: RoleName;
    direction: TranslationEntry["direction"];
    text: string;
    sourceKind?: TranslationSourceKind;
    sourceLanguage: string;
    targetLanguage: string;
    contextText?: string;
    config: TranslationRuntimeConfig;
  }): Promise<{ text: string; warning?: string }> {
    const job = await createCodexConversationJob(input);
    const result = await waitForCodexConversationResult(input.repoRoot!, job, input.config.requestTimeoutMs);
    return {
      text: result.translatedText
    };
  }

  async function createCodexConversationJob(input: {
    repoRoot?: string;
    taskSlug: string;
    role: RoleName;
    direction: TranslationEntry["direction"];
    text: string;
    sourceKind?: TranslationSourceKind;
    sourceLanguage: string;
    targetLanguage: string;
    contextText?: string;
    config: TranslationRuntimeConfig;
    deferDispatch?: boolean;
  }): Promise<CodexConversationTranslationJob> {
    if (!deps.codexTranslationService) {
      throw new VcmError({
        code: "CODEX_TRANSLATION_UNAVAILABLE",
        message: "Codex translation service is unavailable.",
        statusCode: 500
      });
    }
    if (!input.repoRoot) {
      throw new VcmError({
        code: "TRANSLATION_REPO_ROOT_MISSING",
        message: "Codex translation requires a base repository root.",
        statusCode: 500
      });
    }

    return deps.codexTranslationService.createConversationJob(input.repoRoot, {
      taskSlug: input.taskSlug,
      role: input.role,
      direction: input.direction,
      sourceText: input.text,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      contextText: input.contextText,
      deferDispatch: input.deferDispatch
    });
  }

  async function waitForCodexConversationResult(
    repoRoot: string,
    job: CodexConversationTranslationJob,
    timeoutMs: number
  ) {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() <= deadline) {
      const state = await deps.codexTranslationService!.getState(repoRoot);
      const item = job.queueItemId
        ? state.queue.items.find((candidate) => candidate.id === job.queueItemId)
        : undefined;
      if (item && ["failed", "cancelled", "interrupted", "skipped"].includes(item.status)) {
        throw new VcmError({
          code: "TRANSLATION_FAILED",
          message: item.error ?? "Codex translation failed.",
          statusCode: 502
        });
      }
      if (item && item.status !== "completed") {
        await delay(Math.min(500, Math.max(25, timeoutMs)));
        continue;
      }
      try {
        return await deps.codexTranslationService!.validateConversationResult(repoRoot, {
          taskSlug: job.taskSlug,
          resultPath: job.resultPath,
          sourceHash: job.sourceHash,
          targetLanguage: job.targetLanguage
        });
      } catch (error) {
        lastError = error;
        if (item?.status === "completed") {
          throw error;
        }
      }
      await delay(Math.min(500, Math.max(25, timeoutMs)));
    }
    throw new VcmError({
      code: "TRANSLATION_TIMEOUT",
      message: lastError instanceof Error ? `Codex translation timed out: ${lastError.message}` : "Codex translation timed out.",
      statusCode: 504
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function resolveConversationBoundaryTurn(
  state: SessionState,
  boundaryKind: TranslationConversationBoundaryKind
): number | undefined {
  const openTurn = getOpenConversationTurn(state);
  if (boundaryKind === "start") {
    return openTurn ?? getMaxConversationTurn(state) + 1;
  }
  return openTurn;
}

function getOpenConversationTurn(state: SessionState): number | undefined {
  const startTurns = getBoundaryEntries(state)
    .filter((entry) => entry.boundaryKind === "start")
    .map((entry) => entry.conversationTurn)
    .filter((turn): turn is number => typeof turn === "number" && Number.isFinite(turn))
    .sort((left, right) => right - left);

  return startTurns.find((turn) => !hasBoundaryEntry(state, turn, "end"));
}

function getMaxConversationTurn(state: SessionState): number {
  return Math.max(
    0,
    ...getBoundaryEntries(state)
      .map((entry) => entry.conversationTurn)
      .filter((turn): turn is number => typeof turn === "number" && Number.isFinite(turn))
  );
}

function hasBoundaryEntry(
  state: SessionState,
  conversationTurn: number,
  boundaryKind: TranslationConversationBoundaryKind
): boolean {
  return getBoundaryEntries(state).some((entry) =>
    entry.boundaryKind === boundaryKind &&
    entry.conversationTurn === conversationTurn
  );
}

function getBoundaryEntries(state: SessionState): TranslationEntry[] {
  return state.entries.filter((entry) => entry.sourceKind === "conversation-boundary");
}

function getFailureItems(state: SessionState): TranslationFailureItem[] {
  return Array.from(state.failures.values());
}

function isActiveTranslationEntry(entry: TranslationEntry): boolean {
  return entry.status === "queued" || entry.status === "translating";
}

function isRetryableFailedEntry(entry: TranslationEntry): boolean {
  return entry.status === "failed"
    && entry.direction === "cc-output-to-user"
    && entry.sourceKind === "prose";
}

function pruneTranslationEntryEvents(
  events: TranslationSessionEvent[],
  removedIds: Set<string>
): TranslationSessionEvent[] {
  const pruned: TranslationSessionEvent[] = [];
  for (const event of events) {
    if (event.type === "entry") {
      if (!removedIds.has(event.entry.id)) {
        pruned.push(event);
      }
      continue;
    }
    if (event.type === "failures") {
      pruned.push({
        ...event,
        failures: event.failures.filter((failure) => !removedIds.has(failure.translationId))
      });
      continue;
    }
    pruned.push(event);
  }
  return pruned;
}

function formatConversationBoundaryText(
  boundaryKind: TranslationConversationBoundaryKind,
  conversationTurn: number,
  occurredAt: string
): string {
  const label = boundaryKind === "start" ? "开始" : "结束";
  return `-------${label}---第 ${conversationTurn} 轮----${formatBoundaryTime(occurredAt)}---------------`;
}

function formatBoundaryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
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

function normalizeTranslationError(error: unknown): string {
  return error instanceof Error ? error.message : "Translation failed.";
}
