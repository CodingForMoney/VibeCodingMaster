import { createHash } from "node:crypto";
import path from "node:path";
import type { ClaudeHookEventName } from "../../shared/types/claude-hook.js";
import type {
  ActiveMemoryReview,
  AutoMemoryStateReport,
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
import { checkMarkdownArtifact, readArtifactSectionValue } from "../../shared/validation/artifact-check.js";
import { resolveRepoPath, type FileSystemAdapter } from "../adapters/filesystem.js";
import type { GitAdapter } from "../adapters/git-adapter.js";
import { VcmError } from "../errors.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import { submitTerminalInput } from "../runtime/terminal-submit.js";
import {
  readVcmMemoryBlock,
  replaceVcmMemoryBlock
} from "../templates/harness/memory-block.js";
import type { AppSettingsService } from "./app-settings-service.js";
import type { SessionService } from "./session-service.js";

const MEMORY_REVIEW_ROOT = ".ai/vcm/memory-review";
const MEMORY_REVIEW_RUNS_ROOT = `${MEMORY_REVIEW_ROOT}/runs`;
const MEMORY_REVIEW_STATE_PATH = `${MEMORY_REVIEW_ROOT}/state.json`;

const MEMORY_FILE_DEFINITIONS = [
  { path: "CLAUDE.md", title: "Shared Memory" },
  { path: ".claude/agents/project-manager.md", title: "Project Manager Memory", role: "project-manager" },
  { path: ".claude/agents/architect.md", title: "Architect Memory", role: "architect" },
  { path: ".claude/agents/coder.md", title: "Coder Memory", role: "coder" },
  { path: ".claude/agents/tester.md", title: "Tester Memory", role: "tester" },
  { path: ".claude/agents/gate-reviewer.md", title: "Gate Reviewer Memory", role: "gate-reviewer" },
  { path: ".claude/agents/harness-engineer.md", title: "Harness Engineer Memory", role: "harness-engineer" }
] as const satisfies ReadonlyArray<{ path: string; title: string; role?: VcmMemoryRoleName }>;

type WorkflowMemoryRole = Exclude<VcmMemoryRoleName, "harness-engineer">;
type MemorySet = Record<string, string>;

interface StoredMemoryReviewState {
  version: 1;
  runId: string;
  taskSlug: string;
  status: "collecting" | "reviewing" | "failed";
  finalAcceptanceHash: string;
  trigger: MemoryReviewTrigger;
  createdAt: string;
  updatedAt: string;
  drafts: MemoryDraftState[];
  reviewPromptDispatchedAt?: string;
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
  error?: string;
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
  isRoleMemoryTurn(taskRepoRoot: string, role: RoleName): Promise<boolean>;
  handleRoleHook(input: AutoMemoryRoleHookInput): Promise<boolean>;
  handleHarnessEngineerHook(input: AutoMemoryHarnessHookInput): Promise<boolean>;
  assertHarnessEngineerAvailable(taskRepoRoot: string): Promise<void>;
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
  git: Pick<GitAdapter, "commitPaths" | "getDiff">;
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

  async function getState(baseRepoRoot: string, taskRepoRoot: string): Promise<AutoMemoryStateReport> {
    let [active, runs, memoryFiles] = await Promise.all([
      loadActiveState(taskRepoRoot),
      listRuns(taskRepoRoot),
      listMemoryFiles(taskRepoRoot)
    ]);
    if (active && !(await deps.appSettings.getPreferences()).autoMemoryEnabled) {
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
      if (active) {
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
      await dispatchHarnessReview(input.baseRepoRoot, input.taskRepoRoot, active);
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
      roles.push("gate-reviewer");
    }
    const timestamp = now();
    const runId = createRunId(timestamp, "auto");
    const drafts: MemoryDraftState[] = roles.map((role) => ({
      role,
      path: `${MEMORY_REVIEW_RUNS_ROOT}/${runId}/drafts/${role}.md`,
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
      drafts
    };
    const before = await readMemorySet(input.taskRepoRoot);
    await writeRunMemorySet(input.taskRepoRoot, runId, "before", before);
    await writeRunMemorySet(input.taskRepoRoot, runId, "after", before);
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
      reason: "Auto Memory must complete for this Final Acceptance before Task Harness Retrospective."
    };
  }

  async function isRoleMemoryTurn(taskRepoRoot: string, role: RoleName): Promise<boolean> {
    const state = await loadActiveState(taskRepoRoot);
    const draft = state?.status === "collecting" ? currentDraft(state) : undefined;
    return draft?.role === role && draft.status === "dispatched";
  }

  async function handleRoleHook(input: AutoMemoryRoleHookInput): Promise<boolean> {
    const state = await loadActiveState(input.taskRepoRoot);
    if (!(await deps.appSettings.getPreferences()).autoMemoryEnabled) {
      if (state) {
        await discardActiveReview(input.taskRepoRoot, state);
        return true;
      }
      return false;
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
    if (!content || !/^Decision:\s*(update|no-change)\s*$/im.test(content)) {
      await failReview(input.taskRepoRoot, state, `${input.role} memory draft is missing a valid Decision: update or Decision: no-change field.`);
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
    await dispatchHarnessReview(input.baseRepoRoot, input.taskRepoRoot, state);
    return true;
  }

  async function handleHarnessEngineerHook(input: AutoMemoryHarnessHookInput): Promise<boolean> {
    const state = await loadActiveState(input.taskRepoRoot);
    if (!(await deps.appSettings.getPreferences()).autoMemoryEnabled) {
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
      await failReview(input.taskRepoRoot, state, "Harness Engineer memory review turn failed.");
      return true;
    }
    if (input.eventName === "Stop") {
      await applyReviewedMemory(input.taskRepoRoot, state);
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
    await clearActiveState(taskRepoRoot);
    return getState(baseRepoRoot, taskRepoRoot);
  }

  async function assertHarnessEngineerAvailable(taskRepoRoot: string): Promise<void> {
    const state = await loadActiveState(taskRepoRoot);
    if (state && !(await deps.appSettings.getPreferences()).autoMemoryEnabled) {
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
    if (state && !(await deps.appSettings.getPreferences()).autoMemoryEnabled) {
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
      await submitTerminalInput(deps.runtime, session.id, buildRoleDraftPrompt(taskRepoRoot, state, draft));
    } catch (error) {
      await failReview(taskRepoRoot, state, `Unable to start ${draft.role} memory draft: ${errorMessage(error)}`);
    }
  }

  async function dispatchHarnessReview(baseRepoRoot: string, taskRepoRoot: string, state: StoredMemoryReviewState): Promise<void> {
    if (state.status !== "reviewing" || state.reviewPromptDispatchedAt) {
      return;
    }
    if (deps.isHarnessEngineerAvailable && !(await deps.isHarnessEngineerAvailable(baseRepoRoot))) {
      return;
    }
    try {
      const existing = await deps.sessionService.getRoleSession(baseRepoRoot, state.taskSlug, "harness-engineer");
      if (existing?.activityStatus === "running") {
        return;
      }
      const input = { cols: 120, rows: 32 };
      const session = existing?.status === "running"
        ? existing
        : existing?.claudeSessionId
          ? await deps.sessionService.resumeRoleSession(baseRepoRoot, state.taskSlug, "harness-engineer", input)
          : await deps.sessionService.startRoleSession(baseRepoRoot, state.taskSlug, "harness-engineer", input);
      if (session.status !== "running" || session.activityStatus === "running" || !deps.runtime.getSession(session.id)) {
        return;
      }
      state.reviewPromptDispatchedAt = now();
      state.updatedAt = state.reviewPromptDispatchedAt;
      await persistActiveState(taskRepoRoot, state);
      await submitTerminalInput(deps.runtime, session.id, buildHarnessReviewPrompt(taskRepoRoot, state));
    } catch (error) {
      await failReview(taskRepoRoot, state, `Unable to start Harness Engineer memory review: ${errorMessage(error)}`);
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

  async function applyReviewedMemory(
    taskRepoRoot: string,
    state: StoredMemoryReviewState
  ): Promise<void> {
    try {
      const before = await readRunMemorySet(taskRepoRoot, state.runId, "before");
      const after = await readRunMemorySet(taskRepoRoot, state.runId, "after");
      assertCompleteMemorySet(after);
      await applyAndCommitMemorySet(taskRepoRoot, before, after, "chore: update VCM memory");
      const timestamp = now();
      const diff = renderMemoryDiff(before, after);
      const run = await readRun(taskRepoRoot, state.runId);
      await persistRun(taskRepoRoot, {
        ...run,
        status: "applied",
        updatedAt: timestamp,
        appliedAt: timestamp,
        afterHashes: hashMemorySet(after),
        diff
      });
      await deps.fs.writeText(resolveRepoPath(taskRepoRoot, `${MEMORY_REVIEW_RUNS_ROOT}/${state.runId}/applied.patch`), diff);
      await clearActiveState(taskRepoRoot);
    } catch (error) {
      await failReview(taskRepoRoot, state, `Harness Engineer memory result could not be applied: ${errorMessage(error)}`);
    }
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
      await applyAndCommitMemorySet(taskRepoRoot, before, after, "chore: update VCM memory");
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
    reconcileTask,
    getState,
    getTaskRetrospectiveReadiness,
    getFile,
    updateFile,
    revertRun,
    retryFailedReview,
    isRoleMemoryTurn,
    handleRoleHook,
    handleHarnessEngineerHook,
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
    trigger: state.trigger,
    error: state.error
  };
}

function buildRoleDraftPrompt(taskRepoRoot: string, state: StoredMemoryReviewState, draft: MemoryDraftState): string {
  const roleDefinition = MEMORY_FILE_DEFINITIONS.find((definition) => "role" in definition && definition.role === draft.role);
  if (!roleDefinition) {
    throw new Error(`Missing memory definition for role: ${draft.role}`);
  }
  return [
    "[VCM Task Harness Review: Memory Proposal]",
    "",
    "Use the vcm-propose-memory skill to submit the assigned proposal.",
    `Task worktree: ${taskRepoRoot}`,
    `Current shared memory block: ${resolveRepoPath(taskRepoRoot, "CLAUDE.md")}`,
    `Current role memory block: ${resolveRepoPath(taskRepoRoot, roleDefinition.path)}`,
    `Write the draft to: ${resolveRepoPath(taskRepoRoot, draft.path)}`,
    "",
    "End the turn after writing the draft."
  ].join("\n");
}

function buildHarnessReviewPrompt(taskRepoRoot: string, state: StoredMemoryReviewState): string {
  const runRoot = resolveRepoPath(taskRepoRoot, `${MEMORY_REVIEW_RUNS_ROOT}/${state.runId}`);
  return [
    "[VCM Task Harness Review: Memory Review]",
    "",
    "Auto Memory is enabled. Review the role proposals and task evidence, then produce the complete next memory set.",
    `Task worktree: ${taskRepoRoot}`,
    `Role drafts: ${path.join(runRoot, "drafts")}`,
    `Current memory snapshot: ${path.join(runRoot, "before")}`,
    `Write the complete reviewed memory set to: ${path.join(runRoot, "after")}`,
    "",
    "Each snapshot file contains only the matching <VCM-memory> block content, not the full host file.",
    "Keep only verified, durable, reusable project knowledge. Merge duplicates, remove stale entries, and keep role-specific knowledge in the matching role file.",
    "Do not record task narrative, temporary state, unverified conclusions, or Harness rules.",
    "Do not edit product code, active harness files, active memory blocks, or review metadata.",
    "All existing files already exist in the after directory. Edit those files in place and end the turn when review is complete."
  ].join("\n");
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
