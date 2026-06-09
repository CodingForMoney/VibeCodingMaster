import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ClaudeHookEventName } from "../../shared/types/claude-hook.js";
import type { RoleName } from "../../shared/types/role.js";
import type { VcmTaskRoundState } from "../../shared/types/round.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";

export interface RoundService {
  getTaskRoundState(input: TaskRoundInput): Promise<VcmTaskRoundState>;
  recordClaudeHookEvent(input: RecordRoundHookEventInput): Promise<VcmTaskRoundState>;
  stopSession(sessionId: string): void;
  stopTask(taskSlug: string): void;
}

export interface TaskRoundInput {
  stateRepoRoot: string;
  stateRoot: string;
  taskSlug: string;
}

export interface RecordRoundHookEventInput extends TaskRoundInput {
  role: RoleName;
  eventName: ClaudeHookEventName;
}

export interface RoundServiceDeps {
  fs: FileSystemAdapter;
  now?: () => string;
  id?: () => string;
  settleMs?: number;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

interface PersistedRoundFile {
  version: 1;
  taskSlug: string;
  currentRound?: PersistedRound;
  lastPausedRound?: PersistedRound;
  totalRoundCount: number;
  totalPromptSubmitCount: number;
  totalStopCount: number;
  totalCcActiveMs: number;
  updatedAt: string;
}

interface PersistedRound {
  id: string;
  sequence: number;
  status: "active" | "settling" | "paused";
  activeRole: RoleName;
  startedAt: string;
  lastPromptSubmittedAt?: string;
  lastStopAt?: string;
  settleDeadlineAt?: string;
  pausedAt?: string;
  runningSince?: string;
  ccActiveMs: number;
  promptSubmitCount: number;
  stopCount: number;
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

  async function load(input: TaskRoundInput): Promise<PersistedRoundFile> {
    const statePath = getRoundStatePath(input);
    if (!(await deps.fs.pathExists(statePath))) {
      return {
        version: 1,
        taskSlug: input.taskSlug,
        totalRoundCount: 0,
        totalPromptSubmitCount: 0,
        totalStopCount: 0,
        totalCcActiveMs: 0,
        updatedAt: now()
      };
    }
    return normalizeRoundFile(await deps.fs.readJson<Partial<PersistedRoundFile>>(statePath), input.taskSlug, now());
  }

  async function save(input: TaskRoundInput, state: PersistedRoundFile): Promise<void> {
    await deps.fs.writeJsonAtomic(getRoundStatePath(input), state);
  }

  async function settleIfNeeded(input: TaskRoundInput, state: PersistedRoundFile, timestamp: string): Promise<PersistedRoundFile> {
    const current = state.currentRound;
    if (current?.status !== "settling" || !current.settleDeadlineAt) {
      return state;
    }

    if (timestamp < current.settleDeadlineAt) {
      return state;
    }

    const paused: PersistedRound = {
      ...current,
      status: "paused",
      pausedAt: current.settleDeadlineAt
    };
    const next = {
      ...state,
      currentRound: paused,
      lastPausedRound: paused,
      updatedAt: timestamp
    };
    await save(input, next);
    return next;
  }

  async function settleIfStillCurrent(input: TaskRoundInput, roundId: string, settleDeadlineAt: string): Promise<void> {
    await withTaskLock(input, async () => {
      const state = await load(input);
      const current = state.currentRound;
      if (
        current?.id !== roundId ||
        current.status !== "settling" ||
        current.settleDeadlineAt !== settleDeadlineAt
      ) {
        return;
      }
      await settleIfNeeded(input, state, settleDeadlineAt);
    });
  }

