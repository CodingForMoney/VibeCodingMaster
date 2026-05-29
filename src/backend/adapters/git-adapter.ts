import fs from "node:fs/promises";
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
      const result = await runGit(runner, repoRoot, ["rev-parse", "--is-inside-work-tree"]);
      return {
        isRepo: result.exitCode === 0 && result.stdout.trim() === "true",
        hint: result.exitCode === 0 ? undefined : formatGitHint(result.stderr)
      };
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

function formatGitHint(stderr: string): string | undefined {
  const hint = stderr.trim();
  if (!hint) {
    return undefined;
  }

  if (hint.includes("detected dubious ownership")) {
    return `${hint} If this is a devContainer mount, run inside the container: git config --global --add safe.directory <repo-path>`;
  }

  return hint;
}
