import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  CODE_DIFF_FINDING_SCOPES,
  CODE_DIFF_SOURCES,
  GATE_REVIEW_GATES,
  type CodeDiffFindingScope,
  type CodeDiffSource,
  type GateReviewDecision,
  type GateReviewCallbackStatus,
  type GateReviewCancelRequest,
  type GateReviewExceptionRequest,
  type GateReviewFinding,
  type GateReviewGate,
  type GateReviewGateRecord,
  type GateReviewGateStatus,
  type GateReviewIndex,
  type GateReviewSettingsUpdateRequest,
  type GateReviewReport,
  type GateReviewRequestInput,
  type GateReviewRequestResult,
  type GateReviewSeverity
} from "../../shared/types/gate-review.js";
import type { ArtifactCheckResult } from "../../shared/types/artifact.js";
import { checkMarkdownArtifact, readArtifactSectionValue } from "../../shared/validation/artifact-check.js";
import { VcmError } from "../errors.js";
import { resolveRepoPath } from "../adapters/filesystem.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import type { CommandRunner } from "../adapters/command-runner.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import type { AppGateReviewSettings, AppSettingsService } from "./app-settings-service.js";
import type { ProjectService } from "./project-service.js";
import type { RoundService } from "./round-service.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";
import type { WorkflowControlService } from "./workflow-control-service.js";
import { parseGateReviewReportArtifact } from "./managed-artifact-validation.js";

export interface GateReviewService {
  getState(repoRoot: string, taskSlug: string): Promise<GateReviewIndex>;
  updateSettings(repoRoot: string, taskSlug: string, input: GateReviewSettingsUpdateRequest): Promise<GateReviewIndex>;
  requestReviewGate(repoRoot: string, taskSlug: string, gate: GateReviewGate, input?: GateReviewRequestInput): Promise<GateReviewRequestResult>;
  retryReviewGate(repoRoot: string, taskSlug: string, gate: GateReviewGate): Promise<GateReviewRequestResult>;
  cancelReviewGate(repoRoot: string, taskSlug: string, gate: GateReviewGate, input: GateReviewCancelRequest): Promise<GateReviewIndex>;
  skipReviewGate(repoRoot: string, taskSlug: string, gate: GateReviewGate, input: GateReviewExceptionRequest): Promise<GateReviewIndex>;
  overrideReviewGate(repoRoot: string, taskSlug: string, gate: GateReviewGate, input: GateReviewExceptionRequest): Promise<GateReviewIndex>;
  readReport(repoRoot: string, taskSlug: string, gate: GateReviewGate): Promise<GateReviewReport>;
}

export interface GateReviewServiceDeps {
  fs: FileSystemAdapter;
  runner: CommandRunner;
  runtime: TerminalRuntime;
  projectService: Pick<ProjectService, "loadConfig">;
  taskService: Pick<TaskService, "loadTask">;
  appSettings: Pick<AppSettingsService, "getGateReviewSettings" | "updateGateReviewSettings">;
  sessionService: Pick<
    SessionService,
    "getRoleSession" | "markRoleActivityRunning" | "restartRoleSession" | "resumeRoleSession" | "startRoleSession"
  >;
  roundService: Pick<RoundService, "recordRoleTurnEvent">;
  workflowControlService?: Pick<WorkflowControlService, "getProgress" | "getState">;
  onArchitecturePlanDisposition?: (input: {
    repoRoot: string;
    taskSlug: string;
    accepted: boolean;
  }) => Promise<void> | void;
  reportPollIntervalMs?: number;
  now?: () => string;
}

interface GateReviewRuntimeConfig {
  enabled: boolean;
  requiredGates: GateReviewGate[];
}

interface ReviewContext {
  repoRoot: string;
  taskSlug: string;
  taskRepoRoot: string;
  stateRoot: string;
  handoffDir: string;
  config: GateReviewRuntimeConfig;
}

interface CodeDiffInput {
  baseCommit: string;
  headCommit: string;
  commits: string[];
  commitShas: string[];
  changedFiles: string[];
  diffStat: string;
  diffHash: string;
}

interface ParsedReport extends GateReviewReport {
  decision: GateReviewDecision;
}

interface GateInputSnapshot {
  sourcePath: string;
  snapshotPath?: string;
  status: "captured" | "missing";
}

const REVIEWER_AGENT_PATH = ".claude/agents/reviewer.md";
const GATE_REVIEW_DIR = ".ai/vcm/gate-reviews";
const REQUESTS_DIR = ".ai/vcm/gate-reviews/requests";
const GATE_REVIEW_VERSION = 1;
const HARNESS_COMMIT_PREFIX = "[VCM Harness] ";
const REVIEWER_ROLE = "reviewer";
const DEFAULT_REPORT_POLL_INTERVAL_MS = 1000;
const activeRuns = new Map<string, AbortController>();
const gateStateLocks = new Map<string, Promise<unknown>>();
const SOURCE_ARTIFACTS: Record<GateReviewGate, string[]> = {
  "architecture-plan": [
    ".ai/vcm/handoffs/architecture-brief.md",
    ".ai/vcm/handoffs/architecture-evidence.md",
    ".ai/vcm/handoffs/architecture-plan.md"
  ],
  "validation-adequacy": [
    ".ai/vcm/handoffs/architecture-plan.md",
    ".ai/vcm/handoffs/architect-debug.md",
    ".ai/vcm/handoffs/architecture-diagnosis.md",
    ".ai/vcm/handoffs/test-report.md",
    "docs/TESTING.md"
  ],
  "code-diff": [
    ".ai/vcm/handoffs/test-report.md",
    ".ai/vcm/gate-reviews/validation-adequacy-review.md"
  ]
};

const CODE_DIFF_SOURCE_ARTIFACTS: Record<CodeDiffSource, string[]> = {
  coder: [
    ".ai/vcm/handoffs/architecture-plan.md",
    ".ai/vcm/handoffs/coder-completion.md"
  ],
  "architect-debug": [
    ".ai/vcm/handoffs/role-commands/architect.md",
    ".ai/vcm/handoffs/architect-debug.md"
  ],
  "architect-diagnosis": [
    ".ai/vcm/handoffs/architecture-diagnosis.md"
  ]
};

const CORE_INPUT_ARTIFACTS: Partial<Record<GateReviewGate, string>> = {
  "architecture-plan": ".ai/vcm/handoffs/architecture-plan.md",
  "validation-adequacy": ".ai/vcm/handoffs/test-report.md"
};

const VALID_SEVERITIES = new Set<GateReviewSeverity>(["critical", "high", "medium", "low"]);
const VALID_CODE_DIFF_FINDING_SCOPES = new Set<CodeDiffFindingScope>(CODE_DIFF_FINDING_SCOPES);

