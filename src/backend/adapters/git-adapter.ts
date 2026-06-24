import fs from "node:fs/promises";
import path from "node:path";
import { VcmError } from "../errors.js";
import type { CommandRunner } from "./command-runner.js";

export interface GitRepoCheck {
  isRepo: boolean;
  hint?: string;
}

export interface GitAdapter {
  checkRepo(repoRoot: string): Promise<GitRepoCheck>;
  isRepo(repoRoot: string): Promise<boolean>;
  getCurrentBranch(repoRoot: string): Promise<string>;
  getHeadCommit(repoRoot: string): Promise<string>;
  getUpstreamBranch(repoRoot: string): Promise<string | null>;
  getAheadBehind(repoRoot: string, upstreamBranch: string): Promise<GitAheadBehind>;
  isDirty(repoRoot: string): Promise<boolean>;
  getStatusPorcelain(repoRoot: string): Promise<string>;
  getStatusPorcelainV1(repoRoot: string): Promise<string>;
  getCommitInfo(repoRoot: string, ref?: string): Promise<GitCommitInfo>;
  getCommitDiff(repoRoot: string, ref?: string): Promise<string>;
  getCommitList(repoRoot: string, range: string): Promise<GitCommitInfo[]>;
  getMergeBase(repoRoot: string, leftRef: string, rightRef: string): Promise<string>;
  isIgnored(repoRoot: string, repoRelativePath: string): Promise<boolean>;
  branchExists(repoRoot: string, branch: string): Promise<boolean>;
  checkoutBranch(repoRoot: string, branch: string): Promise<void>;
  mergeBranchFastForward(repoRoot: string, branch: string): Promise<GitMergeResult>;
  addPaths(repoRoot: string, paths: string[]): Promise<void>;
  commit(repoRoot: string, message: string): Promise<string>;
  createWorktree(input: CreateGitWorktreeInput): Promise<void>;
  removeWorktree(repoRoot: string, worktreePath: string, options?: { force?: boolean }): Promise<void>;
  deleteBranch(repoRoot: string, branch: string, options?: { force?: boolean }): Promise<void>;
  pullFastForward(repoRoot: string): Promise<GitPullResult>;
}

export interface GitAheadBehind {
  ahead: number;
  behind: number;
}

export interface GitPullResult {
  stdout: string;
  stderr: string;
}

export interface GitMergeResult {
  stdout: string;
  stderr: string;
}

export interface GitCommitInfo {
  sha: string;
  subject: string;
  committedAt?: string;
}

export interface CreateGitWorktreeInput {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseRef?: string;
}

