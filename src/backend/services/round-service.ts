import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ClaudeHookEventName } from "../../shared/types/claude-hook.js";
import type { RoleName } from "../../shared/types/role.js";
import type { VcmSessionRoundState } from "../../shared/types/round.js";
import type { TaskStatus } from "../../shared/types/task.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";

export interface RoundService {
  getSessionRoundState(input: SessionRoundInput): Promise<VcmSessionRoundState>;
  recordClaudeHookEvent(input: RecordRoundHookEventInput): Promise<VcmSessionRoundState>;
  stopSession(sessionId: string): void;
  stopTask(taskSlug: string): void;
}

export interface SessionRoundInput {
  repoRoot?: string;
  stateRepoRoot: string;
  stateRoot: string;
  taskSlug: string;
}

export interface RecordRoundHookEventInput extends SessionRoundInput {
  role: RoleName;
  eventName: ClaudeHookEventName;
  settleGuard?: RoundSettleGuard;
}

export interface RoundSettleGuardInput extends SessionRoundInput {
  role: RoleName;
  roundId: string;
  settleDeadlineAt: string;
}

export type RoundSettleGuardResult =
  | { action: "stop" }
  | { action: "continue"; reason?: string };

export type RoundSettleGuard = (input: RoundSettleGuardInput) => Promise<RoundSettleGuardResult>;

export interface RoundServiceDeps {
  fs: FileSystemAdapter;
  now?: () => string;
  id?: () => string;
  settleMs?: number;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  onSessionStatusChange?: (input: {
    repoRoot: string;
    taskSlug: string;
    status: TaskStatus;
  }) => Promise<void>;
}

interface PersistedRoundFile {
  version: 1;
  taskSlug: string;
  currentRound?: PersistedRound;
  lastStoppedRound?: PersistedRound;
  totalRoundCount: number;
  totalTurnCount: number;
  totalCompletedTurnCount: number;
  totalCcActiveMs: number;
  updatedAt: string;
}

interface PersistedRound {
  id: string;
  sequence: number;
  status: "running" | "stopped";
  activeRole: RoleName;
  startedAt: string;
  lastTurnStartedAt?: string;
  lastTurnEndedAt?: string;
  settleDeadlineAt?: string;
  stoppedAt?: string;
  activeTurnStartedAt?: string;
  ccActiveMs: number;
  turnCount: number;
  completedTurnCount: number;
  roles: RoleName[];
}

const DEFAULT_SETTLE_MS = 10_000;
const setGlobalTimeout = globalThis.setTimeout.bind(globalThis) as (callback: () => void, delayMs: number) => unknown;
const clearGlobalTimeout = globalThis.clearTimeout.bind(globalThis) as (timer: unknown) => void;

