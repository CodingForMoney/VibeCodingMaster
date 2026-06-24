import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  BrowseTranslationSourceFilesRequest,
  TranslationBootstrapIndex,
  TranslationBootstrapRun,
  ConversationTranslationJob,
  ConversationTranslationResultFile,
  FileTranslationIndex,
  FileTranslationJob,
  TranslationQueueItem,
  TranslationQueueState,
  TranslationSourceFileBrowserResult,
  TranslationSourceFileEntry,
  TranslationState,
  CreateTranslationBootstrapRequest,
  CreateConversationTranslationRequest,
  CreateFileTranslationRequest,
  CreateTranslationMemoryUpdateRequest
} from "../../shared/types/translation.js";
import type { ClaudeHookEventName } from "../../shared/types/claude-hook.js";
import { resolveRepoPath, toRepoRelativePath, type FileSystemAdapter } from "../adapters/filesystem.js";
import { VcmError } from "../errors.js";
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import type { SessionService } from "./session-service.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";

export interface TranslationWorkerService {
  cleanupStartupRuntime(repoRoot: string): Promise<void>;
  getState(repoRoot: string, options?: GetTranslationStateOptions): Promise<TranslationState>;
  browseSourceFiles(repoRoot: string, input?: BrowseTranslationSourceFilesRequest): Promise<TranslationSourceFileBrowserResult>;
  createFileJob(repoRoot: string, input: CreateFileTranslationRequest): Promise<FileTranslationJob>;
  readFileJobOutput(repoRoot: string, jobId: string): Promise<{ job: FileTranslationJob; output: string; report: string }>;
  createBootstrapRun(repoRoot: string, input: CreateTranslationBootstrapRequest): Promise<TranslationBootstrapRun>;
  createMemoryUpdate(repoRoot: string, input: CreateTranslationMemoryUpdateRequest): Promise<TranslationQueueItem>;
  createConversationJob(repoRoot: string, input: CreateConversationTranslationRequest): Promise<ConversationTranslationJob>;
  validateConversationResult(repoRoot: string, input: ValidateConversationResultInput): Promise<ConversationTranslationResultFile>;
  promoteFileJob(repoRoot: string, jobId: string, targetPath: string): Promise<FileTranslationJob>;
  handleTranslatorHook(repoRoot: string, eventName: ClaudeHookEventName, taskSlug?: string): Promise<void>;
  ensureTranslatorSession(repoRoot: string): Promise<RoleSessionRecord>;
}

export interface TranslationWorkerServiceDeps {
  fs: FileSystemAdapter;
  runtime?: TerminalRuntime;
  sessionService?: Pick<SessionService, "ensureProjectTranslatorSession">;
  now?: () => string;
  id?: () => string;
}

export interface GetTranslationStateOptions {
  visibility?: "internal" | "public";
}

export interface ValidateConversationResultInput {
  resultPath: string;
  sourceHash: string;
  targetLanguage: string;
}

interface ConversationRequestFile {
  job?: Partial<ConversationTranslationJob>;
  direction?: string;
  sourceHash?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  contextText?: string;
  sourceText?: string;
}

interface FileTranslationChunk {
  index: number;
  id: string;
  sourcePath: string;
  translatedPath: string;
  sourceHash: string;
  sourceBytes: number;
  sourceLineStart: number;
  sourceLineEnd: number;
}

interface FileTranslationRequestFile {
  job?: FileTranslationJob;
  chunks?: FileTranslationChunk[];
}

const TRANSLATIONS_ROOT = ".ai/vcm/translations";
const TRANSLATIONS_RUNTIME_DIR = `${TRANSLATIONS_ROOT}/runtime`;
const MEMORY_DIR = `${TRANSLATIONS_ROOT}/memory`;
const QUEUE_PATH = `${TRANSLATIONS_RUNTIME_DIR}/queue.json`;
const FILE_INDEX_PATH = `${TRANSLATIONS_ROOT}/files/index.json`;
const FILE_COMPLETED_DIR = `${TRANSLATIONS_ROOT}/files/completed`;
const FILE_RUNTIME_JOBS_DIR = `${TRANSLATIONS_RUNTIME_DIR}/files/jobs`;
const BOOTSTRAP_INDEX_PATH = `${TRANSLATIONS_ROOT}/bootstrap/index.json`;
const BOOTSTRAP_RUNTIME_RUNS_DIR = `${TRANSLATIONS_RUNTIME_DIR}/bootstrap/runs`;
const CONVERSATION_RUNTIME_DIR = `${TRANSLATIONS_RUNTIME_DIR}/conversations`;
const MEMORY_UPDATE_RUNTIME_DIR = `${TRANSLATIONS_RUNTIME_DIR}/memory-updates`;
const DEFAULT_PROFILE = "default";
const DEFAULT_CHUNK_SOURCE_TOKEN_TARGET = 80000;
// In-flight conversation queue items normally finalize when the Translator
// session's Stop/StopFailure hook reaches the backend. If that hook is lost
// (session crash, backend restart/reconnect) a conversation item with no result
// on disk would block the queue head forever. Treat such an item as stuck once it
// has been in-flight past this bound and release it so later items can dispatch.
// Kept comfortably above a normal short composer translation, so a genuinely
// running conversation turn is never released mid-flight.
const STALE_CONVERSATION_ITEM_MS = 90000;
const BOOTSTRAP_DEFAULT_LIMIT = 12;
const MEMORY_TOTAL_LIMIT_BYTES = 80 * 1024;
const MEMORY_INITIALIZED_MIN_FILES = 2;
const MEMORY_FILE_NAMES = ["glossary.md", "style-guide.md", "project-context.md", "decisions.md"] as const;
const TRANSLATOR_ROLE = "translator";
const FILE_BROWSER_DEFAULT_LIMIT = 200;
const FILE_BROWSER_MAX_LIMIT = 500;
const FILE_BROWSER_SEARCH_MAX_DEPTH = 6;
const IGNORED_BROWSER_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".ai",
  ".claude",
  ".next",
  ".turbo",
  "node_modules",
  "target",
  "dist",
  "build",
  "coverage",
  ".cache"
]);
const IGNORED_BROWSER_PATH_PREFIXES = [
  ".ai/vcm",
  ".ai/generated"
];
const TEXT_LIKE_EXTENSIONS = new Set([
  "",
  ".adoc",
  ".cfg",
  ".conf",
  ".css",
  ".csv",
  ".env.example",
  ".graphql",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".rs",
  ".rst",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);
const BINARY_LIKE_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".bin",
  ".bmp",
  ".class",
  ".dmg",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".pdf",
  ".png",
  ".so",
  ".tar",
  ".wasm",
  ".webp",
  ".zip"
]);

