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

  it("stages, commits, and rebases with safe.directory", async () => {
    const calls: RunnerCall[] = [];
    const adapter = createGitAdapter({
      async run(command, args = [], options = {}) {
        calls.push({ command, args, options });
        if (args.at(-1) === "HEAD") {
          return { stdout: "abc123456789", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });

    await adapter.addPaths("/workspace", ["CLAUDE.md", ".claude/settings.json"]);
    await expect(adapter.commit("/workspace", "chore: update VCM harness")).resolves.toBe("abc123456789");
    await adapter.rebase("/workspace/.claude/worktrees/demo", "abc123456789");

    expect(calls[0]).toMatchObject({ command: "git", options: { cwd: "/workspace" } });
    expect(calls[0]?.args.slice(-4)).toEqual(["add", "--", "CLAUDE.md", ".claude/settings.json"]);
    expect(calls[1]?.args.slice(-3)).toEqual(["commit", "-m", "chore: update VCM harness"]);
    expect(calls[2]?.args.slice(-2)).toEqual(["rev-parse", "HEAD"]);
    expect(calls[3]).toMatchObject({ command: "git", options: { cwd: "/workspace/.claude/worktrees/demo" } });
    expect(calls[3]?.args.slice(-2)).toEqual(["rebase", "abc123456789"]);
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