export function createGateReviewService(deps: GateReviewServiceDeps): GateReviewService {
  const now = deps.now ?? (() => new Date().toISOString());
  const reportPollIntervalMs = deps.reportPollIntervalMs ?? DEFAULT_REPORT_POLL_INTERVAL_MS;

  async function getContext(repoRoot: string, taskSlug: string): Promise<ReviewContext> {
    const projectConfig = await deps.projectService.loadConfig(repoRoot);
    const task = await deps.taskService.loadTask(repoRoot, taskSlug);
    const taskRepoRoot = getTaskRuntimeRepoRoot(task);
    const reviewSettings = await deps.appSettings.getGateReviewSettings(repoRoot, taskSlug);
    return {
      repoRoot,
      taskSlug,
      taskRepoRoot,
      stateRoot: projectConfig.stateRoot,
      handoffDir: task.handoffDir,
      config: loadRuntimeConfig(reviewSettings)
    };
  }

  async function requestReviewGateInternal(
    repoRoot: string,
    taskSlug: string,
    gate: GateReviewGate,
    options: { force?: boolean; codeDiffSource?: CodeDiffSource } = {}
  ): Promise<GateReviewRequestResult> {
    const context = await getContext(repoRoot, taskSlug);
    return withGateStateLock(context, () => requestReviewGateLocked(context, gate, options));
  }

  async function requestReviewGateLocked(
    context: ReviewContext,
    gate: GateReviewGate,
    options: { force?: boolean; codeDiffSource?: CodeDiffSource }
  ): Promise<GateReviewRequestResult> {
    let index = await loadIndex(deps.fs, context, now());
    const record = index.gates[gate];
    const requestedCodeDiffSource = options.codeDiffSource
      ?? (options.force ? record.codeDiffSource : undefined);
    const codeDiffSource = gate === "code-diff" && isCodeDiffSource(requestedCodeDiffSource)
      ? requestedCodeDiffSource
      : undefined;

    if (!context.config.enabled) {
      index = applyGateState(index, gate, {
        status: "disabled",
        required: false,
        decision: undefined,
        error: undefined
      }, now());
      await saveIndex(deps.fs, context.taskRepoRoot, index);
      await notifyArchitecturePlanDisposition(context, gate, true);
      return { status: "disabled", gate, record: index.gates[gate], message: "Gate review is disabled." };
    }

    if (!record.required) {
      index = applyGateState(index, gate, {
        status: "not_required",
        decision: undefined,
        error: undefined
      }, now());
      await saveIndex(deps.fs, context.taskRepoRoot, index);
      await notifyArchitecturePlanDisposition(context, gate, true);
      return { status: "not_required", gate, record: index.gates[gate], message: "This gate is not required." };
    }

    if (index.activeGate && index.activeGate !== gate) {
      return {
        status: "running",
        gate,
        record,
        message: `Gate review is already running for ${index.activeGate}.`
      };
    }

    if (record.status === "running") {
      return { status: "running", gate, record, message: "Gate review is already running." };
    }

    if (gate === "code-diff" && !codeDiffSource) {
      const message = "code-diff requires --source coder, --source architect-debug, or --source architect-diagnosis.";
      index = applyGateState(index, gate, {
        status: "failed",
        decision: undefined,
        error: message,
        codeDiffSource: undefined,
        codeDiffSources: undefined,
        requestId: undefined,
        requestPath: undefined,
        inputHash: undefined,
        baseCommit: undefined,
        headCommit: undefined,
        commits: undefined,
        changedFiles: undefined,
        diffStat: undefined,
        requestedAt: undefined,
        startedAt: undefined,
        completedAt: now(),
        callbackStatus: "not_sent",
        callbackError: undefined
      }, now(), true);
      await saveIndex(deps.fs, context.taskRepoRoot, index);
      return {
        status: "failed_to_start",
        gate,
        record: index.gates[gate],
        message
      };
    }

    if (gate === "code-diff") {
      const dirtyStatus = await getDirtyCodeDiffStatus(deps.runner, context.taskRepoRoot);
      if (dirtyStatus) {
        const message = `code-diff requires committed inputs; commit or clean these changes first: ${dirtyStatus}`;
        index = applyGateState(index, gate, {
          status: "failed",
          decision: undefined,
          error: message,
          exceptionReason: undefined,
          requestId: undefined,
          requestPath: undefined,
          inputHash: undefined,
          baseCommit: undefined,
          headCommit: undefined,
          commits: undefined,
          changedFiles: undefined,
          diffStat: undefined,
          codeDiffSource,
          codeDiffSources: codeDiffSource ? [codeDiffSource] : undefined,
          requestedAt: undefined,
          startedAt: undefined,
          completedAt: now(),
          callbackStatus: "not_sent",
          callbackError: undefined
        }, now(), true);
        await saveIndex(deps.fs, context.taskRepoRoot, index);
        return {
          status: "failed_to_start",
          gate,
          record: index.gates[gate],
          message
        };
      }
    }

    if (gate === "architecture-plan") {
      const architectureBriefError = await readArchitectureBriefError(deps.fs, context.taskRepoRoot);
      if (architectureBriefError) {
        index = applyGateState(index, gate, {
          status: "failed",
          decision: undefined,
          error: architectureBriefError,
          exceptionReason: undefined,
          requestId: undefined,
          requestPath: undefined,
          inputHash: undefined,
          requestedAt: undefined,
          startedAt: undefined,
          completedAt: now(),
          callbackStatus: "not_sent",
          callbackError: undefined
        }, now(), true);
        await saveIndex(deps.fs, context.taskRepoRoot, index);
        return {
          status: "failed_to_start",
          gate,
          record: index.gates[gate],
          message: architectureBriefError
        };
      }
      const architectureEvidenceError = await readArchitectureEvidenceError(deps.fs, context.taskRepoRoot);
      if (architectureEvidenceError) {
        index = applyGateState(index, gate, {
          status: "failed",
          decision: undefined,
          error: architectureEvidenceError,
          exceptionReason: undefined,
          requestId: undefined,
          requestPath: undefined,
          inputHash: undefined,
          requestedAt: undefined,
          startedAt: undefined,
          completedAt: now(),
          callbackStatus: "not_sent",
          callbackError: undefined
        }, now(), true);
        await saveIndex(deps.fs, context.taskRepoRoot, index);
        return {
          status: "failed_to_start",
          gate,
          record: index.gates[gate],
          message: architectureEvidenceError
        };
      }
    }

    const coreInput = await readCoreInputArtifact(deps.fs, context.taskRepoRoot, gate);
    if (coreInput && coreInput.status !== "ready") {
      index = applyGateState(index, gate, {
        status: "not_required",
        decision: undefined,
        error: undefined,
        exceptionReason: undefined,
        requestId: undefined,
        requestPath: undefined,
        inputHash: undefined,
        requestedAt: undefined,
        startedAt: undefined,
        completedAt: undefined,
        callbackStatus: "not_sent",
        callbackError: undefined
      }, now(), true);
      await saveIndex(deps.fs, context.taskRepoRoot, index);
      return {
        status: "not_required",
        gate,
        record: index.gates[gate],
        message: `${coreInput.path} is ${coreInput.status}.`
      };
    }

    if (gate === "architecture-plan") {
      const architecturePlanError = await readArchitecturePlanError(deps.fs, context.taskRepoRoot);
      if (architecturePlanError) {
        index = applyGateState(index, gate, {
          status: "failed",
          decision: undefined,
          error: architecturePlanError,
          exceptionReason: undefined,
          requestId: undefined,
          requestPath: undefined,
          inputHash: undefined,
          requestedAt: undefined,
          startedAt: undefined,
          completedAt: now(),
          callbackStatus: "not_sent",
          callbackError: undefined
        }, now(), true);
        await saveIndex(deps.fs, context.taskRepoRoot, index);
        return {
          status: "failed_to_start",
          gate,
          record: index.gates[gate],
          message: architecturePlanError
        };
      }
    }

    if (gate === "validation-adequacy") {
      const validationReportError = await readValidationReportError(deps.fs, context.taskRepoRoot);
      if (validationReportError) {
        index = applyGateState(index, gate, {
          status: "failed",
          decision: undefined,
          error: validationReportError,
          exceptionReason: undefined,
          requestId: undefined,
          requestPath: undefined,
          inputHash: undefined,
          requestedAt: undefined,
          startedAt: undefined,
          completedAt: now(),
          callbackStatus: "not_sent",
          callbackError: undefined
        }, now(), true);
        await saveIndex(deps.fs, context.taskRepoRoot, index);
        return {
          status: "failed_to_start",
          gate,
          record: index.gates[gate],
          message: validationReportError
        };
      }
    }

    if (gate === "code-diff") {
      const evidenceError = await readCodeDiffEvidenceError(deps.fs, context.taskRepoRoot, codeDiffSource);
      if (evidenceError) {
        index = await recordCodeDiffStartFailure(index, context, gate, codeDiffSource, evidenceError);
        return {
          status: "failed_to_start",
          gate,
          record: index.gates[gate],
          message: evidenceError
        };
      }
    }

    const codeDiffInput = gate === "code-diff"
      ? await resolveCodeDiffInput(deps, context, record)
      : undefined;
    if (gate === "code-diff" && (!codeDiffInput || codeDiffInput.commits.length === 0)) {
      index = applyGateState(index, gate, {
        status: "not_required",
        decision: undefined,
        error: undefined,
        exceptionReason: undefined,
        requestId: undefined,
        requestPath: undefined,
        inputHash: undefined,
        baseCommit: codeDiffInput?.baseCommit,
        headCommit: codeDiffInput?.headCommit,
        commits: codeDiffInput?.commits,
        changedFiles: codeDiffInput?.changedFiles,
        diffStat: codeDiffInput?.diffStat,
        codeDiffSource,
        codeDiffSources: codeDiffSource ? [codeDiffSource] : undefined,
        requestedAt: undefined,
        startedAt: undefined,
        completedAt: codeDiffInput ? now() : undefined,
        callbackStatus: "not_sent",
        callbackError: undefined
      }, now(), true);
      await saveIndex(deps.fs, context.taskRepoRoot, index);
      return {
        status: "not_required",
        gate,
        record: index.gates[gate],
        message: codeDiffInput ? "No non-Harness commits to review." : "No new commits to review."
      };
    }

    if (gate === "code-diff") {
      const prerequisiteError = await readCodeDiffValidationGateError(deps, context, index);
      if (prerequisiteError) {
        index = await recordCodeDiffStartFailure(index, context, gate, codeDiffSource, prerequisiteError, codeDiffInput);
        return {
          status: "failed_to_start",
          gate,
          record: index.gates[gate],
          message: prerequisiteError
        };
      }
    }

    async function recordCodeDiffStartFailure(
      currentIndex: GateReviewIndex,
      currentContext: ReviewContext,
      currentGate: GateReviewGate,
      currentSource: CodeDiffSource | undefined,
      message: string,
      currentCodeDiffInput?: CodeDiffInput
    ): Promise<GateReviewIndex> {
      const failedIndex = applyGateState(currentIndex, currentGate, {
        status: "failed",
        decision: undefined,
        error: message,
        exceptionReason: undefined,
        requestId: undefined,
        requestPath: undefined,
        inputHash: undefined,
        baseCommit: currentCodeDiffInput?.baseCommit,
        headCommit: currentCodeDiffInput?.headCommit,
        commits: currentCodeDiffInput?.commits,
        changedFiles: currentCodeDiffInput?.changedFiles,
        diffStat: currentCodeDiffInput?.diffStat,
        codeDiffSource: currentSource,
        codeDiffSources: currentSource ? [currentSource] : undefined,
        requestedAt: undefined,
        startedAt: undefined,
        completedAt: now(),
        callbackStatus: "not_sent",
        callbackError: undefined
      }, now(), true);
      await saveIndex(deps.fs, currentContext.taskRepoRoot, failedIndex);
      return failedIndex;
    }

    const currentCodeDiffSources = gate === "code-diff" && codeDiffSource
      ? await resolveWorkflowCodeDiffSources(deps, context, codeDiffSource)
      : undefined;
    const codeDiffSources = gate === "code-diff" && codeDiffInput && currentCodeDiffSources
      ? resolveCodeDiffSources(record, codeDiffInput, currentCodeDiffSources)
      : undefined;
    const inputHash = await computeInputHash(deps, context.taskRepoRoot, gate, codeDiffInput, codeDiffSources);
    if (
      !options.force
      && record.status === "completed"
      && record.decision === "approve"
      && record.inputHash === inputHash
    ) {
      await notifyArchitecturePlanDisposition(context, gate, true);
      return {
        status: "already_approved",
        gate,
        record,
        message: "Gate review already approved the current inputs."
      };
    }

    const timestamp = now();
    const requestId = createRequestId(gate);
    const requestPath = path.posix.join(REQUESTS_DIR, `${requestId}.json`);
    const promptPath = path.posix.join(REQUESTS_DIR, `${requestId}.prompt.md`);
    const requestReportPath = reportPathForRequest(requestId);
    const inputSnapshots = await captureGateInputSnapshots(
      deps.fs,
      context.taskRepoRoot,
      requestId,
      getSourceArtifacts(gate, codeDiffSources)
    );
    const nextRecord: GateReviewGateRecord = {
      ...record,
      status: "running",
      decision: undefined,
      error: undefined,
      exceptionReason: undefined,
      requestId,
      requestPath,
      promptPath,
      inputHash,
      baseCommit: codeDiffInput?.baseCommit,
      headCommit: codeDiffInput?.headCommit,
      commits: codeDiffInput?.commits,
      changedFiles: codeDiffInput?.changedFiles,
      diffStat: codeDiffInput?.diffStat,
      codeDiffSource,
      codeDiffSources,
      requestedAt: timestamp,
      startedAt: undefined,
      completedAt: undefined,
      callbackStatus: "not_sent",
      callbackError: undefined,
      updatedAt: timestamp
    };
    index = {
      ...index,
      activeGate: gate,
      gates: {
        ...index.gates,
        [gate]: nextRecord
      },
      updatedAt: timestamp
    };
    await deps.fs.writeJsonAtomic(resolveRepoPath(context.taskRepoRoot, requestPath), {
      version: GATE_REVIEW_VERSION,
      requestId,
      gate,
      status: "requested",
      requestedAt: timestamp,
      inputHash,
      codeDiffSource,
      codeDiffSources,
      codeDiff: codeDiffInput,
      inputSnapshots,
      reportPath: requestReportPath,
      latestReportPath: nextRecord.reportPath,
      promptPath: nextRecord.promptPath
    });
    await saveIndex(deps.fs, context.taskRepoRoot, index);
    await notifyArchitecturePlanDisposition(context, gate, false);

    void runGateReview(context, gate, requestId, codeDiffInput, codeDiffSources, inputSnapshots).catch(() => {
      // runGateReview records failures in the persisted gate state.
    });

    return {
      status: "started",
      gate,
      record: nextRecord,
      message: "Gate review started."
    };
  }

  async function runGateReview(
    context: ReviewContext,
    gate: GateReviewGate,
    requestId: string,
    codeDiffInput?: CodeDiffInput,
    codeDiffSources?: CodeDiffSource[],
    inputSnapshots: GateInputSnapshot[] = []
  ): Promise<void> {
    const runKey = gateRunKey(context, gate, requestId);
    if (activeRuns.has(runKey)) {
      return;
    }
    const controller = new AbortController();
    activeRuns.set(runKey, controller);
    try {
      const timestamp = now();
      if (!(await markGateRunStarted(context, gate, requestId, timestamp))) {
        return;
      }
      throwIfGateRunCancelled(controller.signal);

      const reviewDir = resolveRepoPath(context.taskRepoRoot, GATE_REVIEW_DIR);
      const agentPath = resolveRepoPath(context.repoRoot, REVIEWER_AGENT_PATH);
      const prompt = buildGatePrompt(context, gate, requestId, codeDiffInput, codeDiffSources, inputSnapshots);
      await deps.fs.ensureDir(reviewDir);
      await deps.fs.ensureDir(resolveRepoPath(context.taskRepoRoot, REQUESTS_DIR));
      await deps.fs.writeText(resolveRepoPath(context.taskRepoRoot, promptPathForRequest(requestId)), prompt);
      throwIfGateRunCancelled(controller.signal);

      if (!(await deps.fs.pathExists(agentPath))) {
        throw new VcmError({
          code: "GATE_REVIEW_AGENT_MISSING",
          message: `${REVIEWER_AGENT_PATH} does not exist.`,
          statusCode: 409,
          hint: "Apply the VCM harness before requesting Gate Review Gates."
        });
      }

      const session = await ensureReviewerSession(context);
      throwIfGateRunCancelled(controller.signal);
      await submitTerminalInput(deps.runtime, session.id, prompt);
      await deps.sessionService.markRoleActivityRunning(
        context.repoRoot,
        context.taskSlug,
        REVIEWER_ROLE,
        session.id
      );
      await deps.roundService.recordRoleTurnEvent({
        repoRoot: context.repoRoot,
        stateRepoRoot: context.taskRepoRoot,
        stateRoot: context.stateRoot,
        taskSlug: context.taskSlug,
        role: REVIEWER_ROLE,
        eventName: "UserPromptSubmit"
      });

      const parsed = await waitForGateReport(
        deps.fs,
        context.taskRepoRoot,
        gate,
        requestId,
        now(),
        reportPollIntervalMs,
        controller.signal
      );
      const completedRecord = await completeGateRun(context, gate, requestId, parsed);
      if (!completedRecord) {
        return;
      }
      await notifyArchitecturePlanDisposition(
        context,
        gate,
        parsed.decision === "approve"
      );
      await callbackProjectManager(
        context,
        gate,
        "completed",
        parsed.decision,
        parsed.reportPath,
        undefined,
        requestId,
        completedRecord.inputHash
      );
    } catch (error) {
      if (isGateRunCancelled(error)) {
        return;
      }
      const message = errorMessage(error);
      const failedRecord = await failGateRun(context, gate, requestId, message);
      if (!failedRecord) {
        return;
      }
      await notifyArchitecturePlanDisposition(context, gate, false);
      await callbackProjectManager(
        context,
        gate,
        "failed",
        undefined,
        reportPathForRequest(requestId),
        message,
        requestId,
        failedRecord.inputHash
      );
    } finally {
      if (activeRuns.get(runKey) === controller) {
        activeRuns.delete(runKey);
      }
    }
  }

  async function markGateRunStarted(
    context: ReviewContext,
    gate: GateReviewGate,
    requestId: string,
    timestamp: string
  ): Promise<boolean> {
    return withGateStateLock(context, async () => {
      const index = await loadIndex(deps.fs, context, timestamp);
      if (!isCurrentRunningRequest(index, gate, requestId)) {
        return false;
      }
      await updateRequestStatus(deps.fs, context, requestId, "running", { startedAt: timestamp });
      const next = applyGateState(index, gate, {
        status: "running",
        startedAt: timestamp,
        updatedAt: timestamp
      }, timestamp);
      await saveIndex(deps.fs, context.taskRepoRoot, next);
      return true;
    });
  }

  async function completeGateRun(
    context: ReviewContext,
    gate: GateReviewGate,
    requestId: string,
    parsed: ParsedReport
  ): Promise<GateReviewGateRecord | undefined> {
    return withGateStateLock(context, async () => {
      const completedAt = now();
      const index = await loadIndex(deps.fs, context, completedAt);
      if (!isCurrentRunningRequest(index, gate, requestId)) {
        await updateRequestStatus(deps.fs, context, requestId, "stale_completion", {
          completedAt,
          decision: parsed.decision,
          summary: parsed.summary,
          findings: parsed.findings,
          reportPath: parsed.reportPath
        });
        return undefined;
      }

      await publishLatestGateReport(deps.fs, context.taskRepoRoot, gate, parsed.content);
      await updateRequestStatus(deps.fs, context, requestId, "completed", {
        completedAt,
        decision: parsed.decision,
        summary: parsed.summary,
        findings: parsed.findings,
        reportPath: parsed.reportPath,
        latestReportPath: reportPathForGate(gate)
      });
      const next = applyGateState(index, gate, {
        status: "completed",
        decision: parsed.decision,
        summary: parsed.summary,
        findings: parsed.findings,
        error: undefined,
        completedAt,
        callbackStatus: "not_sent",
        callbackError: undefined,
        updatedAt: completedAt
      }, completedAt, true);
      await saveIndex(deps.fs, context.taskRepoRoot, next);
      return next.gates[gate];
    });
  }

  async function failGateRun(
    context: ReviewContext,
    gate: GateReviewGate,
    requestId: string,
    message: string
  ): Promise<GateReviewGateRecord | undefined> {
    return withGateStateLock(context, async () => {
      const completedAt = now();
      const index = await loadIndex(deps.fs, context, completedAt);
      if (!isCurrentRunningRequest(index, gate, requestId)) {
        await updateRequestStatus(deps.fs, context, requestId, "stale_completion", {
          completedAt,
          error: message
        });
        return undefined;
      }

      await updateRequestStatus(deps.fs, context, requestId, "failed", {
        completedAt,
        error: message
      });
      const next = applyGateState(index, gate, {
        status: "failed",
        error: message,
        completedAt,
        callbackStatus: "not_sent",
        callbackError: undefined,
        updatedAt: completedAt
      }, completedAt, true);
      await saveIndex(deps.fs, context.taskRepoRoot, next);
      return next.gates[gate];
    });
  }

  async function ensureReviewerSession(context: ReviewContext) {
    const existing = await deps.sessionService.getRoleSession(context.repoRoot, context.taskSlug, REVIEWER_ROLE);
    if (existing?.status === "running" && deps.runtime.getSession(existing.id)) {
      return existing;
    }

    if (existing?.claudeSessionId) {
      try {
        return await deps.sessionService.resumeRoleSession(context.repoRoot, context.taskSlug, REVIEWER_ROLE, {
          cols: 100,
          rows: 28,
          model: "default"
        });
      } catch {
        // Fall through to a fresh Reviewer terminal if the saved session cannot be resumed.
      }
    }

    return deps.sessionService.startRoleSession(context.repoRoot, context.taskSlug, REVIEWER_ROLE, {
      cols: 100,
      rows: 28,
      model: "default"
    });
  }

  async function callbackProjectManager(
    context: ReviewContext,
    gate: GateReviewGate,
    status: GateReviewGateStatus,
    decision: GateReviewDecision | undefined,
    reportPath: string,
    error?: string,
    requestId?: string,
    inputHash?: string
  ): Promise<void> {
    if (!(await gateStateMatches(context, gate, status, requestId))) {
      return;
    }
    const session = await deps.sessionService.getRoleSession(context.repoRoot, context.taskSlug, "project-manager");
    if (!session || session.status !== "running") {
      await updateGateCallbackState(context, gate, status, requestId, {
        callbackStatus: "skipped",
        callbackError: "project-manager session is not running",
        updatedAt: now()
      });
      return;
    }

    const prompt = renderProjectManagerCallback({
      taskSlug: context.taskSlug,
      gate,
      status,
      decision,
      reportPath,
      error,
      requestId,
      inputHash
    });

    try {
      await submitTerminalInput(deps.runtime, session.id, prompt);
      await deps.sessionService.markRoleActivityRunning(
        context.repoRoot,
        context.taskSlug,
        "project-manager",
        session.id
      );
      await deps.roundService.recordRoleTurnEvent({
        repoRoot: context.repoRoot,
        stateRepoRoot: context.taskRepoRoot,
        stateRoot: context.stateRoot,
        taskSlug: context.taskSlug,
        role: "project-manager",
        eventName: "UserPromptSubmit"
      });
      await updateGateCallbackState(context, gate, status, requestId, {
        callbackStatus: "sent",
        callbackError: undefined,
        updatedAt: now()
      });
    } catch (caught) {
      await updateGateCallbackState(context, gate, status, requestId, {
        callbackStatus: "failed",
        callbackError: errorMessage(caught),
        updatedAt: now()
      });
    }
  }

  async function gateStateMatches(
    context: ReviewContext,
    gate: GateReviewGate,
    expectedStatus: GateReviewGateStatus,
    requestId?: string
  ): Promise<boolean> {
    return withGateStateLock(context, async () => {
      const index = await loadIndex(deps.fs, context, now());
      const record = index.gates[gate];
      return record.status === expectedStatus
        && (requestId === undefined || record.requestId === requestId);
    });
  }

  async function updateGateCallbackState(
    context: ReviewContext,
    gate: GateReviewGate,
    expectedStatus: GateReviewGateStatus,
    requestId: string | undefined,
    patch: Partial<GateReviewGateRecord>
  ): Promise<void> {
    await withGateStateLock(context, async () => {
      const timestamp = now();
      const index = await loadIndex(deps.fs, context, timestamp);
      const record = index.gates[gate];
      if (record.status !== expectedStatus || (requestId !== undefined && record.requestId !== requestId)) {
        return;
      }
      const next = applyGateState(index, gate, patch, timestamp);
      await saveIndex(deps.fs, context.taskRepoRoot, next);
    });
  }

  async function notifyArchitecturePlanDisposition(
    context: ReviewContext,
    gate: GateReviewGate,
    accepted: boolean
  ): Promise<void> {
    if (gate !== "architecture-plan" || !deps.onArchitecturePlanDisposition) {
      return;
    }
    try {
      await deps.onArchitecturePlanDisposition({
        repoRoot: context.repoRoot,
        taskSlug: context.taskSlug,
        accepted
      });
    } catch {
      // Gate state remains authoritative even if the deferred session restart cannot run yet.
    }
  }

  return {
    async getState(repoRoot, taskSlug) {
      const context = await getContext(repoRoot, taskSlug);
      return loadIndex(deps.fs, context, now());
    },
    async updateSettings(repoRoot, taskSlug, input) {
      const context = await getContext(repoRoot, taskSlug);
      return withGateStateLock(context, async () => {
        const timestamp = now();
        const currentIndex = await loadIndex(deps.fs, context, timestamp);
        const currentSettings = await deps.appSettings.getGateReviewSettings(repoRoot, taskSlug);
        const requiredGates = new Set(currentSettings.requiredGates);
        for (const [gate, enabled] of Object.entries(input?.gates ?? {})) {
          if (!isGateReviewGate(gate)) {
            continue;
          }
          if (!enabled && currentIndex.gates[gate].status === "running") {
            throw new VcmError({
              code: "GATE_REVIEW_RUNNING",
              message: `Cannot disable ${gate} while its Gate Review request is running.`,
              statusCode: 409,
              hint: "Cancel the running request first, then disable this Gate."
            });
          }
          if (enabled) {
            requiredGates.add(gate);
          } else {
            requiredGates.delete(gate);
          }
        }
        const settings = await deps.appSettings.updateGateReviewSettings(repoRoot, taskSlug, [...requiredGates]);
        const nextContext = {
          ...context,
          config: loadRuntimeConfig(settings)
        };
        const index = await loadIndex(deps.fs, nextContext, timestamp);
        const next = {
          ...index,
          updatedAt: timestamp
        };
        await saveIndex(deps.fs, nextContext.taskRepoRoot, next);
        return next;
      });
    },
    requestReviewGate(repoRoot, taskSlug, gate, input) {
      return requestReviewGateInternal(repoRoot, taskSlug, gate, {
        codeDiffSource: input?.codeDiffSource
      });
    },
    retryReviewGate(repoRoot, taskSlug, gate) {
      return requestReviewGateInternal(repoRoot, taskSlug, gate, { force: true });
    },
    async cancelReviewGate(repoRoot, taskSlug, gate, input) {
      const context = await getContext(repoRoot, taskSlug);
      assertCancelRequest(input);
      return withGateStateLock(context, async () => {
        const timestamp = now();
        const index = await loadIndex(deps.fs, context, timestamp);
        const record = index.gates[gate];
        if (record.status !== "running") {
          throw new VcmError({
            code: "GATE_REVIEW_NOT_RUNNING",
            message: `Gate review ${gate} is not running.`,
            statusCode: 409
          });
        }
        if (record.requestId !== input.requestId) {
          throw new VcmError({
            code: "GATE_REVIEW_REQUEST_MISMATCH",
            message: `Gate review ${gate} is running request ${record.requestId ?? "unknown"}, not ${input.requestId}.`,
            statusCode: 409,
            hint: "Refresh Gate Review state before cancelling the current request."
          });
        }

        activeRuns.get(gateRunKey(context, gate, input.requestId))?.abort();
        await deps.sessionService.restartRoleSession(context.repoRoot, context.taskSlug, REVIEWER_ROLE);
        await updateRequestStatus(deps.fs, context, input.requestId, "cancelled", {
          completedAt: timestamp,
          cancelReason: input.reason.trim()
        });
        const next = applyGateState(index, gate, {
          status: "pending",
          decision: undefined,
          summary: undefined,
          findings: undefined,
          error: undefined,
          exceptionReason: undefined,
          requestId: undefined,
          requestPath: undefined,
          inputHash: undefined,
          baseCommit: undefined,
          headCommit: undefined,
          commits: undefined,
          changedFiles: undefined,
          diffStat: undefined,
          codeDiffSource: undefined,
          codeDiffSources: undefined,
          requestedAt: undefined,
          startedAt: undefined,
          completedAt: undefined,
          callbackStatus: "not_sent",
          callbackError: undefined,
          updatedAt: timestamp
        }, timestamp, true);
        await saveIndex(deps.fs, context.taskRepoRoot, next);
        return next;
      });
    },
    async skipReviewGate(repoRoot, taskSlug, gate, input) {
      const context = await getContext(repoRoot, taskSlug);
      assertExceptionReason(input.reason);
      const index = await withGateStateLock(context, async () => {
        const timestamp = now();
        const current = await loadIndex(deps.fs, context, timestamp);
        if (current.gates[gate].status === "running") {
          throw new VcmError({
            code: "GATE_REVIEW_RUNNING",
            message: "Cannot skip a running Gate review gate.",
            statusCode: 409,
            hint: "Cancel the running request first, then choose retry, skip, or override."
          });
        }
        const next = applyGateState(current, gate, {
          status: "skipped",
          decision: undefined,
          exceptionReason: input.reason,
          error: undefined,
          completedAt: timestamp,
          callbackStatus: "not_sent",
          callbackError: undefined,
          updatedAt: timestamp
        }, timestamp, true);
        await saveIndex(deps.fs, context.taskRepoRoot, next);
        return next;
      });
      await notifyArchitecturePlanDisposition(context, gate, true);
      await callbackProjectManager(context, gate, "skipped", undefined, index.gates[gate].reportPath);
      return loadIndex(deps.fs, context, now());
    },
    async overrideReviewGate(repoRoot, taskSlug, gate, input) {
      const context = await getContext(repoRoot, taskSlug);
      assertExceptionReason(input.reason);
      const index = await withGateStateLock(context, async () => {
        const timestamp = now();
        const current = await loadIndex(deps.fs, context, timestamp);
        if (current.gates[gate].status === "running") {
          throw new VcmError({
            code: "GATE_REVIEW_RUNNING",
            message: "Cannot override a running Gate review gate.",
            statusCode: 409,
            hint: "Cancel the running request first, then choose retry, skip, or override."
          });
        }
        const next = applyGateState(current, gate, {
          status: "overridden",
          decision: "approve",
          exceptionReason: input.reason,
          error: undefined,
          completedAt: timestamp,
          callbackStatus: "not_sent",
          callbackError: undefined,
          updatedAt: timestamp
        }, timestamp, true);
        await saveIndex(deps.fs, context.taskRepoRoot, next);
        return next;
      });
      await notifyArchitecturePlanDisposition(context, gate, true);
      await callbackProjectManager(context, gate, "overridden", "approve", index.gates[gate].reportPath);
      return loadIndex(deps.fs, context, now());
    },
    async readReport(repoRoot, taskSlug, gate) {
      const context = await getContext(repoRoot, taskSlug);
      return parseGateReport(
        deps.fs,
        context.taskRepoRoot,
        gate,
        undefined,
        now(),
        reportPathForGate(gate)
      );
    }
  };
}