export function createGitAdapter(runner: CommandRunner): GitAdapter {
  return {
    async checkRepo(repoRoot) {
      return checkGitMarker(repoRoot);
    },
    async isRepo(repoRoot) {
      return (await this.checkRepo(repoRoot)).isRepo;
    },
    async getCurrentBranch(repoRoot) {
      const result = await runGit(runner, repoRoot, ["branch", "--show-current"]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_ERROR",
          message: "Unable to read current Git branch.",
          statusCode: 400,
          hint: result.stderr
        });
      }

      return result.stdout.trim() || "detached";
    },
    async getHeadCommit(repoRoot) {
      const result = await runGit(runner, repoRoot, ["rev-parse", "HEAD"]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_ERROR",
          message: "Unable to read current Git commit.",
          statusCode: 400,
          hint: result.stderr
        });
      }

      return result.stdout.trim();
    },
    async getUpstreamBranch(repoRoot) {
      const result = await runGit(runner, repoRoot, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{u}"
      ]);
      if (result.exitCode !== 0) {
        return null;
      }

      return result.stdout.trim() || null;
    },
    async getAheadBehind(repoRoot, upstreamBranch) {
      const result = await runGit(runner, repoRoot, [
        "rev-list",
        "--left-right",
        "--count",
        `HEAD...${upstreamBranch}`
      ]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_ERROR",
          message: "Unable to read Git ahead/behind status.",
          statusCode: 400,
          hint: result.stderr
        });
      }

      const [aheadValue, behindValue] = result.stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
      return {
        ahead: Number.isFinite(aheadValue) ? aheadValue : 0,
        behind: Number.isFinite(behindValue) ? behindValue : 0
      };
    },
    async isDirty(repoRoot) {
      return (await this.getStatusPorcelain(repoRoot)).trim().length > 0;
    },
    async getStatusPorcelain(repoRoot) {
      const result = await runGit(runner, repoRoot, ["status", "--porcelain"]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_ERROR",
          message: "Unable to read Git status.",
          statusCode: 400,
          hint: result.stderr
        });
      }

      return result.stdout;
    },
    async getStatusPorcelainV1(repoRoot) {
      const result = await runGit(runner, repoRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all"
      ]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_ERROR",
          message: "Unable to read Git status.",
          statusCode: 400,
          hint: result.stderr
        });
      }

      return result.stdout;
    },
    async getCommitInfo(repoRoot, ref = "HEAD") {
      const result = await runGit(runner, repoRoot, ["show", "-s", "--format=%H%x00%s%x00%cI", ref]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_ERROR",
          message: "Unable to read Git commit.",
          statusCode: 400,
          hint: result.stderr
        });
      }

      const [sha = "", subject = "", committedAt = ""] = result.stdout.split("\0");
      return {
        sha: sha.trim(),
        subject: subject.trim(),
        committedAt: committedAt.trim() || undefined
      };
    },
    async getCommitDiff(repoRoot, ref = "HEAD") {
      const result = await runGit(runner, repoRoot, [
        "show",
        "--format=",
        "--no-ext-diff",
        "--binary",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        ref
      ]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_ERROR",
          message: "Unable to read Git commit diff.",
          statusCode: 400,
          hint: result.stderr
        });
      }

      return result.stdout;
    },
    async getCommitList(repoRoot, range) {
      const result = await runGit(runner, repoRoot, ["log", "--format=%H%x00%s%x00%cI%x1e", range]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_ERROR",
          message: "Unable to read Git commit list.",
          statusCode: 400,
          hint: result.stderr
        });
      }

      return result.stdout
        .split("\x1e")
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => {
          const [sha = "", subject = "", committedAt = ""] = record.split("\0");
          return {
            sha: sha.trim(),
            subject: subject.trim(),
            committedAt: committedAt.trim() || undefined
          };
        })
        .filter((commit) => commit.sha.length > 0);
    },
    async getMergeBase(repoRoot, leftRef, rightRef) {
      const result = await runGit(runner, repoRoot, ["merge-base", leftRef, rightRef]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_ERROR",
          message: "Unable to find Git merge base.",
          statusCode: 400,
          hint: result.stderr
        });
      }

      return result.stdout.trim();
    },
    async isIgnored(repoRoot, repoRelativePath) {
      const result = await runGit(runner, repoRoot, ["check-ignore", "-q", "--", repoRelativePath]);
      if (result.exitCode === 0) {
        return true;
      }
      if (result.exitCode === 1) {
        return false;
      }
      throw new VcmError({
        code: "GIT_ERROR",
        message: `Unable to check whether Git ignores ${repoRelativePath}.`,
        statusCode: 400,
        hint: result.stderr
      });
    },
    async branchExists(repoRoot, branch) {
      const result = await runGit(runner, repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      if (result.exitCode === 0) {
        return true;
      }
      if (result.exitCode === 1) {
        return false;
      }
      throw new VcmError({
        code: "GIT_ERROR",
        message: `Unable to check Git branch: ${branch}`,
        statusCode: 400,
        hint: result.stderr
      });
    },
    async checkoutBranch(repoRoot, branch) {
      const result = await runGit(runner, repoRoot, ["checkout", branch]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_CHECKOUT_FAILED",
          message: `Unable to checkout Git branch: ${branch}`,
          statusCode: 409,
          hint: result.stderr || result.stdout
        });
      }
    },
    async mergeBranchFastForward(repoRoot, branch) {
      const result = await runGit(runner, repoRoot, ["merge", "--ff-only", branch]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_MERGE_FAILED",
          message: `Unable to fast-forward merge branch: ${branch}`,
          statusCode: 409,
          hint: result.stderr || result.stdout || "Rebase the task branch onto local main, then try again."
        });
      }

      return {
        stdout: result.stdout,
        stderr: result.stderr
      };
    },
    async addPaths(repoRoot, paths) {
      if (paths.length === 0) {
        return;
      }
      const result = await runGit(runner, repoRoot, ["add", "--", ...paths]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_ADD_FAILED",
          message: "Unable to stage harness changes.",
          statusCode: 409,
          hint: result.stderr || result.stdout
        });
      }
    },
    async commit(repoRoot, message) {
      const result = await runGit(runner, repoRoot, ["commit", "-m", message]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_COMMIT_FAILED",
          message: "Unable to commit harness changes.",
          statusCode: 409,
          hint: result.stderr || result.stdout
        });
      }

      return this.getHeadCommit(repoRoot);
    },
    async createWorktree(input) {
      const result = await runGit(runner, input.repoRoot, [
        "worktree",
        "add",
        "-b",
        input.branch,
        input.worktreePath,
        input.baseRef ?? "HEAD"
      ]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_WORKTREE_CREATE_FAILED",
          message: `Unable to create task worktree: ${input.worktreePath}`,
          statusCode: 400,
          hint: result.stderr
        });
      }
    },
    async removeWorktree(repoRoot, worktreePath, options = {}) {
      const args = ["worktree", "remove"];
      if (options.force) {
        args.push("--force");
      }
      args.push(worktreePath);
      const result = await runGit(runner, repoRoot, args);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_WORKTREE_REMOVE_FAILED",
          message: `Unable to remove task worktree: ${worktreePath}`,
          statusCode: 400,
          hint: result.stderr
        });
      }
    },
    async deleteBranch(repoRoot, branch, options = {}) {
      const result = await runGit(runner, repoRoot, ["branch", options.force ? "-D" : "-d", branch]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_BRANCH_DELETE_FAILED",
          message: `Unable to delete Git branch: ${branch}`,
          statusCode: 400,
          hint: result.stderr
        });
      }
    },
    async pullFastForward(repoRoot) {
      const result = await runGit(runner, repoRoot, ["pull", "--ff-only"]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_PULL_FAILED",
          message: "Unable to pull connected repository with fast-forward only.",
          statusCode: 409,
          hint: result.stderr || result.stdout
        });
      }

      return {
        stdout: result.stdout,
        stderr: result.stderr
      };
    }
  };
}

