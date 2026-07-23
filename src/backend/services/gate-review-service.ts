import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  CODE_DIFF_SOURCES,
  GATE_REVIEW_GATES,
  type CodeDiffSource,
  type GateReviewDecision,
  type GateReviewCallbackStatus,
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
import { checkMarkdownArtifact } from "../../shared/validation/artifact-check.js";
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

export interface GateReviewService {
  getState(repoRoot: string, taskSlug: string): Promise<GateReviewIndex>;
  updateSettings(repoRoot: string, taskSlug: string, input: GateReviewSettingsUpdateRequest): Promise<GateReviewIndex>;
  requestReviewGate(repoRoot: string, taskSlug: string, gate: GateReviewGate, input?: GateReviewRequestInput): Promise<GateReviewRequestResult>;
  retryReviewGate(repoRoot: string, taskSlug: string, gate: GateReviewGate): Promise<GateReviewRequestResult>;
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
  sessionService: Pick<SessionService, "getRoleSession" | "markRoleActivityRunning" | "resumeRoleSession" | "startRoleSession">;
  roundService: Pick<RoundService, "recordRoleTurnEvent">;
  reportPollIntervalMs?: number;
  reportTimeoutMs?: number;
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
  config: GateReviewRuntimeConfig;
}

interface CodeDiffInput {
  baseCommit: string;
  headCommit: string;
  commits: string[];
  changedFiles: string[];
  diffStat: string;
  diffHash: string;
}

interface ParsedReport extends GateReviewReport {
  decision: GateReviewDecision;
}

const GATE_REVIEW_AGENT_PATH = ".claude/agents/gate-reviewer.md";
const GATE_REVIEW_DIR = ".ai/vcm/gate-reviews";
const REQUESTS_DIR = ".ai/vcm/gate-reviews/requests";
const GATE_REVIEW_VERSION = 1;
const GATE_REVIEWER_ROLE = "gate-reviewer";
const DEFAULT_REPORT_POLL_INTERVAL_MS = 1000;
const DEFAULT_REPORT_TIMEOUT_MS = 30 * 60 * 1000;
const activeRuns = new Set<string>();
const ARCHITECTURE_ANALYSIS_FIELDS = [
  "Evidence Read",
  "Architecture Brief Fit",
  "End-To-End Flow",
  "Scope Fit",
  "Code Reality",
  "Ownership",
  "Data Flow",
  "Lifecycle",
  "Invariants",
  "Boundaries And Public Surface",
  "Failure Model",
  "Coder Readiness"
] as const;
const VALIDATION_ANALYSIS_FIELDS = [
  "Evidence Read",
  "Changed Behavior And Risk",
  "Coverage Mapping",
  "Baseline Coverage",
  "Integration And E2E Coverage",
  "Boundary And Failure Coverage",
  "Public Contract Coverage",
  "Test Integrity",
  "Skips And Gaps",
  "User Approval And Gap Disposition",
  "Validation Readiness"
] as const;
const CODE_DIFF_ANALYSIS_FIELDS = [
  "Commit Range And Sources",
  "Evidence Read",
  "Changed Files And Symbols",
  "Changed Behavior",
  "Source Evidence Fit",
  "Callers And Public Surface",
  "State Lifecycle And Failure Paths",
  "Coding Standards",
  "Baseline Test Integrity",
  "Generated Context And Durable Docs",
  "Code Readiness"
] as const;

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
  "code-diff": []
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

