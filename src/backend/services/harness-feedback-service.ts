import { createHash } from "node:crypto";
import path from "node:path";
import type { ClaudeHookEventName } from "../../shared/types/claude-hook.js";
import type {
  HarnessFeedbackQueueItem,
  HarnessFeedbackStateReport,
  TaskHarnessRetrospectiveTrigger
} from "../../shared/types/harness.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import { checkMarkdownArtifact, readArtifactSectionValue } from "../../shared/validation/artifact-check.js";
import { resolveRepoPath, type FileSystemAdapter } from "../adapters/filesystem.js";
import { VcmError } from "../errors.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import type {
  AutoMemoryService,
  TaskRetrospectiveMemoryReviewContext
} from "./auto-memory-service.js";
import type { SessionService } from "./session-service.js";

export interface HarnessFeedbackService {
  getState(repoRoot: string, activeTaskSlug?: string): Promise<HarnessFeedbackStateReport>;
  sendPendingFeedback(repoRoot: string, input: SendPendingFeedbackInput): Promise<RoleSessionRecord>;
  startTaskRetrospective(repoRoot: string, input: StartTaskRetrospectiveInput): Promise<HarnessFeedbackStateReport>;
  handleTaskRetrospectiveHook(repoRoot: string, input: TaskRetrospectiveHookInput): Promise<boolean>;
  assertHarnessEngineerAvailable(repoRoot: string): Promise<void>;
}

export interface SendPendingFeedbackInput {
  taskSlug: string;
  feedbackPath: string;
}

export interface StartTaskRetrospectiveInput {
  taskSlug: string;
  taskRepoRoot: string;
  handoffDir: string;
  trigger: TaskHarnessRetrospectiveTrigger;
}

export interface TaskRetrospectiveHookInput {
  taskSlug: string;
  eventName: ClaudeHookEventName;
  memoryReviewSucceeded: boolean;
}

export interface HarnessFeedbackServiceDeps {
  fs: FileSystemAdapter;
  runtime: TerminalRuntime;
  sessionService: Pick<
    SessionService,
    "getRoleSession" | "startRoleSession" | "resumeRoleSession"
  >;
  autoMemoryService?: Pick<
    AutoMemoryService,
    "prepareTaskRetrospectiveReview" | "cancelTaskRetrospectiveReview"
  >;
  now?: () => string;
}

const FEEDBACK_ROOT = ".ai/vcm/harness-feedback";
const PENDING_DIR = `${FEEDBACK_ROOT}/pending`;
const TASK_RETROSPECTIVE_DIR = `${FEEDBACK_ROOT}/task-retrospectives`;
const LEGACY_STATE_PATH = `${FEEDBACK_ROOT}/state.json`;

interface TaskRetrospectiveMarker {
  version: 1;
  taskSlug: string;
  trigger: TaskHarnessRetrospectiveTrigger;
  status: "triggered" | "running" | "completed" | "failed";
  analysisPath: string;
  finalAcceptanceHash: string;
  memoryRunId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
}

