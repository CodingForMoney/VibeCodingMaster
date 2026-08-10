import { createHash } from "node:crypto";
import path from "node:path";
import type { ClaudeHookEventName } from "../../shared/types/claude-hook.js";
import type { AutoMemoryReviewStatus } from "../../shared/types/memory.js";
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
import { parseHarnessFeedbackArtifact } from "./managed-artifact-validation.js";
import type { SessionService } from "./session-service.js";

export interface HarnessFeedbackService {
  getState(repoRoot: string, activeTaskSlug?: string): Promise<HarnessFeedbackStateReport>;
  sendPendingFeedback(repoRoot: string, input: SendPendingFeedbackInput): Promise<RoleSessionRecord>;
  startTaskRetrospective(repoRoot: string, input: StartTaskRetrospectiveInput): Promise<HarnessFeedbackStateReport>;
  handleTaskRetrospectiveHook(repoRoot: string, input: TaskRetrospectiveHookInput): Promise<boolean>;
  completeWaitingTaskRetrospective(
    repoRoot: string,
    taskSlug: string,
    memoryStatus: AutoMemoryReviewStatus
  ): Promise<boolean>;
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
  memoryReviewStatus: AutoMemoryReviewStatus;
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
  status: "triggered" | "running" | "waiting-docs" | "completed" | "failed";
  analysisPath: string;
  finalAcceptanceHash: string;
  pendingFeedbackPaths: string[];
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
    const pendingFeedback = await listPendingFeedback(repoRoot);
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
      pendingFeedbackPaths: pendingFeedback.map((item) => item.path),
      ...(memoryReview ? { memoryRunId: memoryReview.runId } : {}),
      createdAt: timestamp,
      updatedAt: timestamp
    };
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
    const reportContent = await deps.fs.pathExists(reportPath)
      ? await deps.fs.readText(reportPath)
      : "";
    const reportErrors = reportContent.trim()
      ? [
          ...getRetrospectiveReportErrors(reportContent),
          ...getFeedbackDispositionErrors(repoRoot, marker.pendingFeedbackPaths ?? [], reportContent)
        ]
      : ["Report is empty."];
    const reportReady = reportErrors.length === 0;
    if (!reportReady || (marker.memoryRunId && input.memoryReviewStatus === "failed")) {
      await persistTaskRetrospectiveMarker(repoRoot, {
        ...marker,
        status: "failed",
        failedAt: timestamp,
        updatedAt: timestamp,
        error: !reportReady
          ? `Harness Engineer did not write a valid Task Harness Retrospective report: ${reportErrors.join(" ")}`
          : "Task Harness Retrospective memory review failed."
      });
      return true;
    }
    if (marker.memoryRunId && input.memoryReviewStatus === "documenting") {
      await persistTaskRetrospectiveMarker(repoRoot, {
        ...marker,
        status: "waiting-docs",
        updatedAt: timestamp
      });
      return true;
    }
    await completeTaskRetrospective(repoRoot, marker);
    return true;
  }

  async function completeWaitingTaskRetrospective(
    repoRoot: string,
    taskSlug: string,
    memoryStatus: AutoMemoryReviewStatus
  ): Promise<boolean> {
    const marker = await loadTaskRetrospectiveMarker(repoRoot, taskSlug);
    if (!marker || marker.status !== "waiting-docs") {
      return false;
    }
    if (memoryStatus === "documenting") {
      return true;
    }
    if (memoryStatus === "failed") {
      const timestamp = now();
      await persistTaskRetrospectiveMarker(repoRoot, {
        ...marker,
        status: "failed",
        failedAt: timestamp,
        updatedAt: timestamp,
        error: "Task Harness Retrospective durable-document assignment failed."
      });
      return true;
    }
    await completeTaskRetrospective(repoRoot, marker);
    return true;
  }

  async function completeTaskRetrospective(repoRoot: string, marker: TaskRetrospectiveMarker): Promise<void> {
    const timestamp = now();
    try {
      await removeProcessedFeedback(repoRoot, marker.pendingFeedbackPaths ?? []);
    } catch (error) {
      await persistTaskRetrospectiveMarker(repoRoot, {
        ...marker,
        status: "failed",
        failedAt: timestamp,
        updatedAt: timestamp,
        error: `VCM could not remove processed Harness Feedback: ${errorMessage(error)}`
      });
      return;
    }
    await persistTaskRetrospectiveMarker(repoRoot, {
      ...marker,
      status: "completed",
      completedAt: timestamp,
      updatedAt: timestamp
    });
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
    const validation = parseHarnessFeedbackArtifact(content);
    if (!validation.parsed || validation.errors.length > 0) {
      throw new VcmError({
        code: "HARNESS_FEEDBACK_INVALID",
        message: `Invalid Harness Feedback ${relativePath}: ${validation.errors.join(" ")}`,
        statusCode: 422
      });
    }
    return {
      id,
      title: compactLine(validation.parsed.title),
      path: relativePath,
      source: "role-feedback",
      reporterRole: validation.parsed.reporterRole,
      taskSlug: validation.parsed.taskSlug,
      summary: validation.parsed.summary
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
            "Process every listed feedback inside this retrospective. Record every disposition in the retrospective report using this exact block for each assigned path:",
            "",
            "### Feedback: <exact assigned absolute path>",
            "Decision: confirmed|rejected|duplicate|already-covered",
            "Evidence: <concise evidence>",
            "Impact: <impact>",
            "Required action: <action or none>",
            "",
            "Do not edit or delete pending feedback files. VCM removes the assigned files after validating every disposition in the accepted report."
          ]
        : []),
      "",
      "The report must contain: # Task Harness Retrospective: <task>, ## Findings, ## Feedback Dispositions, ## Recommended Harness Changes, and ## VCM Issue Drafts.",
      ...(memoryReview
        ? [
            "",
            "Auto Memory Review:",
            `Role drafts: ${memoryReview.roleDraftsPath}`,
            `Current memory snapshot: ${memoryReview.currentMemoryPath}`,
            "Active memory files:",
            ...memoryReview.activeMemoryPaths.map((memoryPath) => `- ${memoryPath}`),
            "Proposal candidates:",
            ...(memoryReview.proposalCandidates.length > 0
              ? memoryReview.proposalCandidates.map((candidate) => [
                  candidate.id,
                  `source=${candidate.source}`,
                  `operation=${candidate.operation}`,
                  `target=${candidate.target}`,
                  `entry=${candidate.content ?? candidate.existing ?? "none"}`
                ].join(" | "))
              : ["none"]),
            ...(memoryReview.planningCandidatePath
              ? [`Architect planning-session candidate: ${memoryReview.planningCandidatePath}`]
              : []),
            "",
            "Review every memory candidate against final task evidence while performing this retrospective.",
            "The snapshot files contain only the matching pre-review <VCM-memory> block content.",
            "Before evaluating proposals, review every substantive entry in every current memory snapshot against current code, documentation, and final task evidence.",
            "Evaluate each proposal independently. Keep only verified, durable, reusable project knowledge; do not keep task narrative, temporary state, unverified conclusions, or Harness rules in memory.",
            "For every existing entry and proposal, record why the decision is necessary, the impact if the knowledge is absent, the evidence checked, and whether a durable document is the correct source.",
            "When the decision is move-to-durable-doc, remove the entry from memory now and add one durableDocAssignment. Do not wait for the durable document update before removing memory.",
            "Apply the reviewed result directly to the listed <VCM-memory> blocks. Do not change content outside those blocks.",
            "If memory changes, commit only the changed active memory files with message [VCM Harness] Update VCM memory. If memory is unchanged, do not create a commit.",
            `Write the complete machine-readable review to: ${memoryReview.reviewResultPath}`,
            "The JSON root must be: {\"version\":1,\"runId\":\"<assigned run id>\",\"memoryCommit\":\"<full commit or none>\",\"decisions\":[],\"durableDocAssignments\":[]}.",
            "Each decision must contain itemId, source (existing|proposal), target, entry, decision, reason, impactIfAbsent, evidence (non-empty array), finalContent, and durableDocPath.",
            "Existing decisions use retain|update|remove|move-to-durable-doc. Add or Update proposal decisions use keep-in-memory|keep-memory-reference|move-to-durable-doc|reject; Remove proposal decisions use remove|retain. Proposal itemId must equal the assigned candidate ID.",
            "Each durableDocAssignment must contain sourceMemoryPath, sourceEntry, targetPath, content, reason, and evidence (non-empty array). Use a project-relative Markdown target outside .ai/vcm.",
            "In the retrospective report, include only this memory summary:",
            "",
            "## Memory Review",
            "Memory commit: <full commit or none>",
            `Review result: ${memoryReview.reviewResultPath}`,
            "Durable document assignments: <count>"
          ]
        : []),
      "",
      `Write the analysis to Result Path: ${resolveRepoPath(repoRoot, analysisPath)}`,
      "Write the report directly to that path. Do not use vcm-artifact.",
      "End your turn after the report is complete."
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

  async function removeProcessedFeedback(repoRoot: string, feedbackPaths: string[]): Promise<void> {
    if (feedbackPaths.length === 0) {
      return;
    }
    if (!deps.fs.removePath) {
      throw new Error("The filesystem adapter does not support feedback removal.");
    }
    for (const feedbackPath of feedbackPaths) {
      assertPendingFeedbackPath(feedbackPath);
    }
    for (const feedbackPath of feedbackPaths) {
      await deps.fs.removePath(resolveRepoPath(repoRoot, feedbackPath), { force: true });
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
    completeWaitingTaskRetrospective,
    assertHarnessEngineerAvailable
  };
}