export function isGateReviewGate(value: string): value is GateReviewGate {
  return GATE_REVIEW_GATES.includes(value as GateReviewGate);
}

function loadRuntimeConfig(reviewSettings: AppGateReviewSettings): GateReviewRuntimeConfig {
  return {
    enabled: reviewSettings.enabled,
    requiredGates: reviewSettings.requiredGates
  };
}

async function loadIndex(fs: FileSystemAdapter, context: ReviewContext, timestamp: string): Promise<GateReviewIndex> {
  const indexPath = getIndexPath(context.taskRepoRoot);
  const raw = await readJsonOrNull<Partial<GateReviewIndex>>(fs, indexPath);
  return normalizeIndex(raw, context.config, timestamp);
}

function normalizeIndex(
  raw: Partial<GateReviewIndex> | null,
  config: GateReviewRuntimeConfig,
  timestamp: string
): GateReviewIndex {
  const existingGates = raw?.gates && typeof raw.gates === "object"
    ? raw.gates as Partial<Record<GateReviewGate, Partial<GateReviewGateRecord>>>
    : {};
  const gates = {} as Record<GateReviewGate, GateReviewGateRecord>;
  const requiredSet = new Set(config.enabled ? config.requiredGates : []);

  for (const gate of GATE_REVIEW_GATES) {
    const existing = existingGates[gate] as Partial<GateReviewGateRecord> | undefined;
    const required = requiredSet.has(gate);
    const fallbackStatus: GateReviewGateStatus = config.enabled
      ? required ? "pending" : "not_required"
      : "disabled";
    const existingStatus = normalizeGateStatus(existing?.status);
    const status = config.enabled && required
      ? (existingStatus === "disabled" ? "pending" : existingStatus ?? fallbackStatus)
      : fallbackStatus;

    gates[gate] = {
      gate,
      required,
      status,
      decision: normalizeDecision(existing?.decision),
      reportPath: reportPathForGate(gate),
      promptPath: promptPathForGate(gate),
      requestId: typeof existing?.requestId === "string" ? existing.requestId : undefined,
      requestPath: typeof existing?.requestPath === "string" ? existing.requestPath : undefined,
      inputHash: typeof existing?.inputHash === "string" ? existing.inputHash : undefined,
      baseCommit: typeof existing?.baseCommit === "string" ? existing.baseCommit : undefined,
      headCommit: typeof existing?.headCommit === "string" ? existing.headCommit : undefined,
      commits: Array.isArray(existing?.commits) ? existing.commits.filter(isString) : undefined,
      changedFiles: Array.isArray(existing?.changedFiles) ? existing.changedFiles.filter(isString) : undefined,
      diffStat: typeof existing?.diffStat === "string" ? existing.diffStat : undefined,
      codeDiffSource: isCodeDiffSource(existing?.codeDiffSource) ? existing.codeDiffSource : undefined,
      codeDiffSources: normalizeCodeDiffSources(existing?.codeDiffSources, existing?.codeDiffSource),
      summary: typeof existing?.summary === "string" ? existing.summary : undefined,
      findings: Array.isArray(existing?.findings) ? existing.findings.filter(isFinding) : undefined,
      error: typeof existing?.error === "string" ? existing.error : undefined,
      exceptionReason: typeof existing?.exceptionReason === "string" ? existing.exceptionReason : undefined,
      requestedAt: typeof existing?.requestedAt === "string" ? existing.requestedAt : undefined,
      startedAt: typeof existing?.startedAt === "string" ? existing.startedAt : undefined,
      completedAt: typeof existing?.completedAt === "string" ? existing.completedAt : undefined,
      updatedAt: typeof existing?.updatedAt === "string" ? existing.updatedAt : timestamp,
      callbackStatus: normalizeCallbackStatus(existing?.callbackStatus),
      callbackError: typeof existing?.callbackError === "string" ? existing.callbackError : undefined
    };
  }

  const activeGate = isGateReviewGate(String(raw?.activeGate)) && gates[raw?.activeGate as GateReviewGate].status === "running"
    ? raw?.activeGate as GateReviewGate
    : null;

  return {
    version: GATE_REVIEW_VERSION,
    enabled: config.enabled,
    activeGate,
    gates,
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : timestamp
  };
}

