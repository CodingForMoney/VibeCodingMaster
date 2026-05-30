import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitAdapter } from "../../../src/backend/adapters/git-adapter.js";
import type {
  CommandResult,
  CommandRunner,
  CommandRunnerOptions
} from "../../../src/backend/adapters/command-runner.js";

describe("createGitAdapter", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("accepts a normal Git repository by checking the .git directory first", async () => {
    const calls: RunnerCall[] = [];
    const repoRoot = await createTempRepoRoot(tempDirs);
    const gitDir = path.join(repoRoot, ".git");
    await fs.mkdir(gitDir);
    await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    const adapter = createGitAdapter(createRunner(calls, {
      stdout: "",
      stderr: "",
      exitCode: 1
    }));

    await expect(adapter.checkRepo(repoRoot)).resolves.toEqual({ isRepo: true });

    expect(calls).toEqual([]);
  });

  it("accepts a Git worktree or submodule by following the .git gitdir file", async () => {
    const repoRoot = await createTempRepoRoot(tempDirs);
    const gitDir = path.join(repoRoot, "linked-git-dir");
    await fs.mkdir(gitDir);
    await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    await fs.writeFile(path.join(repoRoot, ".git"), "gitdir: linked-git-dir\n");
    const adapter = createGitAdapter(createRunner([], {
      stdout: "",
      stderr: "",
      exitCode: 1
    }));

    await expect(adapter.checkRepo(repoRoot)).resolves.toEqual({ isRepo: true });
  });

  it("rejects a path without a .git marker", async () => {
    const repoRoot = await createTempRepoRoot(tempDirs);
    const adapter = createGitAdapter(createRunner([], {
      stdout: "",
      stderr: "",
      exitCode: 1
    }));

    const result = await adapter.checkRepo(repoRoot);

    expect(result.isRepo).toBe(false);
    expect(result.hint).toContain(".git not found");
  });

  it("runs Git metadata commands with a command-scoped safe.directory", async () => {
    const calls: RunnerCall[] = [];
    const adapter = createGitAdapter(createRunner(calls, {
      stdout: "main",
      stderr: "",
      exitCode: 0
    }));

    await expect(adapter.getCurrentBranch("/workspace")).resolves.toBe("main");

    expect(calls[0]).toMatchObject({
      command: "git",
      options: { cwd: "/workspace" }
    });
    expect(calls[0]?.args).toContain("safe.directory=/workspace");
    expect(calls[0]?.args.slice(-2)).toEqual(["branch", "--show-current"]);
  });
});

interface RunnerCall {
  command: string;
  args: string[];
  options: CommandRunnerOptions;
}

async function createTempRepoRoot(tempDirs: string[]): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vcm-git-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function createRunner(calls: RunnerCall[], result: CommandResult): CommandRunner {
  return {
    async run(command, args = [], options = {}) {
      calls.push({ command, args, options });
      return result;
    }
  };
}
