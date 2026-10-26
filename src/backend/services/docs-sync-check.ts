import fs from "node:fs";
import path from "node:path";
import type { CommandRunner } from "../adapters/command-runner.js";

const DOCS_SYNC_TOOL = ".ai/tools/check-docs-sync";
const DOCS_SYNC_TIMEOUT_MS = 60_000;

interface DocsSyncFinding {
  code: string;
  subject: string;
  message: string;
}

// Runs the task worktree's check-docs-sync, which compares the task's commits
// with the architecture plan's Docs Impact, and returns one error per finding.
// A worktree whose harness predates the tool is not checked.
export function createDocsCoverageCheck(runner: CommandRunner) {
  return async (taskRepoRoot: string): Promise<string[]> => {
    const tool = path.join(taskRepoRoot, DOCS_SYNC_TOOL);
    if (!fs.existsSync(tool)) {
      return [];
    }
    const result = await runner.run(process.execPath, [tool, "--json"], {
      cwd: taskRepoRoot,
      timeoutMs: DOCS_SYNC_TIMEOUT_MS
    });
    if (result.exitCode === 0) {
      return [];
    }
    try {
      const parsed = JSON.parse(result.stdout) as { findings?: DocsSyncFinding[] };
      if (result.exitCode === 1 && Array.isArray(parsed.findings) && parsed.findings.length > 0) {
        return parsed.findings.map((finding) => `${finding.code} ${finding.subject}: ${finding.message}`);
      }
    } catch {
      // Fall through to the raw tool error below.
    }
    return [`${DOCS_SYNC_TOOL} could not check the task: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`];
  };
}
