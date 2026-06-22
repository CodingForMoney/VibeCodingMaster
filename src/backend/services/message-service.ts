import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  DeleteMessageHistoryResult,
  MarkAllMessagesDoneResult,
  VcmMessageActor,
  VcmMessageType,
  VcmOrchestrationMode,
  VcmOrchestrationState,
  VcmRoleMessage,
  VcmRouteFile,
  VcmRouteFileDispatchResult
} from "../../shared/types/message.js";
import type { RoleName, VcmRoleName } from "../../shared/types/role.js";
import { CORE_VCM_ROLE_NAMES } from "../../shared/constants.js";
import { VcmError } from "../errors.js";
import { resolveRepoPath } from "../adapters/filesystem.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import { renderMessageEnvelope } from "../templates/message-envelope.js";
import type { TaskService } from "./task-service.js";
import type { SessionService } from "./session-service.js";

export interface MessageService {
  listMessages(input: ListMessagesInput): Promise<VcmRoleMessage[]>;
  listPendingRouteFiles(input: ListRouteFilesInput): Promise<VcmRouteFile[]>;
  scanAndDispatchPendingRouteFiles(input: ScanPendingRouteFilesInput): Promise<VcmRouteFileDispatchResult[]>;
  confirmPromptSubmitted(input: ConfirmPromptSubmittedInput): Promise<VcmRoleMessage | undefined>;
  markAllDone(input: MarkAllDoneInput): Promise<MarkAllMessagesDoneResult>;
  deleteMessageHistory(input: ListMessagesInput): Promise<DeleteMessageHistoryResult>;
  getOrchestrationState(input: OrchestrationStateInput): Promise<VcmOrchestrationState>;
  updateOrchestrationState(input: UpdateOrchestrationStateInput): Promise<VcmOrchestrationState>;
}

export interface ListMessagesInput {
  repoRoot: string;
  stateRepoRoot?: string;
  stateRoot: string;
  taskSlug: string;
}

export interface ListRouteFilesInput extends ListMessagesInput {
  taskRepoRoot?: string;
  handoffDir: string;
}

export interface ScanPendingRouteFilesInput extends ListRouteFilesInput {
  stoppedRole?: RoleName;
}

export interface ConfirmPromptSubmittedInput extends ListRouteFilesInput {
  role: RoleName;
  prompt?: string;
}

export interface MarkAllDoneInput extends ListRouteFilesInput {
  clearRouteFiles?: boolean;
}

export interface OrchestrationStateInput {
  repoRoot: string;
  stateRepoRoot?: string;
  stateRoot: string;
  taskSlug: string;
}

export interface UpdateOrchestrationStateInput extends OrchestrationStateInput {
  mode?: VcmOrchestrationMode;
}

export interface MessageServiceDeps {
  fs: FileSystemAdapter;
  runtime: TerminalRuntime;
  sessionService: SessionService;
  taskService: Pick<TaskService, "loadTask">;
  now?: () => string;
  id?: () => string;
  preDispatchSwitchDelayMs?: number;
  autoDispatchEnterDelayMs?: number;
  dispatchConfirmationEnabled?: boolean;
  dispatchConfirmationRetryDelaysMs?: number[];
  dispatchConfirmationFailureDelayMs?: number;
}

const PM_ROLE: VcmRoleName = "project-manager";
const PM_TO_ROLE_TYPES = new Set<VcmMessageType>(["task", "question", "review-request", "revise", "cancel"]);
const ROLE_TO_PM_TYPES = new Set<VcmMessageType>(["result", "question", "blocked", "finding"]);
const DEFAULT_PRE_DISPATCH_SWITCH_DELAY_MS = 500;
const DEFAULT_AUTO_DISPATCH_ENTER_DELAY_MS = 500;
const DEFAULT_DISPATCH_CONFIRMATION_RETRY_DELAYS_MS = [1500, 3000];
const DEFAULT_DISPATCH_CONFIRMATION_FAILURE_DELAY_MS = 3000;
const DISPATCH_NOT_CONFIRMED_REASON = "Auto orchestration pasted the message, but Claude Code did not confirm submission. Press Enter in the target terminal or resend the route message.";