function applyGateState(
  index: GateReviewIndex,
  gate: GateReviewGate,
  patch: Partial<GateReviewGateRecord>,
  timestamp: string,
  clearActiveGate = false
): GateReviewIndex {
  const record = {
    ...index.gates[gate],
    ...patch,
    gate,
    updatedAt: patch.updatedAt ?? timestamp
  };
  return {
    ...index,
    activeGate: clearActiveGate && index.activeGate === gate
      ? null
      : patch.status === "running" ? gate : index.activeGate,
    gates: {
      ...index.gates,
      [gate]: record
    },
    updatedAt: timestamp
  };
}

function isCurrentRunningRequest(
  index: GateReviewIndex,
  gate: GateReviewGate,
  requestId: string
): boolean {
  const record = index.gates[gate];
  return record.status === "running" && record.requestId === requestId;
}

function gateRunKey(context: ReviewContext, gate: GateReviewGate, requestId: string): string {
  return `${context.taskRepoRoot}:${context.taskSlug}:${gate}:${requestId}`;
}

async function withGateStateLock<T>(context: ReviewContext, run: () => Promise<T>): Promise<T> {
  const key = getIndexPath(context.taskRepoRoot);
  const previous = gateStateLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  gateStateLocks.set(key, next);
  try {
    return await next;
  } finally {
    if (gateStateLocks.get(key) === next) {
      gateStateLocks.delete(key);
    }
  }
}

