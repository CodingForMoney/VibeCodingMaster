import type { RoleName } from "./role.js";

export type TranslationProviderType = "openai-compatible";

export type TranslationDirection =
  | "user-input-to-english"
  | "cc-output-to-user";

export type TranslationInputMode =
  | "review-before-send"
  | "auto-send";

export type TranslationPromptKey =
  | "zh-to-en"
  | "zh-to-en-with-context"
  | "en-to-zh";

export const TRANSLATION_PROMPT_KEYS: readonly TranslationPromptKey[] = [
  "zh-to-en",
  "zh-to-en-with-context",
  "en-to-zh"
] as const;

export const TRANSLATION_ENTRY_RETENTION_LIMIT = 500;

export type TranslationSourceKind =
  | "prose"
  | "tool-output"
  | "conversation-boundary";

export type TranslationConversationBoundaryKind =
  | "start"
  | "end";

export type TranslationStatus =
  | "queued"
  | "translating"
  | "translated"
  | "failed"
  | "preserved";

export interface TranslationSettings {
  version: 1;
  enabled: boolean;
  providerType: TranslationProviderType;
  baseUrl: string;
  apiKey?: string;
  model: string;
  sourceLanguage: "auto" | string;
  targetLanguage: string;
  workingLanguage: "en";
  inputMode: TranslationInputMode;
  translateOutput: boolean;
  translateUserInput: boolean;
  contextEnabled: boolean;
  preserveTechnicalTokens: boolean;
  skipCjkText: boolean;
  redactSecrets: boolean;
  requestTimeoutMs: number;
  temperature: number;
  prompts?: Partial<Record<TranslationPromptKey, string>>;
}

export interface TranslationSecretSettings {
  apiKey?: string;
}

export interface TranslationTokenUsage {
  input: number;
  output: number;
  total?: number;
}

export interface TranslationEntry {
  id: string;
  taskSlug: string;
  role: RoleName;
  direction: TranslationDirection;
  sourceKind: TranslationSourceKind;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  translatedText: string;
  status: TranslationStatus;
  contextUsed: boolean;
  boundaryKind?: TranslationConversationBoundaryKind;
  conversationTurn?: number;
  occurredAt?: string;
  warning?: string;
  error?: string;
  createdAt: string;
  translationStartedAt?: string;
  completedAt?: string;
  provider: TranslationProviderType;
  model: string;
  tokenUsage?: TranslationTokenUsage;
}

export interface TranslationFailureItem {
  translationId: string;
  sessionId: string;
  taskSlug: string;
  role: RoleName;
  sourceText: string;
  error: string;
  failedAt: string;
  retryCount: number;
  lastRetryAt?: string;
}

export interface TranslationFailuresResult {
  failures: TranslationFailureItem[];
}

export interface TranslateUserInputRequest {
  text: string;
  mode?: TranslationInputMode;
  useContext?: boolean;
  send?: boolean;
}

export interface TranslateUserInputResult {
  translation: TranslationEntry;
  englishPreview: string;
  contextUsed: boolean;
  requiresReview: boolean;
  sent: boolean;
}

export interface SendTranslatedInputRequest {
  englishText: string;
}

export interface TranslationProviderTestResult {
  ok: boolean;
  model: string;
  elapsedMs: number;
  error?: string;
}

export interface TranslationPromptPreview {
  key: TranslationPromptKey;
  label: string;
  defaultPrompt: string;
  userPrompt: string;
  customized: boolean;
}

export type TranslationSessionStatus =
  | "ready"
  | "paused"
  | "translating"
  | "failed";

export type TranslationSessionEvent =
  | {
      seq: number;
      type: "entry";
      createdAt: string;
      entry: TranslationEntry;
    }
  | {
      seq: number;
      type: "status";
      createdAt: string;
      status: TranslationSessionStatus;
    }
  | {
      seq: number;
      type: "error";
      createdAt: string;
      id?: string;
      message: string;
    }
  | {
      seq: number;
      type: "failures";
      createdAt: string;
      failures: TranslationFailureItem[];
    };

export interface StartTranslationSessionResult {
  sessionId: string;
  status: TranslationSessionStatus;
  nextCursor: number;
}

export interface PollTranslationSessionResult {
  sessionId: string;
  status: TranslationSessionStatus;
  nextCursor: number;
  events: TranslationSessionEvent[];
}

