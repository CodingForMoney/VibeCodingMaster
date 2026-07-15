import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface E2eRepo {
  repoRoot: string;
  tempRoot: string;
  cleanup(): Promise<void>;
}

export async function createE2eRepo(): Promise<E2eRepo> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vcm-e2e-repo-"));
  const repoRoot = path.join(tempRoot, "repo");
  await fs.mkdir(repoRoot, { recursive: true });
  await git(repoRoot, "init", "-b", "main");
  await git(repoRoot, "config", "user.email", "vcm-e2e@example.test");
  await git(repoRoot, "config", "user.name", "VCM E2E");
  await fs.writeFile(path.join(repoRoot, "README.md"), "# VCM E2E Repo\n", "utf8");
  await git(repoRoot, "add", "README.md");
  await git(repoRoot, "commit", "-m", "initial commit");
  return {
    repoRoot,
    tempRoot,
    async cleanup() {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  };
}

export async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd });
  return { stdout, stderr };
}