export function createMessageService(deps: MessageServiceDeps): MessageService {
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? (() => `msg_${randomUUID()}`);
  const preDispatchSwitchDelayMs = deps.preDispatchSwitchDelayMs ?? DEFAULT_PRE_DISPATCH_SWITCH_DELAY_MS;
  const autoDispatchEnterDelayMs = deps.autoDispatchEnterDelayMs ?? DEFAULT_AUTO_DISPATCH_ENTER_DELAY_MS;
  const dispatchConfirmationEnabled = deps.dispatchConfirmationEnabled ?? true;
  const dispatchConfirmationRetryDelaysMs = deps.dispatchConfirmationRetryDelaysMs ?? DEFAULT_DISPATCH_CONFIRMATION_RETRY_DELAYS_MS;
  const dispatchConfirmationFailureDelayMs = deps.dispatchConfirmationFailureDelayMs ?? DEFAULT_DISPATCH_CONFIRMATION_FAILURE_DELAY_MS;
  const taskLocks = new Map<string, Promise<unknown>>();

  async function getOrchestrationState(input: OrchestrationStateInput): Promise<VcmOrchestrationState> {
    const statePath = getOrchestrationStatePath(getStateRepoRoot(input), input.stateRoot, input.taskSlug);
    if (!(await deps.fs.pathExists(statePath))) {
      return {
        taskSlug: input.taskSlug,
        mode: "auto",
        updatedAt: now()
      };
    }

    const state = await deps.fs.readJson<VcmOrchestrationState>(statePath);
    return {
      taskSlug: state.taskSlug,
      mode: state.mode,
      updatedAt: state.updatedAt
    };
  }

  async function scanLocked(input: ScanPendingRouteFilesInput): Promise<VcmRouteFileDispatchResult[]> {
    await deps.taskService.loadTask(input.repoRoot, input.taskSlug);
    const timestamp = now();
    const base = toRouteContext(input);
    const state = await getOrchestrationState(input);
    const pendingFiles = (await listRouteFiles(deps.fs, base)).filter((routeFile) => routeFile.pending);
    const candidates = selectDispatchCandidates(pendingFiles, input.stoppedRole);
    const results: VcmRouteFileDispatchResult[] = [];

    for (const routeFile of candidates) {
      const result = await dispatchRouteFile(input, routeFile, state, timestamp);
      results.push(result);
      if (result.message) {
        await appendMessageSnapshot(deps.fs, input, result.message);
      }
      if (result.delivered) {
        break;
      }
    }

    return results;
  }

  async function listPendingRouteFiles(input: ListRouteFilesInput): Promise<VcmRouteFile[]> {
    const context = toRouteContext(input);
    const all = await listRouteFiles(deps.fs, context);
    return all.filter((routeFile) => routeFile.pending);
  }

  async function dispatchRouteFile(
    input: ScanPendingRouteFilesInput,
    routeFile: VcmRouteFile,
    state: VcmOrchestrationState,
    timestamp: string
  ): Promise<VcmRouteFileDispatchResult> {
    validateMessagePolicy(routeFile.fromRole, routeFile.toRole, routeFile.type);

    const session = await deps.sessionService.getRoleSession(input.repoRoot, input.taskSlug, routeFile.toRole);
    if (!session || session.status !== "running") {
      return {
        delivered: false,
        requiresUserApproval: false,
        clearedRouteFile: false,
        failureReason: `${routeFile.toRole} session is not running.`
      };
    }

    if (state.mode === "manual") {
      return {
        delivered: false,
        requiresUserApproval: true,
        clearedRouteFile: false
      };
    }

    if (session.activityStatus === "running") {
      return {
        delivered: false,
        requiresUserApproval: false,
        clearedRouteFile: false,
        failureReason: `${routeFile.toRole} is still running.`
      };
    }

    const message: VcmRoleMessage = {
      id: id(),
      taskSlug: input.taskSlug,
      createdAt: timestamp,
      fromRole: routeFile.fromRole,
      toRole: routeFile.toRole,
      type: routeFile.type,
      body: routeFile.body,
      artifactRefs: routeFile.artifactRefs,
      bodyPath: routeFile.path,
      routePath: routeFile.path,
      dispatchingAt: timestamp,
      failureReason: undefined
    };
    await appendMessageSnapshot(deps.fs, input, message);
    await delay(preDispatchSwitchDelayMs);
    const delivered = {
      ...message,
      deliveredAt: timestamp
    };
    await submitTerminalInput(deps.runtime, session.id, renderMessageEnvelope(delivered), {
      enterDelayMs: autoDispatchEnterDelayMs
    });
    await deps.sessionService.markRoleActivityRunning(input.repoRoot, input.taskSlug, routeFile.toRole);
    scheduleDispatchConfirmation(input, delivered, session.id);

    return {
      message: delivered,
      delivered: true,
      requiresUserApproval: false,
      clearedRouteFile: false
    };
  }

  return {
    listMessages(input) {
      return readLatestMessages(deps.fs, getMessagesPath(getStateRepoRoot(input), input.stateRoot, input.taskSlug));
    },
    listPendingRouteFiles(input) {
      return listPendingRouteFiles(input);
    },
    async scanAndDispatchPendingRouteFiles(input) {
      return withTaskLock(taskLocks, getMessagesPath(getStateRepoRoot(input), input.stateRoot, input.taskSlug), () => scanLocked(input));
    },
    async confirmPromptSubmitted(input) {
      return withTaskLock(taskLocks, getMessagesPath(getStateRepoRoot(input), input.stateRoot, input.taskSlug), async () => {
        const timestamp = now();
        const messages = await readLatestMessages(deps.fs, getMessagesPath(getStateRepoRoot(input), input.stateRoot, input.taskSlug));
        const messageId = extractVcmMessageId(input.prompt);
        if (!messageId) {
          return undefined;
        }
        const message = findDeliveredMessageForPrompt(messages, input.role, messageId);
        if (!message) {
          return undefined;
        }

        const accepted: VcmRoleMessage = {
          ...message,
          acceptedAt: timestamp,
          failureReason: undefined
        };
        await appendMessageSnapshot(deps.fs, input, accepted);
        await clearRouteFileIfStillMatchesMessage(deps.fs, input, accepted);
        return accepted;
      });
    },
    async markAllDone(input) {
      return withTaskLock(taskLocks, getMessagesPath(getStateRepoRoot(input), input.stateRoot, input.taskSlug), async () => {
        const messages = await readLatestMessages(deps.fs, getMessagesPath(getStateRepoRoot(input), input.stateRoot, input.taskSlug));
        let clearedCount = 0;

        if (input.clearRouteFiles) {
          for (const routeFile of await listPendingRouteFiles(input)) {
            await deps.fs.writeText(resolveRepoPath(input.taskRepoRoot ?? input.repoRoot, routeFile.path), "");
            clearedCount += 1;
          }
        }

        return {
          taskSlug: input.taskSlug,
          updatedCount: clearedCount,
          messages
        };
      });
    },
    async deleteMessageHistory(input) {
      return withTaskLock(taskLocks, getMessagesPath(getStateRepoRoot(input), input.stateRoot, input.taskSlug), async () => {
        const messagesPath = getMessagesPath(getStateRepoRoot(input), input.stateRoot, input.taskSlug);
        const messages = await readLatestMessages(deps.fs, messagesPath);
        await writeMessageSnapshots(deps.fs, messagesPath, []);
        return {
          taskSlug: input.taskSlug,
          deletedCount: messages.length,
          messages: []
        };
      });
    },
    async getOrchestrationState(input) {
      return getOrchestrationState(input);
    },
    async updateOrchestrationState(input) {
      const current = await getOrchestrationState(input);
      const next: VcmOrchestrationState = {
        ...current,
        mode: input.mode ?? current.mode,
        updatedAt: now()
      };
      await deps.fs.writeJsonAtomic(getOrchestrationStatePath(getStateRepoRoot(input), input.stateRoot, input.taskSlug), next);
      return next;
    }
  };

  function scheduleDispatchConfirmation(
    input: ScanPendingRouteFilesInput,
    message: VcmRoleMessage,
    sessionId: string
  ): void {
    if (!dispatchConfirmationEnabled) {
      return;
    }
    void monitorDispatchConfirmation(input, message, sessionId).catch(() => undefined);
  }

  async function monitorDispatchConfirmation(
    input: ScanPendingRouteFilesInput,
    message: VcmRoleMessage,
    sessionId: string
  ): Promise<void> {
    for (const retryDelayMs of dispatchConfirmationRetryDelaysMs) {
      await delay(retryDelayMs);
      const current = await readMessageById(input, message.id);
      if (!current || current.acceptedAt) {
        return;
      }
      try {
        deps.runtime.write(sessionId, "\r");
      } catch (error) {
        await markDispatchConfirmationFailure(input, message.id, `Auto orchestration could not retry Enter: ${errorMessage(error)}`);
        return;
      }
    }

    await delay(dispatchConfirmationFailureDelayMs);
    const current = await readMessageById(input, message.id);
    if (!current || current.acceptedAt) {
      return;
    }
    await markDispatchConfirmationFailure(input, message.id, DISPATCH_NOT_CONFIRMED_REASON);
  }

  async function readMessageById(input: ListMessagesInput, messageId: string): Promise<VcmRoleMessage | undefined> {
    return withTaskLock(taskLocks, getMessagesPath(getStateRepoRoot(input), input.stateRoot, input.taskSlug), async () => {
      const messages = await readLatestMessages(deps.fs, getMessagesPath(getStateRepoRoot(input), input.stateRoot, input.taskSlug));
      return messages.find((message) => message.id === messageId);
    });
  }

  async function markDispatchConfirmationFailure(input: ListMessagesInput, messageId: string, failureReason: string): Promise<void> {
    await withTaskLock(taskLocks, getMessagesPath(getStateRepoRoot(input), input.stateRoot, input.taskSlug), async () => {
      const messages = await readLatestMessages(deps.fs, getMessagesPath(getStateRepoRoot(input), input.stateRoot, input.taskSlug));
      const current = messages.find((message) => message.id === messageId);
      if (!current || current.acceptedAt) {
        return;
      }
      await appendMessageSnapshot(deps.fs, input, {
        ...current,
        failureReason
      });
    });
  }
}