async function saveIndex(fs: FileSystemAdapter, taskRepoRoot: string, index: GateReviewIndex): Promise<void> {
  await fs.writeJsonAtomic(getIndexPath(taskRepoRoot), index);
}

async function getDirtyCodeDiffStatus(runner: CommandRunner, taskRepoRoot: string): Promise<string | undefined> {
  const status = splitLines(await commandStdout(runner, taskRepoRoot, ["status", "--porcelain=v1"]));
  if (status.length === 0) {
    return undefined;
  }
  const visible = status.slice(0, 8).join("; ");
  return status.length > 8
    ? `${visible}; ... ${status.length - 8} more`
    : visible;
}

async function resolveCodeDiffInput(
  deps: Pick<GateReviewServiceDeps, "runner">,
  context: ReviewContext,
  record: GateReviewGateRecord
): Promise<CodeDiffInput | undefined> {
  const headCommit = (await commandStdout(deps.runner, context.taskRepoRoot, ["rev-parse", "HEAD"])).trim();
  if (!headCommit) {
    throw new VcmError({
      code: "GATE_REVIEW_CODE_DIFF_HEAD_MISSING",
      message: "Unable to resolve current task worktree HEAD for code-diff gate.",
      statusCode: 409
    });
  }

  const baseCommit = await resolveCodeDiffBaseCommit(deps, context, record, headCommit);
  if (!baseCommit || baseCommit === headCommit) {
    return undefined;
  }

  const range = `${baseCommit}..${headCommit}`;
  const allCommits = splitLines(await commandStdout(deps.runner, context.taskRepoRoot, [
    "log",
    "--oneline",
    "--reverse",
    range
  ]));
  if (allCommits.length === 0) {
    return undefined;
  }

  const commits = allCommits.filter((line) => !isHarnessCommitLine(line));
  const commitShas = commits.map(commitShaFromOneline);
  const changedFiles = new Set<string>();
  const diffStats: string[] = [];
  const diffs: string[] = [];
  for (const commitSha of commitShas) {
    for (const changedFile of splitLines(await commandStdout(deps.runner, context.taskRepoRoot, [
      "show",
      "--format=",
      "--name-only",
      "--find-renames",
      commitSha
    ]))) {
      changedFiles.add(changedFile);
    }
    const stat = await commandStdout(deps.runner, context.taskRepoRoot, [
      "show",
      "--format=",
      "--stat",
      "--find-renames",
      commitSha
    ]);
    if (stat.trim()) {
      diffStats.push(stat.trim());
    }
    const patch = await commandStdout(deps.runner, context.taskRepoRoot, [
      "show",
      "--format=",
      "--binary",
      "--find-renames",
      commitSha
    ]);
    if (patch) {
      diffs.push(patch);
    }
  }
  const diffStat = diffStats.join("\n");
  const diff = diffs.join("\n");
  const diffHash = createHash("sha256").update(diff).digest("hex");

  return {
    baseCommit,
    headCommit,
    commits,
    commitShas,
    changedFiles: [...changedFiles],
    diffStat,
    diffHash
  };
}

function commitShaFromOneline(line: string): string {
  return line.split(/\s+/, 1)[0] ?? line;
}

function isHarnessCommitLine(line: string): boolean {
  const separator = line.indexOf(" ");
  return separator >= 0 && line.slice(separator + 1).startsWith(HARNESS_COMMIT_PREFIX);
}

async function resolveCodeDiffBaseCommit(
  deps: Pick<GateReviewServiceDeps, "runner">,
  context: ReviewContext,
  record: GateReviewGateRecord,
  headCommit: string
): Promise<string | undefined> {
  if (
    record.gate === "code-diff"
    && record.status === "failed"
    && record.baseCommit
    && await isAncestor(deps.runner, context.taskRepoRoot, record.baseCommit, headCommit)
  ) {
    return record.baseCommit;
  }

  if (
    record.gate === "code-diff"
    && record.status === "completed"
    && record.decision === "request_changes"
    && record.baseCommit
    && await isAncestor(deps.runner, context.taskRepoRoot, record.baseCommit, headCommit)
  ) {
    return record.baseCommit;
  }

  if (
    record.gate === "code-diff"
    && record.status === "completed"
    && record.decision === "approve"
    && record.headCommit
    && await isAncestor(deps.runner, context.taskRepoRoot, record.headCommit, headCommit)
  ) {
    return record.headCommit;
  }

  if (
    record.gate === "code-diff"
    && record.status === "not_required"
    && record.headCommit
    && await isAncestor(deps.runner, context.taskRepoRoot, record.headCommit, headCommit)
  ) {
    return record.headCommit;
  }

  const rootHead = (await commandStdout(deps.runner, context.repoRoot, ["rev-parse", "HEAD"])).trim();
  if (
    rootHead
    && rootHead !== headCommit
    && await isAncestor(deps.runner, context.taskRepoRoot, rootHead, headCommit)
  ) {
    return rootHead;
  }

  const rootBranch = (await commandStdout(deps.runner, context.repoRoot, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD"
  ])).trim();
  if (rootBranch && rootBranch !== "HEAD") {
    const mergeBase = (await commandStdout(deps.runner, context.taskRepoRoot, [
      "merge-base",
      "HEAD",
      rootBranch
    ])).trim();
    if (
      mergeBase
      && mergeBase !== headCommit
      && await isAncestor(deps.runner, context.taskRepoRoot, mergeBase, headCommit)
    ) {
      return mergeBase;
    }
  }

  const upstream = (await commandStdout(deps.runner, context.taskRepoRoot, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}"
  ])).trim();
  if (upstream) {
    const mergeBase = (await commandStdout(deps.runner, context.taskRepoRoot, [
      "merge-base",
      "HEAD",
      upstream
    ])).trim();
    if (
      mergeBase
      && mergeBase !== headCommit
      && await isAncestor(deps.runner, context.taskRepoRoot, mergeBase, headCommit)
    ) {
      return mergeBase;
    }
  }

  return headCommit;
}

