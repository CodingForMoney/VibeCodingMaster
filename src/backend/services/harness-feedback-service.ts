import { createHash } from "node:crypto";
import path from "node:path";
import type {
  HarnessFeedbackActiveItem,
  HarnessFeedbackDecisionRequest,
  HarnessFeedbackQueueItem,
  HarnessFeedbackSource,
  HarnessFeedbackStateReport,
  HarnessFeedbackStatus,
  TaskHarnessRetrospectiveTrigger
} from "../../shared/types/harness.js";
import type { ClaudeHookEventName } from "../../shared/types/claude-hook.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import { checkMarkdownArtifact } from "../../shared/validation/artifact-check.js";
import { resolveRepoPath, toRepoRelativePath, type FileSystemAdapter } from "../adapters/filesystem.js";
import { VcmError } from "../errors.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import type { SessionService } from "./session-service.js";

export interface HarnessFeedbackService {
  getState(repoRoot: string, activeTaskSlug?: string): Promise<HarnessFeedbackStateReport>;
  startTaskRetrospective(repoRoot: string, input: StartTaskRetrospectiveInput): Promise<HarnessFeedbackStateReport>;
  decide(repoRoot: string, input: HarnessFeedbackDecisionRequest): Promise<HarnessFeedbackStateReport>;
  recordHarnessEngineerHook(repoRoot: string, eventName: ClaudeHookEventName): Promise<void>;
  assertHarnessEngineerAvailable(repoRoot: string): Promise<void>;
}

export interface StartTaskRetrospectiveInput {
  taskSlug: string;
  taskRepoRoot: string;
  handoffDir: string;
  trigger: TaskHarnessRetrospectiveTrigger;
}

export interface HarnessFeedbackServiceDeps {
  fs: FileSystemAdapter;
  runtime: TerminalRuntime;
  sessionService: Pick<
    SessionService,
    "ensureProjectHarnessEngineerSession" | "getProjectHarnessEngineerSession"
  >;
  now?: () => string;
}

interface StoredHarnessFeedbackState {
  version: 1;
  status: Exclude<HarnessFeedbackStatus, "idle" | "queued">;
  active: StoredHarnessFeedbackActive;
}

interface StoredHarnessFeedbackActive {
  id: string;
  title: string;
  path: string;
  source: HarnessFeedbackSource;
  reporterRole?: string;
  taskSlug?: string;
  summary?: string;
  trigger?: TaskHarnessRetrospectiveTrigger;
  finalAcceptanceHash?: string;
  feedbackPath: string;
  analysisPath: string;
  applyReportPath: string;
  startedAt: string;
  updatedAt: string;
  lastPromptAt?: string;
}

const FEEDBACK_ROOT = ".ai/vcm/harness-feedback";
const PENDING_DIR = `${FEEDBACK_ROOT}/pending`;
const ACTIVE_DIR = `${FEEDBACK_ROOT}/active`;
const COMPLETED_DIR = `${FEEDBACK_ROOT}/completed`;
const TASK_RETROSPECTIVE_DIR = `${FEEDBACK_ROOT}/task-retrospectives`;
const STATE_PATH = `${FEEDBACK_ROOT}/state.json`;

