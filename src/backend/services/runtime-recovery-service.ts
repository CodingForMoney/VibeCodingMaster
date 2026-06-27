import path from "node:path";
import { GATE_REVIEW_GATES, type GateReviewGate, type GateReviewIndex } from "../../shared/types/gate-review.js";
import type { VcmRoleMessage } from "../../shared/types/message.js";
import type { RoleName, RoleStatus } from "../../shared/types/role.js";
import type { RoleSessionPointer, RoleSessionRecord, TaskSessionRecord } from "../../shared/types/session.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import type { ProjectService } from "./project-service.js";
import type { TaskService } from "./task-service.js";
import { getTaskRuntimeRepoRoot } from "./task-service.js";
import type { TranslationWorkerService } from "./translation-worker-service.js";

export interface RuntimeRecoveryService {
  recoverProject(repoRoot: string): Promise<ProjectRuntimeRecoveryReport>;
}

export interface ProjectRuntimeRecoveryReport {
  repoRoot: string;
  recoveredAt: string;
  changedPaths: string[];
  warnings: string[];
}

export interface RuntimeRecoveryServiceDeps {
  fs: FileSystemAdapter;
  runtime: Pick<TerminalRuntime, "getSession" | "getSessionByRole" | "listSessions">;
  projectService: Pick<ProjectService, "loadConfig">;
  taskService: Pick<TaskService, "listTasks" | "updateTaskStatus">;
  translationWorkerService?: Pick<TranslationWorkerService, "cleanupStartupRuntime">;
  now?: () => string;
}

interface RuntimeRecoveryContext {
  changedPaths: Set<string>;
  warnings: string[];
}

interface RecoverableRoundFile {
  version: 1;
  taskSlug: string;
  currentRound?: RecoverableRound;
  lastStoppedRound?: RecoverableRound;
  roleRecovery?: {
    role?: string;
    status?: string;
  };
  pendingUserReply?: unknown;
  totalCompletedTurnCount?: number;
  totalCcActiveMs?: number;
  updatedAt: string;
}

interface RecoverableRound {
  id?: string;
  status?: "running" | "stopped";
  activeRole?: RoleName;
  activeTurnStartedAt?: string;
  lastTurnStartedAt?: string;
  lastTurnEndedAt?: string;
  settleDeadlineAt?: string;
  stoppedAt?: string;
  stopReason?: "manual-interrupt" | "runtime-recovery";
  ccActiveMs?: number;
  completedTurnCount?: number;
}

interface ProjectRoleSessionFile {
  version: 1;
  role: RoleName;
  updatedAt: string;
  record: RoleSessionRecord;
}

interface HarnessBootstrapRunState {
  version: 1;
  status?: "running" | "complete";
  updatedAt: string;
}

interface HarnessFeedbackState {
  version: 1;
  status?: "analyzing" | "awaiting_user_approval" | "applying";
  active?: {
    id?: string;
    analysisPath?: string;
    updatedAt?: string;
  };
  updatedAt?: string;
}

const TRANSLATOR_SESSION_PATH = ".ai/vcm/translations/session.json";
const HARNESS_ENGINEER_SESSION_PATH = ".ai/vcm/harness-engineer/session.json";
const BOOTSTRAP_SESSION_PATH = ".ai/vcm/bootstrap/session.json";
const HARNESS_FEEDBACK_STATE_PATH = ".ai/vcm/harness-feedback/state.json";
const RECOVERABLE_FEEDBACK_STATES = new Set(["analyzing", "applying"]);

