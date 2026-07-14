import fs from "node:fs/promises";
import path from "node:path";
import type { RoleName } from "../../shared/types/role.js";

const ACTIVE_JOB_STATUSES = new Set(["queued", "starting", "running"]);
const ACTIVE_CODER_WORKER_STATUSES = new Set(["planned", "running", "completed", "failed"]);
const QUEUED_JOB_FRESH_MS = 120_000;

export const MAX_CONSECUTIVE_STOP_BLOCKS = 3;

export interface ActiveValidationJob {
  jobId: string;
  status: string;
  startedAt?: string;
  timeoutSeconds?: number;
  processId?: number;
  workerPid?: number;
  leaseMtimeMs?: number;
}

interface ActiveCoderWorkerTask {
  workerId: string;
  status: string;
  reportPath?: string;
  error?: string;
  stateMtimeMs?: number;
}

export type StopGuardVerdict =
  | { behavior: "allow" }
  | { behavior: "block"; reason: string };

export interface StopGuardInput {
  repoRoot: string;
  taskSlug: string;
  role: RoleName;
  taskRepoRoot: string;
}

export interface JobGuardService {
  findActiveJobs(taskRepoRoot: string): Promise<ActiveValidationJob[]>;
  evaluateStop(input: StopGuardInput): Promise<StopGuardVerdict>;
  notePromptSubmitted(input: Pick<StopGuardInput, "repoRoot" | "taskSlug" | "role">): void;
}

export interface JobGuardServiceDeps {
  isProcessAlive?(pid: number): boolean;
  now?(): number;
}

interface BlockState {
  count: number;
  lastProgressMtimeMs?: number;
}

