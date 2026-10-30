import type { FileSystemAdapter } from "../adapters/filesystem.js";
import type { VcmRoleMessage } from "../../shared/types/message.js";
import type { VcmRoleName } from "../../shared/types/role.js";
import { readTaskMessages } from "./message-service.js";
import type { WorkflowControlService } from "./workflow-control-service.js";

export interface RouteMessageContext {
  repoRoot: string;
  taskRepoRoot: string;
  stateRoot: string;
  handoffDir: string;
  taskSlug: string;
}

export interface FlowRouteMessages {
  // Start of the current flow run, or undefined when the whole log was used.
  windowStart?: string;
  messages: VcmRoleMessage[];
}

// PM route messages are the operative instructions for a role: the dispatch
// that started the current flow run and every later relay of a user decision.
// They exist only in the task message log, so callers render this slice of it.
export async function collectFlowRouteMessages(
  fs: FileSystemAdapter,
  workflowControlService: Pick<WorkflowControlService, "getProgress" | "getState"> | undefined,
  context: RouteMessageContext,
  roles: ReadonlySet<VcmRoleName>
): Promise<FlowRouteMessages> {
  const messages = await readTaskMessages(fs, {
    repoRoot: context.repoRoot,
    stateRepoRoot: context.taskRepoRoot,
    stateRoot: context.stateRoot,
    taskSlug: context.taskSlug
  });
  const flowRunStart = await findFlowRunStart(workflowControlService, context);
  const acceptedPmMessages = messages
    .filter((message) => message.fromRole === "project-manager" && message.acceptedAt)
    .sort((left, right) => left.acceptedAt!.localeCompare(right.acceptedAt!));
  // A PM message is accepted immediately before Workflow Progress confirms its
  // dispatch, so the flow's starting message is the last one accepted at or
  // before the first confirmation of the flow run.
  const windowStart = flowRunStart
    ? acceptedPmMessages.filter((message) => message.acceptedAt! <= flowRunStart).at(-1)?.acceptedAt ?? flowRunStart
    : undefined;
  return {
    windowStart,
    messages: messages
      .filter((message) => message.fromRole === "user"
        ? !windowStart || message.createdAt >= windowStart
        : message.fromRole === "project-manager"
          && roles.has(message.toRole)
          && Boolean(message.acceptedAt)
          && (!windowStart || message.acceptedAt! >= windowStart))
      .sort((left, right) => messageTime(left).localeCompare(messageTime(right)))
  };
}

export function renderRouteMessages(
  taskSlug: string,
  header: string[],
  flow: FlowRouteMessages
): string {
  return [
    "# PM Route Messages",
    "",
    `Task: ${taskSlug}`,
    ...header,
    flow.windowStart
      ? `Scope: messages since the current flow run started at ${flow.windowStart}`
      : "Scope: the whole task message log; the current flow run start was unavailable",
    "",
    "PM route messages to the listed roles and user messages to PM, oldest first.",
    "A later message overrides an earlier one where they conflict.",
    ...flow.messages.flatMap((message, index) => [
      "",
      `## ${index + 1}. ${message.fromRole} -> ${message.toRole} (${message.type})`,
      "",
      `Message: ${message.id}`,
      `Time: ${messageTime(message)}`,
      ...(message.artifactRefs.length > 0 ? [`Artifacts: ${message.artifactRefs.join(", ")}`] : []),
      "",
      message.body.trimEnd()
    ]),
    ""
  ].join("\n");
}

async function findFlowRunStart(
  workflowControlService: Pick<WorkflowControlService, "getProgress" | "getState"> | undefined,
  context: RouteMessageContext
): Promise<string | undefined> {
  if (!workflowControlService) {
    return undefined;
  }
  try {
    const workflowContext = {
      taskRepoRoot: context.taskRepoRoot,
      stateRoot: context.stateRoot,
      handoffDir: context.handoffDir,
      taskSlug: context.taskSlug
    };
    const [state, progress] = await Promise.all([
      workflowControlService.getState(workflowContext),
      workflowControlService.getProgress(workflowContext)
    ]);
    const startedAtSequence = state.flowRun?.startedAtSequence;
    return progress.history.find((entry) => entry.sequence === startedAtSequence)?.confirmedAt;
  } catch {
    return undefined;
  }
}

function messageTime(message: VcmRoleMessage): string {
  return message.acceptedAt ?? message.createdAt;
}