export function createRoundService(deps: RoundServiceDeps): RoundService {
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? (() => `round_${randomUUID()}`);
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
  const setTimer = deps.setTimeout ?? setGlobalTimeout;
  const clearTimer = deps.clearTimeout ?? clearGlobalTimeout;
  const taskLocks = new Map<string, Promise<unknown>>();
  const settleTimers = new Map<string, unknown>();

  async function load(input: SessionRoundInput): Promise<PersistedRoundFile> {
    const statePath = getRoundStatePath(input);
    if (!(await deps.fs.pathExists(statePath))) {
      return {
        version: 1,
        taskSlug: input.taskSlug,
        totalRoundCount: 0,
        totalTurnCount: 0,
        totalCompletedTurnCount: 0,
        totalCcActiveMs: 0,
        updatedAt: now()
      };
    }
    return normalizeRoundFile(await deps.fs.readJson<Partial<PersistedRoundFile>>(statePath), input.taskSlug, now());
  }

  async function save(input: SessionRoundInput, state: PersistedRoundFile): Promise<void> {
    await deps.fs.writeJsonAtomic(getRoundStatePath(input), state);
  }

  async function updateSessionStatus(input: SessionRoundInput, status: TaskStatus): Promise<void> {
    if (!input.repoRoot || !deps.onSessionStatusChange) {
      return;
    }
    await deps.onSessionStatusChange({
      repoRoot: input.repoRoot,
      taskSlug: input.taskSlug,
      status
    });
  }

  async function settleIfNeeded(input: SessionRoundInput, state: PersistedRoundFile, timestamp: string): Promise<PersistedRoundFile> {
    const current = state.currentRound;
    if (
      current?.status !== "running" ||
      !current.settleDeadlineAt ||
      current.activeTurnStartedAt
    ) {
      return state;
    }

    if (timestamp < current.settleDeadlineAt) {
      return state;
    }

    const stopped: PersistedRound = {
      ...current,
      status: "stopped",
      stoppedAt: current.settleDeadlineAt,
      settleDeadlineAt: undefined
    };
    const next = {
      ...state,
      currentRound: stopped,
      lastStoppedRound: stopped,
      updatedAt: timestamp
    };
    await save(input, next);
    await updateSessionStatus(input, "stopped");
    return next;
  }

  async function settleIfStillCurrent(
    input: SessionRoundInput,
    roundId: string,
    settleDeadlineAt: string,
    settleGuard?: RoundSettleGuard
  ): Promise<void> {
    await withTaskLock(input, async () => {
      const state = await load(input);
      const current = state.currentRound;
      if (
        current?.id !== roundId ||
        current.status !== "running" ||
        current.settleDeadlineAt !== settleDeadlineAt ||
        current.activeTurnStartedAt
      ) {
        return;
      }
      const timestamp = maxIsoTimestamp(now(), settleDeadlineAt);
      if (settleGuard) {
        const decision = await runSettleGuard(settleGuard, {
          ...input,
          role: current.activeRole,
          roundId,
          settleDeadlineAt
        });
        if (decision.action === "continue") {
          const nextRound = {
            ...current,
            settleDeadlineAt: addMilliseconds(timestamp, settleMs)
          };
          const next = {
            ...state,
            currentRound: nextRound,
            updatedAt: timestamp
          };
          await save(input, next);
          scheduleSettleTimer(input, nextRound, timestamp, settleGuard);
          return;
        }
      }
      await settleIfNeeded(input, state, timestamp);
    });
  }

  function clearSettleTimer(input: SessionRoundInput): void {
    const key = getRoundStatePath(input);
    const timer = settleTimers.get(key);
    if (timer === undefined) {
      return;
    }
    clearTimer(timer);
    settleTimers.delete(key);
  }

  function clearSettleTimersForTask(taskSlug: string): void {
    for (const [key, timer] of settleTimers) {
      if (!key.endsWith(path.join("rounds", `${taskSlug}.json`))) {
        continue;
      }
      clearTimer(timer);
      settleTimers.delete(key);
    }
  }

  function scheduleSettleTimer(
    input: SessionRoundInput,
    round: PersistedRound,
    timestamp: string,
    settleGuard?: RoundSettleGuard
  ): void {
    if (
      round.status !== "running" ||
      !round.settleDeadlineAt ||
      round.activeTurnStartedAt
    ) {
      clearSettleTimer(input);
      return;
    }

    clearSettleTimer(input);
    const delayMs = Math.max(0, new Date(round.settleDeadlineAt).getTime() - new Date(timestamp).getTime());
    const timer = setTimer(() => {
      settleTimers.delete(getRoundStatePath(input));
      void settleIfStillCurrent(input, round.id, round.settleDeadlineAt ?? "", settleGuard).catch(() => undefined);
    }, delayMs);
    settleTimers.set(getRoundStatePath(input), timer);
  }

  async function withTaskLock<T>(input: SessionRoundInput, run: () => Promise<T>): Promise<T> {
    const key = getRoundStatePath(input);
    const previous = taskLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    taskLocks.set(key, next);
    try {
      return await next;
    } finally {
      if (taskLocks.get(key) === next) {
        taskLocks.delete(key);
      }
    }
  }

  return {
    async getSessionRoundState(input) {
      return withTaskLock(input, async () => {
        const timestamp = now();
        return toSessionRoundState(await load(input), timestamp);
      });
    },
    async recordClaudeHookEvent(input) {
      return withTaskLock(input, async () => {
        const timestamp = now();
        const settled = await settleIfNeeded(input, await load(input), timestamp);
        const current = settled.currentRound;
        const shouldStartNewRound = input.eventName === "UserPromptSubmit" && (!current || current.status === "stopped");
        const next = applyRoundHookEvent({
          state: settled,
          taskSlug: input.taskSlug,
          role: input.role,
          eventName: input.eventName,
          timestamp,
          roundId: shouldStartNewRound ? id() : current?.id ?? "",
          settleMs
        });
        await save(input, next);
        if (input.eventName === "UserPromptSubmit") {
          clearSettleTimer(input);
          await updateSessionStatus(input, "running");
        } else if (next.currentRound) {
          scheduleSettleTimer(input, next.currentRound, timestamp, input.settleGuard);
        }
        return toSessionRoundState(next, timestamp);
      });
    },
    stopSession() {},
    stopTask(taskSlug) {
      clearSettleTimersForTask(taskSlug);
    }
  };
}

