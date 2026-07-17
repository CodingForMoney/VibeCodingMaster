import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandRunner } from "../../../src/backend/adapters/command-runner.js";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createGitAdapter } from "../../../src/backend/adapters/git-adapter.js";
import type { GitAdapter } from "../../../src/backend/adapters/git-adapter.js";
import { createArtifactService } from "../../../src/backend/services/artifact-service.js";
import { createTaskService } from "../../../src/backend/services/task-service.js";
import type { ProjectConfig } from "../../../src/shared/types/project.js";

describe("createTaskService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("creates a task branch and worktree under .claude/worktrees", async () => {
    const repoRoot = await createTempGitRepo(tempDirs);
    const service = createService(repoRoot);

    const task = await service.createTask(repoRoot, { taskSlug: "demo-task" });

    expect(task).toMatchObject({
      taskSlug: "demo-task",
      repoRoot,
      branch: "feature/demo-task",
      handoffDir: ".ai/vcm/handoffs",
      worktreePath: path.join(repoRoot, ".claude/worktrees/demo-task")
    });
    await expect(fileExists(path.join(task.worktreePath, ".git"))).resolves.toBe(true);
    await expect(fileExists(path.join(task.worktreePath, ".ai/vcm/handoffs/architecture-brief.md"))).resolves.toBe(true);
    await expect(fileExists(path.join(task.worktreePath, ".ai/vcm/handoffs/architecture-plan.md"))).resolves.toBe(true);
    await expect(fileExists(path.join(task.worktreePath, ".ai/vcm/handoffs/final-acceptance.md"))).resolves.toBe(true);
    await expect(fileExists(path.join(task.worktreePath, ".ai/vcm/sessions"))).resolves.toBe(true);
    await expect(fileExists(path.join(task.worktreePath, ".ai/vcm/messages"))).resolves.toBe(true);
    await expect(fileExists(path.join(task.worktreePath, ".ai/vcm/orchestration"))).resolves.toBe(true);
    await expect(fileExists(path.join(task.worktreePath, ".ai/vcm/translation"))).resolves.toBe(true);
    await expect(fileExists(path.join(repoRoot, ".ai/vcm/tasks/demo-task.json"))).resolves.toBe(false);
    await expect(fileExists(path.join(getAppProjectDataRoot(repoRoot), "tasks/demo-task.json"))).resolves.toBe(true);
    await expect(readText(path.join(task.worktreePath, ".ai/vcm/handoffs/role-commands/coder.md")))
      .resolves.toContain(`Task repo root: ${task.worktreePath}`);
    await expect(readText(path.join(task.worktreePath, ".ai/vcm/handoffs/role-commands/coder.md")))
      .resolves.toContain("Branch: feature/demo-task");
    await expect(readGit(repoRoot, ["status", "--porcelain"])).resolves.toBe("");
  });

  it("closes a task by removing its worktree, branch, and central task state", async () => {
    const repoRoot = await createTempGitRepo(tempDirs);
    const service = createService(repoRoot);
    const task = await service.createTask(repoRoot, { taskSlug: "cleanup-task" });

    const result = await service.cleanupTask(repoRoot, "cleanup-task");

    expect(result.taskClosed).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.stateRemoved).toBe(true);
    expect(result.removedWorktreePath).toBe(task.worktreePath);
    expect(result.deletedBranch).toBe("feature/cleanup-task");
    expect(result.removedStatePaths).toContain(path.join(getAppProjectDataRoot(repoRoot), "tasks/cleanup-task.json"));
    expect(result.removedStatePaths).toContain(path.join(task.worktreePath, ".ai/vcm/sessions/cleanup-task.json"));
    expect(result.removedStatePaths).toContain(path.join(task.worktreePath, ".ai/vcm/handoffs"));
    expect(result.removedStatePaths).not.toContain(path.join(repoRoot, ".ai/vcm/sessions/cleanup-task.json"));
    await expect(fileExists(task.worktreePath)).resolves.toBe(false);
    await expect(fileExists(path.join(repoRoot, ".ai/vcm/tasks/cleanup-task.json"))).resolves.toBe(false);
    await expect(fileExists(path.join(getAppProjectDataRoot(repoRoot), "tasks/cleanup-task.json"))).resolves.toBe(false);
    await expect(gitExitCode(repoRoot, ["show-ref", "--verify", "--quiet", "refs/heads/feature/cleanup-task"]))
      .resolves.toBe(1);
  });

  it("closes a task when the worktree is already unregistered but the directory remains", async () => {
    const repoRoot = await createTempGitRepo(tempDirs);
    const service = createService(repoRoot);
    const task = await service.createTask(repoRoot, { taskSlug: "orphaned-worktree-task" });
    await readGit(repoRoot, ["worktree", "remove", "--force", task.worktreePath]);
    await fs.mkdir(task.worktreePath, { recursive: true });
    await fs.writeFile(path.join(task.worktreePath, ".DS_Store"), "stale\n");

    const result = await service.cleanupTask(repoRoot, "orphaned-worktree-task");

    expect(result.removedWorktreePath).toBe(task.worktreePath);
    expect(result.deletedBranch).toBe("feature/orphaned-worktree-task");
    expect(result.removedStatePaths).toContain(path.join(getAppProjectDataRoot(repoRoot), "tasks/orphaned-worktree-task.json"));
    await expect(fileExists(task.worktreePath)).resolves.toBe(false);
    await expect(fileExists(path.join(getAppProjectDataRoot(repoRoot), "tasks/orphaned-worktree-task.json")))
      .resolves.toBe(false);
    await expect(gitExitCode(repoRoot, ["show-ref", "--verify", "--quiet", "refs/heads/feature/orphaned-worktree-task"]))
      .resolves.toBe(1);
  });

  it("closes a task when the worktree and branch were already removed by an earlier cleanup attempt", async () => {
    const repoRoot = await createTempGitRepo(tempDirs);
    const service = createService(repoRoot);
    const task = await service.createTask(repoRoot, { taskSlug: "retry-close-task" });
    await readGit(repoRoot, ["worktree", "remove", "--force", task.worktreePath]);
    await readGit(repoRoot, ["branch", "-D", "feature/retry-close-task"]);
    await fs.mkdir(task.worktreePath, { recursive: true });
    await fs.writeFile(path.join(task.worktreePath, "stale.txt"), "left behind\n");

    const result = await service.cleanupTask(repoRoot, "retry-close-task");

    expect(result.taskClosed).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.deletedBranch).toBeNull();
    await expect(fileExists(task.worktreePath)).resolves.toBe(false);
    await expect(fileExists(path.join(getAppProjectDataRoot(repoRoot), "tasks/retry-close-task.json")))
      .resolves.toBe(false);
  });

  it("force-deletes a task branch with commits not contained in the base branch", async () => {
    const repoRoot = await createTempGitRepo(tempDirs);
    const service = createService(repoRoot);
    const task = await service.createTask(repoRoot, { taskSlug: "unmerged-task" });
    await fs.writeFile(path.join(task.worktreePath, "task-change.txt"), "task-only\n");
    await readGit(task.worktreePath, ["add", "task-change.txt"]);
    await readGit(task.worktreePath, ["commit", "-qm", "task-only commit"]);

    const result = await service.cleanupTask(repoRoot, "unmerged-task");

    expect(result.taskClosed).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.deletedBranch).toBe("feature/unmerged-task");
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("1 commit(s) not contained")
    ]));
    await expect(gitExitCode(repoRoot, ["show-ref", "--verify", "--quiet", "refs/heads/feature/unmerged-task"]))
      .resolves.toBe(1);
  });

  it("keeps the task logically closed when forced branch deletion fails", async () => {
    const repoRoot = await createTempGitRepo(tempDirs);
    const git = createGitAdapter(createCommandRunner());
    const service = createService(repoRoot, {
      git: {
        ...git,
        async deleteBranch() {
          throw new Error("branch is locked");
        }
      }
    });
    await service.createTask(repoRoot, { taskSlug: "locked-branch-task" });

    const result = await service.cleanupTask(repoRoot, "locked-branch-task");

    expect(result.taskClosed).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(result.stateRemoved).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Unable to force-delete task branch feature/locked-branch-task")
    ]));
    await expect(gitExitCode(repoRoot, ["show-ref", "--verify", "--quiet", "refs/heads/feature/locked-branch-task"]))
      .resolves.toBe(0);
    await expect(
      fs.readFile(path.join(getAppProjectDataRoot(repoRoot), "tasks/locked-branch-task.json"), "utf8")
    ).resolves.toContain('"cleanupStatus": "cleaned"');

    const nextTask = await service.createTask(repoRoot, { taskSlug: "next-task" });
    expect(nextTask.taskSlug).toBe("next-task");
  });

  it("refuses to create a second active task for the same project", async () => {
    const repoRoot = await createTempGitRepo(tempDirs);
    const service = createService(repoRoot);
    await service.createTask(repoRoot, { taskSlug: "first-task" });

    await expect(service.createTask(repoRoot, { taskSlug: "second-task" })).rejects.toMatchObject({
      code: "ACTIVE_TASK_EXISTS"
    });
  });

  it("closes a dirty task worktree without checking uncommitted changes", async () => {
    const repoRoot = await createTempGitRepo(tempDirs);
    const service = createService(repoRoot);
    const task = await service.createTask(repoRoot, { taskSlug: "dirty-close-task" });
    await fs.writeFile(path.join(task.worktreePath, "pending.txt"), "uncommitted\n");

    const result = await service.cleanupTask(repoRoot, "dirty-close-task");

    expect(result.deletedBranch).toBe("feature/dirty-close-task");
    await expect(fileExists(task.worktreePath)).resolves.toBe(false);
  });

  it("allows task creation when the base repo only has VCM runtime files", async () => {
    const repoRoot = await createTempGitRepo(tempDirs, {
      ignoreVcm: false,
      ignoreClaudeWorktrees: false
    });
    const service = createService(repoRoot);
    await fs.mkdir(path.join(repoRoot, ".ai/vcm/tasks"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".ai/vcm/tasks/stale.json"), "{}\n");
    await fs.mkdir(path.join(repoRoot, ".claude/worktrees/stale"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".claude/worktrees/stale/marker.txt"), "runtime\n");

    const task = await service.createTask(repoRoot, { taskSlug: "runtime-only-task" });

    expect(task.taskSlug).toBe("runtime-only-task");
  });

  it("refuses task creation when the base repository has uncommitted changes", async () => {
    const repoRoot = await createTempGitRepo(tempDirs);
    const service = createService(repoRoot);
    await fs.writeFile(path.join(repoRoot, "pending.txt"), "not committed\n");

    await expect(service.createTask(repoRoot, { taskSlug: "dirty-task" })).rejects.toMatchObject({
      code: "BASE_REPO_DIRTY"
    });
  });

});