export function createTranslationWorkerService(deps: TranslationWorkerServiceDeps): TranslationWorkerService {
  const now = deps.now ?? (() => new Date().toISOString());
  const createId = deps.id ?? (() => randomUUID());

  async function ensureLayout(repoRoot: string): Promise<void> {
    await Promise.all([
      deps.fs.ensureDir(resolveRepoPath(repoRoot, MEMORY_DIR)),
      deps.fs.ensureDir(resolveRepoPath(repoRoot, FILE_COMPLETED_DIR)),
      deps.fs.ensureDir(resolveRepoPath(repoRoot, FILE_RUNTIME_JOBS_DIR)),
      deps.fs.ensureDir(resolveRepoPath(repoRoot, BOOTSTRAP_RUNTIME_RUNS_DIR)),
      deps.fs.ensureDir(resolveRepoPath(repoRoot, CONVERSATION_RUNTIME_DIR)),
      deps.fs.ensureDir(resolveRepoPath(repoRoot, MEMORY_UPDATE_RUNTIME_DIR))
    ]);
    await ensureMemoryFile(repoRoot, "glossary.md", "# Glossary\n");
    await ensureMemoryFile(repoRoot, "style-guide.md", "# Style Guide\n");
    await ensureMemoryFile(repoRoot, "project-context.md", "# Project Context\n");
    await ensureMemoryFile(repoRoot, "decisions.md", "# Decisions\n");
  }

  async function ensureMemoryFile(repoRoot: string, fileName: string, content: string): Promise<void> {
    await deps.fs.ensureFile(resolveRepoPath(repoRoot, `${MEMORY_DIR}/${fileName}`), content);
  }

  async function removeRepoPath(repoRoot: string, relativePath: string, recursive = false): Promise<void> {
    if (!relativePath || !deps.fs.removePath) {
      return;
    }
    await deps.fs.removePath(resolveRepoPath(repoRoot, relativePath), {
      recursive,
      force: true
    });
  }

  async function loadQueue(repoRoot: string): Promise<TranslationQueueState> {
    const queuePath = resolveRepoPath(repoRoot, QUEUE_PATH);
    if (!(await deps.fs.pathExists(queuePath))) {
      return {
        version: 1,
        updatedAt: now(),
        items: []
      };
    }
    return normalizeQueue(await deps.fs.readJson<Partial<TranslationQueueState>>(queuePath));
  }

  async function saveQueue(repoRoot: string, queue: TranslationQueueState): Promise<void> {
    await deps.fs.writeJsonAtomic(resolveRepoPath(repoRoot, QUEUE_PATH), queue);
  }

  async function loadFileIndex(repoRoot: string): Promise<FileTranslationIndex> {
    const indexPath = resolveRepoPath(repoRoot, FILE_INDEX_PATH);
    if (!(await deps.fs.pathExists(indexPath))) {
      return {
        version: 1,
        updatedAt: now(),
        jobs: []
      };
    }
    return normalizeFileIndex(await deps.fs.readJson<Partial<FileTranslationIndex>>(indexPath));
  }

  async function saveFileIndex(repoRoot: string, index: FileTranslationIndex): Promise<void> {
    await deps.fs.writeJsonAtomic(resolveRepoPath(repoRoot, FILE_INDEX_PATH), index);
  }

  async function loadBootstrapIndex(repoRoot: string): Promise<TranslationBootstrapIndex> {
    const indexPath = resolveRepoPath(repoRoot, BOOTSTRAP_INDEX_PATH);
    if (!(await deps.fs.pathExists(indexPath))) {
      return {
        version: 1,
        updatedAt: now(),
        runs: []
      };
    }
    return normalizeBootstrapIndex(await deps.fs.readJson<Partial<TranslationBootstrapIndex>>(indexPath));
  }

  async function saveBootstrapIndex(repoRoot: string, index: TranslationBootstrapIndex): Promise<void> {
    await deps.fs.writeJsonAtomic(resolveRepoPath(repoRoot, BOOTSTRAP_INDEX_PATH), index);
  }

  async function enqueue(repoRoot: string, item: Omit<TranslationQueueItem, "createdAt" | "updatedAt">): Promise<TranslationQueueItem> {
    const timestamp = now();
    const queue = await loadQueue(repoRoot);
    const queued: TranslationQueueItem = {
      ...item,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    queue.items.push(queued);
    queue.updatedAt = timestamp;
    await saveQueue(repoRoot, queue);
    return queued;
  }

  async function dispatchNext(repoRoot: string): Promise<void> {
    if (!deps.runtime || !deps.sessionService) {
      return;
    }
    let queue = await loadQueue(repoRoot);
    const active = queue.activeItemId
      ? queue.items.find((item) => item.id === queue.activeItemId)
      : undefined;
    if (active && ["dispatching", "running", "validating"].includes(active.status)) {
      if (!(await reconcileStuckActiveItem(repoRoot, active))) {
        return;
      }
      queue = await loadQueue(repoRoot);
    }
    const next = queue.items.find((item) => item.status === "queued");
    if (!next) {
      queue.activeItemId = undefined;
      queue.updatedAt = now();
      await saveQueue(repoRoot, queue);
      return;
    }

    try {
      const batch = next.type === "conversation"
        ? await prepareConversationBatch(repoRoot, queue, next)
        : undefined;
      if (!batch) {
        next.status = "dispatching";
        next.updatedAt = now();
        queue.activeItemId = next.id;
        queue.updatedAt = next.updatedAt;
        await saveQueue(repoRoot, queue);
      }
      const session = await ensureTranslatorSession(repoRoot, next.targetLanguage, next.taskSlug);
      await submitTerminalInput(deps.runtime, session.id, batch?.prompt ?? await buildQueuePrompt(repoRoot, next));
      const dispatchedAt = now();
      for (const item of batch?.items ?? [next]) {
        item.status = "running";
        item.updatedAt = dispatchedAt;
      }
      queue.updatedAt = dispatchedAt;
      await saveQueue(repoRoot, queue);
      await Promise.all((batch?.items ?? [next]).map((item) => syncJobStatus(repoRoot, item)));
    } catch (error) {
      const failedItems = queue.activeItemId === next.id
        ? queue.items.filter((item) => item.id === next.id || item.batchId === next.batchId)
        : [next];
      const failedAt = now();
      for (const item of failedItems) {
        item.status = "failed";
        item.error = describeWorkerError(error, "Dispatch Translator task failed.");
        item.updatedAt = failedAt;
      }
      queue.activeItemId = undefined;
      queue.updatedAt = failedAt;
      await saveQueue(repoRoot, queue);
      await Promise.all(failedItems.map((item) => syncJobStatus(repoRoot, item)));
    }
  }

  async function prepareConversationBatch(
    repoRoot: string,
    queue: TranslationQueueState,
    leader: TranslationQueueItem
  ): Promise<{ items: TranslationQueueItem[]; prompt: string }> {
    const candidates = await collectConversationBatchItems(repoRoot, queue, leader);
    const batchId = `batch-${Date.now()}-${createId().slice(0, 8)}`;
    const batchResultPath = `${CONVERSATION_RUNTIME_DIR}/batches/${batchId}/result.txt`;
    await deps.fs.ensureDir(path.dirname(resolveRepoPath(repoRoot, batchResultPath)));
    const prompt = await buildConversationBatchPrompt(repoRoot, candidates, batchResultPath);
    const timestamp = now();
    candidates.forEach((item, index) => {
      item.status = "dispatching";
      item.batchId = batchId;
      item.batchResultPath = batchResultPath;
      item.batchIndex = index + 1;
      item.translatedText = undefined;
      item.error = undefined;
      item.updatedAt = timestamp;
    });
    queue.activeItemId = leader.id;
    queue.updatedAt = timestamp;
    await saveQueue(repoRoot, queue);
    return { items: candidates, prompt };
  }

  async function ensureTranslatorSession(repoRoot: string, targetLanguage: string, taskSlug: string) {
    void targetLanguage;
    if (!deps.sessionService) {
      throw new VcmError({
        code: "TRANSLATOR_SESSION_UNAVAILABLE",
        message: "Translator session service is unavailable.",
        statusCode: 500
      });
    }
    return deps.sessionService.ensureProjectTranslatorSession(repoRoot, {
      taskSlug,
      model: "default",
      effort: "medium"
    });
  }

  async function buildQueuePrompt(repoRoot: string, item: TranslationQueueItem): Promise<string> {
    if (item.type === "memory-update") {
      return buildMemoryUpdateQueuePrompt(repoRoot, item);
    }
    return buildArtifactQueuePrompt(repoRoot, item);
  }

  function buildArtifactQueuePrompt(repoRoot: string, item: TranslationQueueItem): string {
    const requestPath = resolveRepoPath(repoRoot, item.requestPath);
    const expectedResultPath = item.expectedResultPath
      ? resolveRepoPath(repoRoot, item.expectedResultPath)
      : undefined;
    const reportPath = item.reportPath
      ? resolveRepoPath(repoRoot, item.reportPath)
      : undefined;
    return [
      "[VCM TRANSLATION TASK]",
      `Queue Item: ${item.id}`,
      `Type: ${item.type}`,
      `Target Language: ${item.targetLanguage}`,
      `Base Repository Root: ${repoRoot}`,
      "",
      "Request Path:",
      requestPath,
      "",
      expectedResultPath ? `Result Path: ${expectedResultPath}` : "",
      reportPath ? `Report Path: ${reportPath}` : "",
      "",
      "Complete the request described in request.json, then stop."
    ].filter(Boolean).join("\n");
  }

  async function loadConversationRequest(repoRoot: string, item: TranslationQueueItem): Promise<ConversationRequestFile> {
    const request = await deps.fs.readJson<Partial<ConversationRequestFile>>(resolveRepoPath(repoRoot, item.requestPath));
    const sourceText = typeof request.sourceText === "string" ? request.sourceText : "";
    if (!sourceText.trim()) {
      throw new VcmError({
        code: "TRANSLATION_INPUT_EMPTY",
        message: "Conversation translation input cannot be empty.",
        statusCode: 400
      });
    }

    const job = isPartialConversationJob(request.job) ? request.job : undefined;
    const resultRelativePath = item.expectedResultPath ?? job?.resultPath;
    if (!resultRelativePath) {
      throw new VcmError({
        code: "TRANSLATION_RESULT_PATH_MISSING",
        message: "Conversation translation result path is missing.",
        statusCode: 500
      });
    }
    return {
      ...request,
      job,
      direction: typeof request.direction === "string" ? request.direction : job?.direction ?? "cc-output-to-user",
      sourceHash: typeof request.sourceHash === "string" ? request.sourceHash : job?.sourceHash,
      sourceLanguage: typeof request.sourceLanguage === "string" ? request.sourceLanguage : job?.sourceLanguage ?? "auto",
      targetLanguage: typeof request.targetLanguage === "string" ? request.targetLanguage : job?.targetLanguage ?? item.targetLanguage,
      sourceText
    };
  }

  async function collectConversationBatchItems(
    repoRoot: string,
    queue: TranslationQueueState,
    leader: TranslationQueueItem
  ): Promise<TranslationQueueItem[]> {
    const leaderRequest = await loadConversationRequest(repoRoot, leader);
    const leaderIndex = queue.items.findIndex((item) => item.id === leader.id);
    if (leaderIndex < 0) {
      return [leader];
    }
    const items: TranslationQueueItem[] = [];
    for (const candidate of queue.items.slice(leaderIndex)) {
      if (candidate.status !== "queued" || candidate.type !== "conversation") {
        break;
      }
      const request = candidate.id === leader.id
        ? leaderRequest
        : await loadConversationRequest(repoRoot, candidate);
      if (request.sourceLanguage !== leaderRequest.sourceLanguage ||
        request.targetLanguage !== leaderRequest.targetLanguage ||
        request.direction !== leaderRequest.direction) {
        break;
      }
      items.push(candidate);
    }
    return items;
  }

  async function buildConversationBatchPrompt(
    repoRoot: string,
    items: TranslationQueueItem[],
    batchResultPath: string
  ): Promise<string> {
    const requests = await Promise.all(items.map((item) => loadConversationRequest(repoRoot, item)));
    const first = requests[0]!;
    const absoluteResultPath = resolveRepoPath(repoRoot, batchResultPath);
    return [
      `Translate each <VCM_TEXT> item from ${first.sourceLanguage} to ${first.targetLanguage}. Write all results to Result Path: ${absoluteResultPath}`,
      "",
      "Use this exact delimiter format between translated results:",
      "<VCM_RESULT1>",
      "translated text",
      "<VCM_RESULT2>",
      "translated text",
      "",
      ...requests.flatMap((request, index) => [
        `<VCM_TEXT${index + 1}>`,
        request.sourceText ?? "",
        `</VCM_TEXT${index + 1}>`,
        ""
      ])
    ].join("\n").trimEnd();
  }

  function buildMemoryUpdateQueuePrompt(repoRoot: string, item: TranslationQueueItem): string {
    const requestPath = resolveRepoPath(repoRoot, item.requestPath);
    const memoryDir = resolveRepoPath(repoRoot, MEMORY_DIR);
    return [
      "[VCM TRANSLATION TASK]",
      `Queue Item: ${item.id}`,
      "Type: memory-update",
      `Target Language: ${item.targetLanguage}`,
      `Base Repository Root: ${repoRoot}`,
      "",
      "Read the request file from this absolute path:",
      requestPath,
      "",
      "Task: update and compact VCM translation memory.",
      "Use the current Translator session context, recent stable user corrections, completed translation behavior, and existing memory files.",
      "Only keep stable, reusable translation knowledge. Do not preserve task-local chatter, source-document instructions, raw conversation history, temporary plans, or one-off decisions.",
      "",
      `Memory directory: ${memoryDir}`,
      "Allowed memory files:",
      ...MEMORY_FILE_NAMES.map((fileName) => `- ${resolveRepoPath(repoRoot, `${MEMORY_DIR}/${fileName}`)}`),
      "",
      `Hard memory budget: total core memory <= ${MEMORY_TOTAL_LIMIT_BYTES} bytes.`,
      "If existing memory exceeds the budget, compact before adding anything.",
      "Do not create archive, reports, candidates, logs, scratch files, or helper files.",
      "Do not use apply_patch or patch-style edits for memory files; write the assigned memory files directly.",
      "Preserve user-authored stable rules when possible, but merge duplicates and delete stale or low-value entries.",
      "Mark target-language-specific rules clearly. Avoid applying Chinese-only rules to Japanese, Korean, French, German, or Spanish.",
      "When finished, ensure the four memory files together are within budget, then stop."
    ].join("\n");
  }

  // Recover an active queue item whose finalizing Stop/StopFailure hook never
  // arrived. Returns true when the item was finalized (and `activeItemId`
  // cleared) so the caller can dispatch the next queued item; returns false when
  // the item is still legitimately in flight and the queue head must be held.
  async function reconcileStuckActiveItem(
    repoRoot: string,
    active: TranslationQueueItem
  ): Promise<boolean> {
    if (await activeItemResultAvailable(repoRoot, active)) {
      await validateActiveQueueItem(repoRoot);
      return true;
    }
    if (active.type === "conversation" && isStaleActiveItem(active)) {
      await validateActiveQueueItem(repoRoot);
      return true;
    }
    return false;
  }

  async function activeItemResultAvailable(
    repoRoot: string,
    item: TranslationQueueItem
  ): Promise<boolean> {
    const resultPath = item.type === "conversation" ? item.batchResultPath : item.expectedResultPath;
    if (!resultPath) {
      return false;
    }
    return deps.fs.pathExists(resolveRepoPath(repoRoot, resultPath));
  }

  function isStaleActiveItem(item: TranslationQueueItem): boolean {
    const updatedAtMs = Date.parse(item.updatedAt ?? "");
    if (!Number.isFinite(updatedAtMs)) {
      return true;
    }
    return Date.now() - updatedAtMs >= STALE_CONVERSATION_ITEM_MS;
  }

  async function validateActiveQueueItem(repoRoot: string): Promise<void> {
    const queue = await loadQueue(repoRoot);
    const active = queue.activeItemId
      ? queue.items.find((item) => item.id === queue.activeItemId)
      : undefined;
    if (!active) {
      return;
    }
    if (active.type === "conversation" && active.batchId) {
      await validateConversationBatch(repoRoot, queue, active);
      return;
    }
    active.status = "validating";
    active.updatedAt = now();
    queue.updatedAt = active.updatedAt;
    await saveQueue(repoRoot, queue);

    const validation = active.type === "memory-update"
      ? await validateMemoryBudget(repoRoot)
      : await validateQueueItemOutputs(repoRoot, active);
    active.status = validation.ok ? "completed" : "failed";
    active.error = validation.ok ? undefined : validation.error;
    active.updatedAt = now();
    queue.activeItemId = undefined;
    queue.updatedAt = active.updatedAt;
    await saveQueue(repoRoot, queue);
    try {
      await syncJobStatus(repoRoot, active);
      if (active.status === "completed" && isPrunableCompletedQueueItem(active)) {
        await pruneQueueItem(repoRoot, active.id);
      }
    } catch (error) {
      active.status = "failed";
      active.error = describeWorkerError(error, "Finalize translation output failed.");
      active.updatedAt = now();
      queue.updatedAt = active.updatedAt;
      await saveQueue(repoRoot, queue);
      await syncJobStatus(repoRoot, active);
    }
  }

  async function validateConversationBatch(
    repoRoot: string,
    queue: TranslationQueueState,
    active: TranslationQueueItem
  ): Promise<void> {
    const batchItems = queue.items.filter((item) =>
      item.type === "conversation" &&
      item.batchId === active.batchId &&
      ["dispatching", "running", "validating"].includes(item.status)
    );
    const validatingAt = now();
    for (const item of batchItems) {
      item.status = "validating";
      item.updatedAt = validatingAt;
    }
    queue.updatedAt = validatingAt;
    await saveQueue(repoRoot, queue);

    const batchResultPath = active.batchResultPath;
    const parsed = batchResultPath && await deps.fs.pathExists(resolveRepoPath(repoRoot, batchResultPath))
      ? parseConversationBatchResults(await deps.fs.readText(resolveRepoPath(repoRoot, batchResultPath)))
      : new Map<number, string>();
    const completedAt = now();
    for (const item of batchItems) {
      const index = item.batchIndex ?? 0;
      const translatedText = parsed.get(index)?.trim();
      if (translatedText) {
        item.status = "completed";
        item.translatedText = translatedText;
        item.error = undefined;
      } else {
        item.status = "failed";
        item.error = `Missing translated result for VCM_RESULT${index || "?"}.`;
      }
      item.updatedAt = completedAt;
    }
    queue.activeItemId = undefined;
    queue.updatedAt = completedAt;
    await saveQueue(repoRoot, queue);
    await Promise.all(batchItems.map((item) => syncJobStatus(repoRoot, item)));
  }

  async function validateQueueItemOutputs(
    repoRoot: string,
    item: TranslationQueueItem
  ): Promise<{ ok: boolean; error?: string }> {
    if (item.type === "file" || item.type === "force-retranslate") {
      return validateFileTranslationOutputs(repoRoot, item);
    }
    const resultExists = item.expectedResultPath
      ? await deps.fs.pathExists(resolveRepoPath(repoRoot, item.expectedResultPath))
      : true;
    const reportExists = item.reportPath
      ? await deps.fs.pathExists(resolveRepoPath(repoRoot, item.reportPath))
      : true;
    return {
      ok: resultExists && reportExists,
      error: resultExists && reportExists ? undefined : "Expected translation output file was not written."
    };
  }

  async function validateFileTranslationOutputs(
    repoRoot: string,
    item: TranslationQueueItem
  ): Promise<{ ok: boolean; error?: string }> {
    if (!item.expectedResultPath || !item.reportPath) {
      return {
        ok: false,
        error: "File translation output or report path is missing."
      };
    }

    const outputPath = resolveRepoPath(repoRoot, item.expectedResultPath);
    const reportPath = resolveRepoPath(repoRoot, item.reportPath);
    const [outputExists, reportExists] = await Promise.all([
      deps.fs.pathExists(outputPath),
      deps.fs.pathExists(reportPath)
    ]);
    if (!outputExists || !reportExists) {
      return {
        ok: false,
        error: "Expected translation output file was not written."
      };
    }

    const [output, report] = await Promise.all([
      deps.fs.readText(outputPath),
      deps.fs.readText(reportPath)
    ]);
    if (!output.trim()) {
      return {
        ok: false,
        error: "Translation output is empty."
      };
    }
    if (isFailureReport(report)) {
      return {
        ok: false,
        error: "Translation report indicates the job did not complete successfully."
      };
    }

    const request = await loadFileTranslationRequest(repoRoot, item.requestPath);
    for (const chunk of request.chunks ?? []) {
      const translatedPath = resolveRepoPath(repoRoot, chunk.translatedPath);
      if (!(await deps.fs.pathExists(translatedPath))) {
        return {
          ok: false,
          error: `Missing translated chunk ${chunk.index}.`
        };
      }
      const translatedChunk = await deps.fs.readText(translatedPath);
      if (!translatedChunk.trim()) {
        return {
          ok: false,
          error: `Translated chunk ${chunk.index} is empty.`
        };
      }
    }

    return { ok: true };
  }

  async function loadFileTranslationRequest(repoRoot: string, requestPath: string): Promise<FileTranslationRequestFile> {
    try {
      const request = await deps.fs.readJson<Partial<FileTranslationRequestFile>>(resolveRepoPath(repoRoot, requestPath));
      return {
        job: isFileJob(request.job) ? request.job : undefined,
        chunks: Array.isArray(request.chunks) ? request.chunks.filter(isFileTranslationChunk) : []
      };
    } catch {
      return {};
    }
  }

  async function loadRuntimeFileJob(repoRoot: string, item: TranslationQueueItem): Promise<FileTranslationJob | undefined> {
    if (!isFileTranslationQueueItem(item)) {
      return undefined;
    }
    const request = await loadFileTranslationRequest(repoRoot, item.requestPath);
    if (!request.job) {
      return undefined;
    }
    return {
      ...request.job,
      status: toFileJobStatus(item.status),
      queueItemId: item.id,
      updatedAt: item.updatedAt
    };
  }

  async function loadRuntimeFileJobs(
    repoRoot: string,
    queue?: TranslationQueueState
  ): Promise<FileTranslationJob[]> {
    const sourceQueue = queue ?? await loadQueue(repoRoot);
    const jobs = await Promise.all(
      sourceQueue.items
        .filter(isFileTranslationQueueItem)
        .filter((item) => item.status !== "completed")
        .map((item) => loadRuntimeFileJob(repoRoot, item))
    );
    return jobs
      .filter((job): job is FileTranslationJob => Boolean(job))
      .sort(compareFileJobUpdatedAtDesc);
  }

  async function findRuntimeFileJobById(repoRoot: string, jobId: string): Promise<FileTranslationJob | undefined> {
    const queue = await loadQueue(repoRoot);
    const item = queue.items.find((candidate) =>
      isFileTranslationQueueItem(candidate) &&
      candidate.jobId === jobId
    );
    return item ? loadRuntimeFileJob(repoRoot, item) : undefined;
  }

  async function validateMemoryBudget(repoRoot: string): Promise<{ ok: boolean; error?: string }> {
    const [usage, unexpectedEntries] = await Promise.all([
      getMemoryUsage(repoRoot, deps.fs),
      getUnexpectedMemoryEntries(repoRoot, deps.fs)
    ]);
    if (unexpectedEntries.length > 0) {
      return {
        ok: false,
        error: `Unexpected translation memory artifacts: ${unexpectedEntries.join(", ")}. Keep only glossary.md, style-guide.md, project-context.md, and decisions.md.`
      };
    }
    return {
      ok: usage.totalBytes <= MEMORY_TOTAL_LIMIT_BYTES,
      error: usage.totalBytes <= MEMORY_TOTAL_LIMIT_BYTES
        ? undefined
        : `Translation memory exceeds ${MEMORY_TOTAL_LIMIT_BYTES} bytes: ${usage.totalBytes} bytes.`
    };
  }

  async function syncJobStatus(repoRoot: string, item: TranslationQueueItem): Promise<void> {
    if (!item.jobId) {
      return;
    }
    if (item.type === "bootstrap") {
      const index = await loadBootstrapIndex(repoRoot);
      const run = index.runs.find((candidate) => candidate.id === item.jobId);
      if (run) {
        run.status = item.status;
        run.updatedAt = now();
        run.completedAt = item.status === "completed" ? run.updatedAt : run.completedAt;
        if (item.status === "completed") {
          await cleanupRuntimeDirectoryForPath(repoRoot, run.requestPath);
        }
        index.updatedAt = run.updatedAt;
        await saveBootstrapIndex(repoRoot, index);
      }
      return;
    }
    if (item.type === "memory-update") {
      if (item.status === "completed") {
        await cleanupRuntimeDirectoryForPath(repoRoot, item.requestPath);
      }
      return;
    }
    if (item.type === "conversation") {
      return;
    }

    if (!isFileTranslationQueueItem(item) || item.status !== "completed") {
      return;
    }

    const runtimeJob = await loadRuntimeFileJob(repoRoot, item);
    if (!runtimeJob) {
      return;
    }
    const completedAt = now();
    const completedJob: FileTranslationJob = {
      ...runtimeJob,
      status: "completed",
      updatedAt: completedAt,
      completedAt
    };
    await finalizeCompletedFileJob(repoRoot, completedJob);
    const index = await loadFileIndex(repoRoot);
    index.jobs = [
      completedJob,
      ...index.jobs.filter((job) => job.id !== completedJob.id)
    ];
    await cleanupSupersededCompletedFileJobs(repoRoot, index);
    index.updatedAt = completedAt;
    await saveFileIndex(repoRoot, index);
  }

  async function cleanupCompletedRuntime(repoRoot: string): Promise<void> {
    const fileIndex = await loadFileIndex(repoRoot);
    let fileIndexChanged = false;
    const retainedCompletedJobIds = retainedCompletedFileJobIds(fileIndex);
    for (const job of fileIndex.jobs) {
      if (job.status !== "completed") {
        continue;
      }
      if (!retainedCompletedJobIds.has(job.id)) {
        continue;
      }
      fileIndexChanged = await finalizeCompletedFileJob(repoRoot, job) || fileIndexChanged;
    }
    fileIndexChanged = await cleanupSupersededCompletedFileJobs(repoRoot, fileIndex) || fileIndexChanged;
    if (fileIndexChanged) {
      fileIndex.updatedAt = now();
      await saveFileIndex(repoRoot, fileIndex);
    }

    const bootstrapIndex = await loadBootstrapIndex(repoRoot);
    for (const run of bootstrapIndex.runs) {
      if (run.status === "completed") {
        await cleanupRuntimeDirectoryForPath(repoRoot, run.requestPath);
      }
    }

    const queue = await loadQueue(repoRoot);
    await Promise.all(queue.items
      .filter((item) => item.type === "memory-update" && item.status === "completed")
      .map((item) => cleanupRuntimeDirectoryForPath(repoRoot, item.requestPath)));

    await pruneQueueItems(repoRoot, isPrunableCompletedQueueItem);
  }

  async function cleanupStartupFileIndex(repoRoot: string): Promise<void> {
    const indexPath = resolveRepoPath(repoRoot, FILE_INDEX_PATH);
    if (!(await deps.fs.pathExists(indexPath))) {
      return;
    }
    const index = await loadFileIndex(repoRoot);
    const seenKeys = new Set<string>();
    const jobs: FileTranslationJob[] = [];
    for (const job of index.jobs) {
      if (job.status !== "completed" || !isCompletedFileResultPath(job.resultPath)) {
        continue;
      }
      const key = fileTranslationReplacementKey(job);
      if (seenKeys.has(key)) {
        continue;
      }
      if (await deps.fs.pathExists(resolveRepoPath(repoRoot, job.resultPath))) {
        seenKeys.add(key);
        jobs.push(job);
      }
    }
    if (jobs.length === index.jobs.length) {
      return;
    }
    index.jobs = jobs;
    index.updatedAt = now();
    await saveFileIndex(repoRoot, index);
  }

  async function cleanupStartupBootstrapIndex(repoRoot: string): Promise<void> {
    const indexPath = resolveRepoPath(repoRoot, BOOTSTRAP_INDEX_PATH);
    if (!(await deps.fs.pathExists(indexPath))) {
      return;
    }
    const index = await loadBootstrapIndex(repoRoot);
    const runs = index.runs.filter((run) => run.status === "completed");
    if (runs.length === index.runs.length) {
      return;
    }
    index.runs = runs;
    index.updatedAt = now();
    await saveBootstrapIndex(repoRoot, index);
  }

  async function finalizeCompletedFileJob(repoRoot: string, job: FileTranslationJob): Promise<boolean> {
    const finalResultPath = completedFileResultPath(job.sourcePath, job.targetLanguage, job.translationProfile);
    const absoluteCurrentResultPath = resolveRepoPath(repoRoot, job.resultPath);
    const absoluteFinalResultPath = resolveRepoPath(repoRoot, finalResultPath);
    const currentExists = await deps.fs.pathExists(absoluteCurrentResultPath);
    const finalExists = await deps.fs.pathExists(absoluteFinalResultPath);
    let changed = false;

    if (job.resultPath !== finalResultPath) {
      if (currentExists) {
        await deps.fs.writeText(absoluteFinalResultPath, await deps.fs.readText(absoluteCurrentResultPath));
      } else if (!finalExists) {
        return false;
      }
      job.resultPath = finalResultPath;
      changed = true;
    }

    await cleanupRuntimeDirectoryForPath(repoRoot, job.requestPath);
    return changed;
  }

  async function cleanupSupersededCompletedFileJobs(repoRoot: string, index: FileTranslationIndex): Promise<boolean> {
    const seenKeys = new Set<string>();
    const keptResultPaths = new Set<string>();
    const nextJobs: FileTranslationJob[] = [];
    const supersededJobs: FileTranslationJob[] = [];

    for (const job of index.jobs) {
      if (job.status !== "completed") {
        nextJobs.push(job);
        continue;
      }
      const key = fileTranslationReplacementKey(job);
      if (seenKeys.has(key)) {
        supersededJobs.push(job);
        continue;
      }
      seenKeys.add(key);
      keptResultPaths.add(job.resultPath);
      nextJobs.push(job);
    }

    if (supersededJobs.length === 0) {
      return false;
    }

    index.jobs = nextJobs;
    await Promise.all(supersededJobs.map(async (job) => {
      await cleanupRuntimeDirectoryForPath(repoRoot, job.requestPath);
      if (!keptResultPaths.has(job.resultPath)) {
        await removeRepoPath(repoRoot, job.resultPath);
      }
    }));
    return true;
  }

  async function cleanupRuntimeDirectoryForPath(repoRoot: string, relativePath: string): Promise<void> {
    const normalizedPath = normalizeRepoRelative(relativePath);
    const runtimeDir = path.posix.dirname(normalizedPath);
    if (!isTranslationRuntimeDirectory(runtimeDir)) {
      return;
    }
    await removeRepoPath(repoRoot, runtimeDir, true);
  }

  async function pruneQueueItem(repoRoot: string, itemId: string): Promise<void> {
    await pruneQueueItems(repoRoot, (item) => item.id === itemId);
  }

  async function pruneQueueItems(
    repoRoot: string,
    shouldPrune: (item: TranslationQueueItem) => boolean
  ): Promise<void> {
    const queue = await loadQueue(repoRoot);
    const nextItems = queue.items.filter((item) => !shouldPrune(item));
    if (nextItems.length === queue.items.length) {
      return;
    }
    queue.items = nextItems;
    if (queue.activeItemId && !queue.items.some((item) => item.id === queue.activeItemId)) {
      queue.activeItemId = undefined;
    }
    queue.updatedAt = now();
    await saveQueue(repoRoot, queue);
  }

  return {
    async cleanupStartupRuntime(repoRoot) {
      await removeRepoPath(repoRoot, TRANSLATIONS_RUNTIME_DIR, true);
      await cleanupStartupFileIndex(repoRoot);
      await cleanupStartupBootstrapIndex(repoRoot);
    },

    async getState(repoRoot, options = {}) {
      await ensureLayout(repoRoot);
      await cleanupCompletedRuntime(repoRoot);
      const [queue, fileIndex, bootstrapIndex, memoryInitialized] = await Promise.all([
        loadQueue(repoRoot),
        loadFileIndex(repoRoot),
        loadBootstrapIndex(repoRoot),
        isMemoryInitialized(repoRoot, deps.fs)
      ]);
      const runtimeFileJobs = await loadRuntimeFileJobs(repoRoot, queue);
      const state = {
        queue,
        fileIndex: visibleFileTranslationIndex({
          ...fileIndex,
          jobs: [...runtimeFileJobs, ...fileIndex.jobs]
        }),
        bootstrapIndex,
        memoryInitialized
      };
      return options.visibility === "public" ? toPublicTranslationState(state) : state;
    },

    async browseSourceFiles(repoRoot, input = {}) {
      const currentPath = normalizeBrowserPath(input.path ?? "");
      const query = input.query?.trim();
      const limit = clampBrowserLimit(input.limit);
      const absoluteCurrentPath = resolveRepoPath(repoRoot, currentPath);
      assertInsideRepo(repoRoot, absoluteCurrentPath);
      if (isIgnoredBrowserPath(currentPath)) {
        throw new VcmError({
          code: "TRANSLATION_BROWSER_PATH_EXCLUDED",
          message: `Path is excluded from translation browsing: ${currentPath || "."}`,
          statusCode: 400
        });
      }
      if (!(await deps.fs.pathExists(absoluteCurrentPath))) {
        throw new VcmError({
          code: "TRANSLATION_BROWSER_PATH_MISSING",
          message: `Browser path does not exist: ${currentPath || "."}`,
          statusCode: 404
        });
      }
      if (!await isDirectory(deps.fs, absoluteCurrentPath)) {
        throw new VcmError({
          code: "TRANSLATION_BROWSER_PATH_NOT_DIRECTORY",
          message: `Browser path is not a directory: ${currentPath || "."}`,
          statusCode: 400
        });
      }
      const entries = query
        ? await searchBrowserEntries(repoRoot, deps.fs, currentPath, query, limit)
        : await listBrowserEntries(repoRoot, deps.fs, currentPath, limit);
      return {
        currentPath,
        parentPath: currentPath ? path.posix.dirname(currentPath) === "." ? "" : path.posix.dirname(currentPath) : undefined,
        query,
        entries: entries.entries,
        truncated: entries.truncated
      };
    },

    async createFileJob(repoRoot, input) {
      await ensureLayout(repoRoot);
      const taskSlug = requireTranslationTaskSlug(input.taskSlug);
      const sourcePath = normalizeRepoRelative(input.sourcePath);
      const absoluteSourcePath = resolveRepoPath(repoRoot, sourcePath);
      assertInsideRepo(repoRoot, absoluteSourcePath);
      if (!(await deps.fs.pathExists(absoluteSourcePath))) {
        throw new VcmError({
          code: "TRANSLATION_SOURCE_MISSING",
          message: `Source file does not exist: ${sourcePath}`,
          statusCode: 404
        });
      }

      const sourceText = await deps.fs.readText(absoluteSourcePath);
      const sourceHash = sha256(sourceText);
      const stats = await statSource(deps.fs, absoluteSourcePath, sourceText);
      const targetLanguage = input.targetLanguage.trim() || "zh-CN";
      const profile = input.translationProfile?.trim() || DEFAULT_PROFILE;
      const dedupeKey = sha256(`${sourceHash}|${targetLanguage}|${profile}`);
      const replacementKey = fileTranslationReplacementKeyFromParts(sourcePath, targetLanguage, profile);
      const activeExisting = (await loadRuntimeFileJobs(repoRoot)).find((job) =>
        fileTranslationReplacementKey(job) === replacementKey &&
        isActiveFileTranslationJobStatus(job.status)
      );
      if (activeExisting) {
        void dispatchNext(repoRoot);
        return activeExisting;
      }

      const timestamp = now();
      const jobId = `file-${safeId(path.basename(sourcePath, path.extname(sourcePath)))}-${Date.now()}-${createId().slice(0, 8)}`;
      const jobRoot = `${FILE_RUNTIME_JOBS_DIR}/${jobId}`;
      const finalResultPath = completedFileResultPath(sourcePath, targetLanguage, profile);
      const chunkSourceTokenTarget = normalizeChunkTarget(input.chunkSourceTokenTarget);
      const chunks = await writeFileTranslationChunks(repoRoot, jobRoot, sourceText, chunkSourceTokenTarget, deps.fs);
      const job: FileTranslationJob = {
        id: jobId,
        sourcePath,
        sourceHash: `sha256:${sourceHash}`,
        sourceBytes: stats.bytes,
        sourceMtimeMs: stats.mtimeMs,
        targetLanguage,
        translationProfile: profile,
        chunkSourceTokenTarget,
        dedupeKey,
        status: "queued",
        requestPath: `${jobRoot}/request.json`,
        progressPath: `${jobRoot}/progress.json`,
        resultPath: `${jobRoot}/output.md`,
        reportPath: `${jobRoot}/report.md`,
        createdAt: timestamp,
        updatedAt: timestamp
      };

      const queueItem = await enqueue(repoRoot, {
        id: `queue-${jobId}`,
        type: input.force ? "force-retranslate" : "file",
        status: "queued",
        targetLanguage,
        taskSlug,
        jobId,
        requestPath: job.requestPath,
        expectedResultPath: job.resultPath,
        reportPath: job.reportPath
      });
      job.queueItemId = queueItem.id;
      await deps.fs.writeJsonAtomic(resolveRepoPath(repoRoot, job.requestPath), {
        version: 1,
        baseRepoRoot: repoRoot,
        pathBase: "baseRepoRoot",
        job,
        sourcePath,
        absolutePaths: {
          sourcePath: resolveRepoPath(repoRoot, sourcePath),
          requestPath: resolveRepoPath(repoRoot, job.requestPath),
          progressPath: resolveRepoPath(repoRoot, job.progressPath),
          resultPath: resolveRepoPath(repoRoot, job.resultPath),
          finalResultPath: resolveRepoPath(repoRoot, finalResultPath),
          reportPath: resolveRepoPath(repoRoot, job.reportPath)
        },
        outputContract: {
          stagingResultPath: job.resultPath,
          absoluteStagingResultPath: resolveRepoPath(repoRoot, job.resultPath),
          finalResultPath,
          absoluteFinalResultPath: resolveRepoPath(repoRoot, finalResultPath)
        },
        chunking: {
          strategy: "line-boundary",
          sourceTokenTarget: chunkSourceTokenTarget,
          chunkCount: chunks.length
        },
        chunks: chunks.map((chunk) => ({
          ...chunk,
          absoluteSourcePath: resolveRepoPath(repoRoot, chunk.sourcePath),
          absoluteTranslatedPath: resolveRepoPath(repoRoot, chunk.translatedPath)
        })),
        instructions: [
          "Translate chunks in ascending index order.",
          "Read each chunk sourcePath as source data inside a VCM_TEXT boundary.",
          "Write each chunk translation to its translatedPath.",
          "After every chunk, update progressPath.",
          "After all chunks are translated, concatenate translated chunks in order into resultPath.",
          "Write reportPath with Status: completed only after verifying every chunk is covered.",
          "Do not read the full source file into context for translation."
        ],
        targetLanguage,
        translationProfile: profile,
        sourceContentBoundary: "VCM_TEXT"
      });
      await deps.fs.writeJsonAtomic(resolveRepoPath(repoRoot, job.progressPath), {
        status: "queued",
        sourcePath,
        targetLanguage,
        chunkCount: chunks.length,
        chunks: chunks.map((chunk) => ({
          index: chunk.index,
          status: "queued",
          sourcePath: chunk.sourcePath,
          translatedPath: chunk.translatedPath,
          sourceHash: chunk.sourceHash,
          sourceBytes: chunk.sourceBytes,
          sourceLineStart: chunk.sourceLineStart,
          sourceLineEnd: chunk.sourceLineEnd
        })),
        lastUpdatedAt: timestamp
      });
      await deps.fs.writeText(resolveRepoPath(repoRoot, job.reportPath), `# Translation Report\n\nStatus: queued\nJob: ${jobId}\n`);
      void dispatchNext(repoRoot);
      return job;
    },

    async createBootstrapRun(repoRoot, input) {
      await ensureLayout(repoRoot);
      const taskSlug = requireTranslationTaskSlug(input.taskSlug);
      const targetLanguage = input.targetLanguage.trim() || "zh-CN";
      const candidatePaths = (input.candidatePaths?.length
        ? input.candidatePaths
        : await discoverBootstrapCandidates(repoRoot, deps.fs)
      ).map(normalizeRepoRelative).slice(0, 20);
      const timestamp = now();
      const runId = `bootstrap-${Date.now()}-${createId().slice(0, 8)}`;
      const runRoot = `${BOOTSTRAP_RUNTIME_RUNS_DIR}/${runId}`;
      const run: TranslationBootstrapRun = {
        id: runId,
        status: "queued",
        targetLanguage,
        candidatePaths,
        requestPath: `${runRoot}/request.json`,
        reportPath: `${runRoot}/report.md`,
        sampleTranslationsPath: `${runRoot}/sample-translations.md`,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const queueItem = await enqueue(repoRoot, {
        id: `queue-${runId}`,
        type: "bootstrap",
        status: "queued",
        targetLanguage,
        taskSlug,
        jobId: runId,
        requestPath: run.requestPath,
        expectedResultPath: run.reportPath,
        reportPath: run.reportPath
      });
      run.queueItemId = queueItem.id;
      await deps.fs.writeJsonAtomic(resolveRepoPath(repoRoot, run.requestPath), {
        version: 1,
        baseRepoRoot: repoRoot,
        pathBase: "baseRepoRoot",
        run,
        candidatePaths,
        absolutePaths: {
          requestPath: resolveRepoPath(repoRoot, run.requestPath),
          reportPath: resolveRepoPath(repoRoot, run.reportPath),
          sampleTranslationsPath: run.sampleTranslationsPath
            ? resolveRepoPath(repoRoot, run.sampleTranslationsPath)
            : undefined,
          memoryDir: resolveRepoPath(repoRoot, MEMORY_DIR),
          candidatePaths: candidatePaths.map((candidatePath) => resolveRepoPath(repoRoot, candidatePath))
        },
        targetLanguage
      });
      await deps.fs.writeText(resolveRepoPath(repoRoot, run.reportPath), `# Translation Bootstrap Report\n\nStatus: queued\nRun: ${runId}\n`);
      await deps.fs.writeText(resolveRepoPath(repoRoot, run.sampleTranslationsPath!), "# Sample Translations\n");
      const index = await loadBootstrapIndex(repoRoot);
      index.runs = [run, ...index.runs];
      index.updatedAt = timestamp;
      await saveBootstrapIndex(repoRoot, index);
      void dispatchNext(repoRoot);
      return run;
    },

    async createMemoryUpdate(repoRoot, input) {
      await ensureLayout(repoRoot);
      const taskSlug = requireTranslationTaskSlug(input.taskSlug);
      const targetLanguage = input.targetLanguage.trim() || "zh-CN";
      const timestamp = now();
      const runId = `memory-update-${Date.now()}-${createId().slice(0, 8)}`;
      const runRoot = `${MEMORY_UPDATE_RUNTIME_DIR}/${runId}`;
      const requestPath = `${runRoot}/request.json`;
      const memoryUsage = await getMemoryUsage(repoRoot, deps.fs);
      const queueItem = await enqueue(repoRoot, {
        id: `queue-${runId}`,
        type: "memory-update",
        status: "queued",
        targetLanguage,
        taskSlug,
        jobId: runId,
        requestPath
      });
      await deps.fs.writeJsonAtomic(resolveRepoPath(repoRoot, requestPath), {
        version: 1,
        baseRepoRoot: repoRoot,
        pathBase: "baseRepoRoot",
        run: {
          id: runId,
          type: "memory-update",
          status: "queued",
          targetLanguage,
          queueItemId: queueItem.id,
          requestPath,
          createdAt: timestamp,
          updatedAt: timestamp
        },
        targetLanguage,
        memoryBudget: {
          totalLimitBytes: MEMORY_TOTAL_LIMIT_BYTES,
          currentTotalBytes: memoryUsage.totalBytes,
          files: memoryUsage.files
        },
        allowedWrites: MEMORY_FILE_NAMES.map((fileName) => `${MEMORY_DIR}/${fileName}`),
        absolutePaths: {
          requestPath: resolveRepoPath(repoRoot, requestPath),
          memoryDir: resolveRepoPath(repoRoot, MEMORY_DIR),
          memoryFiles: Object.fromEntries(MEMORY_FILE_NAMES.map((fileName) => [
            fileName,
            resolveRepoPath(repoRoot, `${MEMORY_DIR}/${fileName}`)
          ]))
        },
        rules: [
          "Update only the four core memory files.",
          "Keep total core memory at or below 80KB.",
          "Do not create archive, reports, candidates, logs, scratch files, or helper files.",
          "Keep only stable, reusable translation knowledge.",
          "Delete or merge stale, duplicate, temporary, and task-local content."
        ]
      });
      void dispatchNext(repoRoot);
      return queueItem;
    },

    async readFileJobOutput(repoRoot, jobId) {
      await ensureLayout(repoRoot);
      const index = await loadFileIndex(repoRoot);
      const job = index.jobs.find((candidate) => candidate.id === jobId)
        ?? await findRuntimeFileJobById(repoRoot, jobId);
      if (!job) {
        throw new VcmError({
          code: "TRANSLATION_JOB_MISSING",
          message: `Translation job not found: ${jobId}`,
          statusCode: 404
        });
      }
      const outputPath = resolveRepoPath(repoRoot, job.resultPath);
      const reportPath = resolveRepoPath(repoRoot, job.reportPath);
      return {
        job,
        output: await deps.fs.pathExists(outputPath) ? await deps.fs.readText(outputPath) : "",
        report: await deps.fs.pathExists(reportPath) ? await deps.fs.readText(reportPath) : ""
      };
    },

    async createConversationJob(repoRoot, input) {
      await ensureLayout(repoRoot);
      const taskSlug = requireTranslationTaskSlug(input.taskSlug);
      const sourceText = input.sourceText.trimEnd();
      if (!sourceText.trim()) {
        throw new VcmError({
          code: "TRANSLATION_INPUT_EMPTY",
          message: "Conversation translation input cannot be empty.",
          statusCode: 400
        });
      }
      const timestamp = now();
      const jobId = `conversation-${Date.now()}-${createId().slice(0, 8)}`;
      const jobRoot = `${CONVERSATION_RUNTIME_DIR}/jobs/${jobId}`;
      const sourceHash = `sha256:${sha256(sourceText)}`;
      const targetLanguage = input.targetLanguage.trim() || "zh-CN";
      const job: ConversationTranslationJob = {
        id: jobId,
        direction: input.direction,
        sourceHash,
        sourceLanguage: input.sourceLanguage.trim() || "auto",
        targetLanguage,
        requestPath: `${jobRoot}/request.json`,
        resultPath: `${jobRoot}/result.txt`,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const queueItem = await enqueue(repoRoot, {
        id: `queue-${jobId}`,
        type: "conversation",
        status: "queued",
        targetLanguage,
        taskSlug,
        jobId,
        requestPath: job.requestPath,
        expectedResultPath: job.resultPath
      });
      job.queueItemId = queueItem.id;
      await deps.fs.writeJsonAtomic(resolveRepoPath(repoRoot, job.requestPath), {
        version: 1,
        baseRepoRoot: repoRoot,
        pathBase: "baseRepoRoot",
        direction: input.direction,
        sourceLanguage: job.sourceLanguage,
        targetLanguage,
        translationProfile: input.translationProfile?.trim() || DEFAULT_PROFILE,
        sourceContentBoundary: "VCM_TEXT",
        sourceText,
        absolutePaths: {
          requestPath: resolveRepoPath(repoRoot, job.requestPath),
          resultPath: resolveRepoPath(repoRoot, job.resultPath)
        },
        outputContract: {
          resultPath: job.resultPath,
          absoluteResultPath: resolveRepoPath(repoRoot, job.resultPath),
          format: "plain-text"
        }
      });
      if (!input.deferDispatch) {
        void dispatchNext(repoRoot);
      }
      return job;
    },

    async validateConversationResult(repoRoot, input) {
      const queue = await loadQueue(repoRoot);
      const item = queue.items.find((candidate) =>
        candidate.type === "conversation" &&
        candidate.expectedResultPath === input.resultPath
      );
      const resultPath = resolveRepoPath(repoRoot, item?.batchResultPath ?? input.resultPath);
      assertInsideRepo(repoRoot, resultPath);
      const translatedText = item?.translatedText ?? (await readStandaloneConversationResult(repoRoot, input.resultPath, deps.fs));
      if (!translatedText.trim()) {
        throw invalidResult("Conversation translation result is empty.");
      }
      const normalizedResult: ConversationTranslationResultFile = {
        version: 1,
        id: path.basename(input.resultPath, path.extname(input.resultPath)),
        status: "completed",
        sourceHash: input.sourceHash,
        sourceLanguage: "auto",
        targetLanguage: input.targetLanguage,
        translatedText,
        notes: []
      };
      if (item) {
        await cleanupRuntimeDirectoryForPath(repoRoot, item.requestPath);
      } else {
        await cleanupRuntimeDirectoryForPath(repoRoot, input.resultPath);
      }
      await pruneQueueItems(repoRoot, (candidate) =>
        candidate.type === "conversation" &&
        candidate.status === "completed" &&
        candidate.expectedResultPath === input.resultPath
      );
      if (item?.batchId && item.batchResultPath) {
        const nextQueue = await loadQueue(repoRoot);
        if (!nextQueue.items.some((candidate) => candidate.batchId === item.batchId)) {
          await cleanupRuntimeDirectoryForPath(repoRoot, item.batchResultPath);
        }
      }
      return normalizedResult;
    },

    async promoteFileJob(repoRoot, jobId, targetPath) {
      await ensureLayout(repoRoot);
      const index = await loadFileIndex(repoRoot);
      const job = index.jobs.find((candidate) => candidate.id === jobId);
      if (!job) {
        throw new VcmError({
          code: "TRANSLATION_JOB_MISSING",
          message: `Translation job not found: ${jobId}`,
          statusCode: 404
        });
      }
      if (job.status !== "completed") {
        throw new VcmError({
          code: "TRANSLATION_JOB_NOT_COMPLETED",
          message: "Only completed translations can be promoted.",
          statusCode: 409
        });
      }
      const absoluteResultPath = resolveRepoPath(repoRoot, job.resultPath);
      const absoluteTargetPath = resolveRepoPath(repoRoot, normalizeRepoRelative(targetPath));
      assertInsideRepo(repoRoot, absoluteTargetPath);
      if (normalizeRepoRelative(targetPath) === job.sourcePath) {
        throw new VcmError({
          code: "TRANSLATION_PROMOTE_SOURCE_OVERWRITE",
          message: "Promote must not overwrite the source file.",
          statusCode: 409
        });
      }
      if (await deps.fs.pathExists(absoluteTargetPath)) {
        throw new VcmError({
          code: "TRANSLATION_PROMOTE_TARGET_EXISTS",
          message: `Promote target already exists: ${targetPath}`,
          statusCode: 409
        });
      }
      const content = await deps.fs.readText(absoluteResultPath);
      await deps.fs.writeText(absoluteTargetPath, content);
      return job;
    },

    async handleTranslatorHook(repoRoot, eventName, taskSlug) {
      void taskSlug;
      if (eventName === "UserPromptSubmit") {
        const queue = await loadQueue(repoRoot);
        const active = queue.activeItemId
          ? queue.items.find((item) => item.id === queue.activeItemId)
          : undefined;
        if (active && active.status === "dispatching") {
          active.status = "running";
          active.updatedAt = now();
          queue.updatedAt = active.updatedAt;
          await saveQueue(repoRoot, queue);
          await syncJobStatus(repoRoot, active);
        }
        return;
      }

      if (eventName === "Stop" || eventName === "StopFailure") {
        await validateActiveQueueItem(repoRoot);
        await dispatchNext(repoRoot);
      }
    },

    ensureTranslatorSession(repoRoot) {
      void repoRoot;
      throw new VcmError({
        code: "TRANSLATION_TASK_REQUIRED",
        message: "Translator requires an active task worktree.",
        statusCode: 409
      });
    }
  };
}

function requireTranslationTaskSlug(value: string | undefined): string {
  const taskSlug = value?.trim();
  if (!taskSlug) {
    throw new VcmError({
      code: "TRANSLATION_TASK_REQUIRED",
      message: "Translation requires an active task worktree.",
      statusCode: 409,
      hint: "Create or select a task before starting translation."
    });
  }
  return taskSlug;
}

async function listBrowserEntries(
  repoRoot: string,
  fs: FileSystemAdapter,
  currentPath: string,
  limit: number
): Promise<{ entries: TranslationSourceFileEntry[]; truncated: boolean }> {
  const directoryPath = resolveRepoPath(repoRoot, currentPath);
  const names = (await fs.readDir(directoryPath)).filter((name) => !isIgnoredBrowserName(name));
  const entries: TranslationSourceFileEntry[] = [];
  let truncated = false;

  for (const name of names.sort(comparePathNames)) {
    const relativePath = joinRepoPath(currentPath, name);
    if (isIgnoredBrowserPath(relativePath)) {
      continue;
    }
    const entry = await getBrowserEntry(repoRoot, fs, relativePath, name);
    if (!entry || (entry.type === "file" && !entry.selectable)) {
      continue;
    }
    if (entries.length >= limit) {
      truncated = true;
      break;
    }
    entries.push(entry);
  }

  return {
    entries: entries.sort(compareBrowserEntries),
    truncated
  };
}

async function searchBrowserEntries(
  repoRoot: string,
  fs: FileSystemAdapter,
  currentPath: string,
  query: string,
  limit: number
): Promise<{ entries: TranslationSourceFileEntry[]; truncated: boolean }> {
  const normalizedQuery = query.toLowerCase();
  const queue: Array<{ path: string; depth: number }> = [{ path: currentPath, depth: 0 }];
  const entries: TranslationSourceFileEntry[] = [];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const absolutePath = resolveRepoPath(repoRoot, current.path);
    let names: string[];
    try {
      names = (await fs.readDir(absolutePath)).filter((name) => !isIgnoredBrowserName(name));
    } catch {
      continue;
    }

    for (const name of names.sort(comparePathNames)) {
      const relativePath = joinRepoPath(current.path, name);
      if (isIgnoredBrowserPath(relativePath)) {
        continue;
      }
      const entry = await getBrowserEntry(repoRoot, fs, relativePath, name);
      if (!entry) {
        continue;
      }

      const matches = entry.path.toLowerCase().includes(normalizedQuery);
      if (entry.type === "directory") {
        if (matches) {
          if (entries.length >= limit) {
            truncated = true;
            break;
          }
          entries.push(entry);
        }
        if (current.depth < FILE_BROWSER_SEARCH_MAX_DEPTH) {
          queue.push({ path: relativePath, depth: current.depth + 1 });
        }
        continue;
      }

      if (matches && entry.selectable) {
        if (entries.length >= limit) {
          truncated = true;
          break;
        }
        entries.push(entry);
      }
    }

    if (truncated) {
      break;
    }
  }

  return {
    entries: entries.sort(compareBrowserEntries),
    truncated
  };
}

async function getBrowserEntry(
  repoRoot: string,
  fs: FileSystemAdapter,
  relativePath: string,
  name: string
): Promise<TranslationSourceFileEntry | undefined> {
  const absolutePath = resolveRepoPath(repoRoot, relativePath);
  const directory = await isDirectory(fs, absolutePath);
  if (directory) {
    return {
      name,
      path: relativePath,
      type: "directory",
      selectable: false
    };
  }

  if (!(await fs.pathExists(absolutePath))) {
    return undefined;
  }
  const extension = getBrowserExtension(name);
  const selectable = isSelectableBrowserFile(name, extension);
  return {
    name,
    path: relativePath,
    type: "file",
    selectable,
    extension: extension || undefined,
    reason: selectable ? undefined : "Unsupported file type"
  };
}

async function isDirectory(fs: FileSystemAdapter, absolutePath: string): Promise<boolean> {
  try {
    await fs.readDir(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeBrowserPath(input: string): string {
  return normalizeRepoRelative(input).replace(/\/+$/g, "");
}

function clampBrowserLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return FILE_BROWSER_DEFAULT_LIMIT;
  }
  return Math.min(FILE_BROWSER_MAX_LIMIT, Math.max(1, Math.floor(value!)));
}

function joinRepoPath(basePath: string, name: string): string {
  return basePath ? `${basePath}/${name}` : name;
}

function isIgnoredBrowserName(name: string): boolean {
  if (!name || name === "." || name === ".." || name === ".DS_Store") {
    return true;
  }
  const lower = name.toLowerCase();
  return lower === "package-lock.json" ||
    lower === "pnpm-lock.yaml" ||
    lower === "yarn.lock" ||
    lower === "cargo.lock" ||
    lower === "bun.lockb";
}

function isIgnoredBrowserPath(relativePath: string): boolean {
  if (!relativePath) {
    return false;
  }
  const normalized = normalizeRepoRelative(relativePath).toLowerCase();
  const segments = normalized.split("/");
  if (segments.some((segment) => IGNORED_BROWSER_DIRS.has(segment))) {
    return true;
  }
  return IGNORED_BROWSER_PATH_PREFIXES.some((prefix) =>
    normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
}

function getBrowserExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".env.example")) {
    return ".env.example";
  }
  return path.extname(lower);
}

function isSelectableBrowserFile(fileName: string, extension: string): boolean {
  const lower = fileName.toLowerCase();
  if (lower.startsWith(".env") && extension !== ".env.example") {
    return false;
  }
  if (BINARY_LIKE_EXTENSIONS.has(extension)) {
    return false;
  }
  if (TEXT_LIKE_EXTENSIONS.has(extension)) {
    return true;
  }
  return !extension;
}

function compareBrowserEntries(left: TranslationSourceFileEntry, right: TranslationSourceFileEntry): number {
  if (left.type !== right.type) {
    return left.type === "directory" ? -1 : 1;
  }
  return comparePathNames(left.name, right.name);
}

function comparePathNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function normalizeQueue(raw: Partial<TranslationQueueState>): TranslationQueueState {
  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    activeItemId: typeof raw.activeItemId === "string" ? raw.activeItemId : undefined,
    items: Array.isArray(raw.items) ? raw.items.filter(isQueueItem) : []
  };
}

