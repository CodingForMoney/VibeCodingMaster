import path from "node:path";
import { VCM_ROLE_NAMES } from "../../shared/constants.js";
import type { VcmRoleName } from "../../shared/types/role.js";
import type {
  ClaudePermissionMode,
  RoleSessionRecord,
  SessionEffort,
  SessionModel,
  StartRoleSessionRequest
} from "../../shared/types/session.js";
import { resolveRepoPath, type FileSystemAdapter } from "../adapters/filesystem.js";
import { toVcmError, VcmError } from "../errors.js";
import type { ProjectService } from "./project-service.js";
import type { SessionService } from "./session-service.js";
import { getTaskRuntimeRepoRoot, type TaskService } from "./task-service.js";

const STATE_DIR = "restart-with-context";

interface PendingRoleContextRestart {
  version: 1;
  taskSlug: string;
  role: VcmRoleName;
  sourceSessionId: string;
  replacementSessionId?: string;
  status: "launching" | "awaiting_prompt_confirmation" | "blocked";
  permissionMode: ClaudePermissionMode;
  model?: SessionModel;
  effort?: SessionEffort;
  cols?: number;
  rows?: number;
  error?: {
    code: string;
    message: string;
  };
  updatedAt: string;
}

export interface RoleContextRestartService {
  restart(
    repoRoot: string,
    taskSlug: string,
    role: VcmRoleName,
    input?: StartRoleSessionRequest
  ): Promise<RoleSessionRecord>;
  recoverTask(repoRoot: string, taskSlug: string): Promise<void>;
  recordPromptSubmitted(
    repoRoot: string,
    taskSlug: string,
    role: VcmRoleName,
    sessionId: string
  ): Promise<void>;
  clearRole(repoRoot: string, taskSlug: string, role: VcmRoleName): Promise<void>;
  clear(repoRoot: string, taskSlug: string): Promise<void>;
}

export interface RoleContextRestartServiceDeps {
  fs: FileSystemAdapter;
  projectService: Pick<ProjectService, "loadConfig">;
  taskService: Pick<TaskService, "loadTask">;
  sessionService: Pick<
    SessionService,
    "getRoleSession" | "restartRoleSessionForContext" | "submitRolePrompt"
  >;
  now?: () => string;
}

