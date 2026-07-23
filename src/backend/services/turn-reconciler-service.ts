import type { ClaudeHookRequest } from "../../shared/types/claude-hook.js";
import type { RoleName } from "../../shared/types/role.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import type { TaskRecord } from "../../shared/types/task.js";
import type { TerminalRuntime } from "../runtime/terminal-runtime.js";
import type { ClaudeHookService } from "./claude-hook-service.js";
import {
  readTranscriptTurnEvidence,
  type TranscriptTurnEvidence
} from "./claude-transcript-reply.js";
import type { RoundService } from "./round-service.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot } from "./task-service.js";

export const TURN_STALL_THRESHOLD_MS = 30 * 60_000;
export const TURN_INTERRUPT_GRACE_MS = 10_000;

export interface TurnReconcilerService {
  reconcileTask(repoRoot: string, task: TaskRecord, stateRoot: string): Promise<TurnReconcileResult>;
}

export type TurnReconcileResult =
  | { status: "inactive" | "active" }
  | { status: "completed" | "failed"; role: RoleName; reason: string };

export interface TurnReconcilerServiceDeps {
  sessionService: Pick<SessionService, "getRoleSession">;
  roundService: Pick<RoundService, "getSessionRoundState">;
  claudeHookService: Pick<ClaudeHookService, "handleReconciledTurnEnd">;
  runtime: Pick<TerminalRuntime, "write">;
  now?: () => string;
  stallThresholdMs?: number;
  interruptGraceMs?: number;
  readTranscriptEvidence?: (session: RoleSessionRecord) => Promise<TranscriptTurnEvidence>;
}

export function createTurnReconcilerService(deps: TurnReconcilerServiceDeps): TurnReconcilerService {
  const now = deps.now ?? (() => new Date().toISOString());
  const stallThresholdMs = deps.stallThresholdMs ?? TURN_STALL_THRESHOLD_MS;
  const interruptGraceMs = deps.interruptGraceMs ?? TURN_INTERRUPT_GRACE_MS;
  const readEvidence = deps.readTranscriptEvidence ?? readTranscriptTurnEvidence;
  const pendingInterrupts = new Map<string, { turnStartedAt: string; requestedAt: string }>();

  return {
    async reconcileTask(repoRoot, task, stateRoot) {
      const taskRepoRoot = getTaskRuntimeRepoRoot(task);
      const round = await deps.roundService.getSessionRoundState({
        repoRoot,
        stateRepoRoot: taskRepoRoot,
        stateRoot,
        taskSlug: task.taskSlug
      });
      if (
        round.status !== "running"
        || !round.activeRole
        || !round.activeTurnStartedAt
        || round.roleRecovery
      ) {
        clearTaskInterrupts(repoRoot, task.taskSlug);
        return { status: "inactive" };
      }

      const role = round.activeRole;
      const interruptKey = `${repoRoot}:${task.taskSlug}:${role}`;
      const session = await deps.sessionService.getRoleSession(repoRoot, task.taskSlug, role);
      const evidence = session
        ? await readEvidence({ ...session, lastTurnStartedAt: round.activeTurnStartedAt })
        : {};

      if (evidence.completion) {
        pendingInterrupts.delete(interruptKey);
        await deps.claudeHookService.handleReconciledTurnEnd(buildReconciledHook(
          task.taskSlug,
          role,
          session,
          "Stop",
          {
            vcm_reconcile_reason: "transcript-end-turn",
            vcm_completion_id: evidence.completion.id,
            vcm_completion_at: evidence.completion.timestamp
          }
        ));
        return { status: "completed", role, reason: "transcript-end-turn" };
      }

      if (!session || session.status !== "running") {
        pendingInterrupts.delete(interruptKey);
        const reason = session ? "terminal-session-exited" : "terminal-session-missing";
        await deps.claudeHookService.handleReconciledTurnEnd(buildReconciledHook(
          task.taskSlug,
          role,
          session,
          "StopFailure",
          {
            error: reason.replaceAll("-", "_"),
            error_details: `VCM reconciled an active turn because its ${reason.replaceAll("-", " ")}.`
          }
        ));
        return { status: "failed", role, reason };
      }

      const lastActivityAt = latestTimestamp([
        round.activeTurnStartedAt,
        session.lastHookEventAt,
        session.lastOutputAt,
        evidence.lastActivityAt
      ]);
      const currentTime = now();
      if (!isStale(lastActivityAt, currentTime, stallThresholdMs)) {
        pendingInterrupts.delete(interruptKey);
        return { status: "active" };
      }

      const pendingInterrupt = pendingInterrupts.get(interruptKey);
      if (!pendingInterrupt || pendingInterrupt.turnStartedAt !== round.activeTurnStartedAt) {
        deps.runtime.write(session.id, "\u0003");
        pendingInterrupts.set(interruptKey, {
          turnStartedAt: round.activeTurnStartedAt,
          requestedAt: currentTime
        });
        return { status: "active" };
      }
      if (!isStale(pendingInterrupt.requestedAt, currentTime, interruptGraceMs)) {
        return { status: "active" };
      }
      pendingInterrupts.delete(interruptKey);

      await deps.claudeHookService.handleReconciledTurnEnd(buildReconciledHook(
        task.taskSlug,
        role,
        session,
        "StopFailure",
        {
          error: "turn_stalled",
          error_details: `No hook, terminal output, or transcript activity was observed for ${stallThresholdMs}ms.`
        }
      ));
      return { status: "failed", role, reason: "turn-stalled" };
    }
  };

  function clearTaskInterrupts(repoRoot: string, taskSlug: string): void {
    for (const key of pendingInterrupts.keys()) {
      if (key.startsWith(`${repoRoot}:${taskSlug}:`)) {
        pendingInterrupts.delete(key);
      }
    }
  }
}

function buildReconciledHook(
  taskSlug: string,
  role: RoleName,
  session: RoleSessionRecord | undefined,
  eventName: "Stop" | "StopFailure",
  evidence: Record<string, unknown>
): ClaudeHookRequest {
  return {
    taskSlug,
    role,
    event: {
      hook_event_name: eventName,
      ...(session?.claudeSessionId ? { session_id: session.claudeSessionId } : {}),
      ...(session?.transcriptPath ? { transcript_path: session.transcriptPath } : {}),
      ...(session?.cwd ? { cwd: session.cwd } : {}),
      ...(session?.id ? { vcm_runtime_session_id: session.id } : {}),
      vcm_reconciled: true,
      ...evidence
    }
  };
}

function latestTimestamp(values: Array<string | undefined>): string | undefined {
  return values.reduce<string | undefined>((latest, value) => {
    if (!value) {
      return latest;
    }
    const valueMs = Date.parse(value);
    const latestMs = latest ? Date.parse(latest) : Number.NaN;
    return Number.isFinite(valueMs) && (!Number.isFinite(latestMs) || valueMs > latestMs)
      ? value
      : latest;
  }, undefined);
}

function isStale(lastActivityAt: string | undefined, currentTime: string, thresholdMs: number): boolean {
  const activityMs = lastActivityAt ? Date.parse(lastActivityAt) : Number.NaN;
  const currentMs = Date.parse(currentTime);
  return Number.isFinite(activityMs)
    && Number.isFinite(currentMs)
    && currentMs - activityMs >= thresholdMs;
}
