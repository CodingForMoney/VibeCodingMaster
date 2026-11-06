import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitAdapter } from "../../../src/backend/adapters/git-adapter.js";
import {
  createCommandRunner,
  type CommandResult,
  type CommandRunner,
  type CommandRunnerOptions
} from "../../../src/backend/adapters/command-runner.js";

describe("createGitAdapter commit identity", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  // Runs real Git with no global or system config so only the repository's own
  // config can supply an identity.
  async function createIsolatedRepo(localConfig: Record<string, string> = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vcm-git-identity-"));
    tempDirs.push(root);
    const isolation = { GIT_CONFIG_GLOBAL: path.join(root, "empty-gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
    await fs.writeFile(isolation.GIT_CONFIG_GLOBAL, "");
    const real = createCommandRunner();
    const runner: CommandRunner = {
      run: (command, args, options = {}) => real.run(command, args, { ...options, env: { ...options.env, ...isolation } })
    };
    const repoRoot = path.join(root, "repo");
    await fs.mkdir(repoRoot);
    await runner.run("git", ["init", "-q"], { cwd: repoRoot });
    for (const [key, value] of Object.entries(localConfig)) {
      await runner.run("git", ["config", key, value], { cwd: repoRoot });
    }
    await fs.writeFile(path.join(repoRoot, "file.txt"), "content\n");
    await runner.run("git", ["add", "file.txt"], { cwd: repoRoot });
    return { adapter: createGitAdapter(runner), runner, repoRoot };
  }

  it("commits with the default identity when Git has none configured", async () => {
    const { adapter, runner, repoRoot } = await createIsolatedRepo();

    const identity = await adapter.resolveCommitIdentity(repoRoot);
    expect(identity).toMatchObject({ name: "VCM", email: "vcm@localhost", defaulted: ["name", "email"] });
    expect(identity.env).toEqual({
      GIT_AUTHOR_NAME: "VCM",
      GIT_COMMITTER_NAME: "VCM",
      GIT_AUTHOR_EMAIL: "vcm@localhost",
      GIT_COMMITTER_EMAIL: "vcm@localhost"
    });
    await adapter.commit(repoRoot, "initial");
    const author = await runner.run("git", ["log", "-1", "--format=%an <%ae> | %cn <%ce>"], { cwd: repoRoot });
    expect(author.stdout.trim()).toBe("VCM <vcm@localhost> | VCM <vcm@localhost>");
  });

  it("keeps a configured repository identity and fills only the missing part", async () => {
    const configured = await createIsolatedRepo({ "user.name": "Dev", "user.email": "dev@example.com" });
    await expect(configured.adapter.resolveCommitIdentity(configured.repoRoot))
      .resolves.toEqual({ name: "Dev", email: "dev@example.com", defaulted: [], env: {} });
    await configured.adapter.commit(configured.repoRoot, "initial");
    const author = await configured.runner.run("git", ["log", "-1", "--format=%an <%ae>"], { cwd: configured.repoRoot });
    expect(author.stdout.trim()).toBe("Dev <dev@example.com>");

    const partial = await createIsolatedRepo({ "user.name": "Dev" });
    await expect(partial.adapter.resolveCommitIdentity(partial.repoRoot)).resolves.toEqual({
      name: "Dev",
      email: "vcm@localhost",
      defaulted: ["email"],
      env: { GIT_AUTHOR_EMAIL: "vcm@localhost", GIT_COMMITTER_EMAIL: "vcm@localhost" }
    });
  });
});

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

  it("stages and commits with safe.directory", async () => {
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

    expect(calls[0]).toMatchObject({ command: "git", options: { cwd: "/workspace" } });
    expect(calls[0]?.args.slice(-4)).toEqual(["add", "--", "CLAUDE.md", ".claude/settings.json"]);
    const commitIndex = calls.findIndex((call) => call.args.includes("commit"));
    expect(calls[commitIndex]?.args.slice(-3)).toEqual(["commit", "-m", "chore: update VCM harness"]);
    // The stub reports no configured identity, so the commit carries the default.
    expect(calls[commitIndex]?.options.env).toMatchObject({ GIT_AUTHOR_NAME: "VCM", GIT_COMMITTER_EMAIL: "vcm@localhost" });
    expect(calls[commitIndex + 1]?.args.slice(-2)).toEqual(["rev-parse", "HEAD"]);
  });

  it("commits only the requested memory host files", async () => {
    const calls: RunnerCall[] = [];
    const adapter = createGitAdapter({
      async run(command, args = [], options = {}) {
        calls.push({ command, args, options });
        if (args.at(-1) === "HEAD") {
          return { stdout: "memory123", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });

    await expect(adapter.commitPaths(
      "/workspace",
      "chore: update VCM memory",
      ["CLAUDE.md", ".claude/agents/coder.md"]
    )).resolves.toBe("memory123");

    expect(calls.find((call) => call.args.includes("commit"))?.args.slice(-7)).toEqual([
      "commit",
      "--only",
      "-m",
      "chore: update VCM memory",
      "--",
      "CLAUDE.md",
      ".claude/agents/coder.md"
    ]);
  });

  it("reads porcelain status with safe.directory", async () => {
    const calls: RunnerCall[] = [];
    const adapter = createGitAdapter(createRunner(calls, {
      stdout: "",
      stderr: "",
      exitCode: 0
    }));

    await adapter.getStatusPorcelainV1("/workspace");

    expect(calls[0]).toMatchObject({ command: "git", options: { cwd: "/workspace" } });
    expect(calls[0]?.args).toContain("safe.directory=/workspace");
    expect(calls[0]?.args.slice(-4)).toEqual(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  });

  it("reads changed paths as a null-delimited list", async () => {
    const calls: RunnerCall[] = [];
    const adapter = createGitAdapter(createRunner(calls, {
      stdout: "CLAUDE.md\0.claude/agents/harness-engineer.md\0",
      stderr: "",
      exitCode: 0
    }));

    await expect(adapter.getChangedPaths("/workspace", "base123", "HEAD")).resolves.toEqual([
      "CLAUDE.md",
      ".claude/agents/harness-engineer.md"
    ]);

    expect(calls[0]?.args.slice(-5)).toEqual([
      "diff",
      "--name-only",
      "-z",
      "base123",
      "HEAD"
    ]);
  });

  it("checks whether a worktree path is registered", async () => {
    const calls: RunnerCall[] = [];
    const adapter = createGitAdapter(createRunner(calls, {
      stdout: [
        "worktree /workspace",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /workspace/.claude/worktrees/demo-task",
        "HEAD def456",
        "branch refs/heads/feature/demo-task",
        ""
      ].join("\n"),
      stderr: "",
      exitCode: 0
    }));

    await expect(adapter.isWorktreeRegistered("/workspace", "/workspace/.claude/worktrees/demo-task"))
      .resolves.toBe(true);
    await expect(adapter.isWorktreeRegistered("/workspace", "/workspace/.claude/worktrees/missing-task"))
      .resolves.toBe(false);

    expect(calls[0]?.args).toContain("safe.directory=/workspace");
    expect(calls[0]?.args.slice(-3)).toEqual(["worktree", "list", "--porcelain"]);
  });

  it("prunes stale worktree metadata with safe.directory", async () => {
    const calls: RunnerCall[] = [];
    const adapter = createGitAdapter(createRunner(calls, {
      stdout: "",
      stderr: "",
      exitCode: 0
    }));

    await adapter.pruneWorktrees("/workspace");

    expect(calls[0]?.args).toContain("safe.directory=/workspace");
    expect(calls[0]?.args.slice(-2)).toEqual(["worktree", "prune"]);
  });

  it("reads commit metadata and commit diffs with safe.directory", async () => {
    const calls: RunnerCall[] = [];
    const adapter = createGitAdapter({
      async run(command, args = [], options = {}) {
        calls.push({ command, args, options });
        if (args.includes("merge-base")) {
          return {
            stdout: "base1234567890\n",
            stderr: "",
            exitCode: 0
          };
        }
        if (args.includes("log")) {
          return {
            stdout: "def1234567890\u0000feat: second\u00002026-06-23T01:00:00+00:00\u001eabc1234567890\u0000feat: first\u00002026-06-23T00:00:00+00:00\u001e",
            stderr: "",
            exitCode: 0
          };
        }
        if (args.includes("--format=%H%x00%s%x00%cI")) {
          return {
            stdout: "abc1234567890\u0000chore(vcm-harness): update\u00002026-06-23T00:00:00+00:00\n",
            stderr: "",
            exitCode: 0
          };
        }
        return {
          stdout: "diff --git a/CLAUDE.md b/CLAUDE.md\n",
          stderr: "",
          exitCode: 0
        };
      }
    });

    await expect(adapter.getCommitInfo("/workspace", "HEAD")).resolves.toEqual({
      sha: "abc1234567890",
      subject: "chore(vcm-harness): update",
      committedAt: "2026-06-23T00:00:00+00:00"
    });
    await expect(adapter.getCommitDiff("/workspace", "HEAD")).resolves.toContain("diff --git");
    await expect(adapter.getDiff("/workspace", "base123", null, ["CLAUDE.md"])).resolves.toContain("diff --git");
    await expect(adapter.getCommitList("/workspace", "base123..HEAD")).resolves.toEqual([
      {
        sha: "def1234567890",
        subject: "feat: second",
        committedAt: "2026-06-23T01:00:00+00:00"
      },
      {
        sha: "abc1234567890",
        subject: "feat: first",
        committedAt: "2026-06-23T00:00:00+00:00"
      }
    ]);
    await expect(adapter.getMergeBase("/workspace", "main", "HEAD")).resolves.toBe("base1234567890");

    expect(calls[0]).toMatchObject({ command: "git", options: { cwd: "/workspace" } });
    expect(calls[0]?.args).toContain("safe.directory=/workspace");
    expect(calls[0]?.args.slice(-4)).toEqual(["show", "-s", "--format=%H%x00%s%x00%cI", "HEAD"]);
    expect(calls[1]?.args).toContain("safe.directory=/workspace");
    expect(calls[1]?.args.slice(-5)).toEqual([
      "--no-ext-diff",
      "--binary",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "HEAD"
    ]);
    expect(calls[2]?.args.slice(-8)).toEqual([
      "diff",
      "--no-ext-diff",
      "--binary",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "base123",
      "--",
      "CLAUDE.md"
    ]);
    expect(calls[3]?.args.slice(-3)).toEqual(["log", "--format=%H%x00%s%x00%cI%x1e", "base123..HEAD"]);
    expect(calls[4]?.args.slice(-3)).toEqual(["merge-base", "main", "HEAD"]);
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
