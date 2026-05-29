import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  SendRoleMessageRequest,
  SendRoleMessageResult,
  VcmMessageActor,
  VcmMessageStatus,
  VcmMessageType,
  VcmOrchestrationMode,
  VcmOrchestrationState,
  VcmRoleMessage
} from "../../shared/types/message.js";
import type { RoleName } from "../../shared/types/role.js";
import { ROLE_NAMES } from "../../shared/constants.js";
import { VcmError } from "../errors.js";
import { resolveRepoPath } from "../adapters/filesystem.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import { renderManualStagePrompt, renderMessageEnvelope } from "../templates/message-envelope.js";
import type { TaskService } from "./task-service.js";
import type { SessionService } from "./session-service.js";

export interface MessageService {
  listMessages(input: ListMessagesInput): Promise<VcmRoleMessage[]>;
  sendMessage(input: SendMessageInput): Promise<SendRoleMessageResult>;
  stageMessage(input: MessageActionInput): Promise<VcmRoleMessage>;
  approveMessage(input: MessageActionInput): Promise<VcmRoleMessage>;
  rejectMessage(input: MessageActionInput): Promise<VcmRoleMessage>;
  getOrchestrationState(input: OrchestrationStateInput): Promise<VcmOrchestrationState>;
  updateOrchestrationState(input: UpdateOrchestrationStateInput): Promise<VcmOrchestrationState>;
}

export interface ListMessagesInput {
  repoRoot: string;
  stateRoot: string;
  taskSlug: string;
}

export interface SendMessageInput extends SendRoleMessageRequest {
  repoRoot: string;
  stateRoot: string;
  handoffDir: string;
  taskSlug: string;
}

export interface MessageActionInput {
  repoRoot: string;
  stateRoot: string;
  taskSlug: string;
  messageId: string;
}

export interface OrchestrationStateInput {
  repoRoot: string;
  stateRoot: string;
  taskSlug: string;
}

export interface UpdateOrchestrationStateInput extends OrchestrationStateInput {
  mode?: VcmOrchestrationMode;
  paused?: boolean;
}

export interface MessageServiceDeps {
  fs: FileSystemAdapter;
  runtime: TerminalRuntime;
  sessionService: SessionService;
  taskService: Pick<TaskService, "loadTask">;
  now?: () => string;
  id?: () => string;
}

const PM_ROLE: RoleName = "project-manager";
const PM_TO_ROLE_TYPES = new Set<VcmMessageType>(["task", "question", "review-request", "revise", "cancel"]);
const ROLE_TO_PM_TYPES = new Set<VcmMessageType>(["result", "question", "blocked", "finding"]);

export function createMessageService(deps: MessageServiceDeps): MessageService {
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? (() => `msg_${randomUUID()}`);

  return {
    listMessages(input) {
      return readLatestMessages(deps.fs, getMessagesPath(input.repoRoot, input.stateRoot, input.taskSlug));
    },
    async sendMessage(input) {
      await deps.taskService.loadTask(input.repoRoot, input.taskSlug);
      validateMessagePolicy(input.fromRole, input.toRole, input.type);

      const timestamp = now();
      const message: VcmRoleMessage = {
        id: id(),
        taskSlug: input.taskSlug,
        fromRole: input.fromRole,
        toRole: input.toRole,
        type: input.type,
        body: input.body,
        artifactRefs: input.artifactRefs ?? [],
        parentMessageId: input.parentMessageId,
        status: "queued",
        createdAt: timestamp
      };
      message.bodyPath = await writeMessageBody(deps.fs, input.repoRoot, input.handoffDir, message);

      const state = await this.getOrchestrationState(input);
      const session = await deps.sessionService.getRoleSession(input.repoRoot, input.taskSlug, input.toRole);

      if (!session || session.status !== "running") {
        message.status = "queued";
        message.failureReason = `${input.toRole} session is not running.`;
        await appendMessageSnapshot(deps.fs, input, message);
        return { message, delivered: false, requiresUserApproval: false };
      }

      if (state.mode === "manual") {
        message.status = "pending_approval";
        await appendMessageSnapshot(deps.fs, input, message);
        return { message, delivered: false, requiresUserApproval: true };
      }

      if (state.paused) {
        message.status = "queued";
        message.failureReason = "Auto orchestration is paused.";
        await appendMessageSnapshot(deps.fs, input, message);
        return { message, delivered: false, requiresUserApproval: false };
      }

      const delivered = {
        ...message,
        status: "delivered" as VcmMessageStatus,
        deliveredAt: timestamp,
        failureReason: undefined
      };
      deps.runtime.write(session.id, `${renderMessageEnvelope(delivered)}\r`);
      await appendMessageSnapshot(deps.fs, input, delivered);
      return { message: delivered, delivered: true, requiresUserApproval: false };
    },
    async stageMessage(input) {
      const message = await getMessageOrThrow(deps.fs, input);
      const session = await deps.sessionService.getRoleSession(input.repoRoot, input.taskSlug, message.toRole);
      if (!session || session.status !== "running") {
        throw new VcmError({
          code: "MESSAGE_TARGET_NOT_RUNNING",
          message: `${message.toRole} session is not running.`,
          statusCode: 409,
          hint: `Start the ${message.toRole} session before staging this message.`
        });
      }

      const staged: VcmRoleMessage = {
        ...message,
        status: "staged",
        stagedAt: now(),
        failureReason: undefined
      };
      deps.runtime.write(session.id, renderManualStagePrompt(staged));
      await appendMessageSnapshot(deps.fs, input, staged);
      return staged;
    },
    approveMessage(input) {
      return this.stageMessage(input);
    },
    async rejectMessage(input) {
      const message = await getMessageOrThrow(deps.fs, input);
      const rejected: VcmRoleMessage = {
        ...message,
        status: "rejected",
        failureReason: undefined
      };
      await appendMessageSnapshot(deps.fs, input, rejected);
      return rejected;
    },
    async getOrchestrationState(input) {
      const statePath = getOrchestrationStatePath(input.repoRoot, input.stateRoot, input.taskSlug);
      if (!(await deps.fs.pathExists(statePath))) {
        return {
          taskSlug: input.taskSlug,
          mode: "manual",
          paused: false,
          updatedAt: now()
        };
      }
      return deps.fs.readJson<VcmOrchestrationState>(statePath);
    },
    async updateOrchestrationState(input) {
      const current = await this.getOrchestrationState(input);
      const next: VcmOrchestrationState = {
        ...current,
        mode: input.mode ?? current.mode,
        paused: input.paused ?? current.paused,
        updatedAt: now()
      };
      await deps.fs.writeJsonAtomic(getOrchestrationStatePath(input.repoRoot, input.stateRoot, input.taskSlug), next);
      return next;
    }
  };
}

