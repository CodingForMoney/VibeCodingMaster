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
  isDirty(repoRoot: string): Promise<boolean>;
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
    async isDirty(repoRoot) {
      const result = await runGit(runner, repoRoot, ["status", "--porcelain"]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "GIT_ERROR",
          message: "Unable to read Git status.",
          statusCode: 400,
          hint: result.stderr
        });
      }

      return result.stdout.trim().length > 0;
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
