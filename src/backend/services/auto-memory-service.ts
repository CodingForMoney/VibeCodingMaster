import { createHash } from "node:crypto";
import path from "node:path";
import type { ClaudeHookEventName } from "../../shared/types/claude-hook.js";
import type {
  ActiveMemoryReview,
  AutoMemoryStateReport,
  DurableDocAssignmentOwner,
  DurableDocAssignmentState,
  MemoryDraftState,
  MemoryFileContent,
  MemoryFileSummary,
  MemoryReviewTrigger,
  MemoryReviewRunSource,
  MemoryReviewRunStatus,
  MemoryReviewRunSummary,
  TaskRetrospectiveMemoryReadiness,
  VcmMemoryRoleName
} from "../../shared/types/memory.js";
import type { RoleName, VcmRoleName } from "../../shared/types/role.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import { checkMarkdownArtifact, readArtifactSectionContent, readArtifactSectionValue } from "../../shared/validation/artifact-check.js";
import { DOCS_UPDATE_COMMIT_RULE } from "../../shared/validation/artifact-contract.js";
import { resolveRepoPath, type FileSystemAdapter } from "../adapters/filesystem.js";
import type { GitAdapter } from "../adapters/git-adapter.js";
import { VcmError } from "../errors.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import {
  readVcmMemoryHostFrame,
  readVcmMemoryBlock,
  replaceVcmMemoryBlock,
  type VcmMemoryHostFrame
} from "../templates/harness/memory-block.js";
import type { AppSettingsService } from "./app-settings-service.js";
import {
  ARCHITECT_PLANNING_MEMORY_CANDIDATE_PATH,
  architectPlanningCandidateSnapshotPath,
  durableDocAssignmentReportPath,
  memoryReviewRoleDraftPath,
  MEMORY_REVIEW_RUNS_ROOT,
  MEMORY_REVIEW_STATE_PATH
} from "./memory-review-paths.js";
import {
  parseMemoryProposal,
  type MemoryProposalItem,
  type MemoryProposalOperation,
  validateMemoryProposal
} from "./memory-proposal-validation.js";
import type { SessionService } from "./session-service.js";

const MEMORY_FILE_DEFINITIONS = [
  { path: "CLAUDE.md", title: "Shared Memory" },
  { path: ".claude/agents/project-manager.md", title: "Project Manager Memory", role: "project-manager" },
  { path: ".claude/agents/architect.md", title: "Architect Memory", role: "architect" },
  { path: ".claude/agents/coder.md", title: "Coder Memory", role: "coder" },
  { path: ".claude/agents/tester.md", title: "Tester Memory", role: "tester" },
  { path: ".claude/agents/reviewer.md", title: "Reviewer Memory", role: "reviewer" },
  { path: ".claude/agents/harness-engineer.md", title: "Harness Engineer Memory", role: "harness-engineer" }
] as const satisfies ReadonlyArray<{ path: string; title: string; role?: VcmMemoryRoleName }>;

type WorkflowMemoryRole = Exclude<VcmMemoryRoleName, "harness-engineer">;
type MemorySet = Record<string, string>;
type MemoryReviewTarget = "shared" | VcmMemoryRoleName;

export interface MemoryReviewCandidate {
  id: string;
  source: string;
  operation: MemoryProposalOperation;
  target: MemoryReviewTarget;
  content?: string;
  existing?: string;
}

export interface ExistingMemoryReviewEntry {
  itemId: string;
  target: MemoryReviewTarget;
  memoryPath: string;
  entry: string;
}

interface StoredMemoryReviewState {
  version: 1;
  runId: string;
  taskSlug: string;
  status: "collecting" | "reviewing" | "documenting" | "failed";
  finalAcceptanceHash: string;
  trigger: MemoryReviewTrigger;
  createdAt: string;
  updatedAt: string;
  drafts: MemoryDraftState[];
  assignments: DurableDocAssignmentState[];
  reviewPromptDispatchedAt?: string;
  retrospectiveReportPath?: string;
  reviewBaseCommit?: string;
  error?: string;
}

type StoredMemoryReviewStateOnDisk = Omit<StoredMemoryReviewState, "drafts"> & {
  drafts: Array<Omit<MemoryDraftState, "status"> & {
    status: MemoryDraftState["status"] | "running";
  }>;
};

interface StoredMemoryReviewRun {
  version: 1;
  runId: string;
  taskSlug: string;
  source: MemoryReviewRunSource;
  status: MemoryReviewRunStatus | "collecting" | "reviewing";
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  failedAt?: string;
  revertedAt?: string;
  finalAcceptanceHash?: string;
  trigger?: MemoryReviewTrigger;
  beforeHashes: Record<string, string>;
  afterHashes?: Record<string, string>;
  diff?: string;
  assignments?: DurableDocAssignmentState[];
  error?: string;
}

interface HarnessMemoryReviewDecision {
  itemId: string;
  source: "existing" | "proposal";
  target: MemoryReviewTarget;
  entry: string;
  decision:
    | "retain"
    | "update"
    | "remove"
    | "move-to-durable-doc"
    | "keep-in-memory"
    | "keep-memory-reference"
    | "reject";
  reason: string;
  impactIfAbsent: string;
  evidence: string[];
  finalContent: string;
  durableDocPath: string;
}

interface HarnessDurableDocAssignmentInput {
  sourceMemoryPath: string;
  sourceEntry: string;
  targetPath: string;
  content: string;
  reason: string;
  evidence: string[];
}

interface HarnessMemoryReviewResult {
  version: 1;
  runId: string;
  memoryCommit: string;
  decisions: HarnessMemoryReviewDecision[];
  durableDocAssignments: HarnessDurableDocAssignmentInput[];
}

export interface ReconcileAutoMemoryInput {
  baseRepoRoot: string;
  taskRepoRoot: string;
  taskSlug: string;
  handoffDir: string;
  roundReady: boolean;
  requestTrigger?: MemoryReviewTrigger;
}

export interface AutoMemoryService {
  reconcileTask(input: ReconcileAutoMemoryInput): Promise<AutoMemoryStateReport>;
  getState(baseRepoRoot: string, taskRepoRoot: string): Promise<AutoMemoryStateReport>;
  getTaskRetrospectiveReadiness(input: ReconcileAutoMemoryInput): Promise<TaskRetrospectiveMemoryReadiness>;
  getFile(baseRepoRoot: string, taskRepoRoot: string, filePath: string): Promise<MemoryFileContent>;
  updateFile(baseRepoRoot: string, taskRepoRoot: string, taskSlug: string, filePath: string, content: string): Promise<AutoMemoryStateReport>;
  revertRun(baseRepoRoot: string, taskRepoRoot: string, runId: string): Promise<AutoMemoryStateReport>;
  retryFailedReview(baseRepoRoot: string, taskRepoRoot: string): Promise<AutoMemoryStateReport>;
  retryDurableDocAssignment(
    baseRepoRoot: string,
    taskRepoRoot: string,
    assignmentId: string
  ): Promise<AutoMemoryStateReport>;
  resolveDurableDocAssignmentOwner(
    baseRepoRoot: string,
    taskRepoRoot: string,
    assignmentId: string,
    owner: DurableDocAssignmentOwner
  ): Promise<AutoMemoryStateReport>;
  prepareTaskRetrospectiveReview(
    taskRepoRoot: string,
    retrospectiveReportPath: string
  ): Promise<TaskRetrospectiveMemoryReviewContext | undefined>;
  cancelTaskRetrospectiveReview(taskRepoRoot: string, runId: string): Promise<void>;
  isRoleMemoryTurn(taskRepoRoot: string, role: RoleName): Promise<boolean>;
  getDurableDocAssignment(taskRepoRoot: string, role: RoleName): Promise<DurableDocAssignmentState | undefined>;
  handleRoleHook(input: AutoMemoryRoleHookInput): Promise<boolean>;
  handleHarnessEngineerHook(input: AutoMemoryHarnessHookInput): Promise<boolean>;
  assertHarnessEngineerAvailable(taskRepoRoot: string): Promise<void>;
}

export interface TaskRetrospectiveMemoryReviewContext {
  runId: string;
  roleDraftsPath: string;
  currentMemoryPath: string;
  activeMemoryPaths: string[];
  existingEntriesPath: string;
  proposalCandidates: MemoryReviewCandidate[];
  reviewResultPath: string;
  planningCandidatePath?: string;
}

export interface AutoMemoryRoleHookInput {
  baseRepoRoot: string;
  taskRepoRoot: string;
  taskSlug: string;
  role: RoleName;
  eventName: ClaudeHookEventName;
}

export interface AutoMemoryHarnessHookInput {
  baseRepoRoot: string;
  taskRepoRoot: string;
  taskSlug: string;
  eventName: ClaudeHookEventName;
}

export interface AutoMemoryServiceDeps {
  fs: FileSystemAdapter;
  git: Pick<GitAdapter, "commitPaths" | "getDiff" | "getHeadCommit" | "getChangedPaths" | "getCommitList" | "getCommitInfo">;
  runtime: Pick<TerminalRuntime, "getSession" | "write">;
  sessionService: Pick<
    SessionService,
    | "getRoleSession"
    | "startRoleSession"
    | "resumeRoleSession"
  >;
  appSettings: Pick<AppSettingsService, "getPreferences" | "getGateReviewSettings">;
  isHarnessEngineerAvailable?: (repoRoot: string) => Promise<boolean>;
  now?: () => string;
}

