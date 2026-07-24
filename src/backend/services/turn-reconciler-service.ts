import type { ClaudeHookRequest } from "../../shared/types/claude-hook.js";
import type { RoleName } from "../../shared/types/role.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";
import type { TaskRecord } from "../../shared/types/task.js";
import type { ClaudeHookService } from "./claude-hook-service.js";
import {
  readTranscriptTurnEvidence,
  type TranscriptTurnEvidence
} from "./claude-transcript-reply.js";
import type { RoundService } from "./round-service.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot } from "./task-service.js";

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
  readTranscriptEvidence?: (session: RoleSessionRecord) => Promise<TranscriptTurnEvidence>;
}

export function createTurnReconcilerService(deps: TurnReconcilerServiceDeps): TurnReconcilerService {
  const readEvidence = deps.readTranscriptEvidence ?? readTranscriptTurnEvidence;

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
        return { status: "inactive" };
      }

      const role = round.activeRole;
      const session = await deps.sessionService.getRoleSession(repoRoot, task.taskSlug, role);
      const evidence = session
        ? await readEvidence({ ...session, lastTurnStartedAt: round.activeTurnStartedAt })
        : {};

      if (evidence.completion) {
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

      return { status: "active" };
    }
  };
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
