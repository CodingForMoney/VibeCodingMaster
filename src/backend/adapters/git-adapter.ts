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
  getDiff(repoRoot: string, baseRef: string, headRef?: string | null, paths?: string[]): Promise<string>;
  getChangedPaths(repoRoot: string, baseRef: string, headRef?: string | null): Promise<string[]>;
  getCommitList(repoRoot: string, range: string): Promise<GitCommitInfo[]>;
  getMergeBase(repoRoot: string, leftRef: string, rightRef: string): Promise<string>;
  isIgnored(repoRoot: string, repoRelativePath: string): Promise<boolean>;
  branchExists(repoRoot: string, branch: string): Promise<boolean>;
  isWorktreeRegistered(repoRoot: string, worktreePath: string): Promise<boolean>;
  pruneWorktrees(repoRoot: string): Promise<void>;
  mergeBranchFastForward(repoRoot: string, branch: string): Promise<GitMergeResult>;
  addPaths(repoRoot: string, paths: string[]): Promise<void>;
  commit(repoRoot: string, message: string): Promise<string>;
  commitPaths(repoRoot: string, message: string, paths: string[]): Promise<string>;
  resolveCommitIdentity(repoRoot: string): Promise<GitCommitIdentity>;
  createWorktree(input: CreateGitWorktreeInput): Promise<void>;
  removeWorktree(repoRoot: string, worktreePath: string, options?: { force?: boolean }): Promise<void>;
  deleteBranch(repoRoot: string, branch: string, options?: { force?: boolean }): Promise<void>;
  pullFastForward(repoRoot: string): Promise<GitPullResult>;
  // Contacts the current branch's upstream remote the way a pull would, but
  // without prompting, to tell whether its credentials work.
  checkRemoteAccess(repoRoot: string): Promise<GitRemoteAccess>;
}

export type GitRemoteAccess =
  | { status: "ok"; remote: string }
  | { status: "skipped" }
  | { status: "failed"; remote: string; detail: string };

// Network Git commands run without a terminal prompt: VCM is driven from the
// browser, so a credential prompt would hang the request on the terminal that
// started VCM instead of failing with an error the UI can show.
const REMOTE_COMMAND_TIMEOUT_MS = 20 * 1000;
const PULL_TIMEOUT_MS = 5 * 60 * 1000;

// Commit identity used when neither Git config nor the environment provides one.
// Without it, Git either refuses to commit or invents an identity from the OS
// account and hostname, which silently attributes commits to a machine name.
export const DEFAULT_GIT_IDENTITY = { name: "VCM", email: "vcm@localhost" } as const;

const GIT_IDENTITY_CACHE_TTL_MS = 30 * 1000;

export interface GitCommitIdentity {
  name: string;
  email: string;
  // Identity parts filled from DEFAULT_GIT_IDENTITY.
  defaulted: Array<"name" | "email">;
  // GIT_AUTHOR_* and GIT_COMMITTER_* values for the defaulted parts only, so
  // configured identities, including repository and includeIf ones, still win.
  env: NodeJS.ProcessEnv;
}