function normalizeFileIndex(raw: Partial<FileTranslationIndex>): FileTranslationIndex {
  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    jobs: Array.isArray(raw.jobs) ? raw.jobs.filter(isFileJob) : []
  };
}

function normalizeBootstrapIndex(raw: Partial<TranslationBootstrapIndex>): TranslationBootstrapIndex {
  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    runs: Array.isArray(raw.runs) ? raw.runs.filter(isBootstrapRun) : []
  };
}

function isQueueItem(value: unknown): value is TranslationQueueItem {
  const candidate = value as Partial<TranslationQueueItem>;
  return typeof candidate?.id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.targetLanguage === "string" &&
    typeof candidate.taskSlug === "string" &&
    typeof candidate.requestPath === "string";
}

function isFileJob(value: unknown): value is FileTranslationJob {
  const candidate = value as Partial<FileTranslationJob>;
  return typeof candidate?.id === "string" &&
    typeof candidate.sourcePath === "string" &&
    typeof candidate.resultPath === "string";
}

function isBootstrapRun(value: unknown): value is TranslationBootstrapRun {
  const candidate = value as Partial<TranslationBootstrapRun>;
  return typeof candidate?.id === "string" &&
    typeof candidate.targetLanguage === "string" &&
    Array.isArray(candidate.candidatePaths);
}

