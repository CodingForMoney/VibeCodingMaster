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
      const taskBranch = `feature/${input.taskSlug}`;
      const worktreePath = getTaskWorktreePath(repoRoot, input.taskSlug);

      if (await deps.fs.pathExists(taskPath)) {
        throw new VcmError({
          code: "TASK_EXISTS",
          message: `Task already exists: ${input.taskSlug}`,
          statusCode: 409
        });
      }
      const existingTasks = await readStoredTasks(deps.fs, taskStoreRoot);
      const activeTask = existingTasks.find((task) => task.cleanupStatus !== "cleaned");
      if (activeTask) {
        throw new VcmError({
          code: "ACTIVE_TASK_EXISTS",
          message: `A task is already active for this project: ${activeTask.taskSlug}`,
          statusCode: 409,
          hint: "Close the current task before creating a new one."
        });
      }
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
      const baseVisibleChanges = await getBaseRepoVisibleChanges(deps.git, repoRoot);
      if (baseVisibleChanges.length > 0) {
        throw new VcmError({
          code: "BASE_REPO_DIRTY",
          message: "The connected repository has uncommitted Git-visible changes.",
          statusCode: 409,
          hint: `Commit, stash, or discard these changes before creating a task worktree: ${baseVisibleChanges.slice(0, 12).join(", ")}`
        });
      }

      const timestamp = now();
      await deps.fs.ensureDir(path.dirname(worktreePath));
      await deps.git.createWorktree({
        repoRoot,
        branch: taskBranch,
        worktreePath,
        baseRef: "HEAD"
      });

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

      await ensureTaskRuntimeStateDirs(deps.fs, worktreePath, config.stateRoot);
      await deps.artifactService.ensureHandoffStructure({
        repoRoot: worktreePath,
        taskSlug: input.taskSlug,
        handoffDir: task.handoffDir
      });
      await deps.artifactService.createArtifactTemplates({
        repoRoot: worktreePath,
        taskSlug: input.taskSlug,
        handoffDir: task.handoffDir,
        branch: task.branch
      });
      await this.saveTask(repoRoot, task);
      return task;
    },
    async listTasks(repoRoot) {
      return readStoredTasks(deps.fs, deps.projectService.getProjectDataRoot(repoRoot));
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
      const taskStoreRoot = deps.projectService.getProjectDataRoot(repoRoot);
      const taskPath = getTaskPath(taskStoreRoot, taskSlug);
      const statePaths = getTaskStatePaths(
        taskStoreRoot,
        taskRepoRoot,
        config.stateRoot,
        config.handoffRoot,
        taskSlug
      );
      const removedStatePaths: string[] = [];
      const warnings: string[] = [];
      const cleanedAt = now();

      assertTaskWorktreePath(repoRoot, task.worktreePath);
      await removeTaskWorktreeIdempotent(
        deps.fs,
        deps.git,
        repoRoot,
        task.worktreePath,
        options.force ?? true,
        warnings
      );
      await deleteTaskBranchIdempotent(
        deps.git,
        repoRoot,
        task.branch,
        options.forceDeleteBranch ?? true
      );

      for (const statePath of statePaths.filter((candidate) => candidate !== taskPath)) {
        await removeWorktreeStatePathBestEffort(deps.fs, statePath, removedStatePaths, warnings);
      }
      await deps.fs.removePath(taskPath, { recursive: true, force: true });
      removedStatePaths.push(taskPath);

      return {
        taskSlug,
        removedWorktreePath: task.worktreePath,
        removedStatePaths,
        deletedBranch: task.branch,
        cleanedAt,
        warnings: warnings.length > 0 ? warnings : undefined
      };
    }
  };
}

