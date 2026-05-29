import path from "node:path";
import type { CreateTaskRequest, TaskRecord, TaskStatus } from "../../shared/types/task.js";
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
}

export interface TaskServiceDeps {
  fs: FileSystemAdapter;
  git: GitAdapter;
  artifactService: ArtifactService;
  projectService: Pick<ProjectService, "loadConfig">;
  now?: () => string;
}

export function createTaskService(deps: TaskServiceDeps): TaskService {
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    async createTask(repoRoot, input) {
      assertValidTaskSlug(input.taskSlug);
      const config = await deps.projectService.loadConfig(repoRoot);
      const taskPath = getTaskPath(repoRoot, config.stateRoot, input.taskSlug);

      if (await deps.fs.pathExists(taskPath)) {
        throw new VcmError({
          code: "TASK_EXISTS",
          message: `Task already exists: ${input.taskSlug}`,
          statusCode: 409
        });
      }

      const timestamp = now();
      const task: TaskRecord = {
        version: 1,
        taskSlug: input.taskSlug,
        title: input.title,
        createdAt: timestamp,
        updatedAt: timestamp,
        repoRoot,
        branch: await deps.git.getCurrentBranch(repoRoot),
        handoffDir: path.posix.join(config.handoffRoot, input.taskSlug),
        status: "created",
        specPath: input.specPath
      };

      await deps.artifactService.ensureHandoffStructure({
        repoRoot,
        taskSlug: input.taskSlug,
        handoffDir: task.handoffDir
      });
      await deps.artifactService.createArtifactTemplates({
        repoRoot,
        taskSlug: input.taskSlug,
        handoffDir: task.handoffDir
      });
      await this.saveTask(repoRoot, task);
      return task;
    },
    async listTasks(repoRoot) {
      const config = await deps.projectService.loadConfig(repoRoot);
      const tasksDir = path.join(repoRoot, config.stateRoot, "tasks");
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
      const config = await deps.projectService.loadConfig(repoRoot);
      const taskPath = getTaskPath(repoRoot, config.stateRoot, taskSlug);

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
      const config = await deps.projectService.loadConfig(repoRoot);
      await deps.fs.writeJsonAtomic(getTaskPath(repoRoot, config.stateRoot, task.taskSlug), task);
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
    }
  };
}

function getTaskPath(repoRoot: string, stateRoot: string, taskSlug: string): string {
  return path.join(repoRoot, stateRoot, "tasks", `${taskSlug}.json`);
}
