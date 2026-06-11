import fs from "node:fs/promises";
import path from "node:path";
import type { RoleName } from "../../shared/types/role.js";

const ACTIVE_JOB_STATUSES = new Set(["queued", "starting", "running"]);
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
  lastLeaseMtimeMs?: number;
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
      if (jobs.length === 0) {
        blockStates.delete(key);
        return { behavior: "allow" };
      }

      const leaseMtimeMs = jobs.reduce<number | undefined>(
        (latest, job) => job.leaseMtimeMs !== undefined && (latest === undefined || job.leaseMtimeMs > latest)
          ? job.leaseMtimeMs
          : latest,
        undefined
      );

      let state = blockStates.get(key) ?? { count: 0 };
      const watcherProgressed = state.count > 0
        && leaseMtimeMs !== undefined
        && state.lastLeaseMtimeMs !== undefined
        && leaseMtimeMs > state.lastLeaseMtimeMs;
      if (watcherProgressed) {
        state = { count: 0 };
      }

      if (state.count >= MAX_CONSECUTIVE_STOP_BLOCKS) {
        // The role keeps trying to stop without watching; let it stop so the
        // round can settle. The job worker lease will reap the job itself.
        blockStates.delete(key);
        return { behavior: "allow" };
      }

      blockStates.set(key, { count: state.count + 1, lastLeaseMtimeMs: leaseMtimeMs });
      return { behavior: "block", reason: buildBlockReason(jobs) };
    },

    notePromptSubmitted(input) {
      blockStates.delete(stateKey(input));
    }
  };
}

function stateKey(input: Pick<StopGuardInput, "repoRoot" | "taskSlug" | "role">): string {
  return `${input.repoRoot}::${input.taskSlug}::${input.role}`;
}

function buildBlockReason(jobs: ActiveValidationJob[]): string {
  const first = jobs[0];
  const listing = jobs.map((job) => `${job.jobId} (${job.status})`).join(", ");
  return `VCM: validation job ${listing} is still running. Do not end the turn while a validation job is running. `
    + `Run \`.ai/tools/watch-job ${first.jobId}\` again now and keep watching until it reports a terminal result `
    + `(success, failed, timeout, or orphaned), then record the result.`;
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