async function isAncestor(
  runner: CommandRunner,
  cwd: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  const result = await runner.run("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd });
  return result.exitCode === 0;
}

async function computeInputHash(
  deps: Pick<GateReviewServiceDeps, "fs" | "runner">,
  taskRepoRoot: string,
  gate: GateReviewGate,
  codeDiffInput?: CodeDiffInput,
  codeDiffSources?: CodeDiffSource[]
): Promise<string> {
  const digest = createHash("sha256");
  const coreArtifact = CORE_INPUT_ARTIFACTS[gate];
  if (coreArtifact) {
    digest.update(coreArtifact);
    digest.update(await deps.fs.readText(resolveRepoPath(taskRepoRoot, coreArtifact)));
  }

  const common = gate === "code-diff" ? [] : [
    "CLAUDE.md",
    ".claude/agents/architect.md",
    ".claude/agents/coder.md",
    ".claude/agents/reviewer.md",
    ".claude/agents/tester.md",
    ".claude/skills/vcm-gate-review/SKILL.md",
    ".ai/tools/request-gate-review",
    "docs/CODING_STANDARDS.md"
  ];

  const sourceArtifacts = getSourceArtifacts(gate, codeDiffSources);
  for (const relativePath of new Set([...common, ...sourceArtifacts].filter((item) => item !== coreArtifact))) {
    digest.update(relativePath);
    const absolutePath = resolveRepoPath(taskRepoRoot, relativePath);
    if (await deps.fs.pathExists(absolutePath)) {
      digest.update(await deps.fs.readText(absolutePath));
    } else {
      digest.update("<missing>");
    }
  }

  if (gate === "code-diff" && codeDiffInput) {
    digest.update("codeDiffSources");
    digest.update(codeDiffSources?.join("\n") ?? "<missing>");
    digest.update("commits");
    digest.update(codeDiffInput.commits.join("\n"));
    digest.update("changedFiles");
    digest.update(codeDiffInput.changedFiles.join("\n"));
    digest.update("diffHash");
    digest.update(codeDiffInput.diffHash);
  }

  if (gate === "architecture-plan") {
    const evidencePathspec = ["--", ".", ":(exclude).ai/vcm/**"];
    digest.update("head");
    digest.update(await commandStdout(deps.runner, taskRepoRoot, ["rev-parse", "HEAD"]));
    digest.update("workingDiff");
    digest.update(await commandStdout(deps.runner, taskRepoRoot, ["diff", "--binary", ...evidencePathspec]));
    digest.update("stagedDiff");
    digest.update(await commandStdout(deps.runner, taskRepoRoot, ["diff", "--cached", "--binary", ...evidencePathspec]));
    const untracked = splitLines(await commandStdout(deps.runner, taskRepoRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      ...evidencePathspec
    ]));
    for (const relativePath of untracked) {
      digest.update("untracked");
      digest.update(relativePath);
      digest.update(await commandStdout(deps.runner, taskRepoRoot, ["hash-object", "--", relativePath]));
    }
  }

  if (gate === "validation-adequacy") {
    const evidencePathspec = ["--", ".", ":(exclude).ai/vcm/**", ":(exclude)docs/**"];
    digest.update("trackedEvidence");
    digest.update(await commandStdout(deps.runner, taskRepoRoot, ["ls-files", "-s", ...evidencePathspec]));
    digest.update("workingEvidence");
    digest.update(await commandStdout(deps.runner, taskRepoRoot, ["diff", "--binary", ...evidencePathspec]));
    digest.update("stagedEvidence");
    digest.update(await commandStdout(deps.runner, taskRepoRoot, ["diff", "--cached", "--binary", ...evidencePathspec]));
    const untracked = splitLines(await commandStdout(deps.runner, taskRepoRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      ...evidencePathspec
    ]));
    for (const relativePath of untracked) {
      digest.update("untrackedEvidence");
      digest.update(relativePath);
      digest.update(await commandStdout(deps.runner, taskRepoRoot, ["hash-object", "--", relativePath]));
    }
  }

  return digest.digest("hex");
}

async function readCoreInputArtifact(
  fs: FileSystemAdapter,
  taskRepoRoot: string,
  gate: GateReviewGate
): Promise<{ path: string; status: "missing" | "empty" | "ready" } | null> {
  const relativePath = CORE_INPUT_ARTIFACTS[gate];
  if (!relativePath) {
    return null;
  }
  const absolutePath = resolveRepoPath(taskRepoRoot, relativePath);
  if (!await fs.pathExists(absolutePath)) {
    return { path: relativePath, status: "missing" };
  }
  const content = await fs.readText(absolutePath);
  if (content.trim().length === 0) {
    return { path: relativePath, status: "empty" };
  }
  return { path: relativePath, status: "ready" };
}

async function readArchitectureBriefError(
  fs: FileSystemAdapter,
  taskRepoRoot: string
): Promise<string | undefined> {
  const relativePath = ".ai/vcm/handoffs/architecture-brief.md";
  const absolutePath = resolveRepoPath(taskRepoRoot, relativePath);
  const content = await fs.pathExists(absolutePath) ? await fs.readText(absolutePath) : null;
  if (content === null) return `${relativePath} is missing. Complete Architect Interview before architecture planning.`;
  const status = /^\s*Architecture Brief Status\s*:\s*(.+?)\s*$/im.exec(content)?.[1]?.trim();
  if (status?.toLowerCase() !== "confirmed") {
    return `${relativePath} is not confirmed and cannot start architecture-plan review. `
      + `Architecture Brief Status must be exactly "confirmed"; found ${renderFoundValue(status)}.`;
  }
  const check = checkMarkdownArtifact("architecture-brief", relativePath, content);
  if (check.status !== "ok") {
    return `${relativePath} is incomplete and cannot start architecture-plan review. ${formatArtifactCheckFailure(check)}`;
  }
  return undefined;
}

async function readValidationReportError(
  fs: FileSystemAdapter,
  taskRepoRoot: string
): Promise<string | undefined> {
  const relativePath = CORE_INPUT_ARTIFACTS["validation-adequacy"];
  if (!relativePath) {
    return undefined;
  }
  const absolutePath = resolveRepoPath(taskRepoRoot, relativePath);
  const content = await fs.pathExists(absolutePath) ? await fs.readText(absolutePath) : null;
  const check = checkMarkdownArtifact("test-report", relativePath, content);
  if (check.status !== "ok") {
    return `${relativePath} is incomplete and cannot start validation-adequacy review. `
      + formatValidationArtifactFailure(check, content);
  }
  const infrastructureStatus = matchField(
    extractMarkdownSection(content ?? "", "Test Infrastructure") ?? "",
    "Status"
  );
  if (infrastructureStatus === "repair-required") {
    return `${relativePath} cannot start validation-adequacy review while Test Infrastructure Status is repair-required. Route Tester repair first.`;
  }
  if (infrastructureStatus === "production-change-required") {
    return `${relativePath} cannot start validation-adequacy review while Test Infrastructure Status is production-change-required. Route the active flow's implementation-failure branch first.`;
  }
  return undefined;
}

async function readCodeDiffEvidenceError(
  fs: FileSystemAdapter,
  taskRepoRoot: string,
  source: CodeDiffSource | undefined
): Promise<string | undefined> {
  const reportError = await readValidationReportError(fs, taskRepoRoot);
  if (reportError) {
    return "code-diff requires completed Tester validation. " + reportError;
  }
  return readCodeDiffSourceArtifactError(fs, taskRepoRoot, source);
}

async function readCodeDiffValidationGateError(
  deps: Pick<GateReviewServiceDeps, "fs" | "runner">,
  context: ReviewContext,
  index: GateReviewIndex
): Promise<string | undefined> {
  const validationGate = index.gates["validation-adequacy"];
  if (validationGate.required && validationGate.status !== "skipped" && validationGate.status !== "overridden") {
    if (validationGate.status !== "completed" || validationGate.decision !== "approve") {
      return "code-diff requires the validation-adequacy Gate to complete successfully for the current Tester evidence.";
    }

    const currentValidationHash = await computeInputHash(
      deps,
      context.taskRepoRoot,
      "validation-adequacy"
    );
    if (!validationGate.inputHash || validationGate.inputHash !== currentValidationHash) {
      return "code-diff requires a current validation-adequacy approval; code or test evidence changed after the recorded approval.";
    }
  }

  return undefined;
}

async function readArchitectureEvidenceError(
  fs: FileSystemAdapter,
  taskRepoRoot: string
): Promise<string | undefined> {
  const relativePath = ".ai/vcm/handoffs/architecture-evidence.md";
  const absolutePath = resolveRepoPath(taskRepoRoot, relativePath);
  const content = await fs.pathExists(absolutePath) ? await fs.readText(absolutePath) : null;
  const check = checkMarkdownArtifact("architecture-evidence", relativePath, content);
  if (check.status !== "ok") {
    return `${relativePath} is incomplete and cannot start architecture-plan review. ${formatArtifactCheckFailure(check)}`;
  }
  return undefined;
}

async function readArchitecturePlanError(
  fs: FileSystemAdapter,
  taskRepoRoot: string
): Promise<string | undefined> {
  const relativePath = ".ai/vcm/handoffs/architecture-plan.md";
  const absolutePath = resolveRepoPath(taskRepoRoot, relativePath);
  const content = await fs.pathExists(absolutePath) ? await fs.readText(absolutePath) : null;
  const check = checkMarkdownArtifact("architecture-plan", relativePath, content);
  return check.status === "ok"
    ? undefined
    : `${relativePath} is incomplete and cannot start architecture-plan review. ${formatArtifactCheckFailure(check)}`;
}

async function readCodeDiffSourceArtifactError(
  fs: FileSystemAdapter,
  taskRepoRoot: string,
  source: CodeDiffSource | undefined
): Promise<string | undefined> {
  if (!source) {
    return "code-diff requires a production-code source.";
  }
  const sourceArtifacts = {
    coder: ["coder-completion", ".ai/vcm/handoffs/coder-completion.md", "ready_for_review"],
    "architect-debug": ["architect-debug", ".ai/vcm/handoffs/architect-debug.md", "completed"],
    "architect-diagnosis": ["architecture-diagnosis", ".ai/vcm/handoffs/architecture-diagnosis.md", "diagnosis implementation completed"]
  } as const;
  const [kind, relativePath, terminalValue] = sourceArtifacts[source];
  const absolutePath = resolveRepoPath(taskRepoRoot, relativePath);
  const content = await fs.pathExists(absolutePath) ? await fs.readText(absolutePath) : null;
  const check = checkMarkdownArtifact(kind, relativePath, content);
  if (check.status !== "ok") {
    return `code-diff requires a complete ${relativePath}. ${formatArtifactCheckFailure(check)}`;
  }
  const value = kind === "architecture-diagnosis"
    ? readArtifactSectionValue(content ?? "", "Final Disposition")?.toLowerCase()
    : matchField(content ?? "", kind === "coder-completion" ? "Decision" : "Status");
  if (value !== terminalValue) {
    return `code-diff requires ${relativePath} to report ${terminalValue}; found ${renderFoundValue(value)}.`;
  }
  return undefined;
}

