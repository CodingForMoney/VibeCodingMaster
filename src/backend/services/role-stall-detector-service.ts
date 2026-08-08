import { isVcmRoleName } from "../../shared/constants.js";
import type { ClaudeHookEventName, ClaudeHookPayload } from "../../shared/types/claude-hook.js";
import type { RoleStallActionResult, RoleStallPhase, RoleStallWarning } from "../../shared/types/role-stall.js";
import type { VcmRoleName } from "../../shared/types/role.js";
import { VcmError } from "../errors.js";
import type { RoundService } from "./round-service.js";
import type { SessionService } from "./session-service.js";

export interface RoleStallDetectorService {
  recordHook(input: RoleStallHookInput): Promise<void>;
  reconcileTask(input: RoleStallTaskInput): Promise<void>;
  getWarning(repoRoot: string, taskSlug: string): RoleStallWarning | null;
  ignoreWarning(repoRoot: string, taskSlug: string, warningId: string): RoleStallActionResult;
  recoverWarning(input: RecoverRoleStallInput): Promise<RoleStallActionResult>;
  clearProject(repoRoot: string): void;
  stop(): void;
}

export interface RoleStallTaskInput {
  repoRoot: string;
  taskRepoRoot: string;
  stateRoot: string;
  taskSlug: string;
}

export interface RoleStallHookInput extends RoleStallTaskInput {
  role: VcmRoleName;
  eventName: ClaudeHookEventName;
  event: ClaudeHookPayload;
}

export interface RecoverRoleStallInput extends RoleStallTaskInput {
  warningId: string;
}