export function applyRoundHookEvent(input: {
  state: PersistedRoundFile;
  taskSlug: string;
  role: RoleName;
  eventName: ClaudeHookEventName;
  timestamp: string;
  roundId: string;
  settleMs: number;
}): PersistedRoundFile {
  if (input.eventName === "UserPromptSubmit") {
    return applyPromptSubmitted(input);
  }
  return applyStop(input);
}

function applyPromptSubmitted(input: {
  state: PersistedRoundFile;
  taskSlug: string;
  role: RoleName;
  timestamp: string;
  roundId: string;
}): PersistedRoundFile {
  const current = input.state.currentRound;
  const shouldStartNewRound = !current || current.status === "stopped";
  const totalRoundCount = shouldStartNewRound
    ? input.state.totalRoundCount + 1
    : input.state.totalRoundCount;
  const nextRound: PersistedRound = shouldStartNewRound
    ? {
        id: input.roundId,
        sequence: totalRoundCount,
        status: "running",
        activeRole: input.role,
        startedAt: input.timestamp,
        lastTurnStartedAt: input.timestamp,
        activeTurnStartedAt: input.timestamp,
        ccActiveMs: 0,
        turnCount: 1,
        completedTurnCount: 0,
        roles: [input.role]
      }
    : {
        ...current,
        status: "running",
        activeRole: input.role,
        lastTurnStartedAt: input.timestamp,
        settleDeadlineAt: undefined,
        stoppedAt: undefined,
        activeTurnStartedAt: current.activeTurnStartedAt ?? input.timestamp,
        turnCount: current.turnCount + 1,
        roles: appendUniqueRole(current.roles, input.role)
      };

  return {
    ...input.state,
    taskSlug: input.taskSlug,
    currentRound: nextRound,
    totalRoundCount,
    totalTurnCount: input.state.totalTurnCount + 1,
    totalCompletedTurnCount: input.state.totalCompletedTurnCount,
    totalCcActiveMs: input.state.totalCcActiveMs,
    updatedAt: input.timestamp
  };
}

function applyStop(input: {
  state: PersistedRoundFile;
  taskSlug: string;
  role: RoleName;
  timestamp: string;
  roundId: string;
  settleMs: number;
}): PersistedRoundFile {
  const current = input.state.currentRound;
  if (!current || current.status === "stopped" || !current.activeTurnStartedAt) {
    return {
      ...input.state,
      taskSlug: input.taskSlug,
      updatedAt: input.timestamp
    };
  }

  const activeDurationMs = current.activeTurnStartedAt
    ? getDurationMs(current.activeTurnStartedAt, input.timestamp)
    : 0;
  const nextRound: PersistedRound = {
    ...current,
    status: "running",
    activeRole: input.role,
    lastTurnEndedAt: input.timestamp,
    settleDeadlineAt: addMilliseconds(input.timestamp, input.settleMs),
    activeTurnStartedAt: undefined,
    ccActiveMs: current.ccActiveMs + activeDurationMs,
    completedTurnCount: current.completedTurnCount + 1,
    roles: appendUniqueRole(current.roles, input.role)
  };

  return {
    ...input.state,
    taskSlug: input.taskSlug,
    currentRound: nextRound,
    totalCompletedTurnCount: input.state.totalCompletedTurnCount + 1,
    totalCcActiveMs: input.state.totalCcActiveMs + activeDurationMs,
    updatedAt: input.timestamp
  };
}

function toSessionRoundState(state: PersistedRoundFile, updatedAt: string): VcmSessionRoundState {
  const current = state.currentRound;
  if (!current) {
    return {
      taskSlug: state.taskSlug,
      status: "stopped",
      turnCount: 0,
      completedTurnCount: 0,
      totalRoundCount: state.totalRoundCount,
      totalTurnCount: state.totalTurnCount,
      totalCompletedTurnCount: state.totalCompletedTurnCount,
      totalCcActiveMs: state.totalCcActiveMs,
      currentRoundCcActiveMs: 0,
      roles: [],
      updatedAt
    };
  }

  const activeDurationMs = current.activeTurnStartedAt
    ? getDurationMs(current.activeTurnStartedAt, updatedAt)
    : 0;
  const currentRoundCcActiveMs = current.ccActiveMs + activeDurationMs;

  return {
    taskSlug: state.taskSlug,
    status: current.status,
    roundId: current.id,
    activeRole: current.activeRole,
    startedAt: current.startedAt,
    lastTurnStartedAt: current.lastTurnStartedAt,
    lastTurnEndedAt: current.lastTurnEndedAt,
    settleDeadlineAt: current.settleDeadlineAt,
    stoppedAt: current.stoppedAt,
    activeTurnStartedAt: current.activeTurnStartedAt,
    roundSequence: current.sequence,
    turnCount: current.turnCount,
    completedTurnCount: current.completedTurnCount,
    totalRoundCount: state.totalRoundCount,
    totalTurnCount: state.totalTurnCount,
    totalCompletedTurnCount: state.totalCompletedTurnCount,
    totalCcActiveMs: state.totalCcActiveMs + activeDurationMs,
    currentRoundCcActiveMs,
    roles: current.roles,
    updatedAt
  };
}