export function createAutoMemoryService(deps: AutoMemoryServiceDeps): AutoMemoryService {
  const now = deps.now ?? (() => new Date().toISOString());
  const taskLocks = new Map<string, Promise<unknown>>();

  async function withTaskLock<T>(taskRepoRoot: string, operation: () => Promise<T>): Promise<T> {
    const previous = taskLocks.get(taskRepoRoot) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    taskLocks.set(taskRepoRoot, current);
    try {
      return await current;
    } finally {
      if (taskLocks.get(taskRepoRoot) === current) {
        taskLocks.delete(taskRepoRoot);
      }
    }
  }

  async function readMemorySet(repoRoot: string): Promise<MemorySet> {
    const memory: MemorySet = {};
    for (const definition of MEMORY_FILE_DEFINITIONS) {
      const hostContent = await deps.fs.readText(resolveRepoPath(repoRoot, definition.path));
      const blockContent = readVcmMemoryBlock(hostContent);
      if (blockContent === undefined) {
        throw missingMemoryBlockError(definition.path);
      }
      memory[definition.path] = blockContent;
    }
    return memory;
  }

  async function writeMemorySet(repoRoot: string, memory: MemorySet): Promise<void> {
    assertCompleteMemorySet(memory);
    for (const definition of MEMORY_FILE_DEFINITIONS) {
      const targetPath = resolveRepoPath(repoRoot, definition.path);
      const hostContent = await deps.fs.readText(targetPath);
      const content = replaceVcmMemoryBlock(hostContent, memory[definition.path]);
      if (deps.fs.writeTextAtomic) {
        await deps.fs.writeTextAtomic(targetPath, content);
      } else {
        await deps.fs.writeText(targetPath, content);
      }
    }
  }

  async function applyAndCommitMemorySet(
    taskRepoRoot: string,
    before: MemorySet,
    after: MemorySet,
    commitMessage: string
  ): Promise<void> {
    assertCompleteMemorySet(after);
    const changedPaths = MEMORY_FILE_DEFINITIONS
      .filter((definition) => before[definition.path] !== after[definition.path])
      .map((definition) => definition.path);
    if (changedPaths.length === 0) {
      return;
    }
    const current = await readMemorySet(taskRepoRoot);
    if (!sameHashes(hashMemorySet(current), hashMemorySet(before))) {
      throw new VcmError({
        code: "MEMORY_TARGET_CHANGED",
        message: "VCM memory changed while the review was in progress.",
        statusCode: 409,
        hint: "Review the current memory, then retry the memory review."
      });
    }
    const existingDiff = await deps.git.getDiff(taskRepoRoot, "HEAD", null, changedPaths);
    if (existingDiff.trim()) {
      throw new VcmError({
        code: "MEMORY_HOST_FILE_DIRTY",
        message: "A file containing VCM memory already has uncommitted changes.",
        statusCode: 409,
        hint: "Commit or discard the existing host-file changes before applying memory."
      });
    }

    await writeMemorySet(taskRepoRoot, after);
    try {
      await deps.git.commitPaths(taskRepoRoot, commitMessage, changedPaths);
    } catch (error) {
      await writeMemorySet(taskRepoRoot, before);
      throw error;
    }
  }

  async function writeRunMemorySet(
    taskRepoRoot: string,
    runId: string,
    snapshot: "before" | "after",
    memory: MemorySet
  ): Promise<void> {
    assertCompleteMemorySet(memory);
    for (const definition of MEMORY_FILE_DEFINITIONS) {
      await deps.fs.writeText(
        resolveRepoPath(taskRepoRoot, memoryRunFilePath(runId, snapshot, definition.path)),
        ensureTrailingNewline(memory[definition.path])
      );
    }
  }

  async function readRunMemorySet(
    taskRepoRoot: string,
    runId: string,
    snapshot: "before" | "after"
  ): Promise<MemorySet> {
    const memory: MemorySet = {};
    for (const definition of MEMORY_FILE_DEFINITIONS) {
      const memoryPath = resolveRepoPath(taskRepoRoot, memoryRunFilePath(runId, snapshot, definition.path));
      if (!(await deps.fs.pathExists(memoryPath))) {
        throw new Error(`Missing memory review output: ${definition.path}`);
      }
      memory[definition.path] = await deps.fs.readText(memoryPath);
    }
    return memory;
  }

  async function writeRunMemoryHostSnapshot(taskRepoRoot: string, runId: string): Promise<void> {
    for (const definition of MEMORY_FILE_DEFINITIONS) {
      await deps.fs.writeText(
        resolveRepoPath(taskRepoRoot, memoryRunHostFilePath(runId, definition.path)),
        await deps.fs.readText(resolveRepoPath(taskRepoRoot, definition.path))
      );
    }
  }

  async function assertOnlyMemoryBlocksChanged(
    taskRepoRoot: string,
    runId: string
  ): Promise<void> {
    for (const definition of MEMORY_FILE_DEFINITIONS) {
      const beforeHost = await deps.fs.readText(
        resolveRepoPath(taskRepoRoot, memoryRunHostFilePath(runId, definition.path))
      );
      const currentHost = await deps.fs.readText(resolveRepoPath(taskRepoRoot, definition.path));
      const beforeFrame = readVcmMemoryHostFrame(beforeHost);
      const currentFrame = readVcmMemoryHostFrame(currentHost);
      if (!beforeFrame || !currentFrame) {
        throw missingMemoryBlockError(definition.path);
      }
      const difference = describeMemoryHostDifference(beforeFrame, currentFrame);
      if (difference) {
        throw new VcmError({
          code: "MEMORY_REVIEW_SCOPE_CHANGED",
          message: `Harness Engineer changed content outside the VCM memory block: ${definition.path} (${difference}).`,
          statusCode: 409,
          hint: "Restore non-memory content, keep only the reviewed <VCM-memory> edit, and commit the correction."
        });
      }
    }
  }

  async function getState(baseRepoRoot: string, taskRepoRoot: string): Promise<AutoMemoryStateReport> {
    let [active, runs, memoryFiles] = await Promise.all([
      loadActiveState(taskRepoRoot),
      listRuns(taskRepoRoot),
      listMemoryFiles(taskRepoRoot)
    ]);
    if (active && !preserveDisabledReview(active) && !(await deps.appSettings.getPreferences()).autoMemoryEnabled) {
      await discardActiveReview(taskRepoRoot, active);
      active = undefined;
      runs = await listRuns(taskRepoRoot);
    }
    return {
      version: 1,
      status: active?.status ?? "idle",
      files: memoryFiles.files,
      runs,
      ...(active ? { active: toActiveReview(active) } : {}),
      warnings: memoryFiles.warnings
    };
  }

  async function reconcileTask(input: ReconcileAutoMemoryInput): Promise<AutoMemoryStateReport> {
    const active = await loadActiveState(input.taskRepoRoot);
    const preferences = await deps.appSettings.getPreferences();
    if (!preferences.autoMemoryEnabled) {
      if (active?.status === "documenting") {
        await dispatchCurrentDurableDocAssignment(input.baseRepoRoot, input.taskRepoRoot, active);
      } else if (active?.status === "reviewing" && active.reviewPromptDispatchedAt) {
        return getState(input.baseRepoRoot, input.taskRepoRoot);
      } else if (active && !preserveDisabledReview(active)) {
        await discardActiveReview(input.taskRepoRoot, active);
      }
      return getState(input.baseRepoRoot, input.taskRepoRoot);
    }
    await assertMemoryBlocksInstalled(deps.fs, input.taskRepoRoot);
    if (active?.status === "collecting") {
      await dispatchCurrentDraft(input.baseRepoRoot, input.taskRepoRoot, active);
      return getState(input.baseRepoRoot, input.taskRepoRoot);
    }
    if (active?.status === "reviewing") {
      return getState(input.baseRepoRoot, input.taskRepoRoot);
    }
    if (active?.status === "documenting") {
      await dispatchCurrentDurableDocAssignment(input.baseRepoRoot, input.taskRepoRoot, active);
      return getState(input.baseRepoRoot, input.taskRepoRoot);
    }
    if (active || !input.roundReady || !input.requestTrigger) {
      return getState(input.baseRepoRoot, input.taskRepoRoot);
    }

    if (deps.isHarnessEngineerAvailable && !(await deps.isHarnessEngineerAvailable(input.baseRepoRoot))) {
      return getState(input.baseRepoRoot, input.taskRepoRoot);
    }

    const finalAcceptanceHash = await readAcceptedFinalAcceptanceHash(input.taskRepoRoot, input.handoffDir);
    if (!finalAcceptanceHash) {
      return getState(input.baseRepoRoot, input.taskRepoRoot);
    }
    if (await hasCompletedRunForFinalAcceptance(input.taskRepoRoot, finalAcceptanceHash)) {
      return getState(input.baseRepoRoot, input.taskRepoRoot);
    }

    const gateSettings = await deps.appSettings.getGateReviewSettings(input.baseRepoRoot, input.taskSlug);
    const roles: WorkflowMemoryRole[] = ["project-manager", "architect", "coder", "tester"];
    if (gateSettings.enabled) {
      roles.push("reviewer");
    }
    const timestamp = now();
    const runId = createRunId(timestamp, "auto");
    const drafts: MemoryDraftState[] = roles.map((role) => ({
      role,
      path: memoryReviewRoleDraftPath(runId, role),
      status: "pending"
    }));
    const state: StoredMemoryReviewState = {
      version: 1,
      runId,
      taskSlug: input.taskSlug,
      status: "collecting",
      finalAcceptanceHash,
      trigger: input.requestTrigger,
      createdAt: timestamp,
      updatedAt: timestamp,
      drafts,
      assignments: []
    };
    const before = await readMemorySet(input.taskRepoRoot);
    await writeRunMemorySet(input.taskRepoRoot, runId, "before", before);
    await snapshotArchitectPlanningCandidate(input.taskRepoRoot, runId);
    await persistRun(input.taskRepoRoot, {
      version: 1,
      runId,
      taskSlug: input.taskSlug,
      source: "auto",
      status: "collecting",
      createdAt: timestamp,
      updatedAt: timestamp,
      finalAcceptanceHash,
      trigger: input.requestTrigger,
      beforeHashes: hashMemorySet(before)
    });
    await persistActiveState(input.taskRepoRoot, state);
    await dispatchCurrentDraft(input.baseRepoRoot, input.taskRepoRoot, state);
    return getState(input.baseRepoRoot, input.taskRepoRoot);
  }

  async function getTaskRetrospectiveReadiness(
    input: ReconcileAutoMemoryInput
  ): Promise<TaskRetrospectiveMemoryReadiness> {
    const preferences = await deps.appSettings.getPreferences();
    if (!preferences.autoMemoryEnabled) {
      return { ready: true, disposition: "disabled" };
    }
    const finalAcceptanceHash = await readAcceptedFinalAcceptanceHash(input.taskRepoRoot, input.handoffDir);
    if (!finalAcceptanceHash) {
      return { ready: true, disposition: "not-applicable" };
    }
    const active = await loadActiveState(input.taskRepoRoot);
    if (active) {
      const disposition = active.status;
      if (disposition === "reviewing") {
        return {
          ready: true,
          disposition,
          trigger: active.trigger
        };
      }
      return {
        ready: false,
        disposition,
        trigger: active.trigger,
        reason: disposition === "failed"
          ? "Auto Memory failed for this task. Retry it before Task Harness Retrospective."
          : `Auto Memory is ${disposition} for this task.`
      };
    }
    const completedRun = await findCompletedRunForFinalAcceptance(input.taskRepoRoot, finalAcceptanceHash);
    if (completedRun) {
      return { ready: true, disposition: "completed", trigger: completedRun.trigger };
    }
    return {
      ready: false,
      disposition: "pending",
      reason: "Auto Memory proposals must be collected before Task Harness Retrospective."
    };
  }

  async function prepareTaskRetrospectiveReview(
    taskRepoRoot: string,
    retrospectiveReportPath: string
  ): Promise<TaskRetrospectiveMemoryReviewContext | undefined> {
    if (!(await deps.appSettings.getPreferences()).autoMemoryEnabled) {
      return undefined;
    }
    const state = await loadActiveState(taskRepoRoot);
    if (!state) {
      return undefined;
    }
    if (state.status !== "reviewing") {
      throw new VcmError({
        code: "AUTO_MEMORY_NOT_READY",
        message: "Auto Memory proposals are not ready for Task Harness Retrospective.",
        statusCode: 409,
        hint: "Wait for every workflow role to finish its memory proposal, then retry Task Harness Retrospective."
      });
    }
    if (state.reviewPromptDispatchedAt) {
      throw new VcmError({
        code: "AUTO_MEMORY_REVIEW_RUNNING",
        message: "Task Harness Retrospective is already reviewing Auto Memory.",
        statusCode: 409
      });
    }

    const proposalCandidates = await readReviewCandidates(taskRepoRoot, state);
    const currentMemory = await readMemorySet(taskRepoRoot);
    const beforeMemory = await readRunMemorySet(taskRepoRoot, state.runId, "before");
    if (!sameHashes(hashMemorySet(currentMemory), hashMemorySet(beforeMemory))) {
      throw new VcmError({
        code: "MEMORY_TARGET_CHANGED",
        message: "VCM memory changed while role proposals were being collected.",
        statusCode: 409,
        hint: "Review the current memory, then retry Auto Memory."
      });
    }
    const memoryPaths: string[] = MEMORY_FILE_DEFINITIONS.map((definition) => definition.path);
    const existingDiff = await deps.git.getDiff(taskRepoRoot, "HEAD", null, memoryPaths);
    if (existingDiff.trim()) {
      throw new VcmError({
        code: "MEMORY_HOST_FILE_DIRTY",
        message: "A file containing VCM memory has uncommitted changes before Harness Engineer review.",
        statusCode: 409,
        hint: "Commit or discard the existing host-file changes before starting Task Harness Retrospective."
      });
    }
    await writeRunMemoryHostSnapshot(taskRepoRoot, state.runId);
    const existingEntries = collectExistingMemoryReviewEntries(beforeMemory);
    const timestamp = now();
    state.reviewPromptDispatchedAt = timestamp;
    state.retrospectiveReportPath = retrospectiveReportPath;
    state.reviewBaseCommit = await deps.git.getHeadCommit(taskRepoRoot);
    state.updatedAt = timestamp;
    await persistActiveState(taskRepoRoot, state);

    const runRoot = resolveRepoPath(taskRepoRoot, `${MEMORY_REVIEW_RUNS_ROOT}/${state.runId}`);
    const existingEntriesPath = path.join(runRoot, "existing-entries.json");
    await deps.fs.writeJsonAtomic(existingEntriesPath, {
      version: 1,
      runId: state.runId,
      entries: existingEntries
    });
    const planningCandidatePath = await findPlanningCandidateSnapshot(taskRepoRoot, state.runId);
    return {
      runId: state.runId,
      roleDraftsPath: path.join(runRoot, "drafts"),
      currentMemoryPath: path.join(runRoot, "before"),
      activeMemoryPaths: memoryPaths.map((memoryPath) => resolveRepoPath(taskRepoRoot, memoryPath)),
      existingEntriesPath,
      reviewResultPath: path.join(runRoot, "review-result.json"),
      proposalCandidates,
      ...(planningCandidatePath
        ? { planningCandidatePath: resolveRepoPath(taskRepoRoot, planningCandidatePath) }
        : {})
    };
  }

  async function cancelTaskRetrospectiveReview(taskRepoRoot: string, runId: string): Promise<void> {
    const state = await loadActiveState(taskRepoRoot);
    if (!state || state.runId !== runId || state.status !== "reviewing") {
      return;
    }
    delete state.reviewPromptDispatchedAt;
    delete state.retrospectiveReportPath;
    delete state.reviewBaseCommit;
    state.updatedAt = now();
    await persistActiveState(taskRepoRoot, state);
  }

  async function isRoleMemoryTurn(taskRepoRoot: string, role: RoleName): Promise<boolean> {
    const state = await loadActiveState(taskRepoRoot);
    const draft = state?.status === "collecting" ? currentDraft(state) : undefined;
    if (draft?.role === role && draft.status === "dispatched") {
      return true;
    }
    const assignment = state?.status === "documenting" ? currentDurableDocAssignment(state) : undefined;
    if (!assignment) {
      return false;
    }
    if (assignment.status === "resolving-owner") {
      return role === "project-manager";
    }
    return assignment.status === "running" && assignment.owner === role;
  }

  async function getDurableDocAssignment(taskRepoRoot: string, role: RoleName): Promise<DurableDocAssignmentState | undefined> {
    const state = await loadActiveState(taskRepoRoot);
    const assignment = state?.status === "documenting" ? currentDurableDocAssignment(state) : undefined;
    return assignment?.status === "running" && assignment.owner === role ? assignment : undefined;
  }

  async function handleRoleHook(input: AutoMemoryRoleHookInput): Promise<boolean> {
    const state = await loadActiveState(input.taskRepoRoot);
    if (!(await deps.appSettings.getPreferences()).autoMemoryEnabled && !preserveDisabledReview(state)) {
      if (state) {
        await discardActiveReview(input.taskRepoRoot, state);
        return true;
      }
      return false;
    }
    if (state?.status === "documenting") {
      return handleDurableDocRoleHook(input, state);
    }
    const draft = state?.status === "collecting" ? currentDraft(state) : undefined;
    if (!state || !draft || draft.role !== input.role) {
      return false;
    }
    if (input.eventName === "UserPromptSubmit" || input.eventName === "PostCompact") {
      return true;
    }
    if (input.eventName === "StopFailure") {
      await failReview(input.taskRepoRoot, state, `${input.role} memory draft turn failed.`);
      return true;
    }
    if (input.eventName !== "Stop") {
      return true;
    }

    const draftAbsolutePath = resolveRepoPath(input.taskRepoRoot, draft.path);
    if (!(await deps.fs.pathExists(draftAbsolutePath))) {
      await failReview(input.taskRepoRoot, state, `${input.role} did not write the required memory draft: ${draft.path}`);
      return true;
    }
    const content = (await deps.fs.readText(draftAbsolutePath)).trim();
    const validationError = content ? validateMemoryProposal(content) : "is empty";
    if (validationError) {
      await failReview(
        input.taskRepoRoot,
        state,
        `${input.role} memory draft ${validationError}.`
      );
      return true;
    }

    draft.status = "completed";
    state.updatedAt = now();
    const next = currentDraft(state);
    if (next) {
      await persistActiveState(input.taskRepoRoot, state);
      await dispatchCurrentDraft(input.baseRepoRoot, input.taskRepoRoot, state);
      return true;
    }

    state.status = "reviewing";
    await persistActiveState(input.taskRepoRoot, state);
    await updateRunStatus(input.taskRepoRoot, state.runId, "reviewing", state.updatedAt);
    return true;
  }

  async function handleHarnessEngineerHook(input: AutoMemoryHarnessHookInput): Promise<boolean> {
    const state = await loadActiveState(input.taskRepoRoot);
    if (!(await deps.appSettings.getPreferences()).autoMemoryEnabled && !preserveDisabledReview(state)) {
      if (state) {
        await discardActiveReview(input.taskRepoRoot, state);
        return true;
      }
      return false;
    }
    if (state?.status === "reviewing" && !state.reviewPromptDispatchedAt) {
      return false;
    }
    if (!state || state.status !== "reviewing") {
      return false;
    }
    if (input.eventName === "UserPromptSubmit" || input.eventName === "PostCompact") {
      return true;
    }
    if (input.eventName === "StopFailure") {
      await failReview(input.taskRepoRoot, state, "Task Harness Retrospective memory review turn failed.");
      return true;
    }
    if (input.eventName === "Stop") {
      if (
        !state.retrospectiveReportPath
        || !(await deps.fs.pathExists(state.retrospectiveReportPath))
        || !(await deps.fs.readText(state.retrospectiveReportPath)).trim()
      ) {
        await failReview(
          input.taskRepoRoot,
          state,
          "Task Harness Retrospective did not write the required retrospective report."
        );
        return true;
      }
      try {
        await recordHarnessEngineerMemoryResult(input.taskRepoRoot, state);
        if (state.assignments.length > 0) {
          await dispatchCurrentDurableDocAssignment(input.baseRepoRoot, input.taskRepoRoot, state);
        }
      } catch (error) {
        await failReview(
          input.taskRepoRoot,
          state,
          `Harness Engineer memory result could not be recorded: ${errorMessage(error)}`
        );
        return true;
      }
      return true;
    }
    return true;
  }

  async function getFile(_baseRepoRoot: string, taskRepoRoot: string, filePath: string): Promise<MemoryFileContent> {
    await assertMemoryBlocksInstalled(deps.fs, taskRepoRoot);
    const definition = requireMemoryFileDefinition(filePath);
    const hostContent = await deps.fs.readText(resolveRepoPath(taskRepoRoot, definition.path));
    const content = readVcmMemoryBlock(hostContent);
    if (content === undefined) {
      throw missingMemoryBlockError(definition.path);
    }
    return {
      path: definition.path,
      title: definition.title,
      ...("role" in definition ? { role: definition.role } : {}),
      sizeBytes: Buffer.byteLength(content, "utf8"),
      content,
      editable: true
    };
  }

  async function updateFile(
    baseRepoRoot: string,
    taskRepoRoot: string,
    taskSlug: string,
    filePath: string,
    content: string
  ): Promise<AutoMemoryStateReport> {
    await assertNoActiveReview(taskRepoRoot);
    const definition = requireMemoryFileDefinition(filePath);
    const before = await readMemorySet(taskRepoRoot);
    const normalizedContent = ensureTrailingNewline(content);
    if (before[definition.path] === normalizedContent) {
      return getState(baseRepoRoot, taskRepoRoot);
    }
    const after = { ...before, [definition.path]: normalizedContent };
    await createAppliedRun(taskRepoRoot, taskSlug, "user", before, after);
    return getState(baseRepoRoot, taskRepoRoot);
  }

  async function revertRun(baseRepoRoot: string, taskRepoRoot: string, runId: string): Promise<AutoMemoryStateReport> {
    await assertNoActiveReview(taskRepoRoot);
    const run = await readRun(taskRepoRoot, requireSafeRunId(runId));
    if (run.status !== "applied" || run.revertedAt || !run.afterHashes) {
      throw new VcmError({
        code: "MEMORY_RUN_NOT_REVERTIBLE",
        message: `Memory review run cannot be reverted: ${runId}`,
        statusCode: 409
      });
    }
    const current = await readMemorySet(taskRepoRoot);
    if (!sameHashes(hashMemorySet(current), run.afterHashes)) {
      throw new VcmError({
        code: "MEMORY_RUN_CHANGED",
        message: "Current memory has changed since this review run was applied.",
        statusCode: 409,
        hint: "Review the current memory and edit it manually instead of overwriting newer changes."
      });
    }
    const before = await readRunMemorySet(taskRepoRoot, run.runId, "before");
    await applyAndCommitMemorySet(taskRepoRoot, current, before, "chore: revert VCM memory");
    const timestamp = now();
    await persistRun(taskRepoRoot, {
      ...run,
      status: "reverted",
      revertedAt: timestamp,
      updatedAt: timestamp
    });
    return getState(baseRepoRoot, taskRepoRoot);
  }

  async function retryFailedReview(baseRepoRoot: string, taskRepoRoot: string): Promise<AutoMemoryStateReport> {
    const state = await loadActiveState(taskRepoRoot);
    if (!state || state.status !== "failed") {
      throw new VcmError({
        code: "MEMORY_REVIEW_NOT_FAILED",
        message: "There is no failed Auto Memory review to retry.",
        statusCode: 409
      });
    }
    if (state.assignments.length > 0) {
      throw new VcmError({
        code: "DURABLE_DOC_ASSIGNMENTS_FAILED",
        message: "Memory was already applied. Retry the failed durable-document assignments individually.",
        statusCode: 409
      });
    }
    await clearActiveState(taskRepoRoot);
    return getState(baseRepoRoot, taskRepoRoot);
  }

  async function retryDurableDocAssignment(
    baseRepoRoot: string,
    taskRepoRoot: string,
    assignmentId: string
  ): Promise<AutoMemoryStateReport> {
    const state = await loadActiveState(taskRepoRoot);
    const assignment = state && (state.status === "documenting" || state.status === "failed")
      ? state.assignments.find((candidate) => candidate.id === assignmentId)
      : undefined;
    if (!state || !assignment || assignment.status !== "failed") {
      throw new VcmError({
        code: "DURABLE_DOC_ASSIGNMENT_NOT_FAILED",
        message: `There is no failed durable-document assignment to retry: ${assignmentId}`,
        statusCode: 409
      });
    }
    assignment.status = assignment.owner ? "pending" : "waiting-owner";
    assignment.updatedAt = now();
    delete assignment.requestedOwner;
    delete assignment.dispatchedAt;
    state.status = "documenting";
    delete state.error;
    await persistMemoryAssignmentState(taskRepoRoot, state);
    await dispatchCurrentDurableDocAssignment(baseRepoRoot, taskRepoRoot, state);
    return getState(baseRepoRoot, taskRepoRoot);
  }

  async function resolveDurableDocAssignmentOwner(
    baseRepoRoot: string,
    taskRepoRoot: string,
    assignmentId: string,
    owner: DurableDocAssignmentOwner
  ): Promise<AutoMemoryStateReport> {
    const state = await loadActiveState(taskRepoRoot);
    const assignment = state?.status === "documenting"
      ? currentDurableDocAssignment(state)
      : undefined;
    if (!state || !assignment || assignment.id !== assignmentId || assignment.status !== "resolving-owner") {
      throw new VcmError({
        code: "DURABLE_DOC_OWNER_RESOLUTION_NOT_ACTIVE",
        message: `Durable-document assignment is not waiting for PM owner resolution: ${assignmentId}`,
        statusCode: 409
      });
    }
    assignment.requestedOwner = owner;
    assignment.updatedAt = now();
    await persistMemoryAssignmentState(taskRepoRoot, state);
    return getState(baseRepoRoot, taskRepoRoot);
  }

  async function assertHarnessEngineerAvailable(taskRepoRoot: string): Promise<void> {
    const state = await loadActiveState(taskRepoRoot);
    if (state && !preserveDisabledReview(state) && !(await deps.appSettings.getPreferences()).autoMemoryEnabled) {
      await discardActiveReview(taskRepoRoot, state);
      return;
    }
    if (!state || state.status === "failed") {
      return;
    }
    throw new VcmError({
      code: "HARNESS_ENGINEER_MEMORY_ACTIVE",
      message: "Harness Engineer is reserved for the active Auto Memory review.",
      statusCode: 409,
      hint: "Wait for the memory review to finish before starting another Harness Engineer workflow."
    });
  }

  async function assertNoActiveReview(taskRepoRoot: string): Promise<void> {
    const state = await loadActiveState(taskRepoRoot);
    if (state && !preserveDisabledReview(state) && !(await deps.appSettings.getPreferences()).autoMemoryEnabled) {
      await discardActiveReview(taskRepoRoot, state);
      return;
    }
    if (!state) {
      return;
    }
    throw new VcmError({
      code: "MEMORY_REVIEW_ACTIVE",
      message: "Memory cannot be edited while an Auto Memory review is active.",
      statusCode: 409,
      hint: state.status === "failed"
        ? "Retry the failed review before editing memory."
        : "Wait for the active memory review to finish."
    });
  }

  async function handleDurableDocRoleHook(
    input: AutoMemoryRoleHookInput,
    state: StoredMemoryReviewState
  ): Promise<boolean> {
    const assignment = currentDurableDocAssignment(state);
    if (!assignment) {
      return false;
    }
    const expectedRole = assignment.status === "resolving-owner"
      ? "project-manager"
      : assignment.status === "running"
        ? assignment.owner
        : undefined;
    if (expectedRole !== input.role) {
      return false;
    }
    if (input.eventName === "UserPromptSubmit" || input.eventName === "PostCompact") {
      return true;
    }
    if (input.eventName === "StopFailure") {
      assignment.status = "failed";
      assignment.error = `${input.role} durable-document assignment turn failed.`;
      assignment.updatedAt = now();
      await persistMemoryAssignmentState(input.taskRepoRoot, state);
      await dispatchCurrentDurableDocAssignment(input.baseRepoRoot, input.taskRepoRoot, state);
      return true;
    }
    if (input.eventName !== "Stop") {
      return true;
    }

    if (assignment.status === "resolving-owner") {
      if (!assignment.requestedOwner) {
        return true;
      }
      assignment.owner = assignment.requestedOwner;
      delete assignment.requestedOwner;
      assignment.status = "pending";
      assignment.updatedAt = now();
      await persistMemoryAssignmentState(input.taskRepoRoot, state);
      await dispatchCurrentDurableDocAssignment(input.baseRepoRoot, input.taskRepoRoot, state);
      return true;
    }

    try {
      assignment.commit = await validateDurableDocAssignmentCompletion(input.taskRepoRoot, assignment);
      assignment.status = "completed";
      assignment.completedAt = now();
      assignment.updatedAt = assignment.completedAt;
      delete assignment.error;
      await persistMemoryAssignmentState(input.taskRepoRoot, state);
    } catch (error) {
      assignment.status = "failed";
      assignment.error = `Durable-document assignment could not be completed: ${errorMessage(error)}`;
      assignment.updatedAt = now();
      await persistMemoryAssignmentState(input.taskRepoRoot, state);
    }
    await dispatchCurrentDurableDocAssignment(input.baseRepoRoot, input.taskRepoRoot, state);
    return true;
  }

  async function dispatchCurrentDurableDocAssignment(
    baseRepoRoot: string,
    taskRepoRoot: string,
    state: StoredMemoryReviewState
  ): Promise<void> {
    let assignment = currentDurableDocAssignment(state);
    if (!assignment) {
      await finishDurableDocAssignments(taskRepoRoot, state);
      return;
    }

    if (assignment.status === "running" || assignment.status === "resolving-owner") {
      const role = assignment.status === "resolving-owner" ? "project-manager" : assignment.owner;
      if (!role) {
        return;
      }
      const existing = await deps.sessionService.getRoleSession(baseRepoRoot, state.taskSlug, role);
      if (existing?.activityStatus === "running" && deps.runtime.getSession(existing.id)) {
        return;
      }
      assignment.status = assignment.owner ? "pending" : "waiting-owner";
      assignment.updatedAt = now();
      await persistMemoryAssignmentState(taskRepoRoot, state);
    }

    while (assignment) {
      try {
        await dispatchDurableDocAssignment(baseRepoRoot, taskRepoRoot, state, assignment);
        return;
      } catch (error) {
        assignment.status = "failed";
        assignment.error = `Unable to dispatch durable-document assignment: ${errorMessage(error)}`;
        assignment.updatedAt = now();
        await persistMemoryAssignmentState(taskRepoRoot, state);
        assignment = currentDurableDocAssignment(state);
      }
    }
    await finishDurableDocAssignments(taskRepoRoot, state);
  }

  async function dispatchDurableDocAssignment(
    baseRepoRoot: string, taskRepoRoot: string, state: StoredMemoryReviewState, assignment: DurableDocAssignmentState
  ): Promise<void> {
    const session = await ensureWorkflowRoleSession(baseRepoRoot, state.taskSlug, assignment.owner ?? "project-manager");
    if (session.activityStatus === "running") {
      return;
    }
    assignment.status = assignment.owner ? "running" : "resolving-owner";
    assignment.reportPath = durableDocAssignmentReportPath(assignment.runId, assignment.id);
    if (!assignment.baseCommit) {
      assignment.baseCommit = await deps.git.getHeadCommit(taskRepoRoot);
      assignment.reportHashBefore = await hashOptionalFile(taskRepoRoot, assignment.reportPath);
    }
    assignment.dispatchedAt = now();
    assignment.updatedAt = assignment.dispatchedAt;
    await persistMemoryAssignmentState(taskRepoRoot, state);
    await submitTerminalInput(deps.runtime, session.id, assignment.owner
      ? buildDurableDocAssignmentPrompt(taskRepoRoot, assignment)
      : buildDurableDocOwnerPrompt(taskRepoRoot, assignment));
  }

  async function finishDurableDocAssignments(taskRepoRoot: string, state: StoredMemoryReviewState): Promise<void> {
    const failed = state.assignments.filter((assignment) => assignment.status === "failed");
    if (failed.length > 0) {
      state.status = "failed";
      state.error = `Memory was applied, but ${failed.length} durable-document assignment(s) failed: ${failed.map((assignment) => assignment.targetPath).join(", ")}. Retry the failed assignments; their content is retained in the memory review run.`;
      await persistMemoryAssignmentState(taskRepoRoot, state);
      return;
    }
    delete state.error;
    await persistMemoryAssignmentState(taskRepoRoot, state);
    await clearActiveState(taskRepoRoot);
  }

  async function validateDurableDocAssignmentCompletion(
    taskRepoRoot: string,
    assignment: DurableDocAssignmentState
  ): Promise<string> {
    const reportAbsolutePath = resolveRepoPath(taskRepoRoot, assignment.reportPath);
    if (!(await deps.fs.pathExists(reportAbsolutePath))) {
      throw new Error(`required report is missing: ${assignment.reportPath}`);
    }
    const reportContent = await deps.fs.readText(reportAbsolutePath);
    const reportHash = sha256(reportContent);
    if (assignment.reportHashBefore && reportHash === assignment.reportHashBefore) {
      throw new Error(`${assignment.reportPath} was not updated for assignment ${assignment.id}`);
    }
    const check = checkMarkdownArtifact("docs-update-report", assignment.reportPath, reportContent);
    if (check.status !== "ok") {
      const reasons = [
        ...check.missingHeadings.map((heading) => `missing heading ${heading}`),
        ...check.invalidFields
      ];
      throw new Error(`${assignment.reportPath} is invalid: ${reasons.join("; ") || check.status}`);
    }
    const assignmentId = readArtifactSectionValue(reportContent, "Assignment ID")?.trim();
    if (assignmentId !== assignment.id) {
      throw new Error(`Assignment ID must be exactly ${assignment.id}`);
    }
    const decision = readArtifactSectionValue(reportContent, "Decision")?.trim().toLowerCase();
    if (decision !== "synced" && decision !== "unchanged") {
      throw new Error("Decision must be synced or unchanged");
    }
    if (!(await deps.fs.pathExists(resolveRepoPath(taskRepoRoot, assignment.targetPath)))) {
      throw new Error(`target document is missing: ${assignment.targetPath}`);
    }
    const currentHead = await deps.git.getHeadCommit(taskRepoRoot);
    if (decision === "synced") {
      return validateDurableDocCommit(taskRepoRoot, assignment, reportContent, currentHead);
    }
    return currentHead;
  }

  async function validateDurableDocCommit(
    taskRepoRoot: string, assignment: DurableDocAssignmentState, reportContent: string, currentHead: string
  ): Promise<string> {
    const reportedCommit = readArtifactSectionContent(reportContent, "Commit")!;
    let commit: string;
    try {
      commit = (await deps.git.getCommitInfo(taskRepoRoot, reportedCommit)).sha;
    } catch (error) {
      const detail = error instanceof VcmError && error.hint ? `${errorMessage(error)} ${error.hint}` : errorMessage(error);
      throw new Error(`Commit ${reportedCommit} could not be resolved to a unique Git commit: ${detail}`);
    }
    const existingContentHint = `If ${assignment.targetPath} already preserves the assigned content, report unchanged with verification evidence; do not create a redundant commit.`;
    if (!assignment.baseCommit) {
      throw new Error(`Assignment ${assignment.id} has no recorded commit baseline; cannot validate Commit ${commit}. ${existingContentHint}`);
    }
    if (currentHead === assignment.baseCommit) {
      throw new Error(`No commits follow assignment baseline ${assignment.baseCommit} (HEAD is the same commit); received Commit ${commit}. The document may already have been committed before this baseline. ${existingContentHint}`);
    }
    const commits = await deps.git.getCommitList(taskRepoRoot, `${assignment.baseCommit}..${currentHead}`);
    if (!commits.some((candidate) => candidate.sha === commit)) {
      throw new Error(`Commit ${commit} exists but is outside assignment range ${assignment.baseCommit}..${currentHead}. ${existingContentHint}`);
    }
    const commitPaths = await deps.git.getChangedPaths(taskRepoRoot, `${commit}^`, commit);
    if (!commitPaths.includes(assignment.targetPath)) {
      throw new Error(`reported commit ${commit} does not modify ${assignment.targetPath}`);
    }
    const changedPaths = await deps.git.getChangedPaths(taskRepoRoot, assignment.baseCommit, currentHead);
    if (!changedPaths.includes(assignment.targetPath)) {
      throw new Error(`Commit ${commit} modified ${assignment.targetPath}, but no net change remains in ${assignment.baseCommit}..${currentHead}. Verify the current document before reporting completion.`);
    }
    return commit;
  }

  async function hashOptionalFile(taskRepoRoot: string, relativePath: string): Promise<string | undefined> {
    const absolutePath = resolveRepoPath(taskRepoRoot, relativePath);
    return await deps.fs.pathExists(absolutePath)
      ? sha256(await deps.fs.readText(absolutePath))
      : undefined;
  }

  async function persistMemoryAssignmentState(
    taskRepoRoot: string,
    state: StoredMemoryReviewState
  ): Promise<void> {
    state.updatedAt = now();
    await persistActiveState(taskRepoRoot, state);
    const run = await readRun(taskRepoRoot, state.runId);
    await persistRun(taskRepoRoot, {
      ...run,
      assignments: state.assignments,
      error: state.error,
      updatedAt: state.updatedAt
    });
  }

  async function dispatchCurrentDraft(baseRepoRoot: string, taskRepoRoot: string, state: StoredMemoryReviewState): Promise<void> {
    const draft = currentDraft(state);
    if (!draft || draft.status !== "pending") {
      return;
    }
    try {
      const session = await ensureWorkflowRoleSession(baseRepoRoot, state.taskSlug, draft.role);
      if (session.activityStatus === "running") {
        return;
      }
      draft.status = "dispatched";
      state.updatedAt = now();
      await persistActiveState(taskRepoRoot, state);
      const planningCandidatePath = draft.role === "architect"
        ? await findPlanningCandidateSnapshot(taskRepoRoot, state.runId)
        : undefined;
      await submitTerminalInput(
        deps.runtime,
        session.id,
        buildRoleDraftPrompt(taskRepoRoot, state, draft, planningCandidatePath)
      );
    } catch (error) {
      await failReview(taskRepoRoot, state, `Unable to start ${draft.role} memory draft: ${errorMessage(error)}`);
    }
  }

  async function ensureWorkflowRoleSession(
    baseRepoRoot: string,
    taskSlug: string,
    role: WorkflowMemoryRole
  ): Promise<RoleSessionRecord> {
    const existing = await deps.sessionService.getRoleSession(baseRepoRoot, taskSlug, role as VcmRoleName);
    if (existing?.status === "running" && deps.runtime.getSession(existing.id)) {
      return existing;
    }
    const preferences = await deps.appSettings.getPreferences();
    const options = preferences.launchTemplate.roles[role as VcmRoleName];
    if (existing?.claudeSessionId) {
      return deps.sessionService.resumeRoleSession(baseRepoRoot, taskSlug, role as VcmRoleName, options);
    }
    return deps.sessionService.startRoleSession(baseRepoRoot, taskSlug, role as VcmRoleName, options);
  }

  async function snapshotArchitectPlanningCandidate(taskRepoRoot: string, runId: string): Promise<void> {
    const sourcePath = resolveRepoPath(taskRepoRoot, ARCHITECT_PLANNING_MEMORY_CANDIDATE_PATH);
    if (!(await deps.fs.pathExists(sourcePath))) {
      return;
    }
    const snapshotPath = resolveRepoPath(taskRepoRoot, architectPlanningCandidateSnapshotPath(runId));
    await deps.fs.writeText(snapshotPath, ensureTrailingNewline(await deps.fs.readText(sourcePath)));
  }

  async function findPlanningCandidateSnapshot(
    taskRepoRoot: string,
    runId: string
  ): Promise<string | undefined> {
    const relativePath = architectPlanningCandidateSnapshotPath(runId);
    return await deps.fs.pathExists(resolveRepoPath(taskRepoRoot, relativePath))
      ? relativePath
      : undefined;
  }

  async function readReviewCandidates(
    taskRepoRoot: string,
    state: StoredMemoryReviewState
  ): Promise<MemoryReviewCandidate[]> {
    const candidates: MemoryReviewCandidate[] = [];
    for (const draft of state.drafts) {
      const draftPath = resolveRepoPath(taskRepoRoot, draft.path);
      const parsed = parseMemoryProposal(await deps.fs.readText(draftPath));
      if (!parsed.proposal) {
        throw new Error(`${draft.role} memory draft ${parsed.error ?? "could not be parsed"}`);
      }
      candidates.push(...toReviewCandidates(draft.role, draft.role, parsed.proposal.items));
    }

    const planningCandidatePath = await findPlanningCandidateSnapshot(taskRepoRoot, state.runId);
    if (planningCandidatePath) {
      const parsed = parseMemoryProposal(
        await deps.fs.readText(resolveRepoPath(taskRepoRoot, planningCandidatePath))
      );
      if (!parsed.proposal) {
        throw new Error(`Architect planning-session memory candidate ${parsed.error ?? "could not be parsed"}`);
      }
      candidates.push(...toReviewCandidates("architect-planning", "architect", parsed.proposal.items));
    }
    return candidates;
  }

  async function recordHarnessEngineerMemoryResult(
    taskRepoRoot: string,
    state: StoredMemoryReviewState
  ): Promise<void> {
    if (!state.reviewBaseCommit) {
      throw new VcmError({
        code: "MEMORY_REVIEW_BASE_MISSING",
        message: "Harness Engineer memory review has no recorded base commit.",
        statusCode: 409,
        hint: "Retry Auto Memory before running Task Harness Retrospective again."
      });
    }

    const before = await readRunMemorySet(taskRepoRoot, state.runId, "before");
    const after = await readMemorySet(taskRepoRoot);
    await assertOnlyMemoryBlocksChanged(taskRepoRoot, state.runId);

    const memoryPaths: string[] = MEMORY_FILE_DEFINITIONS.map((definition) => definition.path);
    const uncommittedMemoryDiff = await deps.git.getDiff(taskRepoRoot, "HEAD", null, memoryPaths);
    if (uncommittedMemoryDiff.trim()) {
      throw new VcmError({
        code: "MEMORY_REVIEW_NOT_COMMITTED",
        message: "Harness Engineer left reviewed memory changes uncommitted.",
        statusCode: 409,
        hint: "Commit the reviewed <VCM-memory> changes before ending the retrospective turn."
      });
    }

    const changedMemoryPaths = MEMORY_FILE_DEFINITIONS
      .filter((definition) => before[definition.path] !== after[definition.path])
      .map((definition) => definition.path);
    const currentHead = await deps.git.getHeadCommit(taskRepoRoot);
    const committedPaths = currentHead === state.reviewBaseCommit
      ? []
      : await deps.git.getChangedPaths(taskRepoRoot, state.reviewBaseCommit, currentHead);
    const unexpectedPaths = committedPaths.filter((changedPath) => !memoryPaths.includes(changedPath));
    if (unexpectedPaths.length > 0) {
      throw new VcmError({
        code: "MEMORY_REVIEW_COMMIT_SCOPE_INVALID",
        message: `Harness Engineer memory commit contains files outside managed memory hosts: ${unexpectedPaths.join(", ")}`,
        statusCode: 409,
        hint: "Move unrelated changes to a separate workflow and keep the memory review commit limited to managed memory files."
      });
    }
    const missingCommittedPaths = changedMemoryPaths.filter((changedPath) => !committedPaths.includes(changedPath));
    if (missingCommittedPaths.length > 0) {
      throw new VcmError({
        code: "MEMORY_REVIEW_COMMIT_MISSING",
        message: `Harness Engineer did not commit reviewed memory files: ${missingCommittedPaths.join(", ")}`,
        statusCode: 409,
        hint: "Commit every changed memory host file before ending the retrospective turn."
      });
    }
    if (changedMemoryPaths.length === 0 && committedPaths.length > 0) {
      throw new VcmError({
        code: "MEMORY_REVIEW_EMPTY_COMMIT_RANGE",
        message: "Harness Engineer created memory-host commits but left no final memory change.",
        statusCode: 409,
        hint: "Remove the unnecessary memory commits or leave memory unchanged without committing."
      });
    }

    const reviewResult = await readAndValidateHarnessMemoryReviewResult(
      taskRepoRoot,
      state,
      before,
      after,
      currentHead,
      changedMemoryPaths
    );
    const timestamp = now();
    const assignments = reviewResult.durableDocAssignments.map((assignment, index) => {
      const owner = inferDurableDocAssignmentOwner(assignment.targetPath);
      return {
        id: `${state.runId}-doc-${index + 1}`,
        runId: state.runId,
        sourceMemoryPath: assignment.sourceMemoryPath,
        sourceEntry: assignment.sourceEntry,
        targetPath: normalizeProjectRelativePath(assignment.targetPath),
        content: assignment.content,
        reason: assignment.reason,
        evidence: assignment.evidence,
        ...(owner ? { owner } : {}),
        status: owner ? "pending" : "waiting-owner",
        reportPath: durableDocAssignmentReportPath(state.runId, `${state.runId}-doc-${index + 1}`),
        createdAt: timestamp,
        updatedAt: timestamp
      } satisfies DurableDocAssignmentState;
    });

    await writeRunMemorySet(taskRepoRoot, state.runId, "after", after);
    const diff = renderMemoryDiff(before, after);
    const run = await readRun(taskRepoRoot, state.runId);
    await persistRun(taskRepoRoot, {
      ...run,
      status: "applied",
      updatedAt: timestamp,
      appliedAt: timestamp,
      afterHashes: hashMemorySet(after),
      diff,
      assignments
    });
    await deps.fs.writeText(
      resolveRepoPath(taskRepoRoot, `${MEMORY_REVIEW_RUNS_ROOT}/${state.runId}/applied.patch`),
      diff
    );
    if (assignments.length === 0) {
      await clearActiveState(taskRepoRoot);
      return;
    }
    state.status = "documenting";
    state.assignments = assignments;
    state.updatedAt = timestamp;
    delete state.error;
    await persistActiveState(taskRepoRoot, state);
  }

  async function readAndValidateHarnessMemoryReviewResult(
    taskRepoRoot: string,
    state: StoredMemoryReviewState,
    before: MemorySet,
    after: MemorySet,
    currentHead: string,
    changedMemoryPaths: string[]
  ): Promise<HarnessMemoryReviewResult> {
    const resultPath = resolveRepoPath(
      taskRepoRoot,
      `${MEMORY_REVIEW_RUNS_ROOT}/${state.runId}/review-result.json`
    );
    if (!(await deps.fs.pathExists(resultPath))) {
      throw new VcmError({
        code: "MEMORY_REVIEW_RESULT_MISSING",
        message: "Harness Engineer did not write review-result.json.",
        statusCode: 409,
        hint: `Write the validated memory decisions to ${resultPath} before ending the retrospective turn.`
      });
    }
    const result = await deps.fs.readJson<HarnessMemoryReviewResult>(resultPath);
    const shapeError = validateMemoryReviewResultShape(result, state.runId);
    if (shapeError) {
      throw new VcmError({
        code: "MEMORY_REVIEW_RESULT_INVALID",
        message: `Harness Engineer review-result.json is invalid: ${shapeError}`,
        statusCode: 409
      });
    }
    if (changedMemoryPaths.length > 0 && result.memoryCommit !== currentHead) {
      throw new VcmError({
        code: "MEMORY_REVIEW_RESULT_COMMIT_MISMATCH",
        message: `review-result.json memoryCommit must be the current memory commit: ${currentHead}`,
        statusCode: 409
      });
    }
    if (changedMemoryPaths.length === 0 && result.memoryCommit !== "none") {
      throw new VcmError({
        code: "MEMORY_REVIEW_RESULT_COMMIT_UNEXPECTED",
        message: "review-result.json memoryCommit must be none when memory is unchanged.",
        statusCode: 409
      });
    }

    const candidates = await readReviewCandidates(taskRepoRoot, state);
    const proposalDecisions = result.decisions.filter((decision) => decision.source === "proposal");
    for (const candidate of candidates) {
      const matches = proposalDecisions.filter((decision) => decision.itemId === candidate.id);
      if (matches.length !== 1) {
        throw new VcmError({
          code: "MEMORY_REVIEW_PROPOSAL_DECISION_MISSING",
          message: `review-result.json must contain exactly one decision for proposal ${candidate.id}.`,
          statusCode: 409
        });
      }
      validateProposalDecision(candidate, matches[0], after);
    }
    const unknownProposal = proposalDecisions.find(
      (decision) => !candidates.some((candidate) => candidate.id === decision.itemId)
    );
    if (unknownProposal) {
      throw new VcmError({
        code: "MEMORY_REVIEW_PROPOSAL_DECISION_UNKNOWN",
        message: `review-result.json contains an unknown proposal decision: ${unknownProposal.itemId}`,
        statusCode: 409
      });
    }
    const existingEntries = collectExistingMemoryReviewEntries(before);
    const existingDecisions = result.decisions.filter((candidate) => candidate.source === "existing");
    for (const decision of existingDecisions) {
      const assigned = existingEntries.find((entry) => entry.itemId === decision.itemId);
      if (!assigned) {
        throw new VcmError({
          code: "MEMORY_REVIEW_EXISTING_DECISION_UNKNOWN",
          message: `review-result.json contains an unknown existing-memory decision: ${decision.itemId}`,
          statusCode: 409
        });
      }
      if (decision.target !== assigned.target || decision.entry !== assigned.entry) {
        throw new VcmError({
          code: "MEMORY_REVIEW_EXISTING_DECISION_MISMATCH",
          message: `Existing-memory decision must copy the assigned target and entry exactly: ${decision.itemId}`,
          statusCode: 409
        });
      }
    }
    for (const assigned of existingEntries) {
      const matches = existingDecisions.filter((decision) => decision.itemId === assigned.itemId);
      if (matches.length !== 1) {
        throw new VcmError({
          code: "MEMORY_REVIEW_EXISTING_DECISION_MISSING",
          message: `review-result.json must contain exactly one decision for existing memory item ${assigned.itemId} in ${assigned.memoryPath}.`,
          statusCode: 409
        });
      }
      validateExistingMemoryDecision(assigned.memoryPath, assigned.entry, matches[0], after);
    }

    const moveDecisions = result.decisions.filter((decision) => decision.decision === "move-to-durable-doc");
    if (moveDecisions.length !== result.durableDocAssignments.length) {
      throw new VcmError({
        code: "MEMORY_REVIEW_ASSIGNMENT_COUNT_MISMATCH",
        message: "Every move-to-durable-doc decision must have exactly one durableDocAssignment.",
        statusCode: 409
      });
    }
    const assignmentKeys = new Set<string>();
    for (const assignment of result.durableDocAssignments) {
      const key = `${assignment.sourceMemoryPath}\n${assignment.sourceEntry}\n${assignment.targetPath}`;
      if (assignmentKeys.has(key)) {
        throw new VcmError({
          code: "MEMORY_REVIEW_ASSIGNMENT_DUPLICATE",
          message: `Duplicate durableDocAssignment for ${assignment.targetPath}: ${assignment.sourceEntry}`,
          statusCode: 409
        });
      }
      assignmentKeys.add(key);
      const matchingDecision = moveDecisions.find((decision) => (
        memoryTargetToPath(decision.target) === assignment.sourceMemoryPath
        && decision.entry === assignment.sourceEntry
        && decision.durableDocPath === assignment.targetPath
      ));
      if (!matchingDecision) {
        throw new VcmError({
          code: "MEMORY_REVIEW_ASSIGNMENT_DECISION_MISSING",
          message: `durableDocAssignment has no matching move decision: ${assignment.targetPath}`,
          statusCode: 409
        });
      }
      validateDurableDocAssignmentInput(assignment, matchingDecision.source, after);
    }
    return result;
  }

  function validateProposalDecision(
    candidate: MemoryReviewCandidate,
    decision: HarnessMemoryReviewDecision,
    after: MemorySet
  ): void {
    const expectedEntry = candidate.content ?? candidate.existing ?? "";
    if (decision.entry !== expectedEntry || decision.target !== candidate.target) {
      throw new VcmError({
        code: "MEMORY_REVIEW_PROPOSAL_DECISION_MISMATCH",
        message: `Proposal decision does not match assigned candidate ${candidate.id}.`,
        statusCode: 409
      });
    }
    const afterContent = after[memoryTargetToPath(decision.target)];
    if (candidate.operation === "remove") {
      if (decision.decision !== "remove" && decision.decision !== "retain") {
        throw new VcmError({
          code: "MEMORY_REVIEW_PROPOSAL_DECISION_INVALID",
          message: `Remove proposal ${candidate.id} must use remove or retain.`,
          statusCode: 409
        });
      }
      if (decision.decision === "remove" && memoryContainsReviewContent(afterContent, expectedEntry)) {
        throw new VcmError({
          code: "MEMORY_REVIEW_PROPOSAL_REMOVAL_MISMATCH",
          message: `Accepted removal is still present for proposal ${candidate.id}.`,
          statusCode: 409
        });
      }
      if (decision.decision === "retain" && !memoryContainsReviewContent(afterContent, expectedEntry)) {
        throw new VcmError({
          code: "MEMORY_REVIEW_PROPOSAL_RETAIN_MISMATCH",
          message: `Rejected removal is missing from memory for proposal ${candidate.id}.`,
          statusCode: 409
        });
      }
      return;
    }
    if (!new Set(["keep-in-memory", "keep-memory-reference", "move-to-durable-doc", "reject"]).has(decision.decision)) {
      throw new VcmError({
        code: "MEMORY_REVIEW_PROPOSAL_DECISION_INVALID",
        message: `Add or update proposal ${candidate.id} uses an invalid decision: ${decision.decision}`,
        statusCode: 409
      });
    }
    if (
      (decision.decision === "keep-in-memory" || decision.decision === "keep-memory-reference")
      && !memoryContainsReviewContent(afterContent, decision.finalContent)
    ) {
      throw new VcmError({
        code: "MEMORY_REVIEW_PROPOSAL_CONTENT_MISSING",
        message: `Accepted proposal content is missing from memory for ${candidate.id}.`,
        statusCode: 409
      });
    }
  }

  function validateExistingMemoryDecision(
    memoryPath: string,
    entry: string,
    decision: HarnessMemoryReviewDecision,
    after: MemorySet
  ): void {
    const afterEntries = new Set(parseExistingMemoryEntries(after[memoryPath]));
    if (decision.decision === "retain" && !afterEntries.has(entry)) {
      throw new VcmError({
        code: "MEMORY_REVIEW_RETAIN_MISMATCH",
        message: `Retained memory entry is missing from ${memoryPath}: ${entry}`,
        statusCode: 409
      });
    }
    if ((decision.decision === "remove" || decision.decision === "move-to-durable-doc") && afterEntries.has(entry)) {
      throw new VcmError({
        code: "MEMORY_REVIEW_REMOVAL_MISMATCH",
        message: `Removed memory entry is still present in ${memoryPath}: ${entry}`,
        statusCode: 409
      });
    }
    if (decision.decision === "update") {
      if (!decision.finalContent || decision.finalContent === "none" || !afterEntries.has(decision.finalContent)) {
        throw new VcmError({
          code: "MEMORY_REVIEW_UPDATE_MISMATCH",
          message: `Updated memory content is missing from ${memoryPath}: ${decision.finalContent}`,
          statusCode: 409
        });
      }
    }
  }

  function validateDurableDocAssignmentInput(
    assignment: HarnessDurableDocAssignmentInput,
    source: HarnessMemoryReviewDecision["source"],
    after: MemorySet
  ): void {
    if (!MEMORY_FILE_DEFINITIONS.some((definition) => definition.path === assignment.sourceMemoryPath)) {
      throw new VcmError({
        code: "MEMORY_REVIEW_ASSIGNMENT_SOURCE_INVALID",
        message: `Unknown memory source path: ${assignment.sourceMemoryPath}`,
        statusCode: 409
      });
    }
    const sourceStillPresent = source === "existing"
      ? parseExistingMemoryEntries(after[assignment.sourceMemoryPath]).includes(assignment.sourceEntry)
      : memoryContainsReviewContent(after[assignment.sourceMemoryPath], assignment.sourceEntry);
    if (sourceStillPresent) {
      throw new VcmError({
        code: "MEMORY_REVIEW_ASSIGNMENT_SOURCE_NOT_REMOVED",
        message: `Move-to-durable-doc must remove memory before assignment: ${assignment.sourceEntry}`,
        statusCode: 409
      });
    }
    assertDurableDocPath(assignment.targetPath);
  }

  async function createAppliedRun(
    taskRepoRoot: string,
    taskSlug: string,
    source: MemoryReviewRunSource,
    before: MemorySet,
    after: MemorySet
  ): Promise<void> {
    assertCompleteMemorySet(after);
    const timestamp = now();
    const runId = createRunId(timestamp, source);
    await writeRunMemorySet(taskRepoRoot, runId, "before", before);
    await writeRunMemorySet(taskRepoRoot, runId, "after", after);
    try {
      await applyAndCommitMemorySet(taskRepoRoot, before, after, "[VCM Harness] Update VCM memory");
      const diff = renderMemoryDiff(before, after);
      await persistRun(taskRepoRoot, {
        version: 1,
        runId,
        taskSlug,
        source,
        status: "applied",
        createdAt: timestamp,
        updatedAt: timestamp,
        appliedAt: timestamp,
        beforeHashes: hashMemorySet(before),
        afterHashes: hashMemorySet(after),
        diff
      });
      await deps.fs.writeText(resolveRepoPath(taskRepoRoot, `${MEMORY_REVIEW_RUNS_ROOT}/${runId}/applied.patch`), diff);
    } catch (error) {
      await deps.fs.removePath?.(
        resolveRepoPath(taskRepoRoot, `${MEMORY_REVIEW_RUNS_ROOT}/${runId}`),
        { recursive: true, force: true }
      );
      throw error;
    }
  }

  async function failReview(taskRepoRoot: string, state: StoredMemoryReviewState, message: string): Promise<void> {
    const timestamp = now();
    state.status = "failed";
    state.error = message;
    state.updatedAt = timestamp;
    await persistActiveState(taskRepoRoot, state);
    const run = await readRun(taskRepoRoot, state.runId);
    await persistRun(taskRepoRoot, {
      ...run,
      status: "failed",
      failedAt: timestamp,
      updatedAt: timestamp,
      error: message,
      diff: run.diff ?? ""
    });
  }

  async function listRuns(taskRepoRoot: string): Promise<MemoryReviewRunSummary[]> {
    const runsRoot = resolveRepoPath(taskRepoRoot, MEMORY_REVIEW_RUNS_ROOT);
    if (!(await deps.fs.pathExists(runsRoot))) {
      return [];
    }
    const runIds = await deps.fs.readDir(runsRoot);
    const runs: MemoryReviewRunSummary[] = [];
    for (const runId of runIds) {
      const metadataPath = resolveRepoPath(taskRepoRoot, `${MEMORY_REVIEW_RUNS_ROOT}/${runId}/run.json`);
      if (!(await deps.fs.pathExists(metadataPath))) {
        continue;
      }
      const run = await deps.fs.readJson<StoredMemoryReviewRun>(metadataPath);
      if (run.status === "collecting" || run.status === "reviewing") {
        continue;
      }
      runs.push({
        runId: run.runId,
        taskSlug: run.taskSlug,
        source: run.source,
        status: run.revertedAt ? "reverted" : run.status,
        createdAt: run.createdAt,
        appliedAt: run.appliedAt,
        failedAt: run.failedAt,
        revertedAt: run.revertedAt,
        finalAcceptanceHash: run.finalAcceptanceHash,
        trigger: run.trigger,
        diff: run.diff ?? "",
        assignments: run.assignments ?? [],
        canRevert: run.status === "applied" && !run.revertedAt && Boolean(run.afterHashes),
        error: run.error
      });
    }
    return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async function listMemoryFiles(taskRepoRoot: string): Promise<{ files: MemoryFileSummary[]; warnings: string[] }> {
    const files: MemoryFileSummary[] = [];
    const warnings: string[] = [];
    for (const definition of MEMORY_FILE_DEFINITIONS) {
      let content = "";
      const hostPath = resolveRepoPath(taskRepoRoot, definition.path);
      try {
        if (await deps.fs.pathExists(hostPath)) {
          content = readVcmMemoryBlock(await deps.fs.readText(hostPath)) ?? "";
        }
      } catch (error) {
        warnings.push(`${definition.path}: ${errorMessage(error)}`);
      }
      if (!content) {
        warnings.push(`${definition.path}: VCM memory block is missing. Refresh the VCM Harness.`);
      }
      files.push({
        path: definition.path,
        title: definition.title,
        ...("role" in definition ? { role: definition.role } : {}),
        sizeBytes: Buffer.byteLength(content, "utf8")
      });
    }
    return { files, warnings: [...new Set(warnings)] };
  }

  async function hasCompletedRunForFinalAcceptance(taskRepoRoot: string, finalAcceptanceHash: string): Promise<boolean> {
    return Boolean(await findCompletedRunForFinalAcceptance(taskRepoRoot, finalAcceptanceHash));
  }

  async function findCompletedRunForFinalAcceptance(
    taskRepoRoot: string,
    finalAcceptanceHash: string
  ): Promise<MemoryReviewRunSummary | undefined> {
    const runs = await listRuns(taskRepoRoot);
    return runs.find((run) => run.finalAcceptanceHash === finalAcceptanceHash && (run.status === "applied" || run.status === "reverted"));
  }

  async function loadActiveState(taskRepoRoot: string): Promise<StoredMemoryReviewState | undefined> {
    const statePath = resolveRepoPath(taskRepoRoot, MEMORY_REVIEW_STATE_PATH);
    if (!(await deps.fs.pathExists(statePath))) {
      return undefined;
    }
    const stored = await deps.fs.readJson<StoredMemoryReviewStateOnDisk>(statePath);
    if (stored?.version !== 1 || !stored.runId) {
      return undefined;
    }
    const migrated = stored.drafts.some((draft) => draft.status === "running");
    const state: StoredMemoryReviewState = {
      ...stored,
      assignments: stored.assignments ?? [],
      drafts: stored.drafts.map((draft) => ({
        ...draft,
        status: draft.status === "running" ? "dispatched" : draft.status
      }))
    };
    if (migrated) {
      await persistActiveState(taskRepoRoot, state);
    }
    return state;
  }

  async function persistActiveState(taskRepoRoot: string, state: StoredMemoryReviewState): Promise<void> {
    await deps.fs.writeJsonAtomic(resolveRepoPath(taskRepoRoot, MEMORY_REVIEW_STATE_PATH), state);
  }

  async function clearActiveState(taskRepoRoot: string): Promise<void> {
    await deps.fs.removePath?.(resolveRepoPath(taskRepoRoot, MEMORY_REVIEW_STATE_PATH), { force: true });
  }

  async function discardActiveReview(taskRepoRoot: string, state: StoredMemoryReviewState): Promise<void> {
    await clearActiveState(taskRepoRoot);
    await deps.fs.removePath?.(
      resolveRepoPath(taskRepoRoot, `${MEMORY_REVIEW_RUNS_ROOT}/${state.runId}`),
      { recursive: true, force: true }
    );
  }

  async function readRun(taskRepoRoot: string, runId: string): Promise<StoredMemoryReviewRun> {
    const runPath = resolveRepoPath(taskRepoRoot, `${MEMORY_REVIEW_RUNS_ROOT}/${requireSafeRunId(runId)}/run.json`);
    if (!(await deps.fs.pathExists(runPath))) {
      throw new VcmError({
        code: "MEMORY_RUN_MISSING",
        message: `Memory review run does not exist: ${runId}`,
        statusCode: 404
      });
    }
    return deps.fs.readJson<StoredMemoryReviewRun>(runPath);
  }

  async function persistRun(taskRepoRoot: string, run: StoredMemoryReviewRun): Promise<void> {
    await deps.fs.writeJsonAtomic(resolveRepoPath(taskRepoRoot, `${MEMORY_REVIEW_RUNS_ROOT}/${run.runId}/run.json`), run);
  }

  async function updateRunStatus(
    taskRepoRoot: string,
    runId: string,
    status: StoredMemoryReviewRun["status"],
    timestamp: string
  ): Promise<void> {
    const run = await readRun(taskRepoRoot, runId);
    await persistRun(taskRepoRoot, { ...run, status, updatedAt: timestamp });
  }

  async function readAcceptedFinalAcceptanceHash(
    taskRepoRoot: string,
    handoffDir: string
  ): Promise<string | undefined> {
    const finalAcceptancePath = path.posix.join(handoffDir, "final-acceptance.md");
    const absolutePath = resolveRepoPath(taskRepoRoot, finalAcceptancePath);
    if (!(await deps.fs.pathExists(absolutePath))) {
      return undefined;
    }
    const content = await deps.fs.readText(absolutePath);
    const check = checkMarkdownArtifact("final-acceptance", finalAcceptancePath, content);
    const decision = readArtifactSectionValue(content, "Decision")?.toLowerCase();
    if (check.status !== "ok" || (decision !== "accepted" && decision !== "accepted-with-known-risks")) {
      return undefined;
    }
    return `sha256:${sha256(content)}`;
  }

  return {
    reconcileTask: (input) => withTaskLock(input.taskRepoRoot, () => reconcileTask(input)),
    getState,
    getTaskRetrospectiveReadiness,
    getFile,
    updateFile,
    revertRun,
    retryFailedReview,
    retryDurableDocAssignment: (base, task, id) => withTaskLock(task, () => retryDurableDocAssignment(base, task, id)),
    resolveDurableDocAssignmentOwner: (base, task, id, owner) => withTaskLock(task, () => resolveDurableDocAssignmentOwner(base, task, id, owner)),
    prepareTaskRetrospectiveReview,
    cancelTaskRetrospectiveReview,
    isRoleMemoryTurn,
    getDurableDocAssignment,
    handleRoleHook: (input) => withTaskLock(input.taskRepoRoot, () => handleRoleHook(input)),
    handleHarnessEngineerHook: (input) => withTaskLock(input.taskRepoRoot, () => handleHarnessEngineerHook(input)),
    assertHarnessEngineerAvailable
  };
}

export async function assertMemoryBlocksInstalled(
  fs: FileSystemAdapter,
  taskRepoRoot: string
): Promise<void> {
  for (const definition of MEMORY_FILE_DEFINITIONS) {
    const hostPath = resolveRepoPath(taskRepoRoot, definition.path);
    if (!(await fs.pathExists(hostPath))) {
      throw missingMemoryBlockError(definition.path);
    }
    const content = await fs.readText(hostPath);
    if (readVcmMemoryBlock(content) === undefined) {
      throw missingMemoryBlockError(definition.path);
    }
  }
}

function currentDraft(state: StoredMemoryReviewState): MemoryDraftState | undefined {
  return state.drafts.find((draft) => draft.status !== "completed");
}

function preserveDisabledReview(state: StoredMemoryReviewState | undefined): boolean {
  return Boolean(state?.assignments.length)
    || (state?.status === "reviewing" && Boolean(state.reviewPromptDispatchedAt));
}

function currentDurableDocAssignment(state: StoredMemoryReviewState): DurableDocAssignmentState | undefined {
  return state.assignments.find((assignment) => assignment.status === "running" || assignment.status === "resolving-owner")
    ?? state.assignments.find((assignment) => assignment.status === "pending" || assignment.status === "waiting-owner");
}

function toReviewCandidates(
  source: string,
  currentRole: MemoryReviewTarget,
  items: MemoryProposalItem[]
): MemoryReviewCandidate[] {
  return items.map((item) => ({
    id: `${source}:${item.operation}:${item.ordinal}`,
    source,
    operation: item.operation,
    target: item.target === "shared" ? "shared" : currentRole,
    ...(item.content ? { content: item.content } : {}),
    ...(item.existing ? { existing: item.existing } : {})
  }));
}

function toActiveReview(state: StoredMemoryReviewState): ActiveMemoryReview {
  return {
    runId: state.runId,
    taskSlug: state.taskSlug,
    status: state.status,
    finalAcceptanceHash: state.finalAcceptanceHash,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    currentRole: state.status === "collecting" ? currentDraft(state)?.role : undefined,
    drafts: state.drafts,
    assignments: state.assignments,
    trigger: state.trigger,
    error: state.error
  };
}

function buildRoleDraftPrompt(
  taskRepoRoot: string,
  state: StoredMemoryReviewState,
  draft: MemoryDraftState,
  planningCandidatePath?: string
): string {
  const roleDefinition = MEMORY_FILE_DEFINITIONS.find((definition) => "role" in definition && definition.role === draft.role);
  if (!roleDefinition) {
    throw new Error(`Missing memory definition for role: ${draft.role}`);
  }
  const prompt = [
    "[VCM Task Harness Review: Memory Proposal]",
    "",
    "Use the vcm-propose-memory skill to submit the assigned proposal.",
    `Task worktree: ${taskRepoRoot}`,
    `Current shared memory block: ${resolveRepoPath(taskRepoRoot, "CLAUDE.md")}`,
    `Current role memory block: ${resolveRepoPath(taskRepoRoot, roleDefinition.path)}`,
    ...(planningCandidatePath
      ? [
          `Planning-session memory candidate: ${resolveRepoPath(taskRepoRoot, planningCandidatePath)}`,
          "Review that candidate against final task evidence. Carry forward only facts that remain verified after implementation and testing."
        ]
      : []),
    `Assigned proposal path: ${resolveRepoPath(taskRepoRoot, draft.path)}`
  ];
  return [
    ...prompt,
    "",
    "End the turn after VCM accepts the proposal."
  ].join("\n");
}

function buildDurableDocOwnerPrompt(
  taskRepoRoot: string,
  assignment: DurableDocAssignmentState
): string {
  return [
    "[VCM Durable Documentation Owner Resolution]",
    "",
    `Task worktree: ${taskRepoRoot}`,
    `Assignment ID: ${assignment.id}`,
    `Target document: ${assignment.targetPath}`,
    `Content to preserve: ${assignment.content}`,
    `Reason: ${assignment.reason}`,
    "",
    "Choose architect, coder, or tester as the document owner. If the correct owner cannot be determined, ask the user and wait for the answer.",
    `After deciding, run: .ai/tools/resolve-durable-doc-assignment --assignment ${assignment.id} --owner <architect|coder|tester>`,
    "End the turn after VCM accepts the owner."
  ].join("\n");
}

function buildDurableDocAssignmentPrompt(
  taskRepoRoot: string,
  assignment: DurableDocAssignmentState
): string {
  return [
    "[VCM Durable Documentation Assignment]",
    "",
    `Task worktree: ${taskRepoRoot}`,
    `Assignment ID: ${assignment.id}`,
    `Target document: ${assignment.targetPath}`,
    `Content to preserve: ${assignment.content}`,
    `Reason: ${assignment.reason}`,
    "Evidence:",
    ...assignment.evidence.map((item) => `- ${item}`),
    "",
    "Verify the content, update the target and any directly related durable documentation, run applicable documentation checks, and commit the documentation changes.",
    `Assigned report path: ${assignment.reportPath}`,
    `Submit with .ai/tools/vcm-artifact docs-update-report --file <candidate> --path ${assignment.reportPath} --mode final`,
    "Set Assignment ID to the exact ID above.",
    DOCS_UPDATE_COMMIT_RULE,
    "For synced, record the commit that changed the target document; it need not be HEAD. If the document already preserves the content, use unchanged with evidence; do not create a redundant commit.",
    ...(assignment.error ? [`Previous failure: ${assignment.error}`] : []),
    "End the turn after VCM accepts the report."
  ].join("\n");
}

function inferDurableDocAssignmentOwner(targetPath: string): DurableDocAssignmentOwner | undefined {
  const normalized = normalizeProjectRelativePath(targetPath);
  if (normalized === "docs/TESTING.md") {
    return "tester";
  }
  if (
    normalized === "docs/ARCHITECTURE.md"
    || normalized === "docs/known-issues.md"
    || normalized.endsWith("/ARCHITECTURE.md")
  ) {
    return "architect";
  }
  return undefined;
}

function memoryPathToTarget(memoryPath: string): MemoryReviewTarget {
  if (memoryPath === "CLAUDE.md") {
    return "shared";
  }
  const definition = MEMORY_FILE_DEFINITIONS.find((candidate) => candidate.path === memoryPath);
  if (!definition || !("role" in definition)) {
    throw new Error(`Unknown memory path: ${memoryPath}`);
  }
  return definition.role;
}

function memoryTargetToPath(target: MemoryReviewTarget): string {
  if (target === "shared") {
    return "CLAUDE.md";
  }
  const definition = MEMORY_FILE_DEFINITIONS.find(
    (candidate) => "role" in candidate && candidate.role === target
  );
  if (!definition) {
    throw new Error(`Unknown memory target: ${target}`);
  }
  return definition.path;
}

function collectExistingMemoryReviewEntries(memory: MemorySet): ExistingMemoryReviewEntry[] {
  return MEMORY_FILE_DEFINITIONS.flatMap((definition) => {
    const target = memoryPathToTarget(definition.path);
    return parseExistingMemoryEntries(memory[definition.path]).map((entry, index) => ({
      itemId: `existing:${target}:${index + 1}:${sha256(entry).slice(0, 12)}`,
      target,
      memoryPath: definition.path,
      entry
    }));
  });
}

function parseExistingMemoryEntries(content: string): string[] {
  const normalized = content.replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  const lines = normalized.split("\n");
  const sectionStarts = lines
    .map((line, index) => (/^##(?:\s+|$)/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (sectionStarts.length === 0) {
    return [normalized];
  }
  return sectionStarts.map((start, index) => {
    const end = sectionStarts[index + 1] ?? lines.length;
    return lines.slice(start, end).join("\n").trim();
  }).filter(Boolean);
}

function memoryContainsReviewContent(content: string, expected: string): boolean {
  const normalizedExpected = expected.replace(/\r\n?/g, "\n").trim();
  if (!normalizedExpected) {
    return false;
  }
  if (normalizedExpected.includes("\n") || /^##(?:\s+|$)/.test(normalizedExpected)) {
    return parseExistingMemoryEntries(content).includes(normalizedExpected);
  }
  return content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .includes(normalizedExpected);
}

function assertDurableDocPath(targetPath: string): void {
  const normalized = normalizeProjectRelativePath(targetPath);
  if (
    !normalized
    || normalized.startsWith("../")
    || path.posix.isAbsolute(normalized)
    || normalized.startsWith(".ai/vcm/")
    || !normalized.endsWith(".md")
  ) {
    throw new VcmError({
      code: "MEMORY_REVIEW_DURABLE_DOC_PATH_INVALID",
      message: `Durable-document target must be a project-relative Markdown path outside .ai/vcm: ${targetPath}`,
      statusCode: 409
    });
  }
}

function normalizeProjectRelativePath(filePath: string): string {
  return filePath.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function validateMemoryReviewResultShape(result: HarnessMemoryReviewResult, runId: string): string | undefined {
  if (!result || typeof result !== "object") {
    return "root value must be an object";
  }
  if (result.version !== 1) {
    return "version must be 1";
  }
  if (result.runId !== runId) {
    return `runId must be ${runId}`;
  }
  if (typeof result.memoryCommit !== "string" || !result.memoryCommit.trim()) {
    return "memoryCommit must be a non-empty string";
  }
  if (!Array.isArray(result.decisions) || !Array.isArray(result.durableDocAssignments)) {
    return "decisions and durableDocAssignments must be arrays";
  }
  const allowedSources = new Set(["existing", "proposal"]);
  const allowedTargets = new Set(["shared", "project-manager", "architect", "coder", "tester", "reviewer", "harness-engineer"]);
  const allowedDecisions = new Set([
    "retain",
    "update",
    "remove",
    "move-to-durable-doc",
    "keep-in-memory",
    "keep-memory-reference",
    "reject"
  ]);
  for (const decision of result.decisions) {
    if (
      !decision
      || typeof decision.itemId !== "string"
      || !allowedSources.has(decision.source)
      || !allowedTargets.has(decision.target)
      || typeof decision.entry !== "string"
      || !decision.entry.trim()
      || !allowedDecisions.has(decision.decision)
      || typeof decision.reason !== "string"
      || !decision.reason.trim()
      || typeof decision.impactIfAbsent !== "string"
      || !decision.impactIfAbsent.trim()
      || !Array.isArray(decision.evidence)
      || decision.evidence.length === 0
      || decision.evidence.some((item) => typeof item !== "string" || !item.trim())
      || typeof decision.finalContent !== "string"
      || !decision.finalContent.trim()
      || typeof decision.durableDocPath !== "string"
      || !decision.durableDocPath.trim()
    ) {
      return "every decision must use the complete review-result decision schema";
    }
  }
  for (const assignment of result.durableDocAssignments) {
    if (
      !assignment
      || typeof assignment.sourceMemoryPath !== "string"
      || typeof assignment.sourceEntry !== "string"
      || !assignment.sourceEntry.trim()
      || typeof assignment.targetPath !== "string"
      || typeof assignment.content !== "string"
      || !assignment.content.trim()
      || typeof assignment.reason !== "string"
      || !assignment.reason.trim()
      || !Array.isArray(assignment.evidence)
      || assignment.evidence.length === 0
      || assignment.evidence.some((item) => typeof item !== "string" || !item.trim())
    ) {
      return "every durableDocAssignment must use the complete assignment schema";
    }
  }
  return undefined;
}

function requireMemoryFileDefinition(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const definition = MEMORY_FILE_DEFINITIONS.find((candidate) => candidate.path === normalized);
  if (!definition) {
    throw new VcmError({
      code: "MEMORY_FILE_INVALID",
      message: `Memory file is not managed by VCM: ${filePath}`,
      statusCode: 400
    });
  }
  return definition;
}

function requireSafeRunId(runId: string): string {
  const normalized = runId.trim();
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new VcmError({
      code: "MEMORY_RUN_INVALID",
      message: "Memory review run id is invalid.",
      statusCode: 400
    });
  }
  return normalized;
}

function memoryRunFilePath(runId: string, snapshot: "before" | "after", memoryPath: string): string {
  return `${MEMORY_REVIEW_RUNS_ROOT}/${runId}/${snapshot}/${memoryPath}`;
}

function memoryRunHostFilePath(runId: string, memoryPath: string): string {
  return `${MEMORY_REVIEW_RUNS_ROOT}/${runId}/host-before/${memoryPath}`;
}

function describeMemoryHostDifference(
  before: VcmMemoryHostFrame,
  current: VcmMemoryHostFrame
): string | undefined {
  if (before.beforeBlock !== current.beforeBlock) {
    return describeTextDifference("before-block content", before.beforeBlock, current.beforeBlock);
  }
  if (before.afterBlock !== current.afterBlock) {
    return describeTextDifference("after-block content", before.afterBlock, current.afterBlock);
  }
  return undefined;
}

function describeTextDifference(label: string, before: string, current: string): string {
  const limit = Math.min(before.length, current.length);
  let offset = 0;
  while (offset < limit && before[offset] === current[offset]) {
    offset += 1;
  }
  const excerptStart = Math.max(0, offset - 20);
  const excerptEnd = offset + 40;
  const snapshotExcerpt = JSON.stringify(before.slice(excerptStart, excerptEnd));
  const currentExcerpt = JSON.stringify(current.slice(excerptStart, excerptEnd));
  return `${label} differs at character ${offset}; snapshot=${snapshotExcerpt}; current=${currentExcerpt}`;
}

function missingMemoryBlockError(filePath: string): VcmError {
  return new VcmError({
    code: "MEMORY_BLOCK_MISSING",
    message: `VCM memory block is missing from ${filePath}.`,
    statusCode: 409,
    hint: "Refresh the VCM Harness in the active task worktree before using Auto Memory."
  });
}

function assertCompleteMemorySet(memory: MemorySet): void {
  for (const definition of MEMORY_FILE_DEFINITIONS) {
    if (typeof memory[definition.path] !== "string") {
      throw new Error(`Missing reviewed memory file: ${definition.path}`);
    }
  }
}

function hashMemorySet(memory: MemorySet): Record<string, string> {
  return Object.fromEntries(MEMORY_FILE_DEFINITIONS.map((definition) => [
    definition.path,
    sha256(memory[definition.path] ?? "")
  ]));
}

function sameHashes(left: Record<string, string>, right: Record<string, string>): boolean {
  return MEMORY_FILE_DEFINITIONS.every((definition) => left[definition.path] === right[definition.path]);
}

function renderMemoryDiff(before: MemorySet, after: MemorySet): string {
  const sections: string[] = [];
  for (const definition of MEMORY_FILE_DEFINITIONS) {
    const oldContent = before[definition.path] ?? "";
    const newContent = after[definition.path] ?? "";
    if (oldContent === newContent) {
      continue;
    }
    const oldLines = oldContent.replace(/\n$/, "").split("\n");
    const newLines = newContent.replace(/\n$/, "").split("\n");
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix
      && suffix < newLines.length - prefix
      && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const removed = oldLines.slice(prefix, oldLines.length - suffix).map((line) => `-${line}`);
    const added = newLines.slice(prefix, newLines.length - suffix).map((line) => `+${line}`);
    sections.push([
      `--- ${definition.path}`,
      `+++ ${definition.path}`,
      `@@ line ${prefix + 1} @@`,
      ...removed,
      ...added
    ].join("\n"));
  }
  return sections.length > 0 ? `${sections.join("\n\n")}\n` : "No memory changes.\n";
}

function createRunId(timestamp: string, source: MemoryReviewRunSource): string {
  const suffix = sha256(`${timestamp}:${source}:${Math.random()}`).slice(0, 8);
  return `${timestamp.replace(/[^0-9]/g, "").slice(0, 17)}-${source}-${suffix}`;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