export function createHarnessFeedbackService(deps: HarnessFeedbackServiceDeps): HarnessFeedbackService {
  const now = deps.now ?? (() => new Date().toISOString());

  async function getState(repoRoot: string, _activeTaskSlug?: string): Promise<HarnessFeedbackStateReport> {
    await cleanupLegacyState(repoRoot);
    const pending = await listPendingFeedback(repoRoot);
    return {
      version: 1,
      status: pending.length > 0 ? "queued" : "idle",
      queuedCount: pending.length,
      pending,
      warnings: []
    };
  }

  async function sendPendingFeedback(repoRoot: string, input: SendPendingFeedbackInput): Promise<RoleSessionRecord> {
    await cleanupLegacyState(repoRoot);
    const feedbackPath = input.feedbackPath.trim();
    const pending = await listPendingFeedback(repoRoot);
    const feedback = pending.find((item) => item.path === feedbackPath);
    if (!feedback) {
      throw new VcmError({
        code: "HARNESS_FEEDBACK_NOT_PENDING",
        message: "The selected Harness Feedback is no longer pending.",
        statusCode: 404,
        hint: "Refresh Harness Studio and select a feedback item that is still listed in the Inbox."
      });
    }

    const session = await ensureIdleHarnessEngineer(repoRoot, input.taskSlug);
    await submitTerminalInput(deps.runtime, session.id, buildPendingFeedbackPrompt(repoRoot, feedback.path));
    return session;
  }

  async function startTaskRetrospective(repoRoot: string, input: StartTaskRetrospectiveInput): Promise<HarnessFeedbackStateReport> {
    await cleanupLegacyState(repoRoot);
    const taskSlug = input.taskSlug.trim();
    if (!taskSlug) {
      throw new VcmError({
        code: "HARNESS_TASK_REQUIRED",
        message: "Select an active task before reviewing task harness.",
        statusCode: 409
      });
    }

    const existingMarker = await loadTaskRetrospectiveMarker(repoRoot, taskSlug);
    if (existingMarker && existingMarker.status !== "failed") {
      throw new VcmError({
        code: "TASK_HARNESS_RETROSPECTIVE_EXISTS",
        message: `Task Harness Retrospective has already been triggered for task: ${taskSlug}`,
        statusCode: 409,
        hint: "Review the existing retrospective result instead of starting another retrospective for the same task."
      });
    }

    const finalAcceptancePath = path.posix.join(input.handoffDir, "final-acceptance.md");
    const finalAcceptanceAbsolutePath = resolveRepoPath(input.taskRepoRoot, finalAcceptancePath);
    const finalAcceptanceContent = await readAbsoluteOptionalText(finalAcceptanceAbsolutePath);
    const finalAcceptanceCheck = checkMarkdownArtifact("final-acceptance", finalAcceptancePath, finalAcceptanceContent ?? null);
    const finalAcceptanceDecision = finalAcceptanceContent
      ? readArtifactSectionValue(finalAcceptanceContent, "Decision")?.toLowerCase()
      : undefined;
    if (
      finalAcceptanceCheck.status !== "ok"
      || !finalAcceptanceContent
      || (finalAcceptanceDecision !== "accepted" && finalAcceptanceDecision !== "accepted-with-known-risks")
    ) {
      throw new VcmError({
        code: "TASK_FINAL_ACCEPTANCE_NOT_READY",
        message: "Task Harness Retrospective requires a completed code-change flow.",
        statusCode: 409,
        hint: `${finalAcceptancePath} must pass the final-acceptance artifact check before Task Harness Retrospective can start.`
      });
    }

    const session = await ensureIdleHarnessEngineer(repoRoot, taskSlug);
    const timestamp = now();
    const analysisPath = `${TASK_RETROSPECTIVE_DIR}/${sanitizeFeedbackId(taskSlug)}.md`;
    const analysisAbsolutePath = resolveRepoPath(repoRoot, analysisPath);
    const memoryReview = await deps.autoMemoryService?.prepareTaskRetrospectiveReview(
      input.taskRepoRoot,
      analysisAbsolutePath
    );
    const marker: TaskRetrospectiveMarker = {
      version: 1,
      taskSlug,
      trigger: input.trigger,
      status: "running",
      analysisPath,
      finalAcceptanceHash: `sha256:${sha256(finalAcceptanceContent)}`,
      ...(memoryReview ? { memoryRunId: memoryReview.runId } : {}),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const pendingFeedback = await listPendingFeedback(repoRoot);
    try {
      await persistTaskRetrospectiveMarker(repoRoot, marker);
      await submitTerminalInput(
        deps.runtime,
        session.id,
        buildTaskRetrospectivePrompt(
          repoRoot,
          analysisPath,
          pendingFeedback.map((item) => item.path),
          memoryReview
        )
      );
    } catch (error) {
      if (memoryReview) {
        await deps.autoMemoryService?.cancelTaskRetrospectiveReview(input.taskRepoRoot, memoryReview.runId);
      }
      const failedAt = now();
      await persistTaskRetrospectiveMarker(repoRoot, {
        ...marker,
        status: "failed",
        failedAt,
        updatedAt: failedAt,
        error: errorMessage(error)
      });
      throw error;
    }
    return getState(repoRoot);
  }

  async function handleTaskRetrospectiveHook(
    repoRoot: string,
    input: TaskRetrospectiveHookInput
  ): Promise<boolean> {
    const marker = await loadTaskRetrospectiveMarker(repoRoot, input.taskSlug);
    if (!marker || (marker.status !== "running" && marker.status !== "triggered")) {
      return false;
    }
    if (input.eventName === "UserPromptSubmit" || input.eventName === "PostCompact") {
      return true;
    }

    const timestamp = now();
    if (input.eventName === "StopFailure") {
      await persistTaskRetrospectiveMarker(repoRoot, {
        ...marker,
        status: "failed",
        failedAt: timestamp,
        updatedAt: timestamp,
        error: "Harness Engineer Task Harness Retrospective turn failed."
      });
      return true;
    }
    const reportPath = resolveRepoPath(repoRoot, marker.analysisPath);
    const reportReady = await deps.fs.pathExists(reportPath)
      && Boolean((await deps.fs.readText(reportPath)).trim());
    if (!reportReady || (marker.memoryRunId && !input.memoryReviewSucceeded)) {
      await persistTaskRetrospectiveMarker(repoRoot, {
        ...marker,
        status: "failed",
        failedAt: timestamp,
        updatedAt: timestamp,
        error: !reportReady
          ? "Harness Engineer did not write the required Task Harness Retrospective report."
          : "Task Harness Retrospective memory review failed."
      });
      return true;
    }
    await persistTaskRetrospectiveMarker(repoRoot, {
      ...marker,
      status: "completed",
      completedAt: timestamp,
      updatedAt: timestamp
    });
    return true;
  }

  async function assertHarnessEngineerAvailable(_repoRoot: string): Promise<void> {
    return undefined;
  }

  async function getIdleHarnessEngineer(repoRoot: string, taskSlug: string): Promise<RoleSessionRecord | undefined> {
    const existing = await deps.sessionService.getRoleSession(repoRoot, taskSlug, "harness-engineer");
    if (existing?.status === "running" && existing.activityStatus === "running") {
      throw new VcmError({
        code: "HARNESS_ENGINEER_BUSY",
        message: "Harness Engineer is busy or unavailable.",
        statusCode: 409,
        hint: "Wait for the current Harness Engineer turn to finish, then retry."
      });
    }
    const input = { cols: 120, rows: 32 };
    const session = existing?.status === "running"
      ? existing
      : existing?.claudeSessionId
        ? await deps.sessionService.resumeRoleSession(repoRoot, taskSlug, "harness-engineer", input)
        : await deps.sessionService.startRoleSession(repoRoot, taskSlug, "harness-engineer", input);
    if (session.status !== "running" || session.activityStatus === "running") {
      return undefined;
    }
    if (!deps.runtime.getSession(session.id)) {
      return undefined;
    }
    return session;
  }

  async function ensureIdleHarnessEngineer(repoRoot: string, taskSlug: string): Promise<RoleSessionRecord> {
    const session = await getIdleHarnessEngineer(repoRoot, taskSlug);
    if (!session) {
      throw new VcmError({
        code: "HARNESS_ENGINEER_BUSY",
        message: "Harness Engineer is busy or unavailable.",
        statusCode: 409,
        hint: "Wait for the current Harness Engineer turn to finish, then retry."
      });
    }
    return session;
  }

  async function listPendingFeedback(repoRoot: string): Promise<HarnessFeedbackQueueItem[]> {
    const pendingDir = resolveRepoPath(repoRoot, PENDING_DIR);
    if (!(await deps.fs.pathExists(pendingDir))) {
      return [];
    }
    const names = await deps.fs.readDir(pendingDir);
    const markdownFiles = names
      .filter((name) => name.endsWith(".md") && !name.includes("/") && !name.includes("\\"))
      .sort();
    const items = await Promise.all(markdownFiles.map(async (name) => {
      const relativePath = `${PENDING_DIR}/${name}`;
      const content = await readOptionalText(repoRoot, relativePath) ?? "";
      return parseFeedbackItem(relativePath, content);
    }));
    return items;
  }

  function parseFeedbackItem(relativePath: string, content: string): HarnessFeedbackQueueItem {
    const id = sanitizeFeedbackId(path.posix.basename(relativePath, ".md"));
    const metadata = parseSimpleMetadata(content);
    const title = firstHeading(content)
      ?? metadata.summary
      ?? metadata["observed problem"]
      ?? id;
    return {
      id,
      title: compactLine(title),
      path: relativePath,
      source: "role-feedback",
      reporterRole: metadata["reporter role"] ?? metadata.reporter,
      taskSlug: metadata["task slug"] ?? metadata.task,
      summary: metadata.summary
    };
  }

  function buildTaskRetrospectivePrompt(
    repoRoot: string,
    analysisPath: string,
    pendingFeedbackPaths: string[],
    memoryReview?: TaskRetrospectiveMemoryReviewContext
  ): string {
    const pendingFeedback = pendingFeedbackPaths.length > 0
      ? pendingFeedbackPaths.map((feedbackPath) => `- ${resolveRepoPath(repoRoot, feedbackPath)}`)
      : ["none"];
    return [
      "[VCM Task Harness Retrospective]",
      "",
      "Review the completed task from the current active task worktree.",
      "",
      `Pending Feedback Directory: ${resolveRepoPath(repoRoot, PENDING_DIR)}`,
      "",
      "Pending Feedback:",
      ...pendingFeedback,
      ...(pendingFeedbackPaths.length > 0
        ? [
            "",
            "Process every listed feedback inside this retrospective. Record every disposition in the retrospective report, then delete the processed feedback files before ending the turn."
          ]
        : []),
      ...(memoryReview
        ? [
            "",
            "Auto Memory Review:",
            `Role drafts: ${memoryReview.roleDraftsPath}`,
            `Current memory snapshot: ${memoryReview.currentMemoryPath}`,
            ...(memoryReview.planningCandidatePath
              ? [`Architect planning-session candidate: ${memoryReview.planningCandidatePath}`]
              : []),
            `Write the complete reviewed memory set to: ${memoryReview.reviewedMemoryPath}`,
            "",
            "Review every memory candidate against final task evidence while performing this retrospective.",
            "Each snapshot file contains only the matching <VCM-memory> block content. Edit every existing reviewed-memory file in place.",
            "Before evaluating proposals, review every entry in every current memory snapshot. Retain, update, or remove each existing entry against current code, documentation, and final task evidence.",
            "Complete this full existing-memory review even when every proposal says no-change.",
            "Then evaluate every proposal. Keep only verified, durable, reusable project knowledge. Merge duplicates and keep role-specific knowledge in the matching role file.",
            "Do not record task narrative, temporary state, unverified conclusions, or Harness rules in memory.",
            "Use this exact block in the retrospective report and replace each option or placeholder with one allowed value or a concise summary:",
            "",
            "## Memory Review",
            "Existing memory reviewed: complete",
            "",
            "### Proposal Dispositions",
            ...memoryReview.proposalRoles.map((role) => `- ${role}: accepted|rejected|no-change`),
            "",
            "### Existing Memory Changes",
            "- retained: <summary or none>",
            "- updated: <summary or none>",
            "- removed: <summary or none>",
            "",
            "Reviewed memory set: complete"
          ]
        : []),
      "",
      `Write the analysis to Result Path: ${resolveRepoPath(repoRoot, analysisPath)}`,
      "End your turn after writing the result."
    ].join("\n");
  }

  function buildPendingFeedbackPrompt(repoRoot: string, feedbackPath: string): string {
    return [
      "[VCM Harness Feedback]",
      "",
      "Review this feedback:",
      resolveRepoPath(repoRoot, feedbackPath),
      "",
      "Verify the issue against the current harness and project evidence. Report your findings and proposed changes to the user."
    ].join("\n");
  }

  async function loadTaskRetrospectiveMarker(
    repoRoot: string,
    taskSlug: string
  ): Promise<TaskRetrospectiveMarker | undefined> {
    const markerPath = resolveRepoPath(repoRoot, getTaskRetrospectiveMarkerPath(taskSlug));
    if (!(await deps.fs.pathExists(markerPath))) {
      return undefined;
    }
    return deps.fs.readJson<TaskRetrospectiveMarker>(markerPath);
  }

  async function persistTaskRetrospectiveMarker(repoRoot: string, marker: TaskRetrospectiveMarker): Promise<void> {
    const markerPath = resolveRepoPath(repoRoot, getTaskRetrospectiveMarkerPath(marker.taskSlug));
    await deps.fs.ensureDir(path.dirname(markerPath));
    await deps.fs.writeJsonAtomic(markerPath, marker);
  }

  async function cleanupLegacyState(repoRoot: string): Promise<void> {
    const statePath = resolveRepoPath(repoRoot, LEGACY_STATE_PATH);
    if (await deps.fs.pathExists(statePath)) {
      await deps.fs.removePath?.(statePath, { force: true });
    }
  }

  async function readOptionalText(repoRoot: string, relativePath: string): Promise<string | undefined> {
    const absolutePath = resolveRepoPath(repoRoot, relativePath);
    return readAbsoluteOptionalText(absolutePath);
  }

  async function readAbsoluteOptionalText(absolutePath: string): Promise<string | undefined> {
    if (!(await deps.fs.pathExists(absolutePath))) {
      return undefined;
    }
    return deps.fs.readText(absolutePath);
  }

  return {
    getState,
    sendPendingFeedback,
    startTaskRetrospective,
    handleTaskRetrospectiveHook,
    assertHarnessEngineerAvailable
  };
}

function parseSimpleMetadata(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/).slice(0, 80)) {
    const match = /^[-*]?\s*([A-Za-z][A-Za-z -]{1,40})\s*:\s*(.+)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    result[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return result;
}

function firstHeading(content: string): string | undefined {
  const heading = content.split(/\r?\n/).find((line) => /^#{1,3}\s+\S/.test(line));
  return heading?.replace(/^#{1,3}\s+/, "").trim();
}

function compactLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 160);
}

function getTaskRetrospectiveMarkerPath(taskSlug: string): string {
  return `${TASK_RETROSPECTIVE_DIR}/${sanitizeFeedbackId(taskSlug)}.json`;
}

function sanitizeFeedbackId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized || "feedback";
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