function normalizeRoundFile(input: Partial<PersistedRoundFile>, taskSlug: string, updatedAt: string): PersistedRoundFile {
  const legacy = input as Partial<PersistedRoundFile> & {
    lastPausedRound?: PersistedRound;
    totalPromptSubmitCount?: unknown;
    totalStopCount?: unknown;
  };
  return {
    version: 1,
    taskSlug,
    currentRound: normalizeRound(input.currentRound),
    lastStoppedRound: normalizeRound(input.lastStoppedRound ?? legacy.lastPausedRound),
    totalRoundCount: normalizeNumber(input.totalRoundCount),
    totalTurnCount: normalizeNumber(input.totalTurnCount ?? legacy.totalPromptSubmitCount),
    totalCompletedTurnCount: normalizeNumber(input.totalCompletedTurnCount ?? legacy.totalStopCount),
    totalCcActiveMs: normalizeNumber(input.totalCcActiveMs),
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : updatedAt
  };
}

function normalizeRound(input: PersistedRound | undefined): PersistedRound | undefined {
  if (!input || typeof input.id !== "string") {
    return undefined;
  }
  const status = normalizeRoundStatus(input.status);
  if (!status) {
    return undefined;
  }
  const legacy = input as PersistedRound & {
    lastPromptSubmittedAt?: unknown;
    lastStopAt?: unknown;
    pausedAt?: unknown;
    runningSince?: unknown;
    promptSubmitCount?: unknown;
    stopCount?: unknown;
  };
  return {
    id: input.id,
    sequence: Number.isFinite(input.sequence) ? input.sequence : 1,
    status,
    activeRole: input.activeRole,
    startedAt: input.startedAt,
    lastTurnStartedAt: typeof input.lastTurnStartedAt === "string"
      ? input.lastTurnStartedAt
      : typeof legacy.lastPromptSubmittedAt === "string"
        ? legacy.lastPromptSubmittedAt
        : undefined,
    lastTurnEndedAt: typeof input.lastTurnEndedAt === "string"
      ? input.lastTurnEndedAt
      : typeof legacy.lastStopAt === "string"
        ? legacy.lastStopAt
        : undefined,
    settleDeadlineAt: input.settleDeadlineAt,
    stoppedAt: typeof input.stoppedAt === "string"
      ? input.stoppedAt
      : typeof legacy.pausedAt === "string"
        ? legacy.pausedAt
        : undefined,
    activeTurnStartedAt: typeof input.activeTurnStartedAt === "string"
      ? input.activeTurnStartedAt
      : typeof legacy.runningSince === "string"
        ? legacy.runningSince
        : undefined,
    ccActiveMs: Number.isFinite(input.ccActiveMs) ? input.ccActiveMs : 0,
    turnCount: normalizeNumber(input.turnCount ?? legacy.promptSubmitCount),
    completedTurnCount: normalizeNumber(input.completedTurnCount ?? legacy.stopCount),
    roles: Array.isArray(input.roles) ? input.roles : []
  };
}

function normalizeRoundStatus(value: unknown): PersistedRound["status"] | undefined {
  if (value === "running" || value === "active" || value === "settling") {
    return "running";
  }
  if (value === "stopped" || value === "paused") {
    return "stopped";
  }
  return undefined;
}

function appendUniqueRole(roles: RoleName[], role: RoleName): RoleName[] {
  return roles.includes(role) ? roles : [...roles, role];
}

function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(new Date(value).getTime() + milliseconds).toISOString();
}

function maxIsoTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

async function runSettleGuard(
  settleGuard: RoundSettleGuard,
  input: RoundSettleGuardInput
): Promise<RoundSettleGuardResult> {
  try {
    return await settleGuard(input);
  } catch {
    return { action: "stop" };
  }
}

function getDurationMs(start: string, end: string): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return 0;
  }
  return Math.max(0, endMs - startMs);
}

function normalizeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getRoundStatePath(input: SessionRoundInput): string {
  return path.join(input.stateRepoRoot, input.stateRoot, "rounds", `${input.taskSlug}.json`);
}