  function clearSettleTimer(input: TaskRoundInput): void {
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

  function scheduleSettleTimer(input: TaskRoundInput, round: PersistedRound, timestamp: string): void {
    if (round.status !== "settling" || !round.settleDeadlineAt) {
      clearSettleTimer(input);
      return;
    }

    clearSettleTimer(input);
    const delayMs = Math.max(0, new Date(round.settleDeadlineAt).getTime() - new Date(timestamp).getTime());
    const timer = setTimer(() => {
      settleTimers.delete(getRoundStatePath(input));
      void settleIfStillCurrent(input, round.id, round.settleDeadlineAt ?? "").catch(() => undefined);
    }, delayMs);
    settleTimers.set(getRoundStatePath(input), timer);
  }

  async function withTaskLock<T>(input: TaskRoundInput, run: () => Promise<T>): Promise<T> {
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
    async getTaskRoundState(input) {
      return withTaskLock(input, async () => {
        const timestamp = now();
        const state = await settleIfNeeded(input, await load(input), timestamp);
        return toTaskRoundState(state, timestamp);
      });
    },
    async recordClaudeHookEvent(input) {
      return withTaskLock(input, async () => {
        const timestamp = now();
        const settled = await settleIfNeeded(input, await load(input), timestamp);
        const current = settled.currentRound;
        const shouldStartNewRound = input.eventName === "UserPromptSubmit" && (!current || current.status === "paused");
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
        } else if (next.currentRound) {
          scheduleSettleTimer(input, next.currentRound, timestamp);
        }
        return toTaskRoundState(next, timestamp);
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
  const shouldStartNewRound = !current || current.status === "paused";
  const totalRoundCount = shouldStartNewRound
    ? input.state.totalRoundCount + 1
    : input.state.totalRoundCount;
  const nextRound: PersistedRound = shouldStartNewRound
    ? {
        id: input.roundId,
        sequence: totalRoundCount,
        status: "active",
        activeRole: input.role,
        startedAt: input.timestamp,
        lastPromptSubmittedAt: input.timestamp,
        runningSince: input.timestamp,
        ccActiveMs: 0,
        promptSubmitCount: 1,
        stopCount: 0,
        roles: [input.role]
      }
    : {
        ...current,
        status: "active",
        activeRole: input.role,
        lastPromptSubmittedAt: input.timestamp,
        settleDeadlineAt: undefined,
        pausedAt: undefined,
        runningSince: current.runningSince ?? input.timestamp,
        promptSubmitCount: current.promptSubmitCount + 1,
        roles: appendUniqueRole(current.roles, input.role)
      };

  return {
    ...input.state,
    taskSlug: input.taskSlug,
    currentRound: nextRound,
    totalRoundCount,
    totalPromptSubmitCount: input.state.totalPromptSubmitCount + 1,
    totalStopCount: input.state.totalStopCount,
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
  if (!current || current.status === "paused") {
    return {
      ...input.state,
      taskSlug: input.taskSlug,
      updatedAt: input.timestamp
    };
  }

  const activeDurationMs = current.runningSince
    ? getDurationMs(current.runningSince, input.timestamp)
    : 0;
  const nextRound: PersistedRound = {
    ...current,
    status: "settling",
    activeRole: input.role,
    lastStopAt: input.timestamp,
    settleDeadlineAt: addMilliseconds(input.timestamp, input.settleMs),
    runningSince: undefined,
    ccActiveMs: current.ccActiveMs + activeDurationMs,
    stopCount: current.stopCount + 1,
    roles: appendUniqueRole(current.roles, input.role)
  };

  return {
    ...input.state,
    taskSlug: input.taskSlug,
    currentRound: nextRound,
    totalStopCount: input.state.totalStopCount + 1,
    totalCcActiveMs: input.state.totalCcActiveMs + activeDurationMs,
    updatedAt: input.timestamp
  };
}

function toTaskRoundState(state: PersistedRoundFile, updatedAt: string): VcmTaskRoundState {
  const current = state.currentRound;
  if (!current) {
    return {
      taskSlug: state.taskSlug,
      status: "idle",
      promptSubmitCount: 0,
      stopCount: 0,
      totalRoundCount: state.totalRoundCount,
      totalPromptSubmitCount: state.totalPromptSubmitCount,
      totalStopCount: state.totalStopCount,
      totalCcActiveMs: state.totalCcActiveMs,
      currentRoundCcActiveMs: 0,
      roles: [],
      updatedAt
    };
  }

  const activeDurationMs = current.runningSince
    ? getDurationMs(current.runningSince, updatedAt)
    : 0;
  const currentRoundCcActiveMs = current.ccActiveMs + activeDurationMs;

  return {
    taskSlug: state.taskSlug,
    status: current.status,
    roundId: current.id,
    pauseId: current.status === "paused" ? `${current.id}:${current.pausedAt ?? current.lastStopAt ?? ""}` : undefined,
    activeRole: current.activeRole,
    startedAt: current.startedAt,
    lastPromptSubmittedAt: current.lastPromptSubmittedAt,
    lastStopAt: current.lastStopAt,
    settleDeadlineAt: current.settleDeadlineAt,
    pausedAt: current.pausedAt,
    runningSince: current.runningSince,
    roundSequence: current.sequence,
    promptSubmitCount: current.promptSubmitCount,
    stopCount: current.stopCount,
    totalRoundCount: state.totalRoundCount,
    totalPromptSubmitCount: state.totalPromptSubmitCount,
    totalStopCount: state.totalStopCount,
    totalCcActiveMs: state.totalCcActiveMs + activeDurationMs,
    currentRoundCcActiveMs,
    roles: current.roles,
    updatedAt
  };
}

function normalizeRoundFile(input: Partial<PersistedRoundFile>, taskSlug: string, updatedAt: string): PersistedRoundFile {
  return {
    version: 1,
    taskSlug,
    currentRound: normalizeRound(input.currentRound),
    lastPausedRound: normalizeRound(input.lastPausedRound),
    totalRoundCount: normalizeNumber(input.totalRoundCount),
    totalPromptSubmitCount: normalizeNumber(input.totalPromptSubmitCount),
    totalStopCount: normalizeNumber(input.totalStopCount),
    totalCcActiveMs: normalizeNumber(input.totalCcActiveMs),
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : updatedAt
  };
}

function normalizeRound(input: PersistedRound | undefined): PersistedRound | undefined {
  if (!input || typeof input.id !== "string") {
    return undefined;
  }
  if (input.status !== "active" && input.status !== "settling" && input.status !== "paused") {
    return undefined;
  }
  return {
    id: input.id,
    sequence: Number.isFinite(input.sequence) ? input.sequence : 1,
    status: input.status,
    activeRole: input.activeRole,
    startedAt: input.startedAt,
    lastPromptSubmittedAt: input.lastPromptSubmittedAt,
    lastStopAt: input.lastStopAt,
    settleDeadlineAt: input.settleDeadlineAt,
    pausedAt: input.pausedAt,
    runningSince: input.runningSince,
    ccActiveMs: Number.isFinite(input.ccActiveMs) ? input.ccActiveMs : 0,
    promptSubmitCount: Number.isFinite(input.promptSubmitCount) ? input.promptSubmitCount : 0,
    stopCount: Number.isFinite(input.stopCount) ? input.stopCount : 0,
    roles: Array.isArray(input.roles) ? input.roles : []
  };
}

function appendUniqueRole(roles: RoleName[], role: RoleName): RoleName[] {
  return roles.includes(role) ? roles : [...roles, role];
}

function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(new Date(value).getTime() + milliseconds).toISOString();
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

function getRoundStatePath(input: TaskRoundInput): string {
  return path.join(input.stateRepoRoot, input.stateRoot, "rounds", `${input.taskSlug}.json`);
}