interface RouteContext {
  repoRoot: string;
  taskRepoRoot?: string;
  handoffDir: string;
}

function toRouteContext(input: ListRouteFilesInput): RouteContext {
  return {
    repoRoot: input.repoRoot,
    taskRepoRoot: input.taskRepoRoot,
    handoffDir: input.handoffDir
  };
}

async function listRouteFiles(fs: FileSystemAdapter, input: RouteContext): Promise<VcmRouteFile[]> {
  const repoRoot = input.taskRepoRoot ?? input.repoRoot;
  const routeDir = path.posix.join(input.handoffDir, "messages");
  const absoluteMessagesDir = resolveRepoPath(repoRoot, routeDir);
  if (!(await fs.pathExists(absoluteMessagesDir))) {
    return [];
  }

  const entries = await fs.readDir(absoluteMessagesDir);
  const routeFiles: VcmRouteFile[] = [];
  for (const entry of entries.filter((candidate) => candidate.endsWith(".md")).sort()) {
    const route = parseRouteFileName(entry);
    if (!route) {
      continue;
    }
    const relativePath = path.posix.join(routeDir, entry);
    const content = await fs.readText(resolveRepoPath(repoRoot, relativePath));
    const parsed = parseRouteFileContent(content, route.fromRole, route.toRole);
    routeFiles.push({
      path: relativePath,
      fromRole: route.fromRole,
      toRole: route.toRole,
      type: parsed.type,
      body: parsed.body,
      artifactRefs: parsed.artifactRefs,
      exists: true,
      pending: parsed.body.trim().length > 0
    });
  }

  return routeFiles;
}

