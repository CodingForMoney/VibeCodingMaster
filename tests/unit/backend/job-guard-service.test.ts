import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJobGuardService,
  MAX_CONSECUTIVE_STOP_BLOCKS
} from "../../../src/backend/services/job-guard-service.js";

const LIVE_PID = 4242;

let tmpRoot: string | undefined;

afterEach(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

async function makeTaskRepo(): Promise<string> {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "vcm-job-guard-"));
  return tmpRoot;
}

async function writeJob(
  repo: string,
  jobId: string,
  status: Record<string, unknown>,
  options: { leaseAt?: Date; statusMtime?: Date } = {}
): Promise<void> {
  const dir = path.join(repo, ".ai/vcm/jobs", jobId);
  await mkdir(dir, { recursive: true });
  const statusPath = path.join(dir, "status.json");
  await writeFile(statusPath, JSON.stringify({ jobId, ...status }));
  if (options.statusMtime) {
    await utimes(statusPath, options.statusMtime, options.statusMtime);
  }
  if (options.leaseAt) {
    const leasePath = path.join(dir, "lease");
    await writeFile(leasePath, "");
    await utimes(leasePath, options.leaseAt, options.leaseAt);
  }
}

function createGuard() {
  return createJobGuardService({
    isProcessAlive: (pid) => pid === LIVE_PID
  });
}

function stopInput(repo: string) {
  return {
    repoRoot: "/repo",
    taskSlug: "demo-task",
    role: "coder" as const,
    taskRepoRoot: repo
  };
}

describe("createJobGuardService", () => {
  it("allows stop when there is no jobs directory", async () => {
    const repo = await makeTaskRepo();
    const guard = createGuard();

    await expect(guard.evaluateStop(stopInput(repo))).resolves.toEqual({ behavior: "allow" });
  });

  it("blocks stop while a live job is running and explains how to continue", async () => {
    const repo = await makeTaskRepo();
    await writeJob(repo, "job-1", { status: "running", processId: LIVE_PID });
    const guard = createGuard();

    const verdict = await guard.evaluateStop(stopInput(repo));
    expect(verdict.behavior).toBe("block");
    if (verdict.behavior === "block") {
      expect(verdict.reason).toContain("job-1");
      expect(verdict.reason).toContain(".ai/tools/watch-job job-1");
      expect(verdict.reason).toContain("Do not end the turn");
    }
  });

  it("allows stop when the recorded job process is dead", async () => {
    const repo = await makeTaskRepo();
    await writeJob(repo, "job-1", { status: "running", processId: 9999 });
    const guard = createGuard();

    await expect(guard.evaluateStop(stopInput(repo))).resolves.toEqual({ behavior: "allow" });
  });

  it("allows stop for terminal job statuses", async () => {
    const repo = await makeTaskRepo();
    await writeJob(repo, "job-1", { status: "success", processId: LIVE_PID });
    await writeJob(repo, "job-2", { status: "orphaned", processId: LIVE_PID });
    const guard = createGuard();

    await expect(guard.evaluateStop(stopInput(repo))).resolves.toEqual({ behavior: "allow" });
  });

  it("treats only fresh queued entries without a pid as active", async () => {
    const repo = await makeTaskRepo();
    await writeJob(repo, "job-fresh", { status: "queued", processId: null, workerPid: null });
    const guard = createGuard();
    await expect(guard.evaluateStop(stopInput(repo))).resolves.toMatchObject({ behavior: "block" });

    const repo2 = await mkdtemp(path.join(os.tmpdir(), "vcm-job-guard-stale-"));
    try {
      const old = new Date(Date.now() - 10 * 60_000);
      await writeJob(repo2, "job-old", { status: "queued", processId: null, workerPid: null }, { statusMtime: old });
      await expect(guard.evaluateStop(stopInput(repo2))).resolves.toEqual({ behavior: "allow" });
    } finally {
      await rm(repo2, { recursive: true, force: true });
    }
  });

  it("releases the block after repeated stop attempts without watcher progress", async () => {
    const repo = await makeTaskRepo();
    const lease = new Date(Date.now() - 5_000);
    await writeJob(repo, "job-1", { status: "running", processId: LIVE_PID }, { leaseAt: lease });
    const guard = createGuard();

    for (let attempt = 0; attempt < MAX_CONSECUTIVE_STOP_BLOCKS; attempt += 1) {
      await expect(guard.evaluateStop(stopInput(repo))).resolves.toMatchObject({ behavior: "block" });
    }
    await expect(guard.evaluateStop(stopInput(repo))).resolves.toEqual({ behavior: "allow" });
  });

  it("keeps blocking when the watcher made progress between stop attempts", async () => {
    const repo = await makeTaskRepo();
    let leaseTime = new Date(Date.now() - 60_000);
    await writeJob(repo, "job-1", { status: "running", processId: LIVE_PID }, { leaseAt: leaseTime });
    const guard = createGuard();

    for (let attempt = 0; attempt < MAX_CONSECUTIVE_STOP_BLOCKS + 2; attempt += 1) {
      await expect(guard.evaluateStop(stopInput(repo))).resolves.toMatchObject({ behavior: "block" });
      leaseTime = new Date(leaseTime.getTime() + 10_000);
      const leasePath = path.join(repo, ".ai/vcm/jobs/job-1/lease");
      await utimes(leasePath, leaseTime, leaseTime);
    }
  });

  it("resets the block counter when a new prompt is accepted", async () => {
    const repo = await makeTaskRepo();
    await writeJob(repo, "job-1", { status: "running", processId: LIVE_PID });
    const guard = createGuard();

    for (let attempt = 0; attempt < MAX_CONSECUTIVE_STOP_BLOCKS; attempt += 1) {
      await expect(guard.evaluateStop(stopInput(repo))).resolves.toMatchObject({ behavior: "block" });
    }
    guard.notePromptSubmitted({ repoRoot: "/repo", taskSlug: "demo-task", role: "coder" });
    await expect(guard.evaluateStop(stopInput(repo))).resolves.toMatchObject({ behavior: "block" });
  });

  it("lists active jobs with lease information", async () => {
    const repo = await makeTaskRepo();
    const lease = new Date(Date.now() - 1_000);
    await writeJob(repo, "job-1", { status: "running", processId: LIVE_PID, timeoutSeconds: 600 }, { leaseAt: lease });
    const guard = createGuard();

    const jobs = await guard.findActiveJobs(repo);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      jobId: "job-1",
      status: "running",
      processId: LIVE_PID,
      timeoutSeconds: 600
    });
    expect(jobs[0].leaseMtimeMs).toBeTypeOf("number");
  });
});