export function createRuntimeRecoveryService(deps: RuntimeRecoveryServiceDeps): RuntimeRecoveryService {
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    async recoverProject(repoRoot) {
      const recoveredAt = now();
      const context: RuntimeRecoveryContext = {
        changedPaths: new Set(),
        warnings: []
      };

      await runStep(context, "cleanup translation runtime", () =>
        deps.translationWorkerService?.cleanupStartupRuntime(repoRoot) ?? Promise.resolve()
      );

      const config = await deps.projectService.loadConfig(repoRoot);
      await runStep(context, "recover project tool sessions", () => recoverProjectToolSessions(repoRoot, recoveredAt, context));
      await runStep(context, "recover harness bootstrap", () => recoverHarnessBootstrap(repoRoot, recoveredAt, context));
      await runStep(context, "recover harness feedback", () => recoverHarnessFeedback(repoRoot, recoveredAt, context));

      const tasks = await deps.taskService.listTasks(repoRoot);
      for (const task of tasks.filter((candidate) => candidate.cleanupStatus !== "cleaned")) {
        const taskRepoRoot = getTaskRuntimeRepoRoot(task);
        await runStep(context, `recover task ${task.taskSlug}`, async () => {
          await recoverTaskSessions(taskRepoRoot, config.stateRoot, task.taskSlug, recoveredAt, context);
          const roundRecovered = await recoverRound(taskRepoRoot, config.stateRoot, task.taskSlug, recoveredAt, context);
          await recoverMessages(taskRepoRoot, config.stateRoot, task.taskSlug, recoveredAt, context);
          await recoverGateReview(taskRepoRoot, recoveredAt, context);
          if ((roundRecovered || task.status === "running") && !hasLiveTaskSession(task.taskSlug)) {
            await deps.taskService.updateTaskStatus(repoRoot, task.taskSlug, "stopped");
          }
        });
      }

      return {
        repoRoot,
        recoveredAt,
        changedPaths: [...context.changedPaths].sort(),
        warnings: context.warnings
      };
    }
  };

  async function recoverProjectToolSessions(
    repoRoot: string,
    timestamp: string,
    context: RuntimeRecoveryContext
  ): Promise<void> {
    await recoverProjectRoleSessionFile(repoRoot, TRANSLATOR_SESSION_PATH, timestamp, context);
    await recoverProjectRoleSessionFile(repoRoot, HARNESS_ENGINEER_SESSION_PATH, timestamp, context);
  }

  async function recoverProjectRoleSessionFile(
    repoRoot: string,
    relativePath: string,
    timestamp: string,
    context: RuntimeRecoveryContext
  ): Promise<void> {
    const absolutePath = path.join(repoRoot, relativePath);
    const state = await readJsonIfExists<ProjectRoleSessionFile>(absolutePath);
    if (!state?.record) {
      return;
    }
    const next = recoverRoleSessionRecord(state.record, timestamp);
    if (!next.changed) {
      return;
    }
    await deps.fs.writeJsonAtomic(absolutePath, {
      ...state,
      updatedAt: timestamp,
      record: next.record
    });
    context.changedPaths.add(relativePath);
  }

  async function recoverTaskSessions(
    taskRepoRoot: string,
    stateRoot: string,
    taskSlug: string,
    timestamp: string,
    context: RuntimeRecoveryContext
  ): Promise<void> {
    const relativePath = path.join(stateRoot, "sessions", `${taskSlug}.json`);
    const absolutePath = path.join(taskRepoRoot, relativePath);
    const state = await readJsonIfExists<TaskSessionRecord>(absolutePath);
    if (!state?.roles) {
      return;
    }

    let changed = false;
    const roles: TaskSessionRecord["roles"] = {};
    for (const [role, pointer] of Object.entries(state.roles) as Array<[RoleName, RoleSessionPointer | undefined]>) {
      if (!pointer) {
        continue;
      }
      const record = pointer.record;
      if (!record) {
        roles[role] = pointer;
        continue;
      }
      const next = recoverRoleSessionRecord(record, timestamp);
      changed ||= next.changed;
      roles[role] = {
        ...pointer,
        status: next.record.status,
        record: next.record
      };
    }

    if (!changed) {
      return;
    }
    await deps.fs.writeJsonAtomic(absolutePath, {
      ...state,
      updatedAt: timestamp,
      roles
    });
    context.changedPaths.add(relativePath);
  }

  function recoverRoleSessionRecord(
    record: RoleSessionRecord,
    timestamp: string
  ): { changed: boolean; record: RoleSessionRecord } {
    const live = record.id ? deps.runtime.getSession(record.id) : undefined;
    if (live?.status === "running") {
      return { changed: false, record };
    }

    const recoveredStatus = getRecoveredSessionStatus(record);
    const shouldIdle = record.activityStatus !== "idle";
    if (record.status === recoveredStatus && !shouldIdle) {
      return { changed: false, record };
    }

    return {
      changed: true,
      record: {
        ...record,
        status: recoveredStatus,
        activityStatus: "idle",
        lastTurnEndedAt: record.lastTurnEndedAt ?? timestamp,
        updatedAt: timestamp
      }
    };
  }

  async function recoverRound(
    taskRepoRoot: string,
    stateRoot: string,
    taskSlug: string,
    timestamp: string,
    context: RuntimeRecoveryContext
  ): Promise<boolean> {
    const relativePath = path.join(stateRoot, "rounds", `${taskSlug}.json`);
    const absolutePath = path.join(taskRepoRoot, relativePath);
    const state = await readJsonIfExists<RecoverableRoundFile>(absolutePath);
    if (!state) {
      return false;
    }

    let changed = false;
    let current = state.currentRound;
    if (current?.status === "running" && !hasLiveRoundRole(taskSlug, current.activeRole)) {
      const activeDurationMs = current.activeTurnStartedAt
        ? getDurationMs(current.activeTurnStartedAt, timestamp)
        : 0;
      const completedIncrement = current.activeTurnStartedAt ? 1 : 0;
      current = {
        ...current,
        status: "stopped",
        lastTurnEndedAt: current.lastTurnEndedAt ?? timestamp,
        stoppedAt: timestamp,
        stopReason: "runtime-recovery",
        settleDeadlineAt: undefined,
        activeTurnStartedAt: undefined,
        ccActiveMs: (current.ccActiveMs ?? 0) + activeDurationMs,
        completedTurnCount: (current.completedTurnCount ?? 0) + completedIncrement
      };
      changed = true;
      state.currentRound = current;
      state.lastStoppedRound = current;
      state.totalCompletedTurnCount = (state.totalCompletedTurnCount ?? 0) + completedIncrement;
      state.totalCcActiveMs = (state.totalCcActiveMs ?? 0) + activeDurationMs;
      state.pendingUserReply = undefined;
    }

    if (state.roleRecovery?.status === "waiting" || state.roleRecovery?.status === "retrying") {
      state.roleRecovery = undefined;
      changed = true;
    }

    if (!changed) {
      return false;
    }
    state.updatedAt = timestamp;
    await deps.fs.writeJsonAtomic(absolutePath, state);
    context.changedPaths.add(relativePath);
    return true;
  }

  async function recoverMessages(
    taskRepoRoot: string,
    stateRoot: string,
    taskSlug: string,
    timestamp: string,
    context: RuntimeRecoveryContext
  ): Promise<void> {
    const relativePath = path.join(stateRoot, "messages", `${taskSlug}.jsonl`);
    const absolutePath = path.join(taskRepoRoot, relativePath);
    if (!(await deps.fs.pathExists(absolutePath))) {
      return;
    }
    const lines = (await deps.fs.readText(absolutePath)).split(/\r?\n/).filter((line) => line.trim());
    let changed = false;
    const messages = lines.map((line) => {
      const message = JSON.parse(line) as VcmRoleMessage;
      if (message.dispatchingAt && !message.acceptedAt) {
        const next = {
          ...message,
          failureReason: "VCM restarted before this dispatch was confirmed. Resend the message if it is still needed."
        };
        delete next.dispatchingAt;
        delete next.deliveredAt;
        changed = true;
        return next;
      }
      return message;
    });

    if (!changed) {
      return;
    }
    const content = messages.length ? `${messages.map((message) => JSON.stringify(message)).join("\n")}\n` : "";
    await deps.fs.writeText(absolutePath, content);
    context.changedPaths.add(relativePath);
    void timestamp;
  }

  async function recoverGateReview(
    taskRepoRoot: string,
    timestamp: string,
    context: RuntimeRecoveryContext
  ): Promise<void> {
    const relativePath = path.join(".ai/vcm/gate-reviews", "index.json");
    const absolutePath = path.join(taskRepoRoot, relativePath);
    const index = await readJsonIfExists<GateReviewIndex>(absolutePath);
    if (!index?.gates) {
      return;
    }

    let changed = false;
    const gates = { ...index.gates };
    for (const gate of GATE_REVIEW_GATES) {
      const record = gates[gate];
      if (record?.status !== "running") {
        continue;
      }
      gates[gate] = {
        ...record,
        status: "pending",
        error: "VCM restarted before this Gate Review completed. Request the gate again if it is still required.",
        updatedAt: timestamp
      };
      changed = true;
    }
    const activeGate = isGateReviewGate(index.activeGate) && gates[index.activeGate].status === "running"
      ? index.activeGate
      : null;
    changed ||= index.activeGate !== activeGate;
    if (!changed) {
      return;
    }
    await deps.fs.writeJsonAtomic(absolutePath, {
      ...index,
      activeGate,
      gates,
      updatedAt: timestamp
    });
    context.changedPaths.add(relativePath);
  }

  async function recoverHarnessBootstrap(
    repoRoot: string,
    _timestamp: string,
    context: RuntimeRecoveryContext
  ): Promise<void> {
    const absolutePath = path.join(repoRoot, BOOTSTRAP_SESSION_PATH);
    const state = await readJsonIfExists<HarnessBootstrapRunState>(absolutePath);
    if (state?.status !== "running") {
      return;
    }
    await deps.fs.removePath?.(absolutePath, { force: true });
    context.changedPaths.add(BOOTSTRAP_SESSION_PATH);
  }

  async function recoverHarnessFeedback(
    repoRoot: string,
    timestamp: string,
    context: RuntimeRecoveryContext
  ): Promise<void> {
    const absolutePath = path.join(repoRoot, HARNESS_FEEDBACK_STATE_PATH);
    const state = await readJsonIfExists<HarnessFeedbackState>(absolutePath);
    if (!state?.status || !RECOVERABLE_FEEDBACK_STATES.has(state.status)) {
      return;
    }

    const previousStatus = state.status;
    const next: HarnessFeedbackState = {
      ...state,
      status: "awaiting_user_approval",
      updatedAt: timestamp,
      active: state.active
        ? {
            ...state.active,
            updatedAt: timestamp
          }
        : state.active
    };
    await deps.fs.writeJsonAtomic(absolutePath, next);
    context.changedPaths.add(HARNESS_FEEDBACK_STATE_PATH);

    const analysisPath = state.active?.analysisPath;
    if (analysisPath) {
      const notePath = path.join(repoRoot, analysisPath);
      if (!(await deps.fs.pathExists(notePath))) {
        await deps.fs.writeText(notePath, [
          "# Harness Feedback Recovery",
          "",
          `VCM restarted while this harness feedback item was ${previousStatus}.`,
          "Review the current repository diff and either comment, reject, cancel, or approve explicitly."
        ].join("\n"));
        context.changedPaths.add(analysisPath);
      }
    }
  }

  function hasLiveTaskSession(taskSlug: string): boolean {
    return deps.runtime.listSessions(taskSlug).some((session) => session.status === "running");
  }

  function hasLiveRoundRole(taskSlug: string, role: RoleName | undefined): boolean {
    if (!role) {
      return false;
    }
    return deps.runtime.getSessionByRole(taskSlug, role)?.status === "running";
  }

  async function readJsonIfExists<T>(absolutePath: string): Promise<T | undefined> {
    if (!(await deps.fs.pathExists(absolutePath))) {
      return undefined;
    }
    return deps.fs.readJson<T>(absolutePath);
  }
}

function getRecoveredSessionStatus(record: RoleSessionRecord): RoleStatus {
  if (record.status === "done") {
    return "done";
  }
  if (record.claudeSessionId?.trim()) {
    return "resumable";
  }
  if (record.status === "not_started") {
    return "not_started";
  }
  return "missing";
}

function getDurationMs(start: string, end: string): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return 0;
  }
  return Math.max(0, endMs - startMs);
}

function isGateReviewGate(value: unknown): value is GateReviewGate {
  return typeof value === "string" && GATE_REVIEW_GATES.includes(value as GateReviewGate);
}

async function runStep(
  context: RuntimeRecoveryContext,
  label: string,
  run: () => Promise<void>
): Promise<void> {
  try {
    await run();
  } catch (error) {
    context.warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