export interface RoleStallDetectorServiceDeps {
  sessionService: Pick<SessionService, "getRoleSession" | "recoverRoleSession">;
  roundService: Pick<RoundService, "getSessionRoundState">;
  modelTimeoutMs?: number;
  toolTimeoutMs?: number;
  subagentTimeoutMs?: number;
  now?: () => string;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

interface ActiveTool {
  toolUseId?: string;
  toolName?: string;
  timeoutMs: number;
}

interface RoleMonitor {
  context: RoleStallTaskInput;
  role: VcmRoleName;
  sessionId: string;
  runtimeSessionToken?: string;
  roundId: string;
  phase: RoleStallPhase;
  phaseStartedAt: string;
  generation: number;
  timer?: unknown;
  warning?: RoleStallWarning;
  ignoredGeneration?: number;
  activeTools: Map<string, ActiveTool>;
  currentTool?: ActiveTool;
}

export const ROLE_MODEL_STALL_TIMEOUT_MS = 10 * 60 * 1000;
export const ROLE_TOOL_STALL_TIMEOUT_MS = 10 * 60 * 1000;
export const ROLE_SUBAGENT_STALL_TIMEOUT_MS = 30 * 60 * 1000;
const TOOL_TIMEOUT_GRACE_MS = 30_000;

export function createRoleStallDetectorService(
  deps: RoleStallDetectorServiceDeps
): RoleStallDetectorService {
  const modelTimeoutMs = deps.modelTimeoutMs ?? ROLE_MODEL_STALL_TIMEOUT_MS;
  const toolTimeoutMs = deps.toolTimeoutMs ?? ROLE_TOOL_STALL_TIMEOUT_MS;
  const subagentTimeoutMs = deps.subagentTimeoutMs ?? ROLE_SUBAGENT_STALL_TIMEOUT_MS;
  const now = deps.now ?? (() => new Date().toISOString());
  const setTimer = deps.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const clearTimer = deps.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  const monitors = new Map<string, RoleMonitor>();

  return {
    async recordHook(input) {
      if (!isVcmRoleName(input.role)) {
        return;
      }
      const key = monitorKey(input.repoRoot, input.taskSlug);
      if (input.eventName === "Stop" || input.eventName === "StopFailure") {
        clearMonitor(key);
        return;
      }

      const [session, round] = await Promise.all([
        deps.sessionService.getRoleSession(input.repoRoot, input.taskSlug, input.role),
        deps.roundService.getSessionRoundState(roundInput(input))
      ]);
      if (!session
        || session.status !== "running"
        || session.activityStatus !== "running"
        || round.status !== "running"
        || round.activeRole !== input.role
        || !round.roundId) {
        clearMonitor(key);
        return;
      }

      let monitor = monitors.get(key);
      if (!monitor
        || monitor.sessionId !== session.id
        || monitor.runtimeSessionToken !== session.runtimeSessionToken
        || monitor.roundId !== round.roundId
        || monitor.role !== input.role) {
        clearMonitor(key);
        monitor = {
          context: taskInput(input),
          role: input.role,
          sessionId: session.id,
          runtimeSessionToken: session.runtimeSessionToken,
          roundId: round.roundId,
          phase: "awaiting-model",
          phaseStartedAt: now(),
          generation: 0,
          activeTools: new Map()
        };
        monitors.set(key, monitor);
      }

      advanceMonitor(key, monitor, input.eventName, input.event);
    },

    async reconcileTask(input) {
      const key = monitorKey(input.repoRoot, input.taskSlug);
      for (const [candidateKey, monitor] of monitors) {
        if (monitor.context.repoRoot === input.repoRoot && candidateKey !== key) {
          clearMonitor(candidateKey);
        }
      }
      const monitor = monitors.get(key);
      if (!monitor) {
        return;
      }
      const [session, round] = await Promise.all([
        deps.sessionService.getRoleSession(input.repoRoot, input.taskSlug, monitor.role),
        deps.roundService.getSessionRoundState(roundInput(input))
      ]);
      if (!session
        || session.id !== monitor.sessionId
        || session.runtimeSessionToken !== monitor.runtimeSessionToken
        || session.status !== "running"
        || session.activityStatus !== "running"
        || round.status !== "running"
        || round.activeRole !== monitor.role
        || round.roundId !== monitor.roundId) {
        clearMonitor(key);
      }
    },

    getWarning(repoRoot, taskSlug) {
      const warning = monitors.get(monitorKey(repoRoot, taskSlug))?.warning;
      return warning ? { ...warning } : null;
    },

    ignoreWarning(repoRoot, taskSlug, warningId) {
      const monitor = requireWarning(repoRoot, taskSlug, warningId);
      monitor.ignoredGeneration = monitor.generation;
      monitor.warning = undefined;
      cancelTimer(monitor);
      return { ok: true, warning: null };
    },

    async recoverWarning(input) {
      const key = monitorKey(input.repoRoot, input.taskSlug);
      const monitor = requireWarning(input.repoRoot, input.taskSlug, input.warningId);
      const [session, round] = await Promise.all([
        deps.sessionService.getRoleSession(input.repoRoot, input.taskSlug, monitor.role),
        deps.roundService.getSessionRoundState(roundInput(input))
      ]);
      if (!session
        || session.id !== monitor.sessionId
        || session.runtimeSessionToken !== monitor.runtimeSessionToken
        || session.status !== "running"
        || session.activityStatus !== "running"
        || round.status !== "running"
        || round.activeRole !== monitor.role
        || round.roundId !== monitor.roundId) {
        clearMonitor(key);
        return { ok: true, warning: null };
      }

      await deps.sessionService.recoverRoleSession(input.repoRoot, input.taskSlug, {
        role: monitor.role,
        expectedSessionId: monitor.sessionId,
        expectedRuntimeSessionToken: monitor.runtimeSessionToken,
        recoveryPrompt: renderRecoveryPrompt(monitor)
      });
      clearMonitor(key);
      return { ok: true, warning: null };
    },

    clearProject(repoRoot) {
      for (const [key, monitor] of monitors) {
        if (monitor.context.repoRoot === repoRoot) {
          clearMonitor(key);
        }
      }
    },

    stop() {
      for (const key of [...monitors.keys()]) {
        clearMonitor(key);
      }
    }
  };

  function advanceMonitor(
    key: string,
    monitor: RoleMonitor,
    eventName: ClaudeHookEventName,
    event: ClaudeHookPayload
  ): void {
    monitor.generation += 1;
    monitor.warning = undefined;
    monitor.ignoredGeneration = undefined;
    cancelTimer(monitor);

    switch (eventName) {
      case "UserPromptSubmit":
      case "PostCompact":
      case "PostToolBatch":
        monitor.activeTools.clear();
        monitor.currentTool = undefined;
        setPhase(key, monitor, "awaiting-model", modelTimeoutMs);
        return;
      case "PreToolUse": {
        const tool = readTool(event, toolTimeoutMs, subagentTimeoutMs);
        const toolKey = tool.toolUseId ?? `anonymous-${monitor.generation}`;
        monitor.activeTools.set(toolKey, tool);
        monitor.currentTool = tool;
        setPhase(key, monitor, tool.toolName === "Agent" ? "subagent-running" : "tool-running", tool.timeoutMs);
        return;
      }
      case "SubagentStart":
        setPhase(key, monitor, "subagent-running", subagentTimeoutMs);
        return;
      case "PostToolUse":
      case "PostToolUseFailure": {
        const toolUseId = stringValue(event.tool_use_id);
        if (toolUseId) {
          monitor.activeTools.delete(toolUseId);
        }
        monitor.currentTool = firstTool(monitor.activeTools);
        if (monitor.currentTool) {
          setPhase(key, monitor, monitor.currentTool.toolName === "Agent" ? "subagent-running" : "tool-running", monitor.currentTool.timeoutMs);
        }
        return;
      }
      case "SubagentStop":
        monitor.currentTool = firstTool(monitor.activeTools);
        if (monitor.currentTool) {
          setPhase(
            key,
            monitor,
            monitor.currentTool.toolName === "Agent" ? "subagent-running" : "tool-running",
            monitor.currentTool.timeoutMs
          );
        }
        return;
      case "PreCompact":
        monitor.activeTools.clear();
        monitor.currentTool = undefined;
        setPhase(key, monitor, "compacting", modelTimeoutMs);
        return;
      case "PermissionRequest":
        setPhase(key, monitor, "awaiting-permission");
        return;
      default:
        return;
    }
  }

  function setPhase(key: string, monitor: RoleMonitor, phase: RoleStallPhase, timeoutMs?: number): void {
    monitor.phase = phase;
    monitor.phaseStartedAt = now();
    if (timeoutMs === undefined) {
      return;
    }
    const generation = monitor.generation;
    monitor.timer = setTimer(() => {
      void detectStall(key, generation).catch(() => undefined);
    }, timeoutMs);
  }

  async function detectStall(key: string, generation: number): Promise<void> {
    const monitor = monitors.get(key);
    if (!monitor || monitor.generation !== generation || monitor.ignoredGeneration === generation) {
      return;
    }
    const [session, round] = await Promise.all([
      deps.sessionService.getRoleSession(monitor.context.repoRoot, monitor.context.taskSlug, monitor.role),
      deps.roundService.getSessionRoundState(roundInput(monitor.context))
    ]);
    if (!session
      || session.id !== monitor.sessionId
      || session.runtimeSessionToken !== monitor.runtimeSessionToken
      || session.status !== "running"
      || session.activityStatus !== "running"
      || round.status !== "running"
      || round.activeRole !== monitor.role
      || round.roundId !== monitor.roundId) {
      clearMonitor(key);
      return;
    }

    const detectedAt = now();
    monitor.timer = undefined;
    monitor.warning = {
      id: `${monitor.sessionId}:${monitor.roundId}:${generation}:${detectedAt}`,
      taskSlug: monitor.context.taskSlug,
      role: monitor.role,
      sessionId: monitor.sessionId,
      runtimeSessionToken: monitor.runtimeSessionToken,
      roundId: monitor.roundId,
      phase: monitor.phase,
      phaseStartedAt: monitor.phaseStartedAt,
      detectedAt,
      toolUseId: monitor.currentTool?.toolUseId,
      toolName: monitor.currentTool?.toolName
    };
  }

  function requireWarning(repoRoot: string, taskSlug: string, warningId: string): RoleMonitor {
    const monitor = monitors.get(monitorKey(repoRoot, taskSlug));
    if (!monitor?.warning || monitor.warning.id !== warningId) {
      throw new VcmError({
        code: "ROLE_STALL_WARNING_STALE",
        message: "The role stall warning is no longer active.",
        statusCode: 409,
        hint: "Refresh the task workspace before retrying the action."
      });
    }
    return monitor;
  }

  function cancelTimer(monitor: RoleMonitor): void {
    if (monitor.timer === undefined) {
      return;
    }
    clearTimer(monitor.timer);
    monitor.timer = undefined;
  }

  function clearMonitor(key: string): void {
    const monitor = monitors.get(key);
    if (!monitor) {
      return;
    }
    cancelTimer(monitor);
    monitors.delete(key);
  }
}

function monitorKey(repoRoot: string, taskSlug: string): string {
  return `${repoRoot}:${taskSlug}`;
}

function taskInput(input: RoleStallTaskInput): RoleStallTaskInput {
  return {
    repoRoot: input.repoRoot,
    taskRepoRoot: input.taskRepoRoot,
    stateRoot: input.stateRoot,
    taskSlug: input.taskSlug
  };
}

function roundInput(input: RoleStallTaskInput) {
  return {
    repoRoot: input.repoRoot,
    stateRepoRoot: input.taskRepoRoot,
    stateRoot: input.stateRoot,
    taskSlug: input.taskSlug
  };
}

function readTool(event: ClaudeHookPayload, defaultTimeoutMs: number, subagentTimeoutMs: number): ActiveTool {
  const toolName = stringValue(event.tool_name);
  const toolUseId = stringValue(event.tool_use_id);
  const input = objectValue(event.tool_input);
  const requestedTimeout = numberValue(input?.timeout);
  return {
    toolName,
    toolUseId,
    timeoutMs: toolName === "Agent"
      ? subagentTimeoutMs
      : Math.max(defaultTimeoutMs, requestedTimeout ? requestedTimeout + TOOL_TIMEOUT_GRACE_MS : 0)
  };
}

function firstTool(tools: Map<string, ActiveTool>): ActiveTool | undefined {
  return tools.values().next().value as ActiveTool | undefined;
}

function renderRecoveryPrompt(monitor: RoleMonitor): string {
  const phase = monitor.currentTool?.toolName
    ? `${monitor.phase} (${monitor.currentTool.toolName})`
    : monitor.phase;
  return [
    "[VCM Session Recovery]",
    `The previous ${monitor.role} turn may have stalled during ${phase}.`,
    "Continue the current assigned work from the existing Claude session context.",
    "Do not repeat completed work unless it is needed to verify the current state."
  ].join("\n");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
