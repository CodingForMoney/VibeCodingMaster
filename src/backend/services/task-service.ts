import path from "node:path";
import type {
  CleanupTaskRequest,
  CleanupTaskResult,
  CreateTaskRequest,
  TaskRecord,
  TaskStatus
} from "../../shared/types/task.js";
import { assertValidTaskSlug } from "../../shared/validation/slug-check.js";
import { VcmError } from "../errors.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import type { GitAdapter } from "../adapters/git-adapter.js";
import type { ArtifactService } from "./artifact-service.js";
import type { ProjectService } from "./project-service.js";

export interface TaskService {
  createTask(repoRoot: string, input: CreateTaskRequest): Promise<TaskRecord>;
  listTasks(repoRoot: string): Promise<TaskRecord[]>;
  loadTask(repoRoot: string, taskSlug: string): Promise<TaskRecord>;
  saveTask(repoRoot: string, task: TaskRecord): Promise<void>;
  updateTaskStatus(repoRoot: string, taskSlug: string, status: TaskStatus): Promise<TaskRecord>;
  cleanupTask(repoRoot: string, taskSlug: string, options?: CleanupTaskRequest): Promise<CleanupTaskResult>;
}

export interface TaskServiceDeps {
  fs: FileSystemAdapter;
  git: GitAdapter;
  artifactService: ArtifactService;
  projectService: Pick<ProjectService, "loadConfig" | "getProjectDataRoot">;
  now?: () => string;
}