export function createHarnessFeedbackService(deps: HarnessFeedbackServiceDeps): HarnessFeedbackService {
  const now = deps.now ?? (() => new Date().toISOString());

  async function getState(repoRoot: string, activeTaskSlug?: string): Promise<HarnessFeedbackStateReport> {
    await maybeDispatchNext(repoRoot, activeTaskSlug);
    return buildStateReport(repoRoot);
  }

  async function startTaskRetrospective(repoRoot: string, input: StartTaskRetrospectiveInput): Promise<HarnessFeedbackStateReport> {
    const taskSlug = input.taskSlug.trim();
    if (!taskSlug) {
      throw new VcmError({
        code: "HARNESS_TASK_REQUIRED",
        message: "Select an active task before reviewing task harness.",
        statusCode: 409
      });
    }

    const state = await loadStoredState(repoRoot);
    if (state) {
      throw new VcmError({
        code: "HARNESS_FEEDBACK_ACTIVE",
        message: "Harness feedback is already active.",
        statusCode: 409,
        hint: "Review, approve, comment, or reject the current Harness feedback before starting Task Harness Retrospective."
      });
    }

    const existingMarker = await loadTaskRetrospectiveMarker(repoRoot, taskSlug);
    if (existingMarker) {
      throw new VcmError({
        code: "TASK_HARNESS_RETROSPECTIVE_EXISTS",
        message: `Task Harness Retrospective has already been triggered for task: ${taskSlug}`,
        statusCode: 409,
        hint: "Review the existing Harness feedback item instead of starting another retrospective for the same task."
      });
    }

    const finalAcceptancePath = path.posix.join(input.handoffDir, "final-acceptance.md");
    const finalAcceptanceAbsolutePath = resolveRepoPath(input.taskRepoRoot, finalAcceptancePath);
    const finalAcceptanceContent = await readAbsoluteOptionalText(finalAcceptanceAbsolutePath);
    const finalAcceptanceCheck = checkMarkdownArtifact("final-acceptance", finalAcceptancePath, finalAcceptanceContent ?? null);
    if (finalAcceptanceCheck.status !== "ok" || !finalAcceptanceContent) {
      throw new VcmError({
        code: "TASK_FINAL_ACCEPTANCE_NOT_READY",
        message: "Task final acceptance is not complete yet.",
        statusCode: 409,
        hint: `${finalAcceptancePath} must pass the final-acceptance artifact check before Task Harness Retrospective can start.`
      });
    }

    const session = await ensureIdleHarnessEngineer(repoRoot, taskSlug);
    const timestamp = now();
    const finalAcceptanceHash = `sha256:${sha256(finalAcceptanceContent)}`;
    const id = sanitizeFeedbackId(`${timestamp}-task-retrospective-${taskSlug}`);
    const feedbackPath = `${ACTIVE_DIR}/${id}/feedback.md`;
    const analysisPath = `${ACTIVE_DIR}/${id}/analysis.md`;
    const applyReportPath = `${ACTIVE_DIR}/${id}/apply-report.md`;
    const active: StoredHarnessFeedbackActive = {
      id,
      title: `Task Harness Retrospective: ${taskSlug}`,
      path: feedbackPath,
      source: "task-retrospective",
      taskSlug,
      summary: "Review the completed task workflow for reusable harness problems.",
      trigger: input.trigger,
      finalAcceptanceHash,
      feedbackPath,
      analysisPath,
      applyReportPath,
      startedAt: timestamp,
      updatedAt: timestamp,
      lastPromptAt: timestamp
    };
    const nextState: StoredHarnessFeedbackState = {
      version: 1,
      status: "analyzing",
      active
    };

    await deps.fs.ensureDir(resolveRepoPath(repoRoot, path.posix.dirname(feedbackPath)));
    await deps.fs.writeText(resolveRepoPath(repoRoot, feedbackPath), renderTaskRetrospectiveFeedback(active, finalAcceptancePath));
    await persistStoredState(repoRoot, nextState);
    await persistTaskRetrospectiveMarker(repoRoot, active, "analyzing");
    await submitTerminalInput(deps.runtime, session.id, buildTaskRetrospectivePrompt(repoRoot, active));
    return buildStateReport(repoRoot);
  }

  async function decide(repoRoot: string, input: HarnessFeedbackDecisionRequest): Promise<HarnessFeedbackStateReport> {
    const state = await loadStoredState(repoRoot);
    if (!state || state.status !== "awaiting_user_approval") {
      throw new VcmError({
        code: "HARNESS_FEEDBACK_NOT_AWAITING_APPROVAL",
        message: "There is no Harness feedback waiting for user approval.",
        statusCode: 409
      });
    }

    if (input.action === "reject") {
      await completeActive(repoRoot, state, "rejected", input.comment);
      await clearStoredState(repoRoot);
      return getState(repoRoot, input.taskSlug);
    }

    const taskSlug = input.taskSlug?.trim();
    if (!taskSlug) {
      throw new VcmError({
        code: "HARNESS_FEEDBACK_TASK_REQUIRED",
        message: "Select an active task before asking Harness Engineer to continue feedback work.",
        statusCode: 409
      });
    }

    if (input.action === "comment") {
      const session = await ensureIdleHarnessEngineer(repoRoot, taskSlug);
      const timestamp = now();
      const nextState: StoredHarnessFeedbackState = {
        ...state,
        status: "analyzing",
        active: {
          ...state.active,
          updatedAt: timestamp,
          lastPromptAt: timestamp
        }
      };
      await persistStoredState(repoRoot, nextState);
      await persistTaskRetrospectiveMarker(repoRoot, nextState.active, "analyzing");
      await submitTerminalInput(deps.runtime, session.id, buildFeedbackCommentPrompt(repoRoot, nextState.active, input.comment ?? ""));
      return buildStateReport(repoRoot);
    }

    const session = await ensureIdleHarnessEngineer(repoRoot, taskSlug);
    const timestamp = now();
    const nextState: StoredHarnessFeedbackState = {
      ...state,
      status: "applying",
      active: {
        ...state.active,
        updatedAt: timestamp,
        lastPromptAt: timestamp
      }
    };
    await persistStoredState(repoRoot, nextState);
    await persistTaskRetrospectiveMarker(repoRoot, nextState.active, "applying");
    await submitTerminalInput(deps.runtime, session.id, buildFeedbackApplyPrompt(repoRoot, nextState.active, input.comment ?? ""));
    return buildStateReport(repoRoot);
  }

  async function recordHarnessEngineerHook(repoRoot: string, eventName: ClaudeHookEventName): Promise<void> {
    if (eventName !== "Stop" && eventName !== "StopFailure") {
      return;
    }
    const state = await loadStoredState(repoRoot);
    if (!state) {
      return;
    }

    const timestamp = now();
    if (state.status === "analyzing") {
      const nextState: StoredHarnessFeedbackState = {
        ...state,
        status: "awaiting_user_approval",
        active: {
          ...state.active,
          updatedAt: timestamp
        }
      };
      await persistStoredState(repoRoot, nextState);
      await persistTaskRetrospectiveMarker(repoRoot, nextState.active, "awaiting_user_approval", timestamp);
      return;
    }

    if (state.status === "applying") {
      await completeActive(repoRoot, {
        ...state,
        active: {
          ...state.active,
          updatedAt: timestamp
        }
      }, "applied");
      await clearStoredState(repoRoot);
    }
  }

  async function assertHarnessEngineerAvailable(repoRoot: string): Promise<void> {
    const state = await loadStoredState(repoRoot);
    if (!state) {
      return;
    }
    throw new VcmError({
      code: "HARNESS_ENGINEER_FEEDBACK_ACTIVE",
      message: "Harness Engineer is reserved for an active Harness feedback item.",
      statusCode: 409,
      hint: state.status === "awaiting_user_approval"
        ? "Review, approve, comment, or reject the current Harness feedback before starting another Harness Engineer task."
        : "Wait for the current Harness feedback turn to finish before starting another Harness Engineer task."
    });
  }

  async function maybeDispatchNext(repoRoot: string, activeTaskSlug?: string): Promise<void> {
    const state = await loadStoredState(repoRoot);
    if (state) {
      return;
    }
    const pending = await listPendingFeedback(repoRoot);
    const next = pending[0];
    const taskSlug = activeTaskSlug?.trim();
    if (!next || !taskSlug) {
      return;
    }

    const session = await getIdleHarnessEngineer(repoRoot, taskSlug);
    if (!session) {
      return;
    }

    const timestamp = now();
    const analysisPath = `${ACTIVE_DIR}/${next.id}/analysis.md`;
    const applyReportPath = `${ACTIVE_DIR}/${next.id}/apply-report.md`;
    const active: StoredHarnessFeedbackActive = {
      ...next,
      feedbackPath: next.path,
      source: next.source ?? "role-feedback",
      analysisPath,
      applyReportPath,
      startedAt: timestamp,
      updatedAt: timestamp,
      lastPromptAt: timestamp
    };
    const nextState: StoredHarnessFeedbackState = {
      version: 1,
      status: "analyzing",
      active
    };
    await persistStoredState(repoRoot, nextState);
    await deps.fs.ensureDir(resolveRepoPath(repoRoot, path.posix.dirname(analysisPath)));
    await submitTerminalInput(deps.runtime, session.id, await buildFeedbackAnalysisPrompt(repoRoot, active));
  }

  async function getIdleHarnessEngineer(repoRoot: string, taskSlug: string): Promise<RoleSessionRecord | undefined> {
    const existing = await deps.sessionService.getProjectHarnessEngineerSession(repoRoot);
    if (existing?.status === "running" && existing.activityStatus === "running") {
      return undefined;
    }
    const session = await deps.sessionService.ensureProjectHarnessEngineerSession(repoRoot, {
      taskSlug,
      cols: 120,
      rows: 32
    });
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

  async function buildStateReport(repoRoot: string): Promise<HarnessFeedbackStateReport> {
    const [state, pending] = await Promise.all([
      loadStoredState(repoRoot),
      listPendingFeedback(repoRoot)
    ]);
    if (!state) {
      return {
        version: 1,
        status: pending.length > 0 ? "queued" : "idle",
        queuedCount: pending.length,
        pending,
        warnings: []
      };
    }

    const active = await readActiveItem(repoRoot, state);
    return {
      version: 1,
      status: state.status,
      queuedCount: Math.max(0, pending.length - (pending.some((item) => item.id === state.active.id) ? 1 : 0)),
      pending: pending.filter((item) => item.id !== state.active.id),
      active,
      warnings: []
    };
  }

  async function readActiveItem(repoRoot: string, state: StoredHarnessFeedbackState): Promise<HarnessFeedbackActiveItem> {
    const feedbackContent = await readOptionalText(repoRoot, state.active.feedbackPath) ?? "";
    const analysisContent = await readOptionalText(repoRoot, state.active.analysisPath);
    const applyReportContent = await readOptionalText(repoRoot, state.active.applyReportPath);
    return {
      id: state.active.id,
      title: state.active.title,
      path: state.active.path,
      source: state.active.source,
      reporterRole: state.active.reporterRole,
      taskSlug: state.active.taskSlug,
      summary: state.active.summary,
      status: state.status,
      startedAt: state.active.startedAt,
      updatedAt: state.active.updatedAt,
      trigger: state.active.trigger,
      finalAcceptanceHash: state.active.finalAcceptanceHash,
      feedbackContent,
      analysisPath: state.active.analysisPath,
      analysisContent,
      applyReportPath: state.active.applyReportPath,
      applyReportContent
    };
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

  async function buildFeedbackAnalysisPrompt(repoRoot: string, active: StoredHarnessFeedbackActive): Promise<string> {
    const feedback = await readOptionalText(repoRoot, active.feedbackPath) ?? "";
    return [
      "[VCM Harness Feedback Analysis]",
      "",
      "Analyze this harness feedback. Do not edit files yet.",
      "",
      `Base repository root: ${repoRoot}`,
      `Feedback file: ${resolveRepoPath(repoRoot, active.feedbackPath)}`,
      `Result path: ${resolveRepoPath(repoRoot, active.analysisPath)}`,
      "",
      "Rules:",
      "- Decide whether the reported issue is a real reusable harness problem.",
      "- Inspect relevant harness files before judging.",
      "- If the issue is not real or does not need a harness change, say so in the result file.",
      "- If it should be fixed, write a short proposal with affected files, proposed diff shape, risks, validation, and whether a VCM GitHub issue is needed.",
      "- Do not edit harness files or product source during this analysis turn.",
      "- End your turn after writing the result file.",
      "",
      "<HARNESS_FEEDBACK>",
      feedback.trimEnd(),
      "</HARNESS_FEEDBACK>"
    ].join("\n");
  }

  function buildTaskRetrospectivePrompt(repoRoot: string, active: StoredHarnessFeedbackActive): string {
    return [
      "[VCM Task Harness Retrospective]",
      "",
      "Review the completed task from the current active task worktree.",
      "",
      `Write the analysis to Result Path: ${resolveRepoPath(repoRoot, active.analysisPath)}`,
      "End your turn after writing the result."
    ].join("\n");
  }

  function buildFeedbackCommentPrompt(repoRoot: string, active: StoredHarnessFeedbackActive, comment: string): string {
    return [
      "[VCM Harness Feedback Revision]",
      "",
      "The user reviewed your harness feedback analysis and added comments.",
      "",
      `Feedback file: ${resolveRepoPath(repoRoot, active.feedbackPath)}`,
      `Current analysis path: ${resolveRepoPath(repoRoot, active.analysisPath)}`,
      `Rewrite the analysis result at: ${resolveRepoPath(repoRoot, active.analysisPath)}`,
      "",
      "Rules:",
      "- Do not edit harness files yet.",
      "- Address the user's comments and keep the proposal concise.",
      "- End your turn after updating the analysis result file.",
      "",
      "<USER_COMMENT>",
      comment.trim(),
      "</USER_COMMENT>"
    ].join("\n");
  }

  function buildFeedbackApplyPrompt(repoRoot: string, active: StoredHarnessFeedbackActive, comment: string): string {
    return [
      "[VCM Harness Feedback Approved]",
      "",
      "The user approved this harness improvement. Apply only the approved harness changes.",
      "",
      `Base repository root: ${repoRoot}`,
      `Feedback file: ${resolveRepoPath(repoRoot, active.feedbackPath)}`,
      `Approved analysis path: ${resolveRepoPath(repoRoot, active.analysisPath)}`,
      `Write completion report to: ${resolveRepoPath(repoRoot, active.applyReportPath)}`,
      "",
      "Rules:",
      "- Work in the active task worktree.",
      "- Edit only harness files and project harness docs that are necessary for the approved change.",
      "- Do not edit product source code.",
      "- Do not overwrite VCM fixed managed blocks; draft an issue instead if a fixed template is wrong.",
      "- Stage the harness changes and create a commit yourself.",
      "- Write the completion report with files changed, commit id if available, validation run, and any follow-up.",
      "- End your turn after the report is written.",
      ...(comment.trim()
        ? ["", "<USER_APPROVAL_COMMENT>", comment.trim(), "</USER_APPROVAL_COMMENT>"]
        : [])
    ].join("\n");
  }

  async function completeActive(
    repoRoot: string,
    state: StoredHarnessFeedbackState,
    outcome: "applied" | "rejected",
    comment = ""
  ): Promise<void> {
    const completedDir = `${COMPLETED_DIR}/${state.active.id}`;
    await deps.fs.ensureDir(resolveRepoPath(repoRoot, completedDir));
    const feedbackContent = await readOptionalText(repoRoot, state.active.feedbackPath);
    const analysisContent = await readOptionalText(repoRoot, state.active.analysisPath);
    const applyReportContent = await readOptionalText(repoRoot, state.active.applyReportPath);
    if (feedbackContent !== undefined) {
      await deps.fs.writeText(resolveRepoPath(repoRoot, `${completedDir}/feedback.md`), feedbackContent);
    }
    if (analysisContent !== undefined) {
      await deps.fs.writeText(resolveRepoPath(repoRoot, `${completedDir}/analysis.md`), analysisContent);
    }
    if (applyReportContent !== undefined) {
      await deps.fs.writeText(resolveRepoPath(repoRoot, `${completedDir}/apply-report.md`), applyReportContent);
    }
    await deps.fs.writeJsonAtomic(resolveRepoPath(repoRoot, `${completedDir}/decision.json`), {
      version: 1,
      id: state.active.id,
      title: state.active.title,
      outcome,
      comment,
      completedAt: now()
    });
    await persistTaskRetrospectiveMarker(repoRoot, state.active, outcome === "rejected" ? "rejected" : "completed");
    await deps.fs.removePath?.(resolveRepoPath(repoRoot, state.active.feedbackPath), { force: true });
    await deps.fs.removePath?.(resolveRepoPath(repoRoot, path.posix.dirname(state.active.analysisPath)), { recursive: true, force: true });
  }

  async function loadStoredState(repoRoot: string): Promise<StoredHarnessFeedbackState | undefined> {
    const statePath = resolveRepoPath(repoRoot, STATE_PATH);
    if (!(await deps.fs.pathExists(statePath))) {
      return undefined;
    }
    const state = await deps.fs.readJson<StoredHarnessFeedbackState>(statePath);
    if (state?.version !== 1 || !state.active?.id || !state.status) {
      return undefined;
    }
    state.active.source = state.active.source ?? "role-feedback";
    return state;
  }

  async function persistStoredState(repoRoot: string, state: StoredHarnessFeedbackState): Promise<void> {
    await deps.fs.writeJsonAtomic(resolveRepoPath(repoRoot, STATE_PATH), state);
  }

  async function clearStoredState(repoRoot: string): Promise<void> {
    await deps.fs.removePath?.(resolveRepoPath(repoRoot, STATE_PATH), { force: true });
  }

  async function readOptionalText(repoRoot: string, relativePath: string): Promise<string | undefined> {
    const absolutePath = resolveRepoPath(repoRoot, relativePath);
    if (!(await deps.fs.pathExists(absolutePath))) {
      return undefined;
    }
    return deps.fs.readText(absolutePath);
  }

  async function readAbsoluteOptionalText(absolutePath: string): Promise<string | undefined> {
    if (!(await deps.fs.pathExists(absolutePath))) {
      return undefined;
    }
    return deps.fs.readText(absolutePath);
  }

  async function loadTaskRetrospectiveMarker(repoRoot: string, taskSlug: string): Promise<unknown | undefined> {
    const markerPath = resolveRepoPath(repoRoot, getTaskRetrospectiveMarkerPath(taskSlug));
    if (!(await deps.fs.pathExists(markerPath))) {
      return undefined;
    }
    return deps.fs.readJson<unknown>(markerPath);
  }

  async function persistTaskRetrospectiveMarker(
    repoRoot: string,
    active: StoredHarnessFeedbackActive,
    status: "analyzing" | "awaiting_user_approval" | "applying" | "completed" | "rejected",
    timestamp = now()
  ): Promise<void> {
    if (active.source !== "task-retrospective" || !active.taskSlug) {
      return;
    }
    await deps.fs.writeJsonAtomic(resolveRepoPath(repoRoot, getTaskRetrospectiveMarkerPath(active.taskSlug)), {
      version: 1,
      taskSlug: active.taskSlug,
      activeId: active.id,
      trigger: active.trigger ?? "manual",
      status,
      finalAcceptanceHash: active.finalAcceptanceHash,
      createdAt: active.startedAt,
      updatedAt: timestamp,
      ...(status === "completed" || status === "rejected" ? { completedAt: timestamp } : {})
    });
  }

  return {
    getState,
    startTaskRetrospective,
    decide,
    recordHarnessEngineerHook,
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

function renderTaskRetrospectiveFeedback(active: StoredHarnessFeedbackActive, finalAcceptancePath: string): string {
  return [
    `# ${active.title}`,
    "",
    `Source: ${active.source}`,
    `Task slug: ${active.taskSlug ?? ""}`,
    `Trigger: ${active.trigger ?? "manual"}`,
    `Final acceptance: ${finalAcceptancePath}`,
    `Final acceptance hash: ${active.finalAcceptanceHash ?? ""}`,
    "",
    "Summary: Review the completed task workflow for reusable harness problems."
  ].join("\n");
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

export function getHarnessFeedbackRelativePath(repoRoot: string, absolutePath: string): string {
  return toRepoRelativePath(repoRoot, absolutePath);
}