export function renderGitIdentityWarning(location: string, identity: GitCommitIdentity): string {
  const missing = identity.defaulted.map((part) => `user.${part}`).join(" and ");
  return `Git ${missing} is not configured for ${location}, so VCM and role commits use ${identity.name} <${identity.email}>. `
    + "Set your own identity in the environment that runs VCM: "
    + "git config --global user.name \"<name>\" and git config --global user.email \"<email>\".";
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
  const identityCache = new Map<string, { checkedAt: number; identity: GitCommitIdentity }>();

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
    async getDiff(repoRoot, baseRef, headRef = null, paths = []) {
      const result = await runGit(runner, repoRoot, [
        "diff",
        "--no-ext-diff",
        "--binary",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        baseRef,
        ...(headRef ? [headRef] : []),
        "--",
        ...paths
      ]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_ERROR",
          message: "Unable to read Git diff.",
          statusCode: 400,
          hint: result.stderr
        });
      }

      return result.stdout;
    },
    async getChangedPaths(repoRoot, baseRef, headRef = null) {
      const result = await runGit(runner, repoRoot, [
        "diff",
        "--name-only",
        "-z",
        baseRef,
        ...(headRef ? [headRef] : [])
      ]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_ERROR",
          message: "Unable to read changed Git paths.",
          statusCode: 400,
          hint: result.stderr
        });
      }

      return result.stdout
        .split("\0")
        .map((changedPath) => changedPath.trim())
        .filter(Boolean);
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
    async isWorktreeRegistered(repoRoot, worktreePath) {
      const result = await runGit(runner, repoRoot, ["worktree", "list", "--porcelain"]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_ERROR",
          message: "Unable to list Git worktrees.",
          statusCode: 400,
          hint: result.stderr
        });
      }

      const expectedPath = await normalizeWorktreePath(worktreePath);
      for (const candidate of parseWorktreePaths(result.stdout)) {
        if (await normalizeWorktreePath(candidate) === expectedPath) {
          return true;
        }
      }
      return false;
    },
    async pruneWorktrees(repoRoot) {
      const result = await runGit(runner, repoRoot, ["worktree", "prune"]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_WORKTREE_PRUNE_FAILED",
          message: "Unable to prune Git worktree metadata.",
          statusCode: 400,
          hint: result.stderr
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
          hint: result.stderr || result.stdout || "Rebase the task branch onto the connected repository branch, then try again."
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
      const result = await runGit(runner, repoRoot, ["commit", "-m", message], (await this.resolveCommitIdentity(repoRoot)).env);
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
    async commitPaths(repoRoot, message, paths) {
      if (paths.length === 0) {
        return this.getHeadCommit(repoRoot);
      }
      const result = await runGit(
        runner,
        repoRoot,
        ["commit", "--only", "-m", message, "--", ...paths],
        (await this.resolveCommitIdentity(repoRoot)).env
      );
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_COMMIT_FAILED",
          message: "Unable to commit VCM memory changes.",
          statusCode: 409,
          hint: result.stderr || result.stdout
        });
      }

      return this.getHeadCommit(repoRoot);
    },
    async resolveCommitIdentity(repoRoot) {
      const cached = identityCache.get(repoRoot);
      if (cached && Date.now() - cached.checkedAt < GIT_IDENTITY_CACHE_TTL_MS) {
        return cached.identity;
      }
      const identity: GitCommitIdentity = { name: "", email: "", defaulted: [], env: {} };
      for (const part of ["name", "email"] as const) {
        const result = await runGit(runner, repoRoot, ["config", "--get", `user.${part}`]);
        const configured = result.exitCode === 0 ? result.stdout.trim() : "";
        const variables = [`GIT_AUTHOR_${part.toUpperCase()}`, `GIT_COMMITTER_${part.toUpperCase()}`];
        for (const variable of variables) {
          if (!configured && !process.env[variable]) {
            identity.env[variable] = DEFAULT_GIT_IDENTITY[part];
          }
        }
        if (variables.some((variable) => identity.env[variable])) {
          identity.defaulted.push(part);
        }
        identity[part] = process.env[variables[0]!] || configured || DEFAULT_GIT_IDENTITY[part];
      }
      identityCache.set(repoRoot, { checkedAt: Date.now(), identity });
      return identity;
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
      const result = await runGit(runner, repoRoot, ["pull", "--ff-only"], await buildNonInteractiveGitEnv(runner, repoRoot), PULL_TIMEOUT_MS);
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
    },
    async checkRemoteAccess(repoRoot) {
      const branch = (await runGit(runner, repoRoot, ["branch", "--show-current"])).stdout.trim();
      if (!branch) {
        return { status: "skipped" };
      }
      const remoteResult = await runGit(runner, repoRoot, ["config", "--get", `branch.${branch}.remote`]);
      const remote = remoteResult.stdout.trim();
      if (remoteResult.exitCode !== 0 || !remote || remote === ".") {
        return { status: "skipped" };
      }
      const result = await runGit(
        runner,
        repoRoot,
        ["ls-remote", remote, "HEAD"],
        await buildNonInteractiveGitEnv(runner, repoRoot),
        REMOTE_COMMAND_TIMEOUT_MS
      );
      if (result.exitCode === 0) {
        return { status: "ok", remote };
      }
      return {
        status: "failed",
        remote,
        detail: firstMeaningfulLine(result.stderr) || firstMeaningfulLine(result.stdout) || `git ls-remote exited with ${result.exitCode}`
      };
    }
  };
}

async function buildNonInteractiveGitEnv(runner: CommandRunner, repoRoot: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never"
  };
  // Keep a configured SSH command; otherwise make ssh fail instead of asking
  // for a passphrase or host-key confirmation.
  if (!process.env.GIT_SSH_COMMAND && !process.env.GIT_SSH) {
    const configured = await runGit(runner, repoRoot, ["config", "--get", "core.sshCommand"]);
    if (configured.exitCode !== 0 || !configured.stdout.trim()) {
      env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
    }
  }
  return { ...process.env, ...env };
}

function firstMeaningfulLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
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

async function runGit(runner: CommandRunner, repoRoot: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number) {
  return runner.run("git", [...await buildSafeDirectoryArgs(repoRoot), ...args], { cwd: repoRoot, env, timeoutMs });
}

function parseWorktreePaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean);
}

async function normalizeWorktreePath(worktreePath: string): Promise<string> {
  try {
    return path.resolve(await fs.realpath(worktreePath));
  } catch {
    return path.resolve(worktreePath);
  }
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
