import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  CODEX_REVIEW_GATES,
  type CodexReviewDecision,
  type CodexReviewCallbackStatus,
  type CodexReviewExceptionRequest,
  type CodexReviewFinding,
  type CodexReviewGate,
  type CodexReviewGateRecord,
  type CodexReviewGateStatus,
  type CodexReviewIndex,
  type CodexReviewReport,
  type CodexReviewRequestResult,
  type CodexReviewSeverity
} from "../../shared/types/codex-review.js";
import { VcmError } from "../errors.js";
import { resolveRepoPath } from "../adapters/filesystem.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import type { CommandRunner } from "../adapters/command-runner.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import type { ProjectService } from "./project-service.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";

export interface CodexReviewService {
  getState(repoRoot: string, taskSlug: string): Promise<CodexReviewIndex>;
  requestReviewGate(repoRoot: string, taskSlug: string, gate: CodexReviewGate): Promise<CodexReviewRequestResult>;
  retryReviewGate(repoRoot: string, taskSlug: string, gate: CodexReviewGate): Promise<CodexReviewRequestResult>;
  skipReviewGate(repoRoot: string, taskSlug: string, gate: CodexReviewGate, input: CodexReviewExceptionRequest): Promise<CodexReviewIndex>;
  overrideReviewGate(repoRoot: string, taskSlug: string, gate: CodexReviewGate, input: CodexReviewExceptionRequest): Promise<CodexReviewIndex>;
  readReport(repoRoot: string, taskSlug: string, gate: CodexReviewGate): Promise<CodexReviewReport>;
}

export interface CodexReviewServiceDeps {
  fs: FileSystemAdapter;
  runner: CommandRunner;
  runtime: TerminalRuntime;
  projectService: Pick<ProjectService, "loadConfig">;
  taskService: Pick<TaskService, "loadTask">;
  sessionService: Pick<SessionService, "getRoleSession" | "markRoleActivityRunning">;
  now?: () => string;
}

interface CodexReviewRuntimeConfig {
  enabled: boolean;
  requiredGates: CodexReviewGate[];
  model?: string;
  modelReasoningEffort?: string;
  command: string;
}

interface ReviewContext {
  repoRoot: string;
  taskSlug: string;
  taskRepoRoot: string;
  stateRoot: string;
  config: CodexReviewRuntimeConfig;
}

interface ParsedReport extends CodexReviewReport {
  decision: CodexReviewDecision;
}

const CODEX_DIR = ".ai/codex";
const CODEX_CONFIG_PATH = ".ai/codex/config.toml";
const CODEX_REVIEW_DIR = ".ai/vcm/codex-reviews";
const REQUESTS_DIR = ".ai/vcm/codex-reviews/requests";
const CODEX_REVIEW_VERSION = 1;
const activeRuns = new Set<string>();

const SOURCE_ARTIFACTS: Record<CodexReviewGate, string[]> = {
  "architecture-plan": [
    ".ai/vcm/handoffs/architecture-plan.md"
  ],
  "validation-adequacy": [
    ".ai/vcm/handoffs/architecture-plan.md",
    ".ai/vcm/handoffs/review-report.md"
  ],
  "final-diff": [
    ".ai/vcm/handoffs/architecture-plan.md",
    ".ai/vcm/handoffs/review-report.md",
    ".ai/vcm/handoffs/docs-sync-report.md",
    ".ai/vcm/handoffs/final-acceptance.md"
  ]
};

const VALID_SEVERITIES = new Set<CodexReviewSeverity>(["critical", "high", "medium", "low"]);