async function checkGitMarker(repoRoot: string): Promise<GitRepoCheck> {
  const markerPath = path.join(repoRoot, ".git");
  try {
    const markerStat = await fs.lstat(markerPath);
    if (markerStat.isDirectory()) {
      return checkGitDirectory(markerPath);
    }

    if (markerStat.isFile()) {
      return checkGitFile(repoRoot, markerPath);
    }

    return {
      isRepo: false,
      hint: `.git exists but is neither a directory nor a gitdir file: ${markerPath}`
    };
  } catch {
    return {
      isRepo: false,
      hint: `.git not found under selected path: ${markerPath}`
    };
  }
}

async function checkGitDirectory(gitDir: string): Promise<GitRepoCheck> {
  if (await pathExists(path.join(gitDir, "HEAD"))) {
    return { isRepo: true };
  }

  return {
    isRepo: false,
    hint: `.git directory exists but HEAD is missing: ${gitDir}`
  };
}

async function checkGitFile(repoRoot: string, markerPath: string): Promise<GitRepoCheck> {
  const marker = await fs.readFile(markerPath, "utf8");
  const match = marker.match(/^gitdir:\s*(.+)\s*$/m);
  if (!match) {
    return {
      isRepo: false,
      hint: `.git file does not contain a gitdir pointer: ${markerPath}`
    };
  }

  const gitDir = path.resolve(repoRoot, match[1]);
  if (await pathExists(path.join(gitDir, "HEAD"))) {
    return { isRepo: true };
  }

  return {
    isRepo: false,
    hint: `.git file points to a gitdir without HEAD: ${gitDir}`
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runGit(runner: CommandRunner, repoRoot: string, args: string[]) {
  return runner.run("git", [...await buildSafeDirectoryArgs(repoRoot), ...args], { cwd: repoRoot });
}

async function buildSafeDirectoryArgs(repoRoot: string): Promise<string[]> {
  const safeDirs = new Set([repoRoot]);
  try {
    safeDirs.add(await fs.realpath(repoRoot));
  } catch {
    // The main Git command will return the actionable path error.
  }

  return [...safeDirs].flatMap((safeDir) => ["-c", `safe.directory=${safeDir}`]);
}