export function createTaskService(deps: TaskServiceDeps): TaskService {
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    async createTask(repoRoot, input) {
      assertValidTaskSlug(input.taskSlug);
      const config = await deps.projectService.loadConfig(repoRoot);
      const taskStoreRoot = deps.projectService.getProjectDataRoot(repoRoot);
      const taskPath = getTaskPath(taskStoreRoot, input.taskSlug);
      const shouldCreateWorktree = input.createWorktree !== false;
      const taskBranch = shouldCreateWorktree
        ? `feature/${input.taskSlug}`
        : await deps.git.getCurrentBranch(repoRoot);
      const worktreePath = shouldCreateWorktree
        ? getTaskWorktreePath(repoRoot, input.taskSlug)
        : undefined;

      if (await deps.fs.pathExists(taskPath)) {
        throw new VcmError({
          code: "TASK_EXISTS",
          message: `Task already exists: ${input.taskSlug}`,
          statusCode: 409
        });
      }
      if (!(await deps.git.isIgnored(repoRoot, `${config.stateRoot}/.probe`))) {
        throw new VcmError({
          code: "VCM_STATE_NOT_IGNORED",
          message: `${config.stateRoot}/ is not ignored by Git.`,
          statusCode: 409,
          hint: "Apply VCM Harness first so .gitignore contains the VCM managed block."
        });
      }
      if (shouldCreateWorktree && !(await deps.git.isIgnored(repoRoot, ".claude/worktrees/.probe"))) {
        throw new VcmError({
          code: "VCM_WORKTREES_NOT_IGNORED",
          message: ".claude/worktrees/ is not ignored by Git.",
          statusCode: 409,
          hint: "Apply VCM Harness first so .gitignore ignores Claude-compatible task worktrees."
        });
      }
      if (!shouldCreateWorktree) {
        const activeInlineTask = await findActiveInlineTask(deps.fs, taskStoreRoot);
        if (activeInlineTask) {
          throw new VcmError({
            code: "INLINE_TASK_EXISTS",
            message: `An inline task already exists: ${activeInlineTask.taskSlug}`,
            statusCode: 409,
            hint: "Close the existing inline task first, or enable Create worktree and branch for this task."
          });
        }
      }
      if (shouldCreateWorktree && worktreePath) {
        if (await deps.git.branchExists(repoRoot, taskBranch)) {
          throw new VcmError({
            code: "TASK_BRANCH_EXISTS",
            message: `Task branch already exists: ${taskBranch}`,
            statusCode: 409,
            hint: "Choose a different task name or clean up the existing branch."
          });
        }
        if (await deps.fs.pathExists(worktreePath)) {
          throw new VcmError({
            code: "TASK_WORKTREE_EXISTS",
            message: `Task worktree already exists: ${worktreePath}`,
            statusCode: 409,
            hint: "Choose a different task name or clean up the existing worktree."
          });
        }
        const baseStatus = await deps.git.getStatusPorcelain(repoRoot);
        if (baseStatus.trim()) {
          throw new VcmError({
            code: "BASE_REPO_DIRTY",
            message: "The connected repository has uncommitted changes.",
            statusCode: 409,
            hint: "Commit, stash, or discard base repository changes before creating a task worktree."
          });
        }

        await deps.fs.ensureDir(path.dirname(worktreePath));
        await deps.git.createWorktree({
          repoRoot,
          branch: taskBranch,
          worktreePath,
          baseRef: "HEAD"
        });
      }

      const timestamp = now();
      const taskRepoRoot = worktreePath ?? repoRoot;
      const task: TaskRecord = {
        version: 1,
        taskSlug: input.taskSlug,
        title: input.title,
        createdAt: timestamp,
        updatedAt: timestamp,
        repoRoot,
        worktreePath,
        branch: taskBranch,
        handoffDir: config.handoffRoot,
        status: "created",
        specPath: input.specPath,
        cleanupStatus: "active"
      };

      await ensureTaskRuntimeStateDirs(deps.fs, taskRepoRoot, config.stateRoot);
      await deps.artifactService.ensureHandoffStructure({
        repoRoot: taskRepoRoot,
        taskSlug: input.taskSlug,
        handoffDir: task.handoffDir
      });
      await deps.artifactService.createArtifactTemplates({
        repoRoot: taskRepoRoot,
        taskSlug: input.taskSlug,
        handoffDir: task.handoffDir,
        branch: task.branch
      });
      await this.saveTask(repoRoot, task);
      return task;
    },
    async listTasks(repoRoot) {
      const tasksDir = path.join(deps.projectService.getProjectDataRoot(repoRoot), "tasks");
      if (!(await deps.fs.pathExists(tasksDir))) {
        return [];
      }

      const entries = await deps.fs.readDir(tasksDir);
      const tasks: TaskRecord[] = [];
      for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
        tasks.push(await deps.fs.readJson<TaskRecord>(path.join(tasksDir, entry)));
      }

      return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    async loadTask(repoRoot, taskSlug) {
      assertValidTaskSlug(taskSlug);
      const taskPath = getTaskPath(deps.projectService.getProjectDataRoot(repoRoot), taskSlug);

      if (!(await deps.fs.pathExists(taskPath))) {
        throw new VcmError({
          code: "TASK_MISSING",
          message: `Task does not exist: ${taskSlug}`,
          statusCode: 404
        });
      }

      return deps.fs.readJson<TaskRecord>(taskPath);
    },
    async saveTask(repoRoot, task) {
      await deps.fs.writeJsonAtomic(getTaskPath(deps.projectService.getProjectDataRoot(repoRoot), task.taskSlug), task);
    },
    async updateTaskStatus(repoRoot, taskSlug, status) {
      const task = await this.loadTask(repoRoot, taskSlug);
      const updated = {
        ...task,
        status,
        updatedAt: now()
      };
      await this.saveTask(repoRoot, updated);
      return updated;
    },
    async cleanupTask(repoRoot, taskSlug, options = {}) {
      assertValidTaskSlug(taskSlug);
      if (!deps.fs.removePath) {
        throw new VcmError({
          code: "FILESYSTEM_REMOVE_UNAVAILABLE",
          message: "This VCM runtime cannot remove task files.",
          statusCode: 500
        });
      }

      const config = await deps.projectService.loadConfig(repoRoot);
      const task = await this.loadTask(repoRoot, taskSlug);
      const taskRepoRoot = getTaskRuntimeRepoRoot(task);
      const statePaths = getTaskStatePaths(
        deps.projectService.getProjectDataRoot(repoRoot),
        taskRepoRoot,
        config.stateRoot,
        config.handoffRoot,
        taskSlug
      );
      const removedStatePaths: string[] = [];
      const cleanedAt = now();

      if (task.worktreePath) {
        assertTaskWorktreePath(repoRoot, task.worktreePath);
        await deps.git.removeWorktree(repoRoot, task.worktreePath, { force: options.force ?? true });
      }

      let deletedBranch: string | undefined;
      if (task.worktreePath && (options.deleteBranch ?? true)) {
        await deps.git.deleteBranch(repoRoot, task.branch, { force: options.forceDeleteBranch ?? true });
        deletedBranch = task.branch;
      }

      for (const statePath of statePaths) {
        await deps.fs.removePath(statePath, { recursive: true, force: true });
        removedStatePaths.push(statePath);
      }

      return {
        taskSlug,
        removedWorktreePath: task.worktreePath,
        removedStatePaths,
        deletedBranch,
        cleanedAt
      };
    }
  };
}

