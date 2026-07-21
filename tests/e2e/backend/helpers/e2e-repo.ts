import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { renderVcmMemoryBlock } from "../../../../src/backend/templates/harness/memory-block.js";

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
  await fs.writeFile(path.join(repoRoot, ".gitignore"), ".ai/\n.claude/worktrees/\n", "utf8");
  await fs.mkdir(path.join(repoRoot, ".claude", "agents"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "CLAUDE.md"), memoryHost("CLAUDE"), "utf8");
  for (const role of ["project-manager", "architect", "coder", "tester", "gate-reviewer", "harness-engineer"]) {
    await fs.writeFile(path.join(repoRoot, ".claude", "agents", `${role}.md`), memoryHost(role), "utf8");
  }
  await git(repoRoot, "add", "README.md", ".gitignore", "CLAUDE.md", ".claude/agents");
  await git(repoRoot, "commit", "-m", "initial commit");
  return {
    repoRoot,
    tempRoot,
    async cleanup() {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  };
}

function memoryHost(title: string): string {
  return `# ${title}\n\n${renderVcmMemoryBlock()}\n\n<!-- VCM:BEGIN version=1 -->\nMock VCM rules.\n<!-- VCM:END -->\n`;
}

export async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd });
  return { stdout, stderr };
}
