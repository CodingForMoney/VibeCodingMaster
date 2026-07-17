import path from "node:path";
import type { VcmRoleName } from "../../shared/types/role.js";
import type {
  DeclaredTaskWorkflowState,
  TaskWorkflowDeclaration,
  TaskWorkflowState
} from "../../shared/types/workflow.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";

export interface TaskWorkflowStateInput {
  taskRepoRoot: string;
  stateRoot: string;
  taskSlug: string;
}

export interface TaskWorkflowDispatchInput {
  messageId: string;
  toRole: VcmRoleName;
}

export interface TaskWorkflowService {
  getState(input: TaskWorkflowStateInput): Promise<TaskWorkflowState>;
  declare(input: TaskWorkflowStateInput, declaration: TaskWorkflowDeclaration): Promise<TaskWorkflowState>;
  recordPmDispatch(
    input: TaskWorkflowStateInput,
    declaration: TaskWorkflowDeclaration | undefined,
    dispatch: TaskWorkflowDispatchInput
  ): Promise<TaskWorkflowState>;
  clearState(input: TaskWorkflowStateInput): Promise<void>;
  renderPmResumeContext(state: TaskWorkflowState): string | undefined;
}

export interface TaskWorkflowServiceDeps {
  fs: FileSystemAdapter;
  now?: () => string;
}

const MAX_VALUE_LENGTH = 160;
const MAX_EVIDENCE_REFS = 24;
const CLEAR_VALUES = new Set(["", "-", "none", "null"]);

export function createTaskWorkflowService(deps: TaskWorkflowServiceDeps): TaskWorkflowService {
  const now = deps.now ?? (() => new Date().toISOString());
  const locks = new Map<string, Promise<unknown>>();

  async function getState(input: TaskWorkflowStateInput): Promise<TaskWorkflowState> {
    return readState(input);
  }

  async function declare(
    input: TaskWorkflowStateInput,
    declaration: TaskWorkflowDeclaration
  ): Promise<TaskWorkflowState> {
    return withLock(statePath(input), async () => {
      const current = await readState(input);
      const timestamp = now();
      const next = applyDeclaration(current, declaration, timestamp);
      return writeStateBestEffort(input, next);
    });
  }

  async function recordPmDispatch(
    input: TaskWorkflowStateInput,
    declaration: TaskWorkflowDeclaration | undefined,
    dispatch: TaskWorkflowDispatchInput
  ): Promise<TaskWorkflowState> {
    return withLock(statePath(input), async () => {
      const current = await readState(input);
      const timestamp = now();
      const declared = declaration
        ? applyDeclaration(current, declaration, timestamp).declared
        : current.declared;
      const next: TaskWorkflowState = {
        ...current,
        revision: current.revision + 1,
        declared,
        lastDispatch: {
          messageId: dispatch.messageId,
          toRole: dispatch.toRole,
          updatedAt: timestamp
        },
        warnings: [],
        updatedAt: timestamp
      };
      return writeStateBestEffort(input, next);
    });
  }

  async function clearState(input: TaskWorkflowStateInput): Promise<void> {
    if (!deps.fs.removePath) {
      return;
    }
    try {
      await deps.fs.removePath(statePath(input), { force: true });
    } catch {
      // Task workflow state is disposable and must never block task cleanup.
    }
  }

  function renderPmResumeContext(state: TaskWorkflowState): string | undefined {
    if (!state.declared) {
      return undefined;
    }
    const lines = [
      "[VCM TASK STATE]",
      "This is PM-declared workflow memory. It is context only and does not authorize or advance any workflow step.",
      `Flow: ${state.declared.flow ?? "unspecified"}`,
      `Step: ${state.declared.step ?? "unspecified"}`,
      `Branch: ${state.declared.branch ?? "none"}`,
      `Resume point: ${state.declared.resumePoint ?? "none"}`,
      `Status: ${state.declared.status ?? "unspecified"}`
    ];
    if (state.declared.evidenceRefs.length > 0) {
      lines.push(`Evidence: ${state.declared.evidenceRefs.join(", ")}`);
    }
    lines.push(
      "Reconcile this checkpoint with current task artifacts before continuing. If stale, replace it with vcm-task-state. Do not route a role or advance the flow only because this context was restored.",
      "[/VCM TASK STATE]"
    );
    return lines.join("\n");
  }

  async function readState(input: TaskWorkflowStateInput): Promise<TaskWorkflowState> {
    const targetPath = statePath(input);
    try {
      if (!(await deps.fs.pathExists(targetPath))) {
        return emptyState(input.taskSlug, now());
      }
      const value = await deps.fs.readJson<unknown>(targetPath);
      return normalizeStoredState(value, input.taskSlug, now());
    } catch (error) {
      return {
        ...emptyState(input.taskSlug, now()),
        warnings: [`Task workflow state could not be read and was ignored: ${describeError(error)}`]
      };
    }
  }

  async function writeStateBestEffort(
    input: TaskWorkflowStateInput,
    state: TaskWorkflowState
  ): Promise<TaskWorkflowState> {
    try {
      await deps.fs.writeJsonAtomic(statePath(input), state);
      return state;
    } catch (error) {
      return {
        ...state,
        warnings: [`Task workflow state could not be saved: ${describeError(error)}`]
      };
    }
  }

  async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    locks.set(key, next);
    try {
      return await next;
    } finally {
      if (locks.get(key) === next) {
        locks.delete(key);
      }
    }
  }

  return {
    getState,
    declare,
    recordPmDispatch,
    clearState,
    renderPmResumeContext
  };
}