export function createJobGuardService(deps: JobGuardServiceDeps = {}): JobGuardService {
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const now = deps.now ?? Date.now;
  const blockStates = new Map<string, BlockState>();

  async function findActiveJobs(taskRepoRoot: string): Promise<ActiveValidationJob[]> {
    const jobsRoot = path.join(taskRepoRoot, ".ai/vcm/jobs");
    let entries: string[];
    try {
      entries = await fs.readdir(jobsRoot);
    } catch {
      return [];
    }

    const jobs: ActiveValidationJob[] = [];
    for (const entry of entries.sort()) {
      const statusPath = path.join(jobsRoot, entry, "status.json");
      let status: Record<string, unknown>;
      try {
        status = JSON.parse(await fs.readFile(statusPath, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof status.status !== "string" || !ACTIVE_JOB_STATUSES.has(status.status)) {
        continue;
      }

      const processId = numberOrUndefined(status.processId);
      const workerPid = numberOrUndefined(status.workerPid);
      const pid = processId ?? workerPid;
      if (pid !== undefined) {
        if (!isProcessAlive(pid)) {
          continue;
        }
      } else {
        // queued entry whose worker has not reported a pid yet: only trust it briefly
        try {
          const stat = await fs.stat(statusPath);
          if (now() - stat.mtimeMs > QUEUED_JOB_FRESH_MS) {
            continue;
          }
        } catch {
          continue;
        }
      }

      let leaseMtimeMs: number | undefined;
      try {
        leaseMtimeMs = (await fs.stat(path.join(jobsRoot, entry, "lease"))).mtimeMs;
      } catch {
        leaseMtimeMs = undefined;
      }

      jobs.push({
        jobId: typeof status.jobId === "string" ? status.jobId : entry,
        status: status.status,
        startedAt: typeof status.startedAt === "string" ? status.startedAt : undefined,
        timeoutSeconds: numberOrUndefined(status.timeoutSeconds),
        processId,
        workerPid,
        leaseMtimeMs
      });
    }
    return jobs;
  }

  return {
    findActiveJobs,

    async evaluateStop(input) {
      const key = stateKey(input);
      const jobs = await findActiveJobs(input.taskRepoRoot);
      const coderWorkerTasks = input.role === "coder"
        ? await findActiveCoderWorkerTasks(input.taskRepoRoot)
        : [];
      if (jobs.length === 0 && coderWorkerTasks.length === 0) {
        blockStates.delete(key);
        return { behavior: "allow" };
      }

      const jobProgressMtimeMs = jobs.reduce<number | undefined>(
        (latest, job) => job.leaseMtimeMs !== undefined && (latest === undefined || job.leaseMtimeMs > latest)
          ? job.leaseMtimeMs
          : latest,
        undefined
      );
      const workerProgressMtimeMs = coderWorkerTasks.reduce<number | undefined>(
        (latest, task) => task.stateMtimeMs !== undefined && (latest === undefined || task.stateMtimeMs > latest)
          ? task.stateMtimeMs
          : latest,
        undefined
      );
      const progressMtimeMs = latestMtime(jobProgressMtimeMs, workerProgressMtimeMs);

      let state = blockStates.get(key) ?? { count: 0 };
      const progressChanged = state.count > 0
        && progressMtimeMs !== undefined
        && state.lastProgressMtimeMs !== undefined
        && progressMtimeMs > state.lastProgressMtimeMs;
      if (progressChanged) {
        state = { count: 0 };
      }

      if (state.count >= MAX_CONSECUTIVE_STOP_BLOCKS) {
        // The role keeps trying to stop without watching; let it stop so the
        // round can settle. The job worker lease will reap the job itself.
        blockStates.delete(key);
        return { behavior: "allow" };
      }

      blockStates.set(key, { count: state.count + 1, lastProgressMtimeMs: progressMtimeMs });
      return { behavior: "block", reason: buildBlockReason(jobs, coderWorkerTasks) };
    },

    notePromptSubmitted(input) {
      blockStates.delete(stateKey(input));
    }
  };
}

async function findActiveCoderWorkerTasks(taskRepoRoot: string): Promise<ActiveCoderWorkerTask[]> {
  const tasksRoot = path.join(taskRepoRoot, ".ai/vcm/coder-workers/tasks");
  let entries: string[];
  try {
    entries = await fs.readdir(tasksRoot);
  } catch {
    return [];
  }

  const tasks: ActiveCoderWorkerTask[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const statePath = path.join(tasksRoot, entry);
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const status = typeof state.status === "string" ? state.status : "";
    if (state.handled === true || !ACTIVE_CODER_WORKER_STATUSES.has(status)) {
      continue;
    }

    let stateMtimeMs: number | undefined;
    try {
      stateMtimeMs = (await fs.stat(statePath)).mtimeMs;
    } catch {
      stateMtimeMs = undefined;
    }

    tasks.push({
      workerId: typeof state.workerId === "string" ? state.workerId : path.basename(entry, ".json"),
      status,
      reportPath: typeof state.reportPath === "string" ? state.reportPath : undefined,
      error: typeof state.error === "string" ? state.error : undefined,
      stateMtimeMs
    });
  }
  return tasks;
}

function stateKey(input: Pick<StopGuardInput, "repoRoot" | "taskSlug" | "role">): string {
  return `${input.repoRoot}::${input.taskSlug}::${input.role}`;
}

function buildBlockReason(jobs: ActiveValidationJob[], coderWorkerTasks: ActiveCoderWorkerTask[]): string {
  if (jobs.length > 0 && coderWorkerTasks.length === 0) {
    return buildValidationJobBlockReason(jobs);
  }
  if (jobs.length === 0) {
    return buildCoderWorkerBlockReason(coderWorkerTasks);
  }
  return `${buildValidationJobBlockReason(jobs)}\n${buildCoderWorkerBlockReason(coderWorkerTasks)}`;
}

function buildValidationJobBlockReason(jobs: ActiveValidationJob[]): string {
  const first = jobs[0];
  const listing = jobs.map((job) => `${job.jobId} (${job.status})`).join(", ");
  return `VCM: validation job ${listing} is still running. Do not end the turn while a validation job is running. `
    + `Run \`.ai/tools/watch-job ${first.jobId}\` again now and keep watching until it reports a terminal result `
    + `(success, failed, timeout, or orphaned), then record the result.`;
}

function buildCoderWorkerBlockReason(tasks: ActiveCoderWorkerTask[]): string {
  const listing = tasks.map((task) => `${task.workerId} (${task.status})`).join(", ");
  const reports = tasks
    .map((task) => task.reportPath)
    .filter((reportPath): reportPath is string => Boolean(reportPath));
  const reportHint = reports.length > 0 ? ` Test report(s): ${reports.join(", ")}.` : "";
  return `VCM: coder worker task ${listing} is still unhandled. Do not end the Coder turn while worker tasks are unhandled. `
    + `Wait for worker subagents, test reports and commits, resolve failed or incomplete workers, set \`handled: true\` in each worker state, and continue.${reportHint}`;
}

function latestMtime(...values: Array<number | undefined>): number | undefined {
  return values.reduce<number | undefined>(
    (latest, value) => value !== undefined && (latest === undefined || value > latest) ? value : latest,
    undefined
  );
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