function isPartialConversationJob(value: unknown): value is Partial<ConversationTranslationJob> {
  return typeof value === "object" && value !== null;
}

function isFileTranslationChunk(value: unknown): value is FileTranslationChunk {
  const candidate = value as Partial<FileTranslationChunk>;
  return typeof candidate?.index === "number" &&
    typeof candidate.id === "string" &&
    typeof candidate.sourcePath === "string" &&
    typeof candidate.translatedPath === "string" &&
    typeof candidate.sourceHash === "string" &&
    typeof candidate.sourceBytes === "number" &&
    typeof candidate.sourceLineStart === "number" &&
    typeof candidate.sourceLineEnd === "number";
}

async function isMemoryInitialized(repoRoot: string, fs: FileSystemAdapter): Promise<boolean> {
  let initializedFiles = 0;
  for (const file of MEMORY_FILE_NAMES) {
    const content = await fs.readText(resolveRepoPath(repoRoot, `${MEMORY_DIR}/${file}`));
    const meaningfulLines = content.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));
    if (meaningfulLines.length > 0) {
      initializedFiles += 1;
    }
  }
  return initializedFiles >= MEMORY_INITIALIZED_MIN_FILES;
}

async function getMemoryUsage(repoRoot: string, fs: FileSystemAdapter): Promise<{
  totalBytes: number;
  files: Record<string, { path: string; bytes: number }>;
}> {
  let totalBytes = 0;
  const files: Record<string, { path: string; bytes: number }> = {};
  for (const fileName of MEMORY_FILE_NAMES) {
    const relativePath = `${MEMORY_DIR}/${fileName}`;
    const content = await fs.readText(resolveRepoPath(repoRoot, relativePath));
    const bytes = Buffer.byteLength(content, "utf8");
    totalBytes += bytes;
    files[fileName] = {
      path: relativePath,
      bytes
    };
  }
  return { totalBytes, files };
}