export function getTaskRuntimeRepoRoot(task: TaskRecord): string {
  return task.worktreePath ?? task.repoRoot;
}

function getTaskPath(taskStoreRoot: string, taskSlug: string): string {
  return path.join(taskStoreRoot, "tasks", `${taskSlug}.json`);
}

function getTaskWorktreePath(repoRoot: string, taskSlug: string): string {
  return path.join(repoRoot, ".claude", "worktrees", taskSlug);
}

async function ensureTaskRuntimeStateDirs(fs: FileSystemAdapter, taskRepoRoot: string, stateRoot: string): Promise<void> {
  await fs.ensureDir(path.join(taskRepoRoot, stateRoot, "sessions"));
  await fs.ensureDir(path.join(taskRepoRoot, stateRoot, "messages"));
  await fs.ensureDir(path.join(taskRepoRoot, stateRoot, "orchestration"));
  await fs.ensureDir(path.join(taskRepoRoot, stateRoot, "translation"));
}

async function findActiveInlineTask(fs: FileSystemAdapter, taskStoreRoot: string): Promise<TaskRecord | undefined> {
  const tasksDir = path.join(taskStoreRoot, "tasks");
  if (!(await fs.pathExists(tasksDir))) {
    return undefined;
  }

  const entries = await fs.readDir(tasksDir);
  for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
    const task = await fs.readJson<TaskRecord>(path.join(tasksDir, entry));
    if (!task.worktreePath && task.cleanupStatus !== "cleaned") {
      return task;
    }
  }
  return undefined;
}

function getTaskStatePaths(
  taskStoreRoot: string,
  taskRepoRoot: string,
  stateRoot: string,
  handoffRoot: string,
  taskSlug: string
): string[] {
  return [
    getTaskPath(taskStoreRoot, taskSlug),
    path.join(taskRepoRoot, stateRoot, "sessions", `${taskSlug}.json`),
    path.join(taskRepoRoot, stateRoot, "messages", `${taskSlug}.jsonl`),
    path.join(taskRepoRoot, stateRoot, "orchestration", `${taskSlug}.json`),
    path.join(taskRepoRoot, stateRoot, "translation", taskSlug),
    path.join(taskRepoRoot, handoffRoot)
  ];
}

function assertTaskWorktreePath(repoRoot: string, worktreePath: string): void {
  const worktreeRoot = path.resolve(repoRoot, ".claude", "worktrees");
  const resolvedWorktreePath = path.resolve(worktreePath);
  const relative = path.relative(worktreeRoot, resolvedWorktreePath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
    throw new VcmError({
      code: "TASK_WORKTREE_PATH_INVALID",
      message: `Refusing to clean up worktree outside ${worktreeRoot}.`,
      statusCode: 400,
      hint: resolvedWorktreePath
    });
  }
}
