import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandRunner } from "../../../src/backend/adapters/command-runner.js";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createGitAdapter } from "../../../src/backend/adapters/git-adapter.js";
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

  it("closes a dirty task worktree without checking uncommitted changes", async () => {
    const repoRoot = await createTempGitRepo(tempDirs);
    const service = createService(repoRoot);
    const task = await service.createTask(repoRoot, { taskSlug: "dirty-close-task" });
    await fs.writeFile(path.join(task.worktreePath, "pending.txt"), "uncommitted\n");

    const result = await service.cleanupTask(repoRoot, "dirty-close-task");

    expect(result.deletedBranch).toBe("feature/dirty-close-task");
    await expect(fileExists(task.worktreePath)).resolves.toBe(false);
  });

  it("refuses task creation when .ai/vcm is not ignored", async () => {
    const repoRoot = await createTempGitRepo(tempDirs, { ignoreVcm: false });
    const service = createService(repoRoot);

    await expect(service.createTask(repoRoot, { taskSlug: "blocked-task" })).rejects.toMatchObject({
      code: "VCM_STATE_NOT_IGNORED"
    });
  });

  it("refuses task worktree creation when .claude/worktrees is not ignored", async () => {
    const repoRoot = await createTempGitRepo(tempDirs, { ignoreClaudeWorktrees: false });
    const service = createService(repoRoot);

    await expect(service.createTask(repoRoot, { taskSlug: "blocked-worktree-task" })).rejects.toMatchObject({
      code: "VCM_WORKTREES_NOT_IGNORED"
    });
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

function createService(repoRoot: string) {
  const fsAdapter = createNodeFileSystemAdapter();
  const config: ProjectConfig = {
    version: 1,
    repoRoot,
    defaultRoles: ["project-manager", "architect", "coder", "reviewer"],
    handoffRoot: ".ai/vcm/handoffs",
    stateRoot: ".ai/vcm",
    terminalBackend: "node-pty",
    claudeCommand: "claude"
  };

  return createTaskService({
    fs: fsAdapter,
    git: createGitAdapter(createCommandRunner()),
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
