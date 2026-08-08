import type { VcmRoleRecoveryState } from "../../shared/types/round.js";
import type {
  ArchitectLspStallState,
  RoleSessionRecord
} from "../../shared/types/session.js";
import type {
  ClaudeTranscriptEvent,
  ClaudeTranscriptService
} from "./claude-transcript-service.js";
import type { RoundService } from "./round-service.js";
import type { SessionService } from "./session-service.js";

export interface ArchitectLspWatchdogService {
  reconcileTask(input: ArchitectLspWatchdogTaskInput): Promise<void>;
  clearProject(repoRoot: string): void;
  stop(): void;
}

export interface ArchitectLspWatchdogTaskInput {
  repoRoot: string;
  taskRepoRoot: string;
  stateRoot: string;
  taskSlug: string;
}

export interface ArchitectLspWatchdogServiceDeps {
  transcripts: Pick<ClaudeTranscriptService, "subscribeToRoleSession">;
  sessionService: Pick<
    SessionService,
    | "getRoleSession"
    | "setArchitectLspStall"
    | "recoverArchitectLspSession"
    | "stopArchitectLspSessionForFailure"
  >;
  roundService: Pick<
    RoundService,
    | "getSessionRoundState"
    | "setRoleRecovery"
    | "clearRoleRecovery"
    | "recordRoleRecoveryFailure"
  >;
  stallTimeoutMs?: number;
  now?: () => string;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

interface PendingLspCall {
  toolUseId: string;
  operation?: string;
  startedAt: string;
  timer: unknown;
}

interface ArchitectMonitor {
  input: ArchitectLspWatchdogTaskInput;
  sessionId: string;
  roundId: string;
  pending: Map<string, PendingLspCall>;
  recovering: boolean;
  unsubscribe: () => void;
}

export const ARCHITECT_LSP_STALL_TIMEOUT_MS = 10 * 60 * 1000;

export function createArchitectLspWatchdogService(
  deps: ArchitectLspWatchdogServiceDeps
): ArchitectLspWatchdogService {
  const stallTimeoutMs = deps.stallTimeoutMs ?? ARCHITECT_LSP_STALL_TIMEOUT_MS;
  const now = deps.now ?? (() => new Date().toISOString());
  const setTimer = deps.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const clearTimer = deps.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  const monitors = new Map<string, ArchitectMonitor>();

  return {
    async reconcileTask(input) {
      const key = monitorKey(input.repoRoot, input.taskSlug);
      for (const [candidateKey, monitor] of monitors) {
        if (monitor.input.repoRoot === input.repoRoot && candidateKey !== key) {
          detachMonitor(candidateKey);
        }
      }
      const [session, round] = await Promise.all([
        deps.sessionService.getRoleSession(input.repoRoot, input.taskSlug, "architect"),
        deps.roundService.getSessionRoundState({
          repoRoot: input.repoRoot,
          stateRepoRoot: input.taskRepoRoot,
          stateRoot: input.stateRoot,
          taskSlug: input.taskSlug
        })
      ]);

      if (!isMonitorableArchitectSession(session)
        || round.status !== "running"
        || round.activeRole !== "architect"
        || !round.roundId) {
        detachMonitor(key);
        return;
      }

      const existing = monitors.get(key);
      if (existing?.sessionId === session.id && existing.roundId === round.roundId) {
        return;
      }
      detachMonitor(key);

      const monitor: ArchitectMonitor = {
        input,
        sessionId: session.id,
        roundId: round.roundId,
        pending: new Map(),
        recovering: false,
        unsubscribe: () => {}
      };
      monitors.set(key, monitor);
      monitor.unsubscribe = deps.transcripts.subscribeToRoleSession(
        session,
        (event) => handleTranscriptEvent(key, event),
        {
          replaySince: session.lastTurnStartedAt ?? round.startedAt,
          onError: () => undefined
        }
      );
    },
    clearProject(repoRoot) {
      for (const [key, monitor] of monitors) {
        if (monitor.input.repoRoot === repoRoot) {
          detachMonitor(key);
        }
      }
    },
    stop() {
      for (const key of [...monitors.keys()]) {
        detachMonitor(key);
      }
    }
  };

  function handleTranscriptEvent(key: string, event: ClaudeTranscriptEvent): void {
    const monitor = monitors.get(key);
    if (!monitor || event.isSidechain) {
      return;
    }

    if (event.kind === "tool_result") {
      clearPendingCall(monitor, event.toolResult.tool_use_id);
      return;
    }
    if (event.kind !== "tool_use" || event.toolUse.name !== "LSP" || monitor.pending.has(event.id)) {
      return;
    }

    const startedAt = validTimestamp(event.timestamp) ? event.timestamp : now();
    const elapsedMs = Math.max(0, Date.parse(now()) - Date.parse(startedAt));
    const timer = setTimer(() => {
      void recoverStalledCall(key, event.id).catch((error) => {
        void handleUnexpectedWatchdogFailure(key, event.id, error).catch(() => {
          detachMonitor(key);
        });
      });
    }, Math.max(0, stallTimeoutMs - elapsedMs));
    monitor.pending.set(event.id, {
      toolUseId: event.id,
      operation: readLspOperation(event.toolUse.input),
      startedAt,
      timer
    });
  }

  async function recoverStalledCall(key: string, toolUseId: string): Promise<void> {
    const monitor = monitors.get(key);
    const pending = monitor?.pending.get(toolUseId);
    if (!monitor || !pending || monitor.recovering) {
      return;
    }
    monitor.recovering = true;

    const { input } = monitor;
    const [session, round] = await Promise.all([
      deps.sessionService.getRoleSession(input.repoRoot, input.taskSlug, "architect"),
      deps.roundService.getSessionRoundState({
        repoRoot: input.repoRoot,
        stateRepoRoot: input.taskRepoRoot,
        stateRoot: input.stateRoot,
        taskSlug: input.taskSlug
      })
    ]);
    if (!session
      || session.id !== monitor.sessionId
      || session.status !== "running"
      || session.activityStatus !== "running"
      || round.status !== "running"
      || round.activeRole !== "architect"
      || round.roundId !== monitor.roundId) {
      detachMonitor(key);
      return;
    }

    const detectedAt = now();
    const stall: ArchitectLspStallState = {
      status: "stalled",
      roundId: monitor.roundId,
      toolUseId,
      operation: pending.operation,
      startedAt: pending.startedAt,
      detectedAt,
      recoveryAttempt: 1
    };
    await deps.sessionService.setArchitectLspStall(
      input.repoRoot,
      input.taskSlug,
      session.id,
      stall
    );

    if (session.lastArchitectLspRecovery?.roundId === monitor.roundId) {
      await failRound(key, {
        ...stall,
        status: "failed",
        error: "Architect LSP stalled again after the automatic recovery for this Round."
      });
      return;
    }

    await deps.roundService.setRoleRecovery({
      repoRoot: input.repoRoot,
      stateRepoRoot: input.taskRepoRoot,
      stateRoot: input.stateRoot,
      taskSlug: input.taskSlug,
      recovery: createRecoveryState(stall, "retrying")
    });

    try {
      await deps.sessionService.recoverArchitectLspSession(input.repoRoot, input.taskSlug, {
        expectedSessionId: session.id,
        stall,
        recovery: {
          roundId: monitor.roundId,
          toolUseId,
          operation: pending.operation,
          recoveredAt: now()
        },
        recoveryPrompt: renderRecoveryPrompt(pending.operation)
      });
      await deps.roundService.clearRoleRecovery({
        repoRoot: input.repoRoot,
        stateRepoRoot: input.taskRepoRoot,
        stateRoot: input.stateRoot,
        taskSlug: input.taskSlug,
        role: "architect"
      });
      detachMonitor(key);
    } catch (error) {
      if (errorCode(error) === "ARCHITECT_LSP_SESSION_CHANGED") {
        detachMonitor(key);
        return;
      }
      await failRound(key, {
        ...stall,
        status: "failed",
        error: `Architect LSP recovery failed: ${errorMessage(error)}`
      });
    }
  }

  async function failRound(key: string, stall: ArchitectLspStallState): Promise<void> {
    const monitor = monitors.get(key);
    if (!monitor) {
      return;
    }
    const { input } = monitor;
    let finalStall = stall;
    try {
      await deps.sessionService.stopArchitectLspSessionForFailure(input.repoRoot, input.taskSlug, stall);
    } catch (error) {
      finalStall = {
        ...stall,
        error: `${stall.error ?? "Architect LSP recovery failed."} Failed to persist the stopped Session: ${errorMessage(error)}`
      };
    }
    await deps.roundService.recordRoleRecoveryFailure({
      repoRoot: input.repoRoot,
      stateRepoRoot: input.taskRepoRoot,
      stateRoot: input.stateRoot,
      taskSlug: input.taskSlug,
      recovery: createRecoveryState(finalStall, "failed")
    });
    detachMonitor(key);
  }

  async function handleUnexpectedWatchdogFailure(
    key: string,
    toolUseId: string,
    error: unknown
  ): Promise<void> {
    const monitor = monitors.get(key);
    const pending = monitor?.pending.get(toolUseId);
    if (!monitor || !pending) {
      return;
    }
    await failRound(key, {
      status: "failed",
      roundId: monitor.roundId,
      toolUseId,
      operation: pending.operation,
      startedAt: pending.startedAt,
      detectedAt: now(),
      recoveryAttempt: 1,
      error: `Architect LSP watchdog failed: ${errorMessage(error)}`
    });
  }

  function detachMonitor(key: string): void {
    const monitor = monitors.get(key);
    if (!monitor) {
      return;
    }
    monitor.unsubscribe();
    for (const pending of monitor.pending.values()) {
      clearTimer(pending.timer);
    }
    monitors.delete(key);
  }

  function clearPendingCall(monitor: ArchitectMonitor, toolUseId: string): void {
    const pending = monitor.pending.get(toolUseId);
    if (!pending) {
      return;
    }
    clearTimer(pending.timer);
    monitor.pending.delete(toolUseId);
  }

  function createRecoveryState(
    stall: ArchitectLspStallState,
    status: "retrying" | "failed"
  ): VcmRoleRecoveryState {
    return {
      role: "architect",
      status,
      attempt: 1,
      maxAttempts: 1,
      lastFailureAt: stall.detectedAt,
      error: stall.error ?? `Architect LSP call exceeded the ${formatTimeout(stallTimeoutMs)} completion limit.`,
      errorDetails: [
        `tool_use_id=${stall.toolUseId}`,
        stall.operation ? `operation=${stall.operation}` : undefined,
        `started_at=${stall.startedAt}`
      ].filter(Boolean).join("; "),
      retryable: status !== "failed",
      ...(status === "failed"
        ? { failedAt: now() }
        : { lastRetryAt: now() })
    };
  }
}

function isMonitorableArchitectSession(
  session: RoleSessionRecord | undefined
): session is RoleSessionRecord {
  return Boolean(
    session
    && session.status === "running"
    && session.activityStatus === "running"
    && session.claudeSessionId
  );
}

function readLspOperation(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const operation = (input as Record<string, unknown>).operation;
  return typeof operation === "string" && operation.trim()
    ? operation.trim()
    : undefined;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function monitorKey(repoRoot: string, taskSlug: string): string {
  return `${repoRoot}\u0000${taskSlug}`;
}

function renderRecoveryPrompt(operation: string | undefined): string {
  const operationText = operation ? ` (${operation})` : "";
  return `[VCM LSP RECOVERY] The previous Architect LSP call${operationText} stalled. Continue the current assigned role command from the existing context and re-run only the semantic query needed to proceed.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function formatTimeout(timeoutMs: number): string {
  const minutes = timeoutMs / 60_000;
  return Number.isInteger(minutes) ? `${minutes}-minute` : `${timeoutMs}-millisecond`;
}