function parseRouteFileName(fileName: string): { fromRole: VcmRoleName; toRole: VcmRoleName } | undefined {
  for (const fromRole of CORE_VCM_ROLE_NAMES) {
    for (const toRole of CORE_VCM_ROLE_NAMES) {
      if (fromRole === toRole) {
        continue;
      }
      if (fileName === `${fromRole}-${toRole}.md`) {
        return { fromRole, toRole };
      }
    }
  }
  return undefined;
}

function parseRouteFileContent(content: string, fromRole: VcmRoleName, toRole: VcmRoleName): {
  type: VcmMessageType;
  body: string;
  artifactRefs: string[];
} {
  const { frontmatter, body } = splitFrontmatter(content);
  const type = parseMessageType(frontmatter.type) ?? getDefaultMessageType(fromRole, toRole);
  const artifactRefs = parseArtifactRefs(frontmatter);
  return {
    type,
    body: body.trim(),
    artifactRefs
  };
}

function splitFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const delimiter = line.indexOf(":");
    if (delimiter <= 0) {
      continue;
    }
    const key = line.slice(0, delimiter).trim();
    const value = line.slice(delimiter + 1).trim();
    if (key) {
      frontmatter[key] = value;
    }
  }

  return {
    frontmatter,
    body: content.slice(match[0].length)
  };
}