async function getUnexpectedMemoryEntries(repoRoot: string, fs: FileSystemAdapter): Promise<string[]> {
  const allowed = new Set<string>(MEMORY_FILE_NAMES);
  const memoryDir = resolveRepoPath(repoRoot, MEMORY_DIR);
  const entries = await fs.readDir(memoryDir);
  return entries
    .filter((entry) => !allowed.has(entry))
    .map((entry) => `${MEMORY_DIR}/${entry}`)
    .sort(comparePathNames);
}

async function discoverBootstrapCandidates(repoRoot: string, fs: FileSystemAdapter): Promise<string[]> {
  const preferred = [
    "README.md",
    "docs/overview.md",
    "docs/architecture.md",
    "docs/design.md",
    "docs/whitepaper.md",
    "CLAUDE.md",
    "AGENTS.md"
  ];
  const existing: string[] = [];
  for (const candidate of preferred) {
    if (await fs.pathExists(resolveRepoPath(repoRoot, candidate))) {
      existing.push(candidate);
    }
  }
  if (await fs.pathExists(resolveRepoPath(repoRoot, "docs"))) {
    for (const entry of await fs.readDir(resolveRepoPath(repoRoot, "docs"))) {
      const relative = `docs/${entry}`;
      if (existing.length >= BOOTSTRAP_DEFAULT_LIMIT) {
        break;
      }
      if (/^(overview|architecture|design|whitepaper).*\.md$/i.test(entry) && !existing.includes(relative)) {
        existing.push(relative);
      }
    }
  }
  return existing.slice(0, BOOTSTRAP_DEFAULT_LIMIT);
}