async function commandStdout(runner: CommandRunner, cwd: string, args: string[]): Promise<string> {
  const result = await runner.run("git", args, { cwd });
  return result.exitCode === 0 ? result.stdout : "";
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildGatePrompt(
  context: ReviewContext,
  gate: GateReviewGate,
  requestId: string,
  codeDiffInput?: CodeDiffInput,
  codeDiffSources?: CodeDiffSource[],
  inputSnapshots: GateInputSnapshot[] = []
): string {
  const reportPath = reportPathForRequest(requestId);
  const absoluteReportPath = resolveRepoPath(context.taskRepoRoot, reportPath);
  const evidence = getSourceArtifacts(gate, codeDiffSources)
    .map((relativePath) => `- ${relativePath}`)
    .join("\n");
  const capturedEvidence = inputSnapshots.length > 0
    ? `

Captured Task Evidence:
${inputSnapshots.map((snapshot) => snapshot.status === "captured"
    ? `- ${snapshot.sourcePath} -> ${snapshot.snapshotPath}`
    : `- ${snapshot.sourcePath} -> <missing at request time>`).join("\n")}

Use each captured snapshot as the immutable handoff or prior-Gate input for this request. Do not substitute a later rewritten live artifact.`
    : "";
  const gitLine = gate === "architecture-plan"
    ? "\nDiff: inspect git status/diff in Worktree."
    : "";
  const architectureContract = gate === "architecture-plan"
    ? "\n\nComplete every Architecture Analysis field required by the Reviewer role with concrete current-worktree evidence before deciding."
    : "";
  const validationContract = gate === "validation-adequacy"
    ? "\n\nComplete every Validation Analysis field required by the Reviewer role with concrete current-worktree production and test evidence before deciding."
    : "";
  const codeDiffContract = gate === "code-diff"
    ? "\n\nComplete every Code Diff Analysis field required by the Reviewer role with concrete evidence from the named commit range before deciding."
    : "";
  const codeDiffSection = gate === "code-diff" && codeDiffInput
    ? `

Code Diff Input:
This code-diff gate reviews the new commits from one PM route flow, not the whole task and not one terminal turn.
Code sources: ${codeDiffSources?.join(" -> ") ?? "<missing>"}
Reviewable commits:
${codeDiffInput.commits.map((line) => `- ${line}`).join("\n")}
Changed files:
${codeDiffInput.changedFiles.length > 0 ? codeDiffInput.changedFiles.map((line) => `- ${line}`).join("\n") : "- <none>"}
Diff commands:
${codeDiffInput.commitShas.flatMap((commitSha) => [
    `- git show --stat --oneline ${commitSha}`,
    `- git show --find-renames ${commitSha}`
  ]).join("\n")}
Review only these commits.`
    : "";

  return `[VCM GATE REVIEW]
Task: ${context.taskSlug}
Worktree: ${context.taskRepoRoot}
Gate: ${gate}
Request: ${requestId}
Report: ${absoluteReportPath}
Submit: .ai/tools/vcm-artifact gate-review-report --file <candidate> --path ${reportPath} --mode final

Evidence:
${evidence}${capturedEvidence}${gitLine}${architectureContract}${validationContract}${codeDiffContract}${codeDiffSection}

Write only the candidate Report and submit it with the command above. Start exactly:
Gate: ${gate}
Request: ${requestId}
Decision: approve|request_changes
Summary: <one or two sentences>
[/VCM GATE REVIEW]`;
}

async function captureGateInputSnapshots(
  fs: FileSystemAdapter,
  taskRepoRoot: string,
  requestId: string,
  sourcePaths: string[]
): Promise<GateInputSnapshot[]> {
  const snapshots: GateInputSnapshot[] = [];
  for (const sourcePath of new Set(sourcePaths.filter(isTaskEvidencePath))) {
    const absoluteSourcePath = resolveRepoPath(taskRepoRoot, sourcePath);
    if (!(await fs.pathExists(absoluteSourcePath))) {
      snapshots.push({ sourcePath, status: "missing" });
      continue;
    }

    const snapshotPath = inputSnapshotPathForRequest(requestId, sourcePath);
    await fs.writeText(
      resolveRepoPath(taskRepoRoot, snapshotPath),
      await fs.readText(absoluteSourcePath)
    );
    snapshots.push({ sourcePath, snapshotPath, status: "captured" });
  }
  return snapshots;
}

function isTaskEvidencePath(sourcePath: string): boolean {
  return sourcePath.startsWith(".ai/vcm/handoffs/")
    || sourcePath.startsWith(".ai/vcm/gate-reviews/");
}

async function waitForGateReport(
  fs: FileSystemAdapter,
  taskRepoRoot: string,
  gate: GateReviewGate,
  requestId: string,
  timestamp: string,
  intervalMs: number,
  signal: AbortSignal
): Promise<ParsedReport> {
  const reportPath = reportPathForRequest(requestId);
  while (true) {
    throwIfGateRunCancelled(signal);
    try {
      return await parseGateReport(fs, taskRepoRoot, gate, requestId, timestamp, reportPath);
    } catch (error) {
      if (!isPendingReportError(error)) {
        throw error;
      }
    }
    await delay(intervalMs);
  }
}

async function parseGateReport(
  fs: FileSystemAdapter,
  taskRepoRoot: string,
  gate: GateReviewGate,
  requestId: string | undefined,
  timestamp: string,
  reportPath: string
): Promise<ParsedReport> {
  const absolutePath = resolveRepoPath(taskRepoRoot, reportPath);
  if (!(await fs.pathExists(absolutePath))) {
    throw new VcmError({
      code: "GATE_REVIEW_REPORT_MISSING",
      message: `Gate review report was not written: ${reportPath}`,
      statusCode: 500
    });
  }

  const content = await fs.readText(absolutePath);
  const validation = parseGateReviewReportArtifact(content, {
    expectedGate: gate,
    expectedRequestId: requestId
  });
  if (!validation.parsed || validation.errors.length > 0) {
    throw new VcmError({
      code: gateReportErrorCode(validation.errors),
      message: `Gate review report is invalid: ${validation.errors.join(" ")}`,
      statusCode: 500
    });
  }
  if (gate === "validation-adequacy") {
    if (validation.parsed.decision === "approve") {
      await validateValidationApprovalInput(fs, taskRepoRoot);
    }
  }

  return {
    gate,
    requestId: validation.parsed.requestId,
    decision: validation.parsed.decision,
    summary: validation.parsed.summary,
    findings: validation.parsed.findings,
    reportPath,
    content,
    parsedAt: timestamp
  };
}

function gateReportErrorCode(errors: string[]): string {
  const message = errors.join(" ");
  if (/Architecture Analysis must appear exactly once/.test(message)) return "GATE_REVIEW_ARCHITECTURE_ANALYSIS_MISSING";
  if (/Architecture Analysis field/.test(message)) return "GATE_REVIEW_ARCHITECTURE_ANALYSIS_INCOMPLETE";
  if (/Validation Analysis must appear exactly once/.test(message)) return "GATE_REVIEW_VALIDATION_ANALYSIS_MISSING";
  if (/Validation Analysis field/.test(message)) return "GATE_REVIEW_VALIDATION_ANALYSIS_INCOMPLETE";
  if (/Code Diff Analysis must appear exactly once/.test(message)) return "GATE_REVIEW_CODE_DIFF_ANALYSIS_MISSING";
  if (/Code Diff Analysis field/.test(message)) return "GATE_REVIEW_CODE_DIFF_ANALYSIS_INCOMPLETE";
  if (/Finding Scope|field File|field Line Or Symbol/.test(message)) {
    return "GATE_REVIEW_CODE_DIFF_FINDING_LOCATION_MISSING";
  }
  if (/field Evidence|field Expected|field Gap|field Risk/.test(message)) return "GATE_REVIEW_FINDING_INCOMPLETE";
  if (/requires at least one structured finding/.test(message)) return "GATE_REVIEW_FINDINGS_MISSING";
  if (/Decision must/.test(message)) return "GATE_REVIEW_DECISION_MISSING";
  if (/Gate must/.test(message)) return "GATE_REVIEW_REPORT_GATE_MISMATCH";
  if (/Request must/.test(message)) return "GATE_REVIEW_REPORT_STALE";
  return "GATE_REVIEW_REPORT_INVALID";
}

async function validateValidationApprovalInput(
  fs: FileSystemAdapter,
  taskRepoRoot: string
): Promise<void> {
  const relativePath = CORE_INPUT_ARTIFACTS["validation-adequacy"];
  if (!relativePath) {
    return;
  }
  const absolutePath = resolveRepoPath(taskRepoRoot, relativePath);
  const content = await fs.pathExists(absolutePath) ? await fs.readText(absolutePath) : null;
  const check = checkMarkdownArtifact("test-report", relativePath, content);
  if (check.status === "ok") {
    return;
  }

  throw new VcmError({
    code: "GATE_REVIEW_VALIDATION_INPUT_INCOMPLETE",
    message: `Validation-adequacy cannot approve incomplete Tester evidence in ${relativePath}. `
      + formatValidationArtifactFailure(check, content),
    statusCode: 500
  });
}

function formatValidationArtifactFailure(
  check: ArtifactCheckResult,
  content: string | null
): string {
  return /^\s*Test Result\s*:\s*incomplete\s*$/im.test(content ?? "")
    ? 'Test Result must be exactly one of "pass|fail"; found "incomplete".'
    : formatArtifactCheckFailure(check);
}

function formatArtifactCheckFailure(check: ArtifactCheckResult): string {
  const details = [
    check.status === "missing" ? "Artifact is missing." : "",
    check.status === "empty" ? "Artifact is empty." : "",
    check.missingHeadings.length > 0
      ? `Missing headings: ${check.missingHeadings.join(", ")}.`
      : "",
    ...check.invalidFields,
    check.hasPlaceholder ? "Replace every standalone TBD, Not run yet, or draft-status placeholder." : ""
  ].filter(Boolean);
  return details.length > 0
    ? details.join(" ")
    : "Artifact is not in a gate-ready terminal state.";
}

function renderFoundValue(value: string | undefined): string {
  return value && value.trim().length > 0 ? JSON.stringify(value.trim()) : "<missing>";
}

function extractMarkdownSection(content: string, heading: string): string | undefined {
  const match = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, "im").exec(content);
  if (!match || match.index === undefined) {
    return undefined;
  }
  const remainder = content.slice(match.index + match[0].length);
  const nextHeading = remainder.search(/^##\s+/m);
  const section = (nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder).trim();
  return section || undefined;
}

async function updateRequestStatus(
  fs: FileSystemAdapter,
  context: ReviewContext,
  requestId: string,
  status: string,
  patch: Record<string, unknown>
): Promise<void> {
  const requestPath = resolveRepoPath(context.taskRepoRoot, path.posix.join(REQUESTS_DIR, `${requestId}.json`));
  const current = await readJsonOrNull<Record<string, unknown>>(fs, requestPath) ?? {
    version: GATE_REVIEW_VERSION,
    requestId
  };
  await fs.writeJsonAtomic(requestPath, {
    ...current,
    ...patch,
    status,
    updatedAt: new Date().toISOString()
  });
}

async function publishLatestGateReport(
  fs: FileSystemAdapter,
  taskRepoRoot: string,
  gate: GateReviewGate,
  content: string
): Promise<void> {
  const latestPath = resolveRepoPath(taskRepoRoot, reportPathForGate(gate));
  if (fs.writeTextAtomic) {
    await fs.writeTextAtomic(latestPath, content);
    return;
  }
  await fs.writeText(latestPath, content);
}

function reportPathForGate(gate: GateReviewGate): string {
  return path.posix.join(GATE_REVIEW_DIR, `${gate}-review.md`);
}

function reportPathForRequest(requestId: string): string {
  return path.posix.join(REQUESTS_DIR, `${requestId}.report.md`);
}

function promptPathForRequest(requestId: string): string {
  return path.posix.join(REQUESTS_DIR, `${requestId}.prompt.md`);
}

function inputSnapshotPathForRequest(requestId: string, sourcePath: string): string {
  const taskEvidencePath = sourcePath.replace(/^\.ai\/vcm\//, "");
  return path.posix.join(REQUESTS_DIR, `${requestId}.inputs`, taskEvidencePath);
}

function promptPathForGate(gate: GateReviewGate): string {
  return path.posix.join(GATE_REVIEW_DIR, "prompts", `${gate}-gate.md`);
}

function getIndexPath(taskRepoRoot: string): string {
  return resolveRepoPath(taskRepoRoot, path.posix.join(GATE_REVIEW_DIR, "index.json"));
}

function createRequestId(gate: GateReviewGate): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${gate}-${randomUUID().slice(0, 8)}`;
}

async function readJsonOrNull<T>(fs: FileSystemAdapter, targetPath: string): Promise<T | null> {
  try {
    if (!(await fs.pathExists(targetPath))) {
      return null;
    }
    return await fs.readJson<T>(targetPath);
  } catch {
    return null;
  }
}

function matchField(content: string, field: string): string | undefined {
  const match = content.match(new RegExp(`^\\s*(?:[-*]\\s*)?${escapeRegex(field)}\\s*:\\s*(.+?)\\s*$`, "mi"));
  return match?.[1]?.trim();
}

function getSourceArtifacts(gate: GateReviewGate, codeDiffSources?: CodeDiffSource[]): string[] {
  if (gate !== "code-diff") {
    return SOURCE_ARTIFACTS[gate];
  }
  return [...new Set([
    ...SOURCE_ARTIFACTS["code-diff"],
    ...(codeDiffSources ?? []).flatMap((source) => CODE_DIFF_SOURCE_ARTIFACTS[source])
  ])];
}

function resolveCodeDiffSources(
  record: GateReviewGateRecord,
  codeDiffInput: CodeDiffInput,
  currentSources: CodeDiffSource[]
): CodeDiffSource[] {
  const continuingRecordedRange = record.baseCommit === codeDiffInput.baseCommit
    && (
      (record.status === "completed" && record.decision === "request_changes")
      || record.status === "failed"
    );
  if (!continuingRecordedRange) {
    return currentSources;
  }
  return [...new Set([
    ...(normalizeCodeDiffSources(record.codeDiffSources, record.codeDiffSource) ?? []),
    ...currentSources
  ])];
}

async function resolveWorkflowCodeDiffSources(
  deps: Pick<GateReviewServiceDeps, "workflowControlService">,
  context: ReviewContext,
  currentSource: CodeDiffSource
): Promise<CodeDiffSource[]> {
  if (!deps.workflowControlService) {
    return [currentSource];
  }
  try {
    const workflowContext = {
      taskRepoRoot: context.taskRepoRoot,
      stateRoot: context.stateRoot,
      handoffDir: context.handoffDir,
      taskSlug: context.taskSlug
    };
    const [state, progress] = await Promise.all([
      deps.workflowControlService.getState(workflowContext),
      deps.workflowControlService.getProgress(workflowContext)
    ]);
    const startedAtSequence = state.flowRun?.startedAtSequence;
    if (state.warnings.length > 0 || startedAtSequence === undefined) {
      return [currentSource];
    }
    const sources: CodeDiffSource[] = [];
    for (const entry of progress.history) {
      if (entry.sequence < startedAtSequence) continue;
      if (entry.flow === "code-change" && entry.targetRole === "coder") {
        sources.push("coder");
      } else if (entry.flow === "architect-debug" && entry.targetRole === "architect") {
        sources.push("architect-debug");
      } else if (entry.flow === "architecture-diagnosis" && entry.targetRole === "architect") {
        sources.push("architect-diagnosis");
      }
    }
    sources.push(currentSource);
    return [...new Set(sources)];
  } catch {
    return [currentSource];
  }
}

function normalizeCodeDiffSources(sources: unknown, source: unknown): CodeDiffSource[] | undefined {
  const normalized = Array.isArray(sources) ? sources.filter(isCodeDiffSource) : [];
  if (normalized.length === 0 && isCodeDiffSource(source)) {
    normalized.push(source);
  }
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

export function isCodeDiffSource(value: unknown): value is CodeDiffSource {
  return typeof value === "string" && CODE_DIFF_SOURCES.includes(value as CodeDiffSource);
}

function normalizeGateStatus(value: unknown): GateReviewGateStatus | undefined {
  return typeof value === "string" && [
    "disabled",
    "not_required",
    "pending",
    "running",
    "completed",
    "failed",
    "skipped",
    "overridden"
  ].includes(value)
    ? value as GateReviewGateStatus
    : undefined;
}

function normalizeDecision(value: unknown): GateReviewDecision | undefined {
  return value === "approve" || value === "request_changes" ? value : undefined;
}

function normalizeSeverity(value: unknown): GateReviewSeverity | undefined {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  return VALID_SEVERITIES.has(normalized as GateReviewSeverity)
    ? normalized as GateReviewSeverity
    : undefined;
}

function normalizeCodeDiffFindingScope(value: unknown): CodeDiffFindingScope | undefined {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  return VALID_CODE_DIFF_FINDING_SCOPES.has(normalized as CodeDiffFindingScope)
    ? normalized as CodeDiffFindingScope
    : undefined;
}

function normalizeCallbackStatus(value: unknown): GateReviewCallbackStatus | undefined {
  return value === "not_sent" || value === "sent" || value === "skipped" || value === "failed"
    ? value
    : undefined;
}

function isFinding(value: unknown): value is GateReviewFinding {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as GateReviewFinding;
  return Boolean(normalizeSeverity(candidate.severity) && candidate.title);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function assertExceptionReason(reason: string | undefined): void {
  if (!reason?.trim()) {
    throw new VcmError({
      code: "GATE_REVIEW_REASON_REQUIRED",
      message: "A reason is required.",
      statusCode: 400
    });
  }
}

function assertCancelRequest(input: GateReviewCancelRequest | undefined): asserts input is GateReviewCancelRequest {
  if (!input?.requestId?.trim()) {
    throw new VcmError({
      code: "GATE_REVIEW_REQUEST_ID_REQUIRED",
      message: "The current Gate Review request ID is required.",
      statusCode: 400
    });
  }
  assertExceptionReason(input.reason);
}

class GateReviewRunCancelledError extends Error {
  constructor() {
    super("Gate Review run was cancelled.");
    this.name = "GateReviewRunCancelledError";
  }
}

function throwIfGateRunCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new GateReviewRunCancelledError();
  }
}

function isGateRunCancelled(error: unknown): error is GateReviewRunCancelledError {
  return error instanceof GateReviewRunCancelledError;
}

function renderProjectManagerCallback(input: {
  taskSlug: string;
  gate: GateReviewGate;
  status: GateReviewGateStatus;
  decision?: GateReviewDecision;
  reportPath: string;
  error?: string;
  requestId?: string;
  inputHash?: string;
}): string {
  const lines = [
    "[VCM GATE REVIEW CALLBACK]",
    `task: ${input.taskSlug}`,
    `gate: ${input.gate}`,
    `status: ${input.status}`,
    `decision: ${input.decision ?? "none"}`,
    `request_id: ${input.requestId ?? "none"}`,
    `input_hash: ${input.inputHash ?? "none"}`,
    `report: ${input.reportPath}`,
    ...(input.error ? [`error: ${input.error}`] : []),
    "",
    "Use the vcm-gate-review skill to handle this callback.",
    "If status is completed and decision is approve, continue the VCM flow.",
    "If decision is request_changes, analyze the report and route follow-up through the normal VCM roles.",
    "If status is failed, stop and ask the user to retry, skip, or override in VCM.",
    "[/VCM GATE REVIEW CALLBACK]"
  ];
  return lines.join("\n");
}

function errorMessage(error: unknown): string {
  if (error instanceof VcmError) {
    return error.hint ? `${error.message} ${error.hint}` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown Gate review error.";
}

function isPendingReportError(error: unknown): boolean {
  return error instanceof VcmError && error.code === "GATE_REVIEW_REPORT_MISSING";
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