async function removeTaskWorktreeIdempotent(
  fs: FileSystemAdapter,
  git: GitAdapter,
  repoRoot: string,
  worktreePath: string,
  force: boolean,
  warnings: string[]
): Promise<void> {
  const wasRegistered = await git.isWorktreeRegistered(repoRoot, worktreePath);
  if (wasRegistered) {
    try {
      await git.removeWorktree(repoRoot, worktreePath, { force });
    } catch (error) {
      await pruneWorktreesBestEffort(git, repoRoot, warnings);
      if (await git.isWorktreeRegistered(repoRoot, worktreePath)) {
        throw error;
      }
      warnings.push(`Git worktree metadata was already cleared for ${worktreePath}; continuing cleanup.`);
    }
  } else {
    await pruneWorktreesBestEffort(git, repoRoot, warnings);
  }

  if (await fs.pathExists(worktreePath)) {
    try {
      await fs.removePath?.(worktreePath, { recursive: true, force: true });
    } catch (error) {
      warnings.push(`Unable to remove stale task worktree directory ${worktreePath}: ${describeError(error)}`);
    }
  }
}

async function deleteTaskBranchIdempotent(
  git: GitAdapter,
  repoRoot: string,
  branch: string,
  force: boolean
): Promise<void> {
  if (!(await git.branchExists(repoRoot, branch))) {
    return;
  }
  try {
    await git.deleteBranch(repoRoot, branch, { force });
  } catch (error) {
    if (!(await git.branchExists(repoRoot, branch))) {
      return;
    }
    throw error;
  }
}

async function pruneWorktreesBestEffort(git: GitAdapter, repoRoot: string, warnings: string[]): Promise<void> {
  try {
    await git.pruneWorktrees(repoRoot);
  } catch (error) {
    warnings.push(`Unable to prune Git worktree metadata: ${describeError(error)}`);
  }
}

async function removeWorktreeStatePathBestEffort(
  fs: FileSystemAdapter,
  statePath: string,
  removedStatePaths: string[],
  warnings: string[]
): Promise<void> {
  try {
    await fs.removePath?.(statePath, { recursive: true, force: true });
    removedStatePaths.push(statePath);
  } catch (error) {
    warnings.push(`Unable to remove stale task state path ${statePath}: ${describeError(error)}`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readStoredTasks(fs: FileSystemAdapter, taskStoreRoot: string): Promise<TaskRecord[]> {
  const tasksDir = path.join(taskStoreRoot, "tasks");
  if (!(await fs.pathExists(tasksDir))) {
    return [];
  }

  const entries = await fs.readDir(tasksDir);
  const tasks: TaskRecord[] = [];
  for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
    tasks.push(await fs.readJson<TaskRecord>(path.join(tasksDir, entry)));
  }

  return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function getTaskRuntimeRepoRoot(task: TaskRecord): string {
  return task.worktreePath;
}

async function getBaseRepoVisibleChanges(git: GitAdapter, repoRoot: string): Promise<string[]> {
  const rawStatus = await git.getStatusPorcelainV1(repoRoot);
  return parseGitStatusPaths(rawStatus).filter((filePath) => !isVcmRuntimePath(filePath));
}

function parseGitStatusPaths(rawStatus: string): string[] {
  const records = rawStatus.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length < 4) {
      continue;
    }
    const indexStatus = record[0] ?? " ";
    const filePath = normalizeGitStatusPath(record.slice(3));
    paths.push(filePath);
    if (indexStatus === "R" || indexStatus === "C") {
      index += 1;
    }
  }
  return paths;
}

function normalizeGitStatusPath(value: string): string {
  return path.posix.normalize(value).replace(/^\.\//, "");
}

function isVcmRuntimePath(repoRelativePath: string): boolean {
  return repoRelativePath.startsWith(".ai/vcm/") ||
    repoRelativePath.startsWith(".claude/worktrees/") ||
    repoRelativePath.startsWith(".ai/tools/__pycache__/");
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
  await fs.ensureDir(path.join(taskRepoRoot, stateRoot, "gate-reviews"));
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
    path.join(taskRepoRoot, stateRoot, "gate-reviews"),
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