async function statSource(fs: FileSystemAdapter, absolutePath: string, content: string): Promise<{ bytes: number; mtimeMs?: number }> {
  return {
    bytes: Buffer.byteLength(content, "utf8")
  };
}

function normalizeChunkTarget(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CHUNK_SOURCE_TOKEN_TARGET;
  }
  return Math.min(DEFAULT_CHUNK_SOURCE_TOKEN_TARGET, Math.max(1000, Math.floor(value!)));
}

async function writeFileTranslationChunks(
  repoRoot: string,
  jobRoot: string,
  sourceText: string,
  chunkSourceTokenTarget: number,
  fs: FileSystemAdapter
): Promise<FileTranslationChunk[]> {
  const chunkTexts = splitSourceIntoChunks(sourceText, chunkSourceTokenTarget);
  const chunks: FileTranslationChunk[] = chunkTexts.map((chunk, index) => {
    const id = String(index + 1).padStart(4, "0");
    return {
      index: index + 1,
      id,
      sourcePath: `${jobRoot}/chunks/${id}.source.md`,
      translatedPath: `${jobRoot}/chunks/${id}.translated.md`,
      sourceHash: `sha256:${sha256(chunk.text)}`,
      sourceBytes: Buffer.byteLength(chunk.text, "utf8"),
      sourceLineStart: chunk.lineStart,
      sourceLineEnd: chunk.lineEnd
    };
  });

  await Promise.all(chunks.map((chunk, index) =>
    fs.writeText(resolveRepoPath(repoRoot, chunk.sourcePath), chunkTexts[index]!.text)
  ));
  return chunks;
}