export function createGateReviewService(deps: GateReviewServiceDeps): GateReviewService {
  const now = deps.now ?? (() => new Date().toISOString());
  const reportPollIntervalMs = deps.reportPollIntervalMs ?? DEFAULT_REPORT_POLL_INTERVAL_MS;
  const reportTimeoutMs = deps.reportTimeoutMs ?? DEFAULT_REPORT_TIMEOUT_MS;

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
      return { status: "disabled", gate, record: index.gates[gate], message: "Gate review is disabled." };
    }

    if (!record.required) {
      index = applyGateState(index, gate, {
        status: "not_required",
        decision: undefined,
        error: undefined
      }, now());
      await saveIndex(deps.fs, context.taskRepoRoot, index);
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

    if (record.status === "running" && !options.force) {
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

    const codeDiffInput = gate === "code-diff"
      ? await resolveCodeDiffInput(deps, context, record)
      : undefined;
    if (gate === "code-diff" && !codeDiffInput) {
      index = applyGateState(index, gate, {
        status: "not_required",
        decision: undefined,
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
        codeDiffSource,
        codeDiffSources: codeDiffSource ? [codeDiffSource] : undefined,
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
        message: "No new commits to review."
      };
    }

    const codeDiffSources = gate === "code-diff" && codeDiffInput && codeDiffSource
      ? resolveCodeDiffSources(record, codeDiffInput, codeDiffSource)
      : undefined;
    const inputHash = await computeInputHash(deps, context.taskRepoRoot, gate, codeDiffInput, codeDiffSources);
    if (
      !options.force
      && record.status === "completed"
      && record.decision === "approve"
      && record.inputHash === inputHash
    ) {
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
      reportPath: nextRecord.reportPath,
      promptPath: nextRecord.promptPath
    });
    await saveIndex(deps.fs, context.taskRepoRoot, index);

    void runGateReview(context, gate, requestId, codeDiffInput, codeDiffSources).catch(() => {
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
    codeDiffSources?: CodeDiffSource[]
  ): Promise<void> {
    const runKey = `${context.taskRepoRoot}:${context.taskSlug}:${gate}`;
    if (activeRuns.has(runKey)) {
      return;
    }
    activeRuns.add(runKey);
    try {
      const timestamp = now();
      await updateGateRecord(context, gate, {
        status: "running",
        startedAt: timestamp,
        updatedAt: timestamp
      });
      await updateRequestStatus(deps.fs, context, requestId, "running", { startedAt: timestamp });

      const reviewDir = resolveRepoPath(context.taskRepoRoot, GATE_REVIEW_DIR);
      const agentPath = resolveRepoPath(context.repoRoot, GATE_REVIEW_AGENT_PATH);
      const prompt = buildGatePrompt(context, gate, requestId, codeDiffInput, codeDiffSources);
      await deps.fs.ensureDir(reviewDir);
      await deps.fs.ensureDir(resolveRepoPath(context.taskRepoRoot, REQUESTS_DIR));
      await deps.fs.writeText(resolveRepoPath(context.taskRepoRoot, promptPathForRequest(requestId)), prompt);

      if (!(await deps.fs.pathExists(agentPath))) {
        throw new VcmError({
          code: "GATE_REVIEW_AGENT_MISSING",
          message: `${GATE_REVIEW_AGENT_PATH} does not exist.`,
          statusCode: 409,
          hint: "Apply the VCM harness before requesting Gate Review Gates."
        });
      }

      const session = await ensureGateReviewerSession(context);
      await submitTerminalInput(deps.runtime, session.id, prompt);
      await deps.sessionService.markRoleActivityRunning(
        context.repoRoot,
        context.taskSlug,
        GATE_REVIEWER_ROLE,
        session.id
      );
      await deps.roundService.recordRoleTurnEvent({
        repoRoot: context.repoRoot,
        stateRepoRoot: context.taskRepoRoot,
        stateRoot: context.stateRoot,
        taskSlug: context.taskSlug,
        role: GATE_REVIEWER_ROLE,
        eventName: "UserPromptSubmit"
      });

      const parsed = await waitForGateReport(deps.fs, context.taskRepoRoot, gate, requestId, now(), {
        intervalMs: reportPollIntervalMs,
        timeoutMs: reportTimeoutMs
      });
      const completedAt = now();
      await updateRequestStatus(deps.fs, context, requestId, "completed", {
        completedAt,
        decision: parsed.decision,
        reportPath: parsed.reportPath
      });
      activeRuns.delete(runKey);
      await updateGateRecord(context, gate, {
        status: "completed",
        decision: parsed.decision,
        summary: parsed.summary,
        findings: parsed.findings,
        error: undefined,
        completedAt,
        callbackStatus: "not_sent",
        callbackError: undefined,
        updatedAt: completedAt
      }, { clearActiveGate: true });
      await callbackProjectManager(context, gate, "completed", parsed.decision, parsed.reportPath);
    } catch (error) {
      const timestamp = now();
      const message = errorMessage(error);
      await updateRequestStatus(deps.fs, context, requestId, "failed", {
        completedAt: timestamp,
        error: message
      });
      activeRuns.delete(runKey);
      await updateGateRecord(context, gate, {
        status: "failed",
        error: message,
        completedAt: timestamp,
        callbackStatus: "not_sent",
        callbackError: undefined,
        updatedAt: timestamp
      }, { clearActiveGate: true });
      await callbackProjectManager(context, gate, "failed", undefined, reportPathForGate(gate), message);
    } finally {
      activeRuns.delete(runKey);
    }
  }

  async function ensureGateReviewerSession(context: ReviewContext) {
    const existing = await deps.sessionService.getRoleSession(context.repoRoot, context.taskSlug, GATE_REVIEWER_ROLE);
    if (existing?.status === "running" && deps.runtime.getSession(existing.id)) {
      return existing;
    }

    if (existing?.claudeSessionId) {
      try {
        return await deps.sessionService.resumeRoleSession(context.repoRoot, context.taskSlug, GATE_REVIEWER_ROLE, {
          cols: 100,
          rows: 28,
          model: "default"
        });
      } catch {
        // Fall through to a fresh Gate Reviewer terminal if the saved session cannot be resumed.
      }
    }

    return deps.sessionService.startRoleSession(context.repoRoot, context.taskSlug, GATE_REVIEWER_ROLE, {
      cols: 100,
      rows: 28,
      model: "default"
    });
  }

  async function updateGateRecord(
    context: ReviewContext,
    gate: GateReviewGate,
    patch: Partial<GateReviewGateRecord>,
    options: { clearActiveGate?: boolean } = {}
  ): Promise<GateReviewIndex> {
    const index = await loadIndex(deps.fs, context, now());
    const next = applyGateState(index, gate, patch, now(), options.clearActiveGate);
    await saveIndex(deps.fs, context.taskRepoRoot, next);
    return next;
  }

  async function callbackProjectManager(
    context: ReviewContext,
    gate: GateReviewGate,
    status: GateReviewGateStatus,
    decision: GateReviewDecision | undefined,
    reportPath: string,
    error?: string
  ): Promise<void> {
    const session = await deps.sessionService.getRoleSession(context.repoRoot, context.taskSlug, "project-manager");
    if (!session || session.status !== "running") {
      await updateGateRecord(context, gate, {
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
      error
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
      await updateGateRecord(context, gate, {
        callbackStatus: "sent",
        callbackError: undefined,
        updatedAt: now()
      });
    } catch (caught) {
      await updateGateRecord(context, gate, {
        callbackStatus: "failed",
        callbackError: errorMessage(caught),
        updatedAt: now()
      });
    }
  }

  return {
    async getState(repoRoot, taskSlug) {
      const context = await getContext(repoRoot, taskSlug);
      return loadIndex(deps.fs, context, now());
    },
    async updateSettings(repoRoot, taskSlug, input) {
      const currentSettings = await deps.appSettings.getGateReviewSettings(repoRoot, taskSlug);
      const requiredGates = new Set(currentSettings.requiredGates);
      for (const [gate, enabled] of Object.entries(input?.gates ?? {})) {
        if (!isGateReviewGate(gate)) {
          continue;
        }
        if (enabled) {
          requiredGates.add(gate);
        } else {
          requiredGates.delete(gate);
        }
      }
      await deps.appSettings.updateGateReviewSettings(repoRoot, taskSlug, [...requiredGates]);
      const nextContext = await getContext(repoRoot, taskSlug);
      const index = await loadIndex(deps.fs, nextContext, now());
      await saveIndex(deps.fs, nextContext.taskRepoRoot, {
        ...index,
        updatedAt: now()
      });
      return loadIndex(deps.fs, nextContext, now());
    },
    requestReviewGate(repoRoot, taskSlug, gate, input) {
      return requestReviewGateInternal(repoRoot, taskSlug, gate, {
        codeDiffSource: input?.codeDiffSource
      });
    },
    retryReviewGate(repoRoot, taskSlug, gate) {
      return requestReviewGateInternal(repoRoot, taskSlug, gate, { force: true });
    },
    async skipReviewGate(repoRoot, taskSlug, gate, input) {
      const context = await getContext(repoRoot, taskSlug);
      assertExceptionReason(input.reason);
      const current = await loadIndex(deps.fs, context, now());
      if (current.gates[gate].status === "running") {
        throw new VcmError({
          code: "GATE_REVIEW_RUNNING",
          message: "Cannot skip a running Gate review gate.",
          statusCode: 409,
          hint: "Wait for the gate review to finish, then choose retry, skip, or override."
        });
      }
      const index = await updateGateRecord(context, gate, {
        status: "skipped",
        decision: undefined,
        exceptionReason: input.reason,
        error: undefined,
        completedAt: now(),
        callbackStatus: "not_sent",
        callbackError: undefined,
        updatedAt: now()
      }, { clearActiveGate: true });
      await callbackProjectManager(context, gate, "skipped", undefined, index.gates[gate].reportPath);
      return loadIndex(deps.fs, context, now());
    },
    async overrideReviewGate(repoRoot, taskSlug, gate, input) {
      const context = await getContext(repoRoot, taskSlug);
      assertExceptionReason(input.reason);
      const current = await loadIndex(deps.fs, context, now());
      if (current.gates[gate].status === "running") {
        throw new VcmError({
          code: "GATE_REVIEW_RUNNING",
          message: "Cannot override a running Gate review gate.",
          statusCode: 409,
          hint: "Wait for the gate review to finish, then choose retry, skip, or override."
        });
      }
      const index = await updateGateRecord(context, gate, {
        status: "overridden",
        decision: "approve",
        exceptionReason: input.reason,
        error: undefined,
        completedAt: now(),
        callbackStatus: "not_sent",
        callbackError: undefined,
        updatedAt: now()
      }, { clearActiveGate: true });
      await callbackProjectManager(context, gate, "overridden", "approve", index.gates[gate].reportPath);
      return loadIndex(deps.fs, context, now());
    },
    async readReport(repoRoot, taskSlug, gate) {
      const context = await getContext(repoRoot, taskSlug);
      return parseGateReport(deps.fs, context.taskRepoRoot, gate, undefined, now());
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
  const commits = splitLines(await commandStdout(deps.runner, context.taskRepoRoot, [
    "log",
    "--oneline",
    "--reverse",
    range
  ]));
  if (commits.length === 0) {
    return undefined;
  }

  const changedFiles = splitLines(await commandStdout(deps.runner, context.taskRepoRoot, [
    "diff",
    "--name-only",
    "--find-renames",
    range
  ]));
  const diffStat = await commandStdout(deps.runner, context.taskRepoRoot, [
    "diff",
    "--stat",
    "--find-renames",
    range
  ]);
  const diff = await commandStdout(deps.runner, context.taskRepoRoot, [
    "diff",
    "--binary",
    "--find-renames",
    range
  ]);
  const diffHash = createHash("sha256").update(diff).digest("hex");

  return {
    baseCommit,
    headCommit,
    commits,
    changedFiles,
    diffStat,
    diffHash
  };
}

async function resolveCodeDiffBaseCommit(
  deps: Pick<GateReviewServiceDeps, "runner">,
  context: ReviewContext,
  record: GateReviewGateRecord,
  headCommit: string
): Promise<string | undefined> {
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

  const common = [
    "CLAUDE.md",
    ".claude/agents/architect.md",
    ".claude/agents/coder.md",
    ".claude/agents/gate-reviewer.md",
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
    digest.update("baseCommit");
    digest.update(codeDiffInput.baseCommit);
    digest.update("headCommit");
    digest.update(codeDiffInput.headCommit);
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
  if (!await fs.pathExists(absolutePath)) {
    return `${relativePath} is missing. Complete Architect Interview before architecture planning.`;
  }
  const content = await fs.readText(absolutePath);
  const check = checkMarkdownArtifact("architecture-brief", relativePath, content);
  if (check.status !== "ok") {
    return `${relativePath} is incomplete. Complete and confirm Architect Interview before requesting architecture-plan review.`;
  }
  if (!/^\s*Architecture Brief Status\s*:\s*confirmed\s*$/im.test(content)) {
    return `${relativePath} is not confirmed. Obtain explicit user confirmation before architecture planning.`;
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
  if (check.status === "ok") {
    return undefined;
  }
  const details = [
    check.missingHeadings.length > 0 ? `missing headings: ${check.missingHeadings.join(", ")}` : "",
    check.invalidFields.length > 0 ? check.invalidFields.join(" ") : "",
    check.hasPlaceholder ? "contains placeholders" : ""
  ].filter(Boolean).join("; ");
  return `${relativePath} is incomplete and cannot start validation-adequacy review.${details ? ` ${details}` : ""}`;
}

async function readArchitectureEvidenceError(
  fs: FileSystemAdapter,
  taskRepoRoot: string
): Promise<string | undefined> {
  const relativePath = ".ai/vcm/handoffs/architecture-evidence.md";
  const absolutePath = resolveRepoPath(taskRepoRoot, relativePath);
  if (!await fs.pathExists(absolutePath)) {
    return `${relativePath} is missing. Complete architecture evidence before requesting architecture-plan review.`;
  }
  const content = await fs.readText(absolutePath);
  if (content.trim().length === 0) {
    return `${relativePath} is empty. Complete architecture evidence before requesting architecture-plan review.`;
  }
  if (!/^\s*Architecture Evidence Status\s*:\s*complete\s*$/im.test(content)) {
    return `${relativePath} is incomplete. Finish current-worktree evidence before requesting architecture-plan review.`;
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
  codeDiffSources?: CodeDiffSource[]
): string {
  const reportPath = reportPathForGate(gate);
  const absoluteReportPath = resolveRepoPath(context.taskRepoRoot, reportPath);
  const evidence = getSourceArtifacts(gate, codeDiffSources)
    .map((relativePath) => `- ${relativePath}`)
    .join("\n");
  const gitLine = gate === "architecture-plan"
    ? "\nDiff: inspect git status/diff in Worktree."
    : "";
  const architectureContract = gate === "architecture-plan"
    ? "\n\nComplete every Architecture Analysis field required by the Gate Reviewer role with concrete current-worktree evidence before deciding."
    : "";
  const validationContract = gate === "validation-adequacy"
    ? "\n\nComplete every Validation Analysis field required by the Gate Reviewer role with concrete current-worktree production and test evidence before deciding."
    : "";
  const codeDiffContract = gate === "code-diff"
    ? "\n\nComplete every Code Diff Analysis field required by the Gate Reviewer role with concrete evidence from the named commit range before deciding."
    : "";
  const codeDiffSection = gate === "code-diff" && codeDiffInput
    ? `

Code Diff Input:
This code-diff gate reviews the new commits from one PM route flow, not the whole task and not one terminal turn.
Code sources: ${codeDiffSources?.join(" -> ") ?? "<missing>"}
Base commit: ${codeDiffInput.baseCommit}
Head commit: ${codeDiffInput.headCommit}
Commits:
${codeDiffInput.commits.map((line) => `- ${line}`).join("\n")}
Changed files:
${codeDiffInput.changedFiles.length > 0 ? codeDiffInput.changedFiles.map((line) => `- ${line}`).join("\n") : "- <none>"}
Diff commands:
- git diff --stat --find-renames ${codeDiffInput.baseCommit}..${codeDiffInput.headCommit}
- git diff --find-renames ${codeDiffInput.baseCommit}..${codeDiffInput.headCommit}
- git show --stat --oneline <commit>
Review only this commit range.`
    : "";

  return `[VCM GATE REVIEW]
Task: ${context.taskSlug}
Worktree: ${context.taskRepoRoot}
Gate: ${gate}
Request: ${requestId}
Report: ${absoluteReportPath}

Evidence:
${evidence}${gitLine}${architectureContract}${validationContract}${codeDiffContract}${codeDiffSection}

Write only Report. Start exactly:
Gate: ${gate}
Request: ${requestId}
Decision: approve|request_changes
Summary: <one or two sentences>
[/VCM GATE REVIEW]`;
}

async function waitForGateReport(
  fs: FileSystemAdapter,
  taskRepoRoot: string,
  gate: GateReviewGate,
  requestId: string,
  timestamp: string,
  options: { intervalMs: number; timeoutMs: number }
): Promise<ParsedReport> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt <= options.timeoutMs) {
    try {
      return await parseGateReport(fs, taskRepoRoot, gate, requestId, timestamp);
    } catch (error) {
      lastError = error;
      if (!isPendingReportError(error)) {
        throw error;
      }
    }
    await delay(options.intervalMs);
  }

  const detail = errorMessage(lastError);
  throw new VcmError({
    code: "GATE_REVIEW_REPORT_TIMEOUT",
    message: `Gate Reviewer did not produce a valid ${gate} report within ${Math.round(options.timeoutMs / 1000)}s.`,
    statusCode: 504,
    hint: detail
  });
}

async function parseGateReport(
  fs: FileSystemAdapter,
  taskRepoRoot: string,
  gate: GateReviewGate,
  requestId: string | undefined,
  timestamp: string
): Promise<ParsedReport> {
  const reportPath = reportPathForGate(gate);
  const absolutePath = resolveRepoPath(taskRepoRoot, reportPath);
  if (!(await fs.pathExists(absolutePath))) {
    throw new VcmError({
      code: "GATE_REVIEW_REPORT_MISSING",
      message: `Gate review report was not written: ${reportPath}`,
      statusCode: 500
    });
  }

  const content = await fs.readText(absolutePath);
  const parsedGate = matchField(content, "Gate");
  if (parsedGate && parsedGate !== gate) {
    throw new VcmError({
      code: "GATE_REVIEW_REPORT_GATE_MISMATCH",
      message: `Gate review report gate is ${parsedGate}, expected ${gate}.`,
      statusCode: 500
    });
  }

  const parsedRequest = matchField(content, "Request");
  if (requestId && parsedRequest !== requestId) {
    throw new VcmError({
      code: "GATE_REVIEW_REPORT_STALE",
      message: `Gate review report request is ${parsedRequest ?? "missing"}, expected ${requestId}.`,
      statusCode: 500
    });
  }

  const decision = normalizeDecision(matchField(content, "Decision"));
  if (!decision) {
    throw new VcmError({
      code: "GATE_REVIEW_DECISION_MISSING",
      message: `Gate review report must contain Decision: approve or Decision: request_changes.`,
      statusCode: 500
    });
  }

  const findings = extractFindings(content);
  if (gate === "architecture-plan") {
    validateArchitectureAnalysis(content);
  }
  if (gate === "validation-adequacy") {
    validateValidationAnalysis(content);
    if (decision === "approve") {
      await validateValidationApprovalInput(fs, taskRepoRoot);
    }
  }
  if (gate === "code-diff") {
    validateCodeDiffAnalysis(content);
  }
  if (decision === "request_changes") {
    validateRequestChangeFindings(findings);
    if (gate === "code-diff") {
      validateCodeDiffFindings(findings);
    }
  }

  return {
    gate,
    requestId: parsedRequest,
    decision,
    summary: extractSummary(content),
    findings,
    reportPath,
    content,
    parsedAt: timestamp
  };
}

function validateArchitectureAnalysis(content: string): void {
  const section = extractMarkdownSection(content, "Architecture Analysis");
  if (!section) {
    throw new VcmError({
      code: "GATE_REVIEW_ARCHITECTURE_ANALYSIS_MISSING",
      message: "Architecture-plan review must contain a non-empty Architecture Analysis section.",
      statusCode: 500
    });
  }

  const missingFields = ARCHITECTURE_ANALYSIS_FIELDS.filter((field) => !matchField(section, field));
  if (missingFields.length > 0) {
    throw new VcmError({
      code: "GATE_REVIEW_ARCHITECTURE_ANALYSIS_INCOMPLETE",
      message: `Architecture Analysis is missing required evidence: ${missingFields.join(", ")}.`,
      statusCode: 500
    });
  }
}

function validateValidationAnalysis(content: string): void {
  const section = extractMarkdownSection(content, "Validation Analysis");
  if (!section) {
    throw new VcmError({
      code: "GATE_REVIEW_VALIDATION_ANALYSIS_MISSING",
      message: "Validation-adequacy review must contain a non-empty Validation Analysis section.",
      statusCode: 500
    });
  }

  const missingFields = VALIDATION_ANALYSIS_FIELDS.filter((field) => !matchField(section, field));
  if (missingFields.length > 0) {
    throw new VcmError({
      code: "GATE_REVIEW_VALIDATION_ANALYSIS_INCOMPLETE",
      message: `Validation Analysis is missing required evidence: ${missingFields.join(", ")}.`,
      statusCode: 500
    });
  }
}

function validateCodeDiffAnalysis(content: string): void {
  const section = extractMarkdownSection(content, "Code Diff Analysis");
  if (!section) {
    throw new VcmError({
      code: "GATE_REVIEW_CODE_DIFF_ANALYSIS_MISSING",
      message: "Code-diff review must contain a non-empty Code Diff Analysis section.",
      statusCode: 500
    });
  }

  const missingFields = CODE_DIFF_ANALYSIS_FIELDS.filter((field) => !matchField(section, field));
  if (missingFields.length > 0) {
    throw new VcmError({
      code: "GATE_REVIEW_CODE_DIFF_ANALYSIS_INCOMPLETE",
      message: `Code Diff Analysis is missing required evidence: ${missingFields.join(", ")}.`,
      statusCode: 500
    });
  }
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

  const details = [
    `status=${check.status}`,
    check.missingHeadings.length > 0 ? `missing headings: ${check.missingHeadings.join(", ")}` : "",
    check.invalidFields.length > 0 ? check.invalidFields.join(" ") : "",
    check.hasPlaceholder ? "contains placeholders" : ""
  ].filter(Boolean).join("; ");
  throw new VcmError({
    code: "GATE_REVIEW_VALIDATION_INPUT_INCOMPLETE",
    message: `Validation-adequacy cannot approve incomplete Tester evidence in ${relativePath}. ${details}`,
    statusCode: 500
  });
}

function validateRequestChangeFindings(findings: GateReviewFinding[]): void {
  if (findings.length === 0) {
    throw new VcmError({
      code: "GATE_REVIEW_FINDINGS_MISSING",
      message: "A request_changes decision must contain at least one structured finding.",
      statusCode: 500
    });
  }
  const incomplete = findings.find((finding) => (
    !finding.evidence.trim()
    || !finding.expected.trim()
    || !finding.gap.trim()
    || !finding.risk.trim()
  ));
  if (incomplete) {
    throw new VcmError({
      code: "GATE_REVIEW_FINDING_INCOMPLETE",
      message: `Finding ${incomplete.title} must contain Evidence, Expected, Gap, and Risk.`,
      statusCode: 500
    });
  }
}

function validateCodeDiffFindings(findings: GateReviewFinding[]): void {
  const incomplete = findings.find((finding) => !finding.file?.trim() || !finding.location?.trim());
  if (incomplete) {
    throw new VcmError({
      code: "GATE_REVIEW_CODE_DIFF_FINDING_LOCATION_MISSING",
      message: `Code-diff finding ${incomplete.title} must contain File and Line Or Symbol.`,
      statusCode: 500
    });
  }
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

function reportPathForGate(gate: GateReviewGate): string {
  return path.posix.join(GATE_REVIEW_DIR, `${gate}-review.md`);
}

function promptPathForRequest(requestId: string): string {
  return path.posix.join(REQUESTS_DIR, `${requestId}.prompt.md`);
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

function extractSummary(content: string): string | undefined {
  const field = matchField(content, "Summary");
  if (field) {
    return field;
  }
  const section = content.match(/^##\s+Summary\s*\n([\s\S]*?)(?=\n##\s+|\s*$)/im);
  return section?.[1]?.trim() || undefined;
}

function extractFindings(content: string): GateReviewFinding[] {
  const findings: GateReviewFinding[] = [];
  const blocks = content.split(/\n(?=#{2,4}\s+|-+\s*severity\s*:|severity\s*:)/i);
  for (const block of blocks) {
    const heading = block.match(/^#{2,4}\s+(critical|high|medium|low)\s*:\s*(.+)$/im);
    const severity = normalizeSeverity(matchField(block, "severity") ?? heading?.[1]);
    const title = matchField(block, "title") ?? heading?.[2]?.trim() ?? block.match(/^#{2,4}\s+(.+)$/m)?.[1]?.trim();
    if (!severity || !title) {
      continue;
    }
    findings.push({
      severity,
      title,
      file: matchField(block, "file"),
      line: parsePositiveInteger(matchField(block, "line")),
      location: matchField(block, "line or symbol"),
      evidence: matchField(block, "evidence") ?? "",
      expected: matchField(block, "expected") ?? "",
      gap: matchField(block, "gap") ?? "",
      risk: matchField(block, "risk") ?? ""
    });
  }
  return findings;
}

function getSourceArtifacts(gate: GateReviewGate, codeDiffSources?: CodeDiffSource[]): string[] {
  if (gate !== "code-diff") {
    return SOURCE_ARTIFACTS[gate];
  }
  return [...new Set((codeDiffSources ?? []).flatMap((source) => CODE_DIFF_SOURCE_ARTIFACTS[source]))];
}

function resolveCodeDiffSources(
  record: GateReviewGateRecord,
  codeDiffInput: CodeDiffInput,
  currentSource: CodeDiffSource
): CodeDiffSource[] {
  const continuingRecordedRange = record.baseCommit === codeDiffInput.baseCommit
    && (
      (record.status === "completed" && record.decision === "request_changes")
      || record.status === "failed"
    );
  if (!continuingRecordedRange) {
    return [currentSource];
  }
  return [...new Set([
    ...(normalizeCodeDiffSources(record.codeDiffSources, record.codeDiffSource) ?? []),
    currentSource
  ])];
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

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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

function renderProjectManagerCallback(input: {
  taskSlug: string;
  gate: GateReviewGate;
  status: GateReviewGateStatus;
  decision?: GateReviewDecision;
  reportPath: string;
  error?: string;
}): string {
  const lines = [
    "[VCM GATE REVIEW CALLBACK]",
    `task: ${input.taskSlug}`,
    `gate: ${input.gate}`,
    `status: ${input.status}`,
    `decision: ${input.decision ?? "none"}`,
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
  return error instanceof VcmError && [
    "GATE_REVIEW_DECISION_MISSING",
    "GATE_REVIEW_ARCHITECTURE_ANALYSIS_MISSING",
    "GATE_REVIEW_ARCHITECTURE_ANALYSIS_INCOMPLETE",
    "GATE_REVIEW_FINDINGS_MISSING",
    "GATE_REVIEW_FINDING_INCOMPLETE",
    "GATE_REVIEW_REPORT_GATE_MISMATCH",
    "GATE_REVIEW_REPORT_MISSING",
    "GATE_REVIEW_REPORT_STALE"
  ].includes(error.code);
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