export function createCodexReviewService(deps: CodexReviewServiceDeps): CodexReviewService {
  const now = deps.now ?? (() => new Date().toISOString());

  async function getContext(repoRoot: string, taskSlug: string): Promise<ReviewContext> {
    const projectConfig = await deps.projectService.loadConfig(repoRoot);
    const task = await deps.taskService.loadTask(repoRoot, taskSlug);
    const taskRepoRoot = getTaskRuntimeRepoRoot(task);
    return {
      repoRoot,
      taskSlug,
      taskRepoRoot,
      stateRoot: projectConfig.stateRoot,
      config: await loadRuntimeConfig(deps.fs, taskRepoRoot)
    };
  }

  async function requestReviewGateInternal(
    repoRoot: string,
    taskSlug: string,
    gate: CodexReviewGate,
    options: { force?: boolean } = {}
  ): Promise<CodexReviewRequestResult> {
    const context = await getContext(repoRoot, taskSlug);
    let index = await loadIndex(deps.fs, context, now());
    const record = index.gates[gate];

    if (!context.config.enabled) {
      index = applyGateState(index, gate, {
        status: "disabled",
        required: false,
        decision: undefined,
        error: undefined
      }, now());
      await saveIndex(deps.fs, context.taskRepoRoot, index);
      return { status: "disabled", gate, record: index.gates[gate], message: "Codex review is disabled." };
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
        message: `Codex review is already running for ${index.activeGate}.`
      };
    }

    if (record.status === "running" && !options.force) {
      return { status: "running", gate, record, message: "Codex review is already running." };
    }

    const inputHash = await computeInputHash(deps, context.taskRepoRoot, gate);
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
        message: "Codex review already approved the current inputs."
      };
    }

    const timestamp = now();
    const requestId = createRequestId(gate);
    const requestPath = path.posix.join(REQUESTS_DIR, `${requestId}.json`);
    const nextRecord: CodexReviewGateRecord = {
      ...record,
      status: "running",
      decision: undefined,
      error: undefined,
      exceptionReason: undefined,
      requestId,
      requestPath,
      inputHash,
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
      version: CODEX_REVIEW_VERSION,
      requestId,
      gate,
      status: "requested",
      requestedAt: timestamp,
      inputHash,
      reportPath: nextRecord.reportPath,
      promptPath: nextRecord.promptPath
    });
    await saveIndex(deps.fs, context.taskRepoRoot, index);

    void runCodexReview(context, gate, requestId).catch(() => {
      // runCodexReview records failures in the persisted gate state.
    });

    return {
      status: "started",
      gate,
      record: nextRecord,
      message: "Codex review started."
    };
  }

  async function runCodexReview(context: ReviewContext, gate: CodexReviewGate, requestId: string): Promise<void> {
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

      const codexDir = resolveRepoPath(context.taskRepoRoot, CODEX_DIR);
      const reviewDir = resolveRepoPath(context.taskRepoRoot, CODEX_REVIEW_DIR);
      const prompt = await buildCodexPrompt(deps.fs, context.taskRepoRoot, gate, requestId);
      const outputMessagePath = path.join(reviewDir, "logs", `${requestId}.last-message.txt`);
      await deps.fs.ensureDir(reviewDir);
      await deps.fs.ensureDir(path.dirname(outputMessagePath));

      if (!(await deps.fs.pathExists(codexDir))) {
        throw new VcmError({
          code: "CODEX_REVIEW_CONFIG_MISSING",
          message: `${CODEX_DIR} does not exist.`,
          statusCode: 409,
          hint: "Apply the VCM harness before requesting Codex review gates."
        });
      }

      const args = buildCodexExecArgs({
        codexDir,
        reviewDir,
        prompt,
        outputMessagePath,
        config: context.config
      });
      const result = await deps.runner.run(context.config.command, args, {
        cwd: context.taskRepoRoot,
        env: {
          ...process.env,
          VCM_TASK_REPO_ROOT: context.taskRepoRoot,
          VCM_TASK_SLUG: context.taskSlug,
          VCM_CODEX_REVIEW_GATE: gate,
          VCM_CODEX_REVIEW_REQUEST_ID: requestId
        }
      });

      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "CODEX_REVIEW_FAILED",
          message: `Codex CLI exited with ${result.exitCode}.`,
          statusCode: 500,
          hint: trimCommandOutput(`${result.stderr}\n${result.stdout}`)
        });
      }

      const parsed = await parseGateReport(deps.fs, context.taskRepoRoot, gate, requestId, now());
      const completedAt = now();
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
      await updateRequestStatus(deps.fs, context, requestId, "completed", {
        completedAt,
        decision: parsed.decision,
        reportPath: parsed.reportPath
      });
      await callbackProjectManager(context, gate, "completed", parsed.decision, parsed.reportPath);
    } catch (error) {
      const timestamp = now();
      const message = errorMessage(error);
      await updateGateRecord(context, gate, {
        status: "failed",
        error: message,
        completedAt: timestamp,
        callbackStatus: "not_sent",
        callbackError: undefined,
        updatedAt: timestamp
      }, { clearActiveGate: true });
      await updateRequestStatus(deps.fs, context, requestId, "failed", {
        completedAt: timestamp,
        error: message
      });
      await callbackProjectManager(context, gate, "failed", undefined, reportPathForGate(gate), message);
    } finally {
      activeRuns.delete(runKey);
    }
  }

  async function updateGateRecord(
    context: ReviewContext,
    gate: CodexReviewGate,
    patch: Partial<CodexReviewGateRecord>,
    options: { clearActiveGate?: boolean } = {}
  ): Promise<CodexReviewIndex> {
    const index = await loadIndex(deps.fs, context, now());
    const next = applyGateState(index, gate, patch, now(), options.clearActiveGate);
    await saveIndex(deps.fs, context.taskRepoRoot, next);
    return next;
  }

  async function callbackProjectManager(
    context: ReviewContext,
    gate: CodexReviewGate,
    status: CodexReviewGateStatus,
    decision: CodexReviewDecision | undefined,
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
      await deps.sessionService.markRoleActivityRunning(context.repoRoot, context.taskSlug, "project-manager");
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
    requestReviewGate(repoRoot, taskSlug, gate) {
      return requestReviewGateInternal(repoRoot, taskSlug, gate);
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
          code: "CODEX_REVIEW_RUNNING",
          message: "Cannot skip a running Codex review gate.",
          statusCode: 409,
          hint: "Wait for the Codex run to finish, then choose retry, skip, or override."
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
          code: "CODEX_REVIEW_RUNNING",
          message: "Cannot override a running Codex review gate.",
          statusCode: 409,
          hint: "Wait for the Codex run to finish, then choose retry, skip, or override."
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

export function isCodexReviewGate(value: string): value is CodexReviewGate {
  return CODEX_REVIEW_GATES.includes(value as CodexReviewGate);
}

async function loadRuntimeConfig(fs: FileSystemAdapter, taskRepoRoot: string): Promise<CodexReviewRuntimeConfig> {
  const configPath = resolveRepoPath(taskRepoRoot, CODEX_CONFIG_PATH);
  if (!(await fs.pathExists(configPath))) {
    return {
      enabled: false,
      requiredGates: [],
      command: "codex"
    };
  }

  const content = await fs.readText(configPath);
  const section = extractTomlSection(content, "vcm.codex_review");
  const enabled = parseTomlBoolean(section, "enabled") ?? false;
  const parsedGates = parseTomlStringArray(section, "required_gates").filter(isCodexReviewGate);
  return {
    enabled,
    requiredGates: parsedGates.length > 0 ? parsedGates : [...CODEX_REVIEW_GATES],
    model: parseTomlString(content, "model"),
    modelReasoningEffort: parseTomlString(content, "model_reasoning_effort"),
    command: parseTomlString(section, "command") ?? "codex"
  };
}

async function loadIndex(fs: FileSystemAdapter, context: ReviewContext, timestamp: string): Promise<CodexReviewIndex> {
  const indexPath = getIndexPath(context.taskRepoRoot);
  const raw = await readJsonOrNull<Partial<CodexReviewIndex>>(fs, indexPath);
  return normalizeIndex(raw, context.config, timestamp);
}

function normalizeIndex(
  raw: Partial<CodexReviewIndex> | null,
  config: CodexReviewRuntimeConfig,
  timestamp: string
): CodexReviewIndex {
  const existingGates = raw?.gates && typeof raw.gates === "object"
    ? raw.gates as Partial<Record<CodexReviewGate, Partial<CodexReviewGateRecord>>>
    : {};
  const gates = {} as Record<CodexReviewGate, CodexReviewGateRecord>;
  const requiredSet = new Set(config.enabled ? config.requiredGates : []);

  for (const gate of CODEX_REVIEW_GATES) {
    const existing = existingGates[gate] as Partial<CodexReviewGateRecord> | undefined;
    const required = requiredSet.has(gate);
    const fallbackStatus: CodexReviewGateStatus = config.enabled
      ? required ? "pending" : "not_required"
      : "disabled";
    const existingStatus = normalizeGateStatus(existing?.status);
    const status = config.enabled && required
      ? (existingStatus === "disabled" || existingStatus === "not_required" ? "pending" : existingStatus ?? fallbackStatus)
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

  const activeGate = isCodexReviewGate(String(raw?.activeGate)) && gates[raw?.activeGate as CodexReviewGate].status === "running"
    ? raw?.activeGate as CodexReviewGate
    : null;

  return {
    version: CODEX_REVIEW_VERSION,
    enabled: config.enabled,
    activeGate,
    gates,
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : timestamp
  };
}

function applyGateState(
  index: CodexReviewIndex,
  gate: CodexReviewGate,
  patch: Partial<CodexReviewGateRecord>,
  timestamp: string,
  clearActiveGate = false
): CodexReviewIndex {
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

async function saveIndex(fs: FileSystemAdapter, taskRepoRoot: string, index: CodexReviewIndex): Promise<void> {
  await fs.writeJsonAtomic(getIndexPath(taskRepoRoot), index);
}

async function computeInputHash(
  deps: Pick<CodexReviewServiceDeps, "fs" | "runner">,
  taskRepoRoot: string,
  gate: CodexReviewGate
): Promise<string> {
  const digest = createHash("sha256");
  const common = [
    "CLAUDE.md",
    ".ai/codex/AGENTS.md",
    ".ai/codex/config.toml",
    promptPathForGate(gate)
  ];

  for (const relativePath of [...common, ...SOURCE_ARTIFACTS[gate]]) {
    digest.update(relativePath);
    const absolutePath = resolveRepoPath(taskRepoRoot, relativePath);
    if (await deps.fs.pathExists(absolutePath)) {
      digest.update(await deps.fs.readText(absolutePath));
    } else {
      digest.update("<missing>");
    }
  }

  if (gate === "final-diff") {
    digest.update(await commandStdout(deps.runner, taskRepoRoot, ["status", "--porcelain=v1"]));
    digest.update(await commandStdout(deps.runner, taskRepoRoot, ["diff", "--binary"]));
    digest.update(await commandStdout(deps.runner, taskRepoRoot, ["diff", "--cached", "--binary"]));
  }

  return digest.digest("hex");
}

async function commandStdout(runner: CommandRunner, cwd: string, args: string[]): Promise<string> {
  const result = await runner.run("git", args, { cwd });
  return result.exitCode === 0 ? result.stdout : "";
}

async function buildCodexPrompt(
  fs: FileSystemAdapter,
  taskRepoRoot: string,
  gate: CodexReviewGate,
  requestId: string
): Promise<string> {
  const promptPath = resolveRepoPath(taskRepoRoot, promptPathForGate(gate));
  if (!(await fs.pathExists(promptPath))) {
    throw new VcmError({
      code: "CODEX_REVIEW_PROMPT_MISSING",
      message: `Codex review prompt is missing: ${promptPathForGate(gate)}`,
      statusCode: 409,
      hint: "Apply the VCM harness before requesting Codex review gates."
    });
  }

  const basePrompt = await fs.readText(promptPath);
  const reportPath = path.posix.relative(CODEX_DIR, reportPathForGate(gate));
  return `${basePrompt.trimEnd()}

## VCM Runtime Contract

- Gate: ${gate}
- Request: ${requestId}
- Report path from this working directory: ${reportPath}

Your report must begin with these exact fields:

\`\`\`text
Gate: ${gate}
Request: ${requestId}
Decision: approve|request_changes
\`\`\`

Write only that report file. Do not edit any other file.`;
}

function buildCodexExecArgs(input: {
  codexDir: string;
  reviewDir: string;
  prompt: string;
  outputMessagePath: string;
  config: CodexReviewRuntimeConfig;
}): string[] {
  const args = [
    "exec",
    "--cd",
    input.codexDir,
    "--add-dir",
    input.reviewDir,
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--output-last-message",
    input.outputMessagePath
  ];
  if (input.config.model) {
    args.push("--model", input.config.model);
  }
  if (input.config.modelReasoningEffort) {
    args.push("--config", `model_reasoning_effort="${input.config.modelReasoningEffort}"`);
  }
  args.push(input.prompt);
  return args;
}

async function parseGateReport(
  fs: FileSystemAdapter,
  taskRepoRoot: string,
  gate: CodexReviewGate,
  requestId: string | undefined,
  timestamp: string
): Promise<ParsedReport> {
  const reportPath = reportPathForGate(gate);
  const absolutePath = resolveRepoPath(taskRepoRoot, reportPath);
  if (!(await fs.pathExists(absolutePath))) {
    throw new VcmError({
      code: "CODEX_REVIEW_REPORT_MISSING",
      message: `Codex review report was not written: ${reportPath}`,
      statusCode: 500
    });
  }

  const content = await fs.readText(absolutePath);
  const parsedGate = matchField(content, "Gate");
  if (parsedGate && parsedGate !== gate) {
    throw new VcmError({
      code: "CODEX_REVIEW_REPORT_GATE_MISMATCH",
      message: `Codex review report gate is ${parsedGate}, expected ${gate}.`,
      statusCode: 500
    });
  }

  const parsedRequest = matchField(content, "Request");
  if (requestId && parsedRequest !== requestId) {
    throw new VcmError({
      code: "CODEX_REVIEW_REPORT_STALE",
      message: `Codex review report request is ${parsedRequest ?? "missing"}, expected ${requestId}.`,
      statusCode: 500
    });
  }

  const decision = normalizeDecision(matchField(content, "Decision"));
  if (!decision) {
    throw new VcmError({
      code: "CODEX_REVIEW_DECISION_MISSING",
      message: `Codex review report must contain Decision: approve or Decision: request_changes.`,
      statusCode: 500
    });
  }

  return {
    gate,
    requestId: parsedRequest,
    decision,
    summary: extractSummary(content),
    findings: extractFindings(content),
    reportPath,
    content,
    parsedAt: timestamp
  };
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
    version: CODEX_REVIEW_VERSION,
    requestId
  };
  await fs.writeJsonAtomic(requestPath, {
    ...current,
    ...patch,
    status,
    updatedAt: new Date().toISOString()
  });
}

function reportPathForGate(gate: CodexReviewGate): string {
  return path.posix.join(CODEX_REVIEW_DIR, `${gate}-review.md`);
}

function promptPathForGate(gate: CodexReviewGate): string {
  return path.posix.join(CODEX_DIR, "prompts", `${gate}-gate.md`);
}

function getIndexPath(taskRepoRoot: string): string {
  return resolveRepoPath(taskRepoRoot, path.posix.join(CODEX_REVIEW_DIR, "index.json"));
}

function createRequestId(gate: CodexReviewGate): string {
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

function extractTomlSection(content: string, sectionName: string): string {
  const lines = content.split(/\r?\n/);
  const sectionHeader = `[${sectionName}]`;
  const collected: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      if (inSection) {
        break;
      }
      inSection = trimmed === sectionHeader;
      continue;
    }
    if (inSection) {
      collected.push(line);
    }
  }
  return collected.join("\n");
}

function parseTomlBoolean(section: string, key: string): boolean | undefined {
  const match = section.match(new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?$`, "mi"));
  return match ? match[1] === "true" : undefined;
}

function parseTomlString(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?$`, "mi"));
  return match?.[1];
}

function parseTomlStringArray(section: string, key: string): string[] {
  const match = section.match(new RegExp(`${escapeRegex(key)}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m"));
  if (!match) {
    return [];
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((candidate) => candidate[1]);
}

function matchField(content: string, field: string): string | undefined {
  const match = content.match(new RegExp(`^\\s*${escapeRegex(field)}\\s*:\\s*(.+?)\\s*$`, "mi"));
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

function extractFindings(content: string): CodexReviewFinding[] {
  const findings: CodexReviewFinding[] = [];
  const blocks = content.split(/\n(?=#{2,4}\s+|-+\s*severity\s*:|severity\s*:)/i);
  for (const block of blocks) {
    const severity = normalizeSeverity(matchField(block, "severity"));
    const title = matchField(block, "title") ?? block.match(/^#{2,4}\s+(.+)$/m)?.[1]?.trim();
    if (!severity || !title) {
      continue;
    }
    findings.push({
      severity,
      title,
      file: matchField(block, "file"),
      line: parsePositiveInteger(matchField(block, "line")),
      evidence: matchField(block, "evidence") ?? "",
      expected: matchField(block, "expected") ?? "",
      gap: matchField(block, "gap") ?? "",
      risk: matchField(block, "risk") ?? ""
    });
  }
  return findings;
}

function normalizeGateStatus(value: unknown): CodexReviewGateStatus | undefined {
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
    ? value as CodexReviewGateStatus
    : undefined;
}

function normalizeDecision(value: unknown): CodexReviewDecision | undefined {
  return value === "approve" || value === "request_changes" ? value : undefined;
}

function normalizeSeverity(value: unknown): CodexReviewSeverity | undefined {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  return VALID_SEVERITIES.has(normalized as CodexReviewSeverity)
    ? normalized as CodexReviewSeverity
    : undefined;
}

function normalizeCallbackStatus(value: unknown): CodexReviewCallbackStatus | undefined {
  return value === "not_sent" || value === "sent" || value === "skipped" || value === "failed"
    ? value
    : undefined;
}

function isFinding(value: unknown): value is CodexReviewFinding {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as CodexReviewFinding;
  return Boolean(normalizeSeverity(candidate.severity) && candidate.title);
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
      code: "CODEX_REVIEW_REASON_REQUIRED",
      message: "A reason is required.",
      statusCode: 400
    });
  }
}

function renderProjectManagerCallback(input: {
  taskSlug: string;
  gate: CodexReviewGate;
  status: CodexReviewGateStatus;
  decision?: CodexReviewDecision;
  reportPath: string;
  error?: string;
}): string {
  const lines = [
    "[VCM CODEX REVIEW CALLBACK]",
    `task: ${input.taskSlug}`,
    `gate: ${input.gate}`,
    `status: ${input.status}`,
    `decision: ${input.decision ?? "none"}`,
    `report: ${input.reportPath}`,
    ...(input.error ? [`error: ${input.error}`] : []),
    "",
    "Use the vcm-codex-review-gate skill to handle this callback.",
    "If status is completed and decision is approve, continue the VCM flow.",
    "If decision is request_changes, analyze the report and route follow-up through the normal VCM roles.",
    "If status is failed, stop and ask the user to retry, skip, or override in VCM.",
    "[/VCM CODEX REVIEW CALLBACK]"
  ];
  return lines.join("\n");
}

function trimCommandOutput(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}...` : trimmed;
}

function errorMessage(error: unknown): string {
  if (error instanceof VcmError) {
    return error.hint ? `${error.message} ${error.hint}` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown Codex review error.";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