function createService(repoRoot: string, options: { git?: GitAdapter } = {}) {
  const fsAdapter = createNodeFileSystemAdapter();
  const config: ProjectConfig = {
    version: 1,
    repoRoot,
    defaultRoles: ["project-manager", "architect", "coder", "tester"],
    handoffRoot: ".ai/vcm/handoffs",
    stateRoot: ".ai/vcm",
    terminalBackend: "node-pty",
    claudeCommand: "claude"
  };

  return createTaskService({
    fs: fsAdapter,
    git: options.git ?? createGitAdapter(createCommandRunner()),
    artifactService: createArtifactService(fsAdapter),
    projectService: {
      async loadConfig() {
        return config;
      },
      getProjectDataRoot() {
        return getAppProjectDataRoot(repoRoot);
      }
    },
    now: () => "2026-05-31T00:00:00.000Z"
  });
}

function getAppProjectDataRoot(repoRoot: string): string {
  return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-vcm-app`);
}

async function createTempGitRepo(
  tempDirs: string[],
  options: { ignoreVcm?: boolean; ignoreClaudeWorktrees?: boolean } = {}
): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vcm-task-"));
  tempDirs.push(repoRoot);
  tempDirs.push(getAppProjectDataRoot(repoRoot));
  await readGit(repoRoot, ["init", "-q"]);
  await readGit(repoRoot, ["config", "user.email", "test@example.com"]);
  await readGit(repoRoot, ["config", "user.name", "Test User"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# demo\n");
  await fs.writeFile(
    path.join(repoRoot, ".gitignore"),
    [
      "node_modules/",
      ...(options.ignoreVcm === false ? [] : [".ai/vcm/"]),
      ...(options.ignoreClaudeWorktrees === false ? [] : [".claude/worktrees/"]),
      ""
    ].join("\n")
  );
  await readGit(repoRoot, ["add", "README.md", ".gitignore"]);
  await readGit(repoRoot, ["commit", "-qm", "init"]);
  return repoRoot;
}

async function readGit(cwd: string, args: string[]): Promise<string> {
  const result = await createCommandRunner().run("git", args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

async function gitExitCode(cwd: string, args: string[]): Promise<number> {
  return (await createCommandRunner().run("git", args, { cwd })).exitCode;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readText(targetPath: string): Promise<string> {
  return fs.readFile(targetPath, "utf8");
}