export function createRoleContextRestartService(
  deps: RoleContextRestartServiceDeps
): RoleContextRestartService {
  const pending = new Map<string, PendingRoleContextRestart>();
  const operations = new Map<string, Promise<unknown>>();
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    async restart(repoRoot, taskSlug, role, input = {}) {
      return withLock(restartKey(repoRoot, taskSlug, role), async () => {
        const current = await deps.sessionService.getRoleSession(repoRoot, taskSlug, role);
        if (!current) {
          throw new VcmError({
            code: "SESSION_MISSING",
            message: `${role} session has not been started.`,
            statusCode: 404
          });
        }
        const state: PendingRoleContextRestart = {
          version: 1,
          taskSlug,
          role,
          sourceSessionId: current.id,
          status: "launching",
          permissionMode: input.permissionMode ?? current.permissionMode,
          model: input.model ?? current.model,
          effort: input.effort ?? current.effort,
          cols: input.cols,
          rows: input.rows,
          updatedAt: now()
        };
        await persist(repoRoot, state);
        return launch(repoRoot, state);
      });
    },

    async recoverTask(repoRoot, taskSlug) {
      for (const role of VCM_ROLE_NAMES) {
        await withLock(restartKey(repoRoot, taskSlug, role), async () => {
          const state = await load(repoRoot, taskSlug, role);
          if (!state) {
            return;
          }
          const session = await deps.sessionService.getRoleSession(repoRoot, taskSlug, role);
          if (
            state.replacementSessionId
            && session?.id === state.replacementSessionId
            && session.claudeSessionId
          ) {
            await remove(repoRoot, state);
            return;
          }
          state.status = "launching";
          state.error = undefined;
          state.updatedAt = now();
          await persist(repoRoot, state);
          await launch(repoRoot, state);
        });
      }
    },

    async recordPromptSubmitted(repoRoot, taskSlug, role, sessionId) {
      await withLock(restartKey(repoRoot, taskSlug, role), async () => {
        const state = pending.get(restartKey(repoRoot, taskSlug, role))
          ?? await load(repoRoot, taskSlug, role);
        if (
          !state
          || state.status !== "awaiting_prompt_confirmation"
          || state.replacementSessionId !== sessionId
        ) {
          return;
        }
        await remove(repoRoot, state);
      });
    },

    async clearRole(repoRoot, taskSlug, role) {
      await withLock(restartKey(repoRoot, taskSlug, role), async () => {
        pending.delete(restartKey(repoRoot, taskSlug, role));
        const target = await statePath(repoRoot, taskSlug, role);
        if (await deps.fs.pathExists(target)) {
          await deps.fs.removePath?.(target, { force: true });
        }
      });
    },

    async clear(repoRoot, taskSlug) {
      for (const role of VCM_ROLE_NAMES) {
        pending.delete(restartKey(repoRoot, taskSlug, role));
      }
      const target = await stateDirectory(repoRoot, taskSlug);
      if (await deps.fs.pathExists(target)) {
        await deps.fs.removePath?.(target, { recursive: true, force: true });
      }
    }
  };

  async function launch(
    repoRoot: string,
    state: PendingRoleContextRestart
  ): Promise<RoleSessionRecord> {
    const prompts = await buildPrompts(repoRoot, state.taskSlug, state.role);
    try {
      const replacement = await deps.sessionService.restartRoleSessionForContext(
        repoRoot,
        state.taskSlug,
        state.role,
        {
          permissionMode: state.permissionMode,
          model: state.model,
          effort: state.effort,
          cols: state.cols,
          rows: state.rows,
          appendSystemPrompt: prompts.system
        }
      );
      state.replacementSessionId = replacement.id;
      state.status = "awaiting_prompt_confirmation";
      state.updatedAt = now();
      await persist(repoRoot, state);
      await deps.sessionService.submitRolePrompt(
        repoRoot,
        state.taskSlug,
        state.role,
        replacement.id,
        prompts.user
      );
      return replacement;
    } catch (error) {
      const normalized = toVcmError(error);
      state.status = "blocked";
      state.error = {
        code: normalized.code,
        message: normalized.message
      };
      state.updatedAt = now();
      await persist(repoRoot, state);
      throw error;
    }
  }

  async function buildPrompts(
    repoRoot: string,
    taskSlug: string,
    role: VcmRoleName
  ): Promise<{ system: string; user: string }> {
    const [config, task] = await Promise.all([
      deps.projectService.loadConfig(repoRoot),
      deps.taskService.loadTask(repoRoot, taskSlug)
    ]);
    const handoffDir = task.handoffDir;
    const stateRoot = config.stateRoot;
    const files = roleContextFiles(role, handoffDir, stateRoot);
    return {
      system: [
        `This fresh ${role} session continues the current VCM task after Restart With Context.`,
        "",
        "Before continuing, read the existing files or directories that apply:",
        ...files.map((file) => `- ${file}`),
        "- the current worktree and Git state",
        "",
        "Treat the current artifacts and worktree as the source of truth. Continue the accepted assignment from the recorded current state. Do not repeat completed work or rely on the previous Session transcript."
      ].join("\n"),
      user: `[VCM RESTART WITH CONTEXT]\nRestore the current ${role} work from the listed task artifacts and continue the accepted assignment.`
    };
  }

  async function persist(repoRoot: string, state: PendingRoleContextRestart): Promise<void> {
    await deps.fs.writeJsonAtomic(await statePath(repoRoot, state.taskSlug, state.role), state);
    pending.set(restartKey(repoRoot, state.taskSlug, state.role), state);
  }

  async function load(
    repoRoot: string,
    taskSlug: string,
    role: VcmRoleName
  ): Promise<PendingRoleContextRestart | undefined> {
    const target = await statePath(repoRoot, taskSlug, role);
    if (!(await deps.fs.pathExists(target))) {
      return undefined;
    }
    const state = await deps.fs.readJson<PendingRoleContextRestart>(target);
    if (
      state.version !== 1
      || state.taskSlug !== taskSlug
      || state.role !== role
      || !["launching", "awaiting_prompt_confirmation", "blocked"].includes(state.status)
    ) {
      throw new VcmError({
        code: "ROLE_CONTEXT_RESTART_STATE_INVALID",
        message: `Restart With Context state is invalid for ${role} in task ${taskSlug}.`,
        statusCode: 500
      });
    }
    pending.set(restartKey(repoRoot, taskSlug, role), state);
    return state;
  }

  async function remove(repoRoot: string, state: PendingRoleContextRestart): Promise<void> {
    pending.delete(restartKey(repoRoot, state.taskSlug, state.role));
    const target = await statePath(repoRoot, state.taskSlug, state.role);
    if (await deps.fs.pathExists(target)) {
      await deps.fs.removePath?.(target, { force: true });
    }
  }

  async function stateDirectory(repoRoot: string, taskSlug: string): Promise<string> {
    const [config, task] = await Promise.all([
      deps.projectService.loadConfig(repoRoot),
      deps.taskService.loadTask(repoRoot, taskSlug)
    ]);
    return resolveRepoPath(
      getTaskRuntimeRepoRoot(task),
      path.posix.join(config.stateRoot, STATE_DIR)
    );
  }

  async function statePath(
    repoRoot: string,
    taskSlug: string,
    role: VcmRoleName
  ): Promise<string> {
    return path.join(await stateDirectory(repoRoot, taskSlug), `${role}.json`);
  }

  async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = operations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    operations.set(key, current);
    try {
      return await current;
    } finally {
      if (operations.get(key) === current) {
        operations.delete(key);
      }
    }
  }
}

function roleContextFiles(
  role: VcmRoleName,
  handoffDir: string,
  stateRoot: string
): string[] {
  switch (role) {
    case "project-manager":
      return [
        `${handoffDir}/workflow-progress.md`,
        `${stateRoot}/workflow/state.json`,
        `${stateRoot}/workflow-control.json`,
        `${handoffDir}/messages/`
      ];
    case "architect":
      return [
        `${handoffDir}/role-commands/architect.md`,
        `${handoffDir}/architecture-brief.md`,
        `${handoffDir}/architecture-evidence.md`,
        `${handoffDir}/planning-progress.md`,
        `${handoffDir}/architecture-plan.md`,
        `${handoffDir}/architect-debug.md`,
        `${handoffDir}/architecture-diagnosis.md`,
        ".ai/vcm/gate-reviews/index.json"
      ];
    case "coder":
      return [
        `${handoffDir}/role-commands/coder.md`,
        `${handoffDir}/architecture-plan.md`,
        `${handoffDir}/coder-completion.md`,
        ".ai/vcm/coder-workers/"
      ];
    case "tester":
      return [
        `${handoffDir}/role-commands/tester.md`,
        `${handoffDir}/architecture-plan.md`,
        `${handoffDir}/coder-completion.md`,
        `${handoffDir}/test-report.md`
      ];
    case "reviewer":
      return [
        ".ai/vcm/gate-reviews/index.json",
        ".ai/vcm/gate-reviews/requests/"
      ];
  }
}

function restartKey(repoRoot: string, taskSlug: string, role: VcmRoleName): string {
  return `${repoRoot}\0${taskSlug}\0${role}`;
}