export type TranslationWsMessage =
  | { type: "translation-entry"; entry: TranslationEntry }
  | { type: "translation-status"; status: TranslationSessionStatus }
  | { type: "translation-poll"; checkedAt: string }
  | { type: "translation-error"; id?: string; message: string }
  | { type: "translation-failures"; failures: TranslationFailureItem[] };

export type CodexTranslationQueueItemType =
  | "bootstrap"
  | "file"
  | "conversation"
  | "retry"
  | "resume"
  | "force-retranslate";

export type CodexTranslationQueueItemStatus =
  | "queued"
  | "dispatching"
  | "running"
  | "validating"
  | "completed"
  | "needs_review"
  | "failed"
  | "interrupted"
  | "skipped"
  | "cancelled";

export interface CodexTranslationQueueItem {
  id: string;
  type: CodexTranslationQueueItemType;
  status: CodexTranslationQueueItemStatus;
  targetLanguage: string;
  jobId?: string;
  requestPath: string;
  expectedResultPath?: string;
  reportPath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexTranslationQueueState {
  version: 1;
  activeItemId?: string;
  updatedAt: string;
  items: CodexTranslationQueueItem[];
}

export type CodexFileTranslationJobStatus =
  | "queued"
  | "running"
  | "validating"
  | "completed"
  | "needs_review"
  | "failed"
  | "interrupted"
  | "skipped"
  | "cancelled";

export interface CodexFileTranslationJob {
  id: string;
  sourcePath: string;
  sourceHash: string;
  sourceBytes: number;
  sourceMtimeMs?: number;
  targetLanguage: string;
  translationProfile: string;
  chunkSourceTokenTarget: number;
  dedupeKey: string;
  status: CodexFileTranslationJobStatus;
  requestPath: string;
  progressPath: string;
  resultPath: string;
  reportPath: string;
  queueItemId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CodexFileTranslationIndex {
  version: 1;
  updatedAt: string;
  jobs: CodexFileTranslationJob[];
}

export interface CodexBootstrapRun {
  id: string;
  status: CodexTranslationQueueItemStatus;
  targetLanguage: string;
  candidatePaths: string[];
  requestPath: string;
  reportPath: string;
  sampleTranslationsPath?: string;
  queueItemId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CodexBootstrapIndex {
  version: 1;
  updatedAt: string;
  runs: CodexBootstrapRun[];
}

export interface CreateCodexFileTranslationRequest {
  taskSlug?: string;
  sourcePath: string;
  targetLanguage: string;
  translationProfile?: string;
  chunkSourceTokenTarget?: number;
  force?: boolean;
}

export interface BrowseCodexTranslationSourceFilesRequest {
  path?: string;
  query?: string;
  limit?: number;
}

export interface CodexTranslationSourceFileEntry {
  name: string;
  path: string;
  type: "directory" | "file";
  selectable: boolean;
  extension?: string;
  reason?: string;
}

export interface CodexTranslationSourceFileBrowserResult {
  currentPath: string;
  parentPath?: string;
  query?: string;
  entries: CodexTranslationSourceFileEntry[];
  truncated: boolean;
}

export interface CreateCodexBootstrapRequest {
  taskSlug?: string;
  targetLanguage: string;
  candidatePaths?: string[];
}

export interface CodexConversationTranslationJob {
  id: string;
  taskSlug: string;
  role: RoleName;
  direction: TranslationDirection;
  sourceHash: string;
  sourceLanguage: string;
  targetLanguage: string;
  requestPath: string;
  resultPath: string;
  reportPath: string;
  queueItemId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCodexConversationTranslationRequest {
  taskSlug: string;
  role: RoleName;
  direction: TranslationDirection;
  sourceText: string;
  sourceLanguage: string;
  targetLanguage: string;
  contextText?: string;
  translationProfile?: string;
}

export interface CodexTranslationState {
  queue: CodexTranslationQueueState;
  fileIndex: CodexFileTranslationIndex;
  bootstrapIndex: CodexBootstrapIndex;
  memoryInitialized: boolean;
}

export interface CodexConversationTranslationResultFile {
  version: 1;
  id: string;
  status: "completed" | "failed" | "needs_review";
  sourceHash: string;
  sourceLanguage: string;
  targetLanguage: string;
  translatedText: string;
  notes: string[];
}