function parseMessageType(value: string | undefined): VcmMessageType | undefined {
  const validTypes: VcmMessageType[] = [
    "user-request",
    "task",
    "question",
    "blocked",
    "result",
    "finding",
    "review-request",
    "revise",
    "cancel"
  ];
  return value && validTypes.includes(value as VcmMessageType)
    ? value as VcmMessageType
    : undefined;
}

function parseArtifactRefs(frontmatter: Record<string, string>): string[] {
  const refs = frontmatter.artifact_refs ?? frontmatter.artifactRefs ?? frontmatter.related_artifact;
  if (!refs) {
    return [];
  }
  return refs
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getDefaultMessageType(fromRole: VcmRoleName, toRole: VcmRoleName): VcmMessageType {
  if (fromRole === PM_ROLE && toRole !== PM_ROLE) {
    return "task";
  }
  if (fromRole !== PM_ROLE && toRole === PM_ROLE) {
    return "result";
  }
  return "question";
}

function selectDispatchCandidates(routeFiles: VcmRouteFile[], stoppedRole?: RoleName): VcmRouteFile[] {
  const candidates = stoppedRole
    ? routeFiles.filter((routeFile) => routeFile.fromRole === stoppedRole || routeFile.toRole === stoppedRole)
    : routeFiles;
  return [...candidates].sort((left, right) => {
    const updated = (left.updatedAt ?? "").localeCompare(right.updatedAt ?? "");
    return updated !== 0 ? updated : left.path.localeCompare(right.path);
  });
}

function validateMessagePolicy(fromRole: VcmMessageActor, toRole: VcmRoleName, type: VcmMessageType): void {
  if (!CORE_VCM_ROLE_NAMES.some((role) => role === toRole)) {
    throw new VcmError({
      code: "MESSAGE_TARGET_UNKNOWN",
      message: `Unknown target role: ${toRole}`,
      statusCode: 400
    });
  }

  if (!CORE_VCM_ROLE_NAMES.some((role) => role === fromRole)) {
    throw new VcmError({
      code: "MESSAGE_SENDER_UNKNOWN",
      message: `Unknown sender role: ${fromRole}`,
      statusCode: 400
    });
  }

  if (fromRole === PM_ROLE && toRole !== PM_ROLE && PM_TO_ROLE_TYPES.has(type)) {
    return;
  }

  if (fromRole !== PM_ROLE && toRole === PM_ROLE && ROLE_TO_PM_TYPES.has(type)) {
    return;
  }

  throw new VcmError({
    code: "MESSAGE_POLICY_DENIED",
    message: `${fromRole} cannot send ${type} messages to ${toRole}.`,
    statusCode: 403,
    hint: "Use project-manager as the orchestration hub unless this task explicitly allows a peer route."
  });
}

async function withTaskLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  run: () => Promise<T>
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) {
      locks.delete(key);
    }
  }
}

