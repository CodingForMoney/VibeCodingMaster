import { ROLE_NAMES } from "../../shared/constants.js";
import type { RoleName } from "../../shared/types/role.js";
import type { VcmRoleTurnState, VcmTaskRoundState } from "../../shared/types/round.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";

export interface RoundService {
  getTaskRoundState(input: TaskRoundInput): VcmTaskRoundState;
  stopSession(sessionId: string): void;
  stopTask(taskSlug: string): void;
}

export interface TaskRoundInput {
  taskSlug: string;
  sessions: RoleSessionRecord[];
  pendingRouteCount: number;
}

export interface RoundServiceDeps {
  now?: () => string;
}

export function createRoundService(deps: RoundServiceDeps = {}): RoundService {
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    getTaskRoundState(input) {
      const roleStates = ROLE_NAMES.map((role) => toRoleTurnState(role, input.sessions));
      const state = evaluateTaskRoundState({
        taskSlug: input.taskSlug,
        pendingRouteCount: input.pendingRouteCount,
        roleStates,
        updatedAt: now()
      });

      return {
        ...state,
        pendingRouteCount: input.pendingRouteCount
      };
    },
    stopSession() {},
    stopTask() {}
  };
}

export function evaluateTaskRoundState(input: {
  taskSlug: string;
  pendingRouteCount: number;
  roleStates: VcmRoleTurnState[];
  updatedAt: string;
}): Omit<VcmTaskRoundState, "pendingRouteCount"> {
  const activeRole = input.roleStates.find((roleState) =>
    roleState.status === "answering" ||
    roleState.status === "using_tools" ||
    roleState.status === "waiting_user" ||
    roleState.status === "abnormal"
  );

  if (activeRole) {
    return {
      taskSlug: input.taskSlug,
      status: activeRole.status === "waiting_user" ? "waiting_user" : "active",
      activeRole: activeRole.role,
      roles: input.roleStates,
      updatedAt: input.updatedAt
    };
  }

  const latestIdleRole = getLatestIdleRole(input.roleStates);
  const hasPendingRoutes = input.pendingRouteCount > 0;

  if (latestIdleRole?.lastAnswerEndedAt && !hasPendingRoutes) {
    return {
      taskSlug: input.taskSlug,
      status: "completed",
      activeRole: latestIdleRole.role,
      completionId: `direct:${latestIdleRole.role}:${latestIdleRole.lastAnswerEndedAt}`,
      completedAt: latestIdleRole.lastAnswerEndedAt,
      roles: input.roleStates,
      updatedAt: input.updatedAt
    };
  }

  return {
    taskSlug: input.taskSlug,
    status: hasPendingRoutes ? "active" : "idle",
    activeRole: latestIdleRole?.role,
    roles: input.roleStates,
    updatedAt: input.updatedAt
  };
}

function toRoleTurnState(
  role: RoleName,
  sessions: RoleSessionRecord[]
): VcmRoleTurnState {
  const session = sessions.find((candidate) => candidate.role === role && candidate.status === "running");
  const activityStatus = session?.activityStatus ?? "idle";
  return {
    role,
    sessionId: session?.id,
    status: session ? activityStatus === "running" ? "answering" : "idle" : "unknown",
    pendingToolUseCount: 0,
    lastActivityAt: session?.lastPromptSubmittedAt ?? session?.lastHookEventAt,
    lastAnswerEndedAt: session?.lastStopAt,
    reason: session
      ? activityStatus === "running"
        ? "Claude Code accepted a prompt and has not emitted Stop yet."
        : "Claude Code emitted Stop or has not started a prompt in this process."
      : undefined
  };
}

function getLatestIdleRole(roleStates: VcmRoleTurnState[]): VcmRoleTurnState | undefined {
  return roleStates
    .filter((roleState) => roleState.status === "idle" && roleState.lastAnswerEndedAt)
    .sort((left, right) => (left.lastAnswerEndedAt ?? "").localeCompare(right.lastAnswerEndedAt ?? ""))
    .at(-1);
}