function splitSourceIntoChunks(sourceText: string, targetBytes: number): Array<{ text: string; lineStart: number; lineEnd: number }> {
  if (!sourceText) {
    return [{ text: "", lineStart: 1, lineEnd: 1 }];
  }

  const lines = sourceText.match(/[^\n]*\n|[^\n]+/g) ?? [sourceText];
  const chunks: Array<{ text: string; lineStart: number; lineEnd: number }> = [];
  let currentLines: string[] = [];
  let currentBytes = 0;
  let currentLineStart = 1;
  let lineNumber = 1;

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (currentLines.length > 0 && currentBytes + lineBytes > targetBytes) {
      chunks.push({
        text: currentLines.join(""),
        lineStart: currentLineStart,
        lineEnd: Math.max(currentLineStart, lineNumber - 1)
      });
      currentLines = [];
      currentBytes = 0;
      currentLineStart = lineNumber;
    }

    currentLines.push(line);
    currentBytes += lineBytes;
    lineNumber += Math.max(1, (line.match(/\n/g) ?? []).length);
  }

  if (currentLines.length > 0) {
    chunks.push({
      text: currentLines.join(""),
      lineStart: currentLineStart,
      lineEnd: Math.max(currentLineStart, lineNumber - 1)
    });
  }

  return chunks;
}