function findDeliveredMessageForPrompt(
  messages: VcmRoleMessage[],
  role: RoleName,
  messageId: string
): VcmRoleMessage | undefined {
  const delivered = messages.filter((message) =>
    message.toRole === role &&
    message.id === messageId &&
    message.deliveredAt
  );
  return delivered.sort((left, right) => getMessageDeliveryTime(left).localeCompare(getMessageDeliveryTime(right))).at(-1);
}

function extractVcmMessageId(prompt: string | undefined): string | undefined {
  return prompt?.match(/^\s*id:\s*(\S+)\s*$/m)?.[1];
}

function getMessageDeliveryTime(message: VcmRoleMessage): string {
  return message.deliveredAt ?? message.createdAt;
}

async function clearRouteFileIfStillMatchesMessage(
  fs: FileSystemAdapter,
  input: { repoRoot: string; taskRepoRoot?: string },
  message: VcmRoleMessage
): Promise<void> {
  const fromRole = message.fromRole;
  if (!message.routePath || !isCoreRouteRole(fromRole) || !isCoreRouteRole(message.toRole)) {
    return;
  }

  const absolutePath = resolveRepoPath(input.taskRepoRoot ?? input.repoRoot, message.routePath);
  if (!(await fs.pathExists(absolutePath))) {
    return;
  }

  const routeContent = await fs.readText(absolutePath);
  const parsed = parseRouteFileContent(routeContent, fromRole, message.toRole);
  if (
    parsed.body.trim() === message.body.trim() &&
    parsed.type === message.type &&
    arraysEqual(parsed.artifactRefs, message.artifactRefs)
  ) {
    await fs.writeText(absolutePath, "");
  }
}

function isCoreRouteRole(role: VcmMessageActor): role is VcmRoleName {
  return CORE_VCM_ROLE_NAMES.some((candidate) => candidate === role);
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

async function readLatestMessages(fs: FileSystemAdapter, messagesPath: string): Promise<VcmRoleMessage[]> {
  if (!(await fs.pathExists(messagesPath))) {
    return [];
  }

  const latest = new Map<string, VcmRoleMessage>();
  const lines = (await fs.readText(messagesPath)).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const message = JSON.parse(line) as VcmRoleMessage;
    latest.set(message.id, message);
  }

  return [...latest.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

async function appendMessageSnapshot(
  fs: FileSystemAdapter,
  input: { repoRoot: string; stateRepoRoot?: string; stateRoot: string; taskSlug: string },
  message: VcmRoleMessage
): Promise<void> {
  await fs.appendText(getMessagesPath(getStateRepoRoot(input), input.stateRoot, input.taskSlug), `${JSON.stringify(message)}\n`);
}

async function writeMessageSnapshots(
  fs: FileSystemAdapter,
  messagesPath: string,
  messages: VcmRoleMessage[]
): Promise<void> {
  const content = messages.length > 0
    ? `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`
    : "";
  await fs.writeText(messagesPath, content);
}

function getMessagesPath(repoRoot: string, stateRoot: string, taskSlug: string): string {
  return path.join(repoRoot, stateRoot, "messages", `${taskSlug}.jsonl`);
}

function getOrchestrationStatePath(repoRoot: string, stateRoot: string, taskSlug: string): string {
  return path.join(repoRoot, stateRoot, "orchestration", `${taskSlug}.json`);
}

function getStateRepoRoot(input: { repoRoot: string; stateRepoRoot?: string }): string {
  return input.stateRepoRoot ?? input.repoRoot;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
