import type { RoleName } from "./role.js";

export type TranslationProviderType = "claude-code";

export type TranslationDirection =
  | "user-input-to-english"
  | "cc-output-to-user";

export type TranslationInputMode =
  | "review-before-send"
  | "auto-send";

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

export interface TranslateManualOutputRequest {
  text: string;
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

export interface TranslationTaskFeedEvent {
  seq: number;
  sessionId: string;
  role: RoleName;
  event: TranslationSessionEvent;
}

export interface TranslationTaskFeedSession {
  sessionId: string;
  role: RoleName;
  status: TranslationSessionStatus;
}

export interface PollTranslationTaskFeedResult {
  taskSlug: string;
  nextCursor: number;
  sessions: TranslationTaskFeedSession[];
  events: TranslationTaskFeedEvent[];
}

export type TranslationWsMessage =
  | { type: "translation-entry"; entry: TranslationEntry }
  | { type: "translation-status"; status: TranslationSessionStatus }
  | { type: "translation-poll"; checkedAt: string }
  | { type: "translation-error"; id?: string; message: string }
  | { type: "translation-failures"; failures: TranslationFailureItem[] };

export type TranslationQueueItemType =
  | "bootstrap"
  | "file"
  | "conversation"
  | "memory-update"
  | "retry"
  | "resume"
  | "force-retranslate";

export type TranslationQueueItemStatus =
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

export interface TranslationQueueItem {
  id: string;
  type: TranslationQueueItemType;
  status: TranslationQueueItemStatus;
  targetLanguage: string;
  taskSlug: string;
  jobId?: string;
  requestPath: string;
  expectedResultPath?: string;
  reportPath?: string;
  batchId?: string;
  batchResultPath?: string;
  batchIndex?: number;
  translatedText?: string;
  /**
   * Inline conversation source for `type: "conversation"` items. Carrying the
   * source on the queue item (persisted in queue.json) removes the need for a
   * per-job conversation `request.json`: the queue is the single durable record
   * that distinguishes conversation tasks, while the translated output lives in
   * one shared, self-describing `result.json`. Undefined for non-conversation
   * types.
   */
  conversation?: ConversationQueueItemSource;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Source text and metadata for a conversation queue item, inlined into
 * queue.json (previously stored in a per-job request.json). `sourceHash`
 * deduplicates/identifies the input; the batch identity used for crash-recovery
 * re-association lives in `TranslationQueueItem.batchId`.
 */
export interface ConversationQueueItemSource {
  direction: TranslationDirection;
  sourceLanguage: string;
  sourceHash: string;
  sourceText: string;
  contextText?: string;
}

export interface TranslationQueueState {
  version: 1;
  activeItemId?: string;
  updatedAt: string;
  items: TranslationQueueItem[];
}

export type FileTranslationJobStatus =
  | "queued"
  | "running"
  | "validating"
  | "completed"
  | "needs_review"
  | "failed"
  | "interrupted"
  | "skipped"
  | "cancelled";

export interface FileTranslationJob {
  id: string;
  sourcePath: string;
  sourceHash: string;
  sourceBytes: number;
  sourceMtimeMs?: number;
  targetLanguage: string;
  translationProfile: string;
  chunkSourceTokenTarget: number;
  dedupeKey: string;
  status: FileTranslationJobStatus;
  requestPath: string;
  progressPath: string;
  resultPath: string;
  reportPath: string;
  queueItemId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface FileTranslationIndex {
  version: 1;
  updatedAt: string;
  jobs: FileTranslationJob[];
}

export interface TranslationBootstrapRun {
  id: string;
  status: TranslationQueueItemStatus;
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

export interface TranslationBootstrapIndex {
  version: 1;
  updatedAt: string;
  runs: TranslationBootstrapRun[];
}

export interface CreateFileTranslationRequest {
  taskSlug?: string;
  sourcePath: string;
  targetLanguage: string;
  translationProfile?: string;
  chunkSourceTokenTarget?: number;
  force?: boolean;
}

export interface BrowseTranslationSourceFilesRequest {
  path?: string;
  query?: string;
  limit?: number;
}

export interface TranslationSourceFileEntry {
  name: string;
  path: string;
  type: "directory" | "file";
  selectable: boolean;
  extension?: string;
  reason?: string;
}

export interface TranslationSourceFileBrowserResult {
  currentPath: string;
  parentPath?: string;
  query?: string;
  entries: TranslationSourceFileEntry[];
  truncated: boolean;
}

export interface CreateTranslationBootstrapRequest {
  taskSlug?: string;
  targetLanguage: string;
  candidatePaths?: string[];
}

export interface CreateTranslationMemoryUpdateRequest {
  taskSlug?: string;
  targetLanguage: string;
}

export interface ConversationTranslationJob {
  id: string;
  direction: TranslationDirection;
  sourceHash: string;
  sourceLanguage: string;
  targetLanguage: string;
  requestPath: string;
  resultPath: string;
  reportPath?: string;
  queueItemId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConversationTranslationRequest {
  taskSlug: string;
  direction: TranslationDirection;
  sourceText: string;
  sourceLanguage: string;
  targetLanguage: string;
  contextText?: string;
  translationProfile?: string;
  deferDispatch?: boolean;
}

export interface TranslationState {
  queue: TranslationQueueState;
  fileIndex: FileTranslationIndex;
  bootstrapIndex: TranslationBootstrapIndex;
  memoryInitialized: boolean;
}

export interface ConversationTranslationResultFile {
  version: 1;
  id: string;
  status: "completed" | "failed" | "needs_review";
  sourceHash: string;
  sourceLanguage: string;
  targetLanguage: string;
  translatedText: string;
  notes: string[];
}
