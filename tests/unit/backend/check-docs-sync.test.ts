import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandRunner } from "../../../src/backend/adapters/command-runner.js";
import { createDocsSyncCheck } from "../../../src/backend/services/docs-sync-check.js";

const execFileAsync = promisify(execFile);
const toolSource = path.join(process.cwd(), "scripts/harness-tools/check-docs-sync");

let tmpRoot: string | undefined;

afterEach(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function writeRepoFile(root: string, relative: string, content: string) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), content);
}

function commit(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

// A base repository with two modules and a task worktree branched from it.
async function createTaskWorktree() {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "vcm-docs-sync-"));
  const base = path.join(tmpRoot, "base");
  await mkdir(base);
  git(base, "init", "-q", "-b", "main");
  await writeRepoFile(base, ".ai/generated/module-index.json", JSON.stringify({
    layers: [{
      name: "packages",
      modules: [
        { name: "@demo/core", path: "packages/core", architectureDoc: "packages/core/ARCHITECTURE.md" },
        { name: "@demo/api", path: "packages/api", architectureDoc: "packages/api/ARCHITECTURE.md" }
      ]
    }]
  }));
  await writeRepoFile(base, ".ai/tools/check-docs-sync", await readFile(toolSource, "utf8"));
  await writeRepoFile(base, ".ai/tools/package.json", "{\"type\":\"commonjs\"}\n");
  await writeRepoFile(base, "packages/core/src/index.ts", "export const core = 1;\n");
  await writeRepoFile(base, "packages/core/ARCHITECTURE.md", "# Core\n");
  await writeRepoFile(base, "packages/api/src/index.ts", "export const api = 1;\n");
  await writeRepoFile(base, "packages/api/ARCHITECTURE.md", "# API\n");
  await writeRepoFile(base, ".gitignore", ".ai/vcm/\n");
  commit(base, "init");
  const task = path.join(tmpRoot, "task");
  git(base, "worktree", "add", "-q", "-b", "feature/demo", task);
  return { base, task };
}

function report(coverage: string, commits = "None.") {
  return [
    "# Docs Sync Report: demo",
    "",
    "## Module Coverage",
    "",
    "| Module | Owning Doc | Status | Reason |",
    "| --- | --- | --- | --- |",
    coverage,
    "",
    "## Reconciliation Commits",
    "",
    commits,
    "",
    "## Decision",
    "",
    "synced",
    ""
  ].join("\n");
}

async function runTool(cwd: string, reportContent: string, extraArgs: string[] = []) {
  const reportPath = path.join(cwd, ".ai/vcm/handoffs/docs-sync-report.md");
  await writeRepoFile(cwd, ".ai/vcm/handoffs/docs-sync-report.md", reportContent);
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(cwd, ".ai/tools/check-docs-sync"), "--json", "--report", reportPath, ...extraArgs], { cwd });
    return { code: 0, ...JSON.parse(stdout) as { base: string; findings: Array<{ code: string; subject: string }> } };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, ...(failure.stdout ? JSON.parse(failure.stdout) : { findings: [] }), stderr: failure.stderr };
  }
}

describe("check-docs-sync", () => {
  it("passes when every touched module is covered and reconciliation changes only docs", async () => {
    const { base, task } = await createTaskWorktree();
    await writeRepoFile(task, "packages/core/src/index.ts", "export const core = 2;\n");
    await writeRepoFile(task, "packages/api/src/index.test.ts", "test\n");
    commit(task, "feat: change core");
    await writeRepoFile(task, "packages/core/ARCHITECTURE.md", "# Core\n\nUpdated design.\n");
    const reconciliation = commit(task, "docs: reconcile core");

    const result = await runTool(task, report([
      "| @demo/core | packages/core/ARCHITECTURE.md | updated | |",
      "| packages/api | packages/api/ARCHITECTURE.md | unchanged | Only tests changed. |"
    ].join("\n"), reconciliation.slice(0, 7)));

    expect(result.code).toBe(0);
    // The base is the merge-base with the base repository's checked-out branch.
    expect(result.base).toBe(git(base, "rev-parse", "HEAD"));
    expect(result.findings).toEqual([]);
  });

  it("reports uncovered modules, docs claimed updated but unchanged, and non-doc reconciliation commits", async () => {
    const { task } = await createTaskWorktree();
    await writeRepoFile(task, "packages/core/src/index.ts", "export const core = 2;\n");
    await writeRepoFile(task, "packages/api/src/index.ts", "export const api = 2;\n");
    commit(task, "feat: change both modules");
    await writeRepoFile(task, "packages/core/src/extra.ts", "export const extra = 1;\n");
    const reconciliation = commit(task, "docs: reconcile");

    const result = await runTool(task, report(
      "| @demo/core | packages/core/ARCHITECTURE.md | updated | |",
      `${reconciliation}\n0000000`
    ));

    expect(result.code).toBe(1);
    expect(result.findings.map((finding: { code: string; subject: string }) => [finding.code, finding.subject])).toEqual([
      ["DS_DOC_NOT_UPDATED", "packages/core/ARCHITECTURE.md"],
      ["DS_MODULE_NOT_COVERED", "packages/api"],
      ["DS_RECONCILIATION_NON_DOC", "packages/core/src/extra.ts"],
      ["DS_UNKNOWN_COMMIT", "0000000"]
    ]);
  });

  it("reports a document the plan's Docs Impact changed that the task never changed", async () => {
    const { task } = await createTaskWorktree();
    await writeRepoFile(task, ".ai/vcm/handoffs/architecture-plan.md", [
      "## Docs Impact",
      "",
      "| Document | Change | Reason |",
      "| --- | --- | --- |",
      "| `packages/api/ARCHITECTURE.md` | Document the new retry contract. | Contract changes. |",
      "| `packages/core/ARCHITECTURE.md` | none | No owned fact changes. |",
      ""
    ].join("\n"));
    await writeRepoFile(task, "packages/api/src/index.ts", "export const api = 2;\n");
    commit(task, "feat: change api");

    const result = await runTool(task, report("| @demo/api | packages/api/ARCHITECTURE.md | unchanged | Retry is internal. |"));

    expect(result.findings.map((finding: { code: string }) => finding.code)).toEqual(["DS_PLANNED_DOC_NOT_CHANGED"]);
  });

  it("lets the backend reject a docs-sync report with the tool's findings", async () => {
    const { task } = await createTaskWorktree();
    await writeRepoFile(task, "packages/api/src/index.ts", "export const api = 2;\n");
    commit(task, "feat: change api");
    const check = createDocsSyncCheck(createCommandRunner());

    await expect(check(task, report("| @demo/api | packages/api/ARCHITECTURE.md | unchanged | Internal refactor. |")))
      .resolves.toEqual([]);
    const errors = await check(task, report("| @demo/core | packages/core/ARCHITECTURE.md | unchanged | Not touched. |"));
    expect(errors).toEqual([expect.stringContaining("DS_MODULE_NOT_COVERED packages/api")]);
    // A worktree whose harness predates the tool is not checked.
    await rm(path.join(task, ".ai/tools/check-docs-sync"));
    await expect(check(task, report(""))).resolves.toEqual([]);
  });
});