function getFeedbackDispositionErrors(
  repoRoot: string,
  feedbackPaths: string[],
  reportContent: string
): string[] {
  if (feedbackPaths.length === 0) {
    return [];
  }
  const section = readLevelTwoSection(reportContent, "Feedback Dispositions");
  if (!section) {
    return ["Feedback Dispositions is empty."];
  }

  const errors: string[] = [];
  const lines = section.split(/\r?\n/);
  for (const feedbackPath of feedbackPaths) {
    try {
      assertPendingFeedbackPath(feedbackPath);
    } catch (error) {
      errors.push(errorMessage(error));
      continue;
    }
    const absolutePath = resolveRepoPath(repoRoot, feedbackPath);
    const heading = `### Feedback: ${absolutePath}`;
    const start = lines.findIndex((line) => line.trim() === heading);
    if (start < 0) {
      errors.push(`Missing disposition for assigned feedback: ${absolutePath}.`);
      continue;
    }
    const endOffset = lines.slice(start + 1).findIndex((line) => /^###\s+/.test(line.trim()));
    const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
    const block = lines.slice(start + 1, end);
    const decision = readDispositionField(block, "Decision");
    if (!decision || !["confirmed", "rejected", "duplicate", "already-covered"].includes(decision)) {
      errors.push(`Feedback disposition Decision for ${absolutePath} must be confirmed|rejected|duplicate|already-covered.`);
    }
    for (const field of ["Evidence", "Impact", "Required action"]) {
      if (!readDispositionField(block, field)) {
        errors.push(`Feedback disposition ${field} is required for ${absolutePath}.`);
      }
    }
  }
  return errors;
}

function readLevelTwoSection(content: string, heading: string): string | undefined {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^##\\s+${escapedHeading}\\s*$`, "im").exec(content);
  if (!match || match.index === undefined) {
    return undefined;
  }
  const afterHeading = content.slice(match.index + match[0].length);
  const nextHeading = /\n##\s+\S/.exec(afterHeading);
  return (nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading).trim();
}

function readDispositionField(lines: string[], field: string): string | undefined {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return lines
    .map((line) => new RegExp(`^${escapedField}:\\s*(.+)$`, "i").exec(line.trim())?.[1]?.trim())
    .find((value): value is string => Boolean(value));
}

function assertPendingFeedbackPath(feedbackPath: string): void {
  if (!/^\.ai\/vcm\/harness-feedback\/pending\/[A-Za-z0-9._-]+\.md$/.test(feedbackPath)) {
    throw new Error(`Invalid assigned Harness Feedback path: ${feedbackPath}.`);
  }
}

function getRetrospectiveReportErrors(content: string): string[] {
  const errors: string[] = [];
  if (!/^# Task Harness Retrospective(?::\s*.+)?\s*$/m.test(content)) {
    errors.push("Retrospective report requires '# Task Harness Retrospective: <task>'.");
  }
  for (const heading of ["Findings", "Feedback Dispositions", "Recommended Harness Changes", "VCM Issue Drafts"]) {
    if (!new RegExp(`^## ${heading}\\s*$`, "m").test(content)) {
      errors.push(`Missing required section: ${heading}.`);
    }
  }
  return errors;
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
