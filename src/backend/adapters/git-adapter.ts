import { VcmError } from "../errors.js";
import type { CommandRunner } from "./command-runner.js";

export interface GitAdapter {
  isRepo(repoRoot: string): Promise<boolean>;
  getCurrentBranch(repoRoot: string): Promise<string>;
  isDirty(repoRoot: string): Promise<boolean>;
}

export function createGitAdapter(runner: CommandRunner): GitAdapter {
  return {
    async isRepo(repoRoot) {
      const result = await runner.run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot });
      return result.exitCode === 0 && result.stdout.trim() === "true";
    },
    async getCurrentBranch(repoRoot) {
      const result = await runner.run("git", ["branch", "--show-current"], { cwd: repoRoot });
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
      const result = await runner.run("git", ["status", "--porcelain"], { cwd: repoRoot });
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