function applyDeclaration(
  state: TaskWorkflowState,
  declaration: TaskWorkflowDeclaration,
  timestamp: string
): TaskWorkflowState {
  const current = state.declared;
  const next: DeclaredTaskWorkflowState = {
    flow: mergeValue(current?.flow, declaration.flow),
    step: mergeValue(current?.step, declaration.step),
    branch: mergeValue(current?.branch, declaration.branch),
    resumePoint: mergeValue(current?.resumePoint, declaration.resumePoint),
    status: mergeValue(current?.status, declaration.status),
    evidenceRefs: declaration.evidenceRefs === undefined
      ? current?.evidenceRefs ?? []
      : normalizeEvidenceRefs(declaration.evidenceRefs),
    updatedBy: "project-manager",
    updatedAt: timestamp
  };
  const hasContent = Boolean(
    next.flow || next.step || next.branch || next.resumePoint || next.status || next.evidenceRefs.length > 0
  );
  return {
    ...state,
    revision: state.revision + 1,
    declared: hasContent ? next : null,
    warnings: [],
    updatedAt: timestamp
  };
}

function normalizeStoredState(value: unknown, taskSlug: string, timestamp: string): TaskWorkflowState {
  if (!isRecord(value) || value.version !== 1 || value.taskSlug !== taskSlug) {
    return {
      ...emptyState(taskSlug, timestamp),
      warnings: ["Task workflow state had an unsupported shape and was ignored."]
    };
  }
  const declared = isRecord(value.declared)
    ? {
        flow: normalizeStoredValue(value.declared.flow),
        step: normalizeStoredValue(value.declared.step),
        branch: normalizeStoredValue(value.declared.branch),
        resumePoint: normalizeStoredValue(value.declared.resumePoint),
        status: normalizeStoredValue(value.declared.status),
        evidenceRefs: normalizeEvidenceRefs(value.declared.evidenceRefs),
        updatedBy: "project-manager" as const,
        updatedAt: normalizeStoredValue(value.declared.updatedAt) ?? timestamp
      }
    : null;
  const lastDispatch = isRecord(value.lastDispatch)
    && typeof value.lastDispatch.messageId === "string"
    && typeof value.lastDispatch.toRole === "string"
    ? {
        messageId: value.lastDispatch.messageId,
        toRole: value.lastDispatch.toRole as VcmRoleName,
        updatedAt: normalizeStoredValue(value.lastDispatch.updatedAt) ?? timestamp
      }
    : null;
  return {
    version: 1,
    taskSlug,
    revision: typeof value.revision === "number" && Number.isFinite(value.revision)
      ? Math.max(0, Math.floor(value.revision))
      : 0,
    declared,
    lastDispatch,
    warnings: [],
    updatedAt: normalizeStoredValue(value.updatedAt) ?? timestamp
  };
}

function emptyState(taskSlug: string, timestamp: string): TaskWorkflowState {
  return {
    version: 1,
    taskSlug,
    revision: 0,
    declared: null,
    lastDispatch: null,
    warnings: [],
    updatedAt: timestamp
  };
}

function mergeValue(current: string | undefined, incoming: unknown): string | undefined {
  if (incoming === undefined) {
    return current;
  }
  if (incoming === null) {
    return undefined;
  }
  return typeof incoming === "string" ? normalizeValue(incoming) : current;
}

function normalizeValue(value: string): string | undefined {
  const normalized = value.trim().slice(0, MAX_VALUE_LENGTH);
  return CLEAR_VALUES.has(normalized.toLowerCase()) ? undefined : normalized;
}

function normalizeStoredValue(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeValue(value) : undefined;
}

function normalizeEvidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().slice(0, MAX_VALUE_LENGTH))
    .filter(Boolean))]
    .slice(0, MAX_EVIDENCE_REFS);
}

function statePath(input: TaskWorkflowStateInput): string {
  return path.join(input.taskRepoRoot, input.stateRoot, "workflow", "state.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