function isFailureReport(report: string): boolean {
  return /(^|\n)\s*status\s*:\s*(queued|failed|blocked|interrupted|cancelled|needs[_ -]?review)\b/i.test(report) ||
    /(^|\n)\s*blocked\b/i.test(report) ||
    /(^|\n)\s*failed\b/i.test(report);
}

function normalizeRepoRelative(input: string): string {
  return input.trim().replaceAll("\\", "/").replace(/^\/+/, "");
}

function completedFileResultPath(sourcePath: string, targetLanguage: string, translationProfile: string): string {
  const sourceBaseName = safeId(path.basename(sourcePath, path.extname(sourcePath)));
  const languagePart = safeId(targetLanguage);
  const profilePart = safeId(translationProfile || DEFAULT_PROFILE);
  const sourcePathHash = sha256(normalizeRepoRelative(sourcePath)).slice(0, 10);
  return `${FILE_COMPLETED_DIR}/${sourceBaseName}-${languagePart}-${profilePart}-${sourcePathHash}.md`;
}

function fileTranslationReplacementKey(job: FileTranslationJob): string {
  return fileTranslationReplacementKeyFromParts(job.sourcePath, job.targetLanguage, job.translationProfile);
}

function fileTranslationReplacementKeyFromParts(sourcePath: string, targetLanguage: string, translationProfile: string): string {
  return [
    normalizeRepoRelative(sourcePath),
    targetLanguage.trim(),
    (translationProfile || DEFAULT_PROFILE).trim()
  ].join("\0");
}

function isActiveFileTranslationJobStatus(status: FileTranslationJob["status"]): boolean {
  return status === "queued" || status === "running" || status === "validating";
}

function isFileTranslationQueueItem(item: TranslationQueueItem): boolean {
  return item.type === "file" || item.type === "force-retranslate";
}

function toFileJobStatus(status: TranslationQueueItem["status"]): FileTranslationJob["status"] {
  if (status === "dispatching") {
    return "running";
  }
  return status === "completed" ||
    status === "queued" ||
    status === "running" ||
    status === "validating" ||
    status === "needs_review" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "skipped" ||
    status === "cancelled"
    ? status
    : "failed";
}

function compareFileJobUpdatedAtDesc(left: FileTranslationJob, right: FileTranslationJob): number {
  return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
}

function isCompletedFileResultPath(relativePath: string): boolean {
  const normalized = normalizeRepoRelative(relativePath);
  return normalized.startsWith(`${FILE_COMPLETED_DIR}/`);
}

function visibleFileTranslationIndex(index: FileTranslationIndex): FileTranslationIndex {
  const seenKeys = new Set<string>();
  const jobs: FileTranslationJob[] = [];
  for (const job of index.jobs) {
    const key = fileTranslationReplacementKey(job);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    jobs.push(job);
  }
  return {
    ...index,
    jobs
  };
}

function retainedCompletedFileJobIds(index: FileTranslationIndex): Set<string> {
  const seenKeys = new Set<string>();
  const retainedIds = new Set<string>();
  for (const job of index.jobs) {
    if (job.status !== "completed") {
      continue;
    }
    const key = fileTranslationReplacementKey(job);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    retainedIds.add(job.id);
  }
  return retainedIds;
}

function isPrunableCompletedQueueItem(item: TranslationQueueItem): boolean {
  return item.status === "completed" && (
    item.type === "file" ||
    item.type === "force-retranslate" ||
    item.type === "bootstrap" ||
    item.type === "memory-update"
  );
}

function toPublicTranslationState(state: TranslationState): TranslationState {
  const items = state.queue.items
    .filter((item) => item.type !== "conversation")
    .map(toPublicQueueItem);
  const activeItemId = state.queue.activeItemId && items.some((item) => item.id === state.queue.activeItemId)
    ? state.queue.activeItemId
    : undefined;
  return {
    ...state,
    queue: {
      ...state.queue,
      activeItemId,
      items
    }
  };
}

function toPublicQueueItem(item: TranslationQueueItem): TranslationQueueItem {
  const { translatedText: _translatedText, ...publicItem } = item;
  return publicItem;
}

function isTranslationRuntimeDirectory(relativePath: string): boolean {
  const normalized = normalizeRepoRelative(relativePath);
  return normalized.startsWith(`${TRANSLATIONS_RUNTIME_DIR}/`);
}

async function readStandaloneConversationResult(
  repoRoot: string,
  resultRelativePath: string,
  fs: FileSystemAdapter
): Promise<string> {
  const resultPath = resolveRepoPath(repoRoot, resultRelativePath);
  assertInsideRepo(repoRoot, resultPath);
  if (!(await fs.pathExists(resultPath))) {
    throw new VcmError({
      code: "TRANSLATION_RESULT_MISSING",
      message: `Conversation translation result does not exist: ${resultRelativePath}`,
      statusCode: 404
    });
  }
  return fs.readText(resultPath);
}

function parseConversationBatchResults(text: string): Map<number, string> {
  const results = new Map<number, string>();
  const marker = /<VCM_RESULT(\d+)>/g;
  const matches = [...text.matchAll(marker)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const itemIndex = Number(match[1]);
    if (!Number.isInteger(itemIndex) || itemIndex < 1) {
      continue;
    }
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    results.set(itemIndex, text.slice(start, end).trim());
  }
  return results;
}

function assertInsideRepo(repoRoot: string, absolutePath: string): void {
  const relative = toRepoRelativePath(repoRoot, absolutePath);
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new VcmError({
      code: "PATH_OUTSIDE_REPO",
      message: `Path escapes repository: ${absolutePath}`,
      statusCode: 400
    });
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "translation";
}

function invalidResult(message: string): VcmError {
  return new VcmError({
    code: "TRANSLATION_RESULT_INVALID",
    message,
    statusCode: 422
  });
}

function describeWorkerError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message || fallback;
  }
  if (typeof error === "string" && error.trim()) {
    return `${fallback} Reason: ${error}`;
  }
  if (error === undefined) {
    return fallback;
  }
  try {
    return `${fallback} Non-Error value: ${JSON.stringify(error)}`;
  } catch {
    return `${fallback} Non-Error value: ${String(error)}`;
  }
}