function validateMessagePolicy(fromRole: VcmMessageActor, toRole: RoleName, type: VcmMessageType): void {
  if (!ROLE_NAMES.includes(toRole)) {
    throw new VcmError({
      code: "MESSAGE_TARGET_UNKNOWN",
      message: `Unknown target role: ${toRole}`,
      statusCode: 400
    });
  }

  if (fromRole === "user") {
    if (toRole === PM_ROLE && type === "user-request") {
      return;
    }
    throw new VcmError({
      code: "MESSAGE_POLICY_DENIED",
      message: "User messages can only target project-manager as user-request.",
      statusCode: 403
    });
  }

  if (!ROLE_NAMES.includes(fromRole)) {
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
    hint: "Use project-manager as the orchestration hub."
  });
}

async function writeMessageBody(
  fs: FileSystemAdapter,
  repoRoot: string,
  handoffDir: string,
  message: VcmRoleMessage
): Promise<string> {
  const bodyPath = path.posix.join(handoffDir, "messages", `${message.id}.md`);
  await fs.writeText(resolveRepoPath(repoRoot, bodyPath), renderMessageBodyFile(message));
  return bodyPath;
}

function renderMessageBodyFile(message: VcmRoleMessage): string {
  const artifactRefs = message.artifactRefs.length > 0
    ? message.artifactRefs.map((artifact) => `- ${artifact}`).join("\n")
    : "- none";
  return `# VCM Message ${message.id}

- Task: ${message.taskSlug}
- From: ${message.fromRole}
- To: ${message.toRole}
- Type: ${message.type}

## Body

${message.body}

## Artifact Refs

${artifactRefs}
`;
}

async function getMessageOrThrow(fs: FileSystemAdapter, input: MessageActionInput): Promise<VcmRoleMessage> {
  const messages = await readLatestMessages(fs, getMessagesPath(input.repoRoot, input.stateRoot, input.taskSlug));
  const message = messages.find((candidate) => candidate.id === input.messageId);
  if (!message) {
    throw new VcmError({
      code: "MESSAGE_MISSING",
      message: `Message does not exist: ${input.messageId}`,
      statusCode: 404
    });
  }
  return message;
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
  input: { repoRoot: string; stateRoot: string; taskSlug: string },
  message: VcmRoleMessage
): Promise<void> {
  await fs.appendText(getMessagesPath(input.repoRoot, input.stateRoot, input.taskSlug), `${JSON.stringify(message)}\n`);
}

function getMessagesPath(repoRoot: string, stateRoot: string, taskSlug: string): string {
  return path.join(repoRoot, stateRoot, "messages", `${taskSlug}.jsonl`);
}

function getOrchestrationStatePath(repoRoot: string, stateRoot: string, taskSlug: string): string {
  return path.join(repoRoot, stateRoot, "orchestration", `${taskSlug}.json`);
}
