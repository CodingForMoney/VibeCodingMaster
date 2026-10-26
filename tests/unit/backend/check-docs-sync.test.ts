import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandRunner } from "../../../src/backend/adapters/command-runner.js";
import { createDocsCoverageCheck } from "../../../src/backend/services/docs-sync-check.js";

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

// Writes a complete architecture plan whose Docs Impact holds the given rows.
async function writePlan(root: string, rows: string[], planningResult = "complete") {
  await writeRepoFile(root, ".ai/vcm/handoffs/architecture-plan.md", [
    `Planning Result: ${planningResult}`,
    "",
    "## Docs Impact",
    "",
    "| Document | Change | Reason |",
    "| --- | --- | --- |",
    ...rows,
    ""
  ].join("\n"));
}

async function runTool(cwd: string, extraArgs: string[] = []) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(cwd, ".ai/tools/check-docs-sync"), "--json", ...extraArgs], { cwd });
    return { code: 0, ...JSON.parse(stdout) as { base?: string; skipped?: string; findings: Array<{ code: string; subject: string }> } };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, ...(failure.stdout ? JSON.parse(failure.stdout) : { findings: [] }), stderr: failure.stderr };
  }
}

function codes(result: { findings: Array<{ code: string; subject: string }> }) {
  return result.findings.map((finding) => [finding.code, finding.subject]);
}

describe("check-docs-sync", () => {
  it("passes when every touched module's doc changed or Docs Impact explains why not", async () => {
    const { base, task } = await createTaskWorktree();
    await writePlan(task, [
      "| `packages/core/ARCHITECTURE.md` | Document the new counter. | Behavior changes. |",
      "| `packages/api/ARCHITECTURE.md` | none | Only tests changed. |"
    ]);
    await writeRepoFile(task, "packages/core/src/index.ts", "export const core = 2;\n");
    await writeRepoFile(task, "packages/core/ARCHITECTURE.md", "# Core\n\nUpdated design.\n");
    await writeRepoFile(task, "packages/api/src/index.test.ts", "test\n");
    commit(task, "feat: change core");

    const result = await runTool(task);

    expect(result.code).toBe(0);
    // The base is the merge-base with the base repository's checked-out branch.
    expect(result.base).toBe(git(base, "rev-parse", "HEAD"));
    expect(result.findings).toEqual([]);
  });

  it("accepts an owning-doc update for a module Docs Impact does not list", async () => {
    const { task } = await createTaskWorktree();
    await writePlan(task, []);
    await writeRepoFile(task, "packages/api/src/index.ts", "export const api = 2;\n");
    await writeRepoFile(task, "packages/api/ARCHITECTURE.md", "# API\n\nRetry contract.\n");
    commit(task, "fix: retry api calls");

    expect((await runTool(task)).findings).toEqual([]);
  });

  it("reports uncovered modules, unexplained no-change rows, and planned docs the task never changed", async () => {
    const { task } = await createTaskWorktree();
    await writePlan(task, [
      "| `packages/core/ARCHITECTURE.md` | Document the new counter. | Behavior changes. |",
      "| `docs/ARCHITECTURE.md` | none | |"
    ]);
    await writeRepoFile(task, "packages/core/src/index.ts", "export const core = 2;\n");
    await writeRepoFile(task, "packages/api/src/index.ts", "export const api = 2;\n");
    commit(task, "feat: change both modules");

    const result = await runTool(task);

    expect(result.code).toBe(1);
    expect(codes(result)).toEqual([
      ["DS_MODULE_NOT_COVERED", "packages/api"],
      ["DS_PLANNED_DOC_NOT_CHANGED", "packages/core/ARCHITECTURE.md"],
      ["DS_UNCHANGED_WITHOUT_REASON", "docs/ARCHITECTURE.md"]
    ]);
  });

  it("skips a task without a complete architecture plan", async () => {
    const { task } = await createTaskWorktree();
    await writeRepoFile(task, "packages/api/src/index.ts", "export const api = 2;\n");
    commit(task, "fix: debug repair");

    const missing = await runTool(task);
    expect(missing).toMatchObject({ code: 0, findings: [] });
    expect(missing.skipped).toContain("architecture-plan.md");

    await writePlan(task, [], "incomplete");
    expect(await runTool(task)).toMatchObject({ code: 0, findings: [] });
  });

  it("treats a repository without a module index as one module owned by docs/ARCHITECTURE.md", async () => {
    const { task } = await createTaskWorktree();
    await rm(path.join(task, ".ai/generated/module-index.json"));
    commit(task, "chore: project without a module index");
    await writeRepoFile(task, "app.py", "print(2)\n");
    commit(task, "feat: change app");

    await writePlan(task, ["| `packages/api/ARCHITECTURE.md` | none | Not touched. |"]);
    expect(codes(await runTool(task))).toEqual([["DS_MODULE_NOT_COVERED", "."]]);

    await writePlan(task, ["| `docs/ARCHITECTURE.md` | none | Internal change only. |"]);
    const covered = await runTool(task);
    expect(covered.code).toBe(0);
    expect(covered.findings).toEqual([]);
  });

  it("lets the backend refuse the code-diff Gate with the tool's findings", async () => {
    const { task } = await createTaskWorktree();
    await writeRepoFile(task, "packages/api/src/index.ts", "export const api = 2;\n");
    commit(task, "feat: change api");
    const check = createDocsCoverageCheck(createCommandRunner());

    await writePlan(task, ["| `packages/api/ARCHITECTURE.md` | none | Internal refactor. |"]);
    await expect(check(task)).resolves.toEqual([]);
    await writePlan(task, ["| `packages/core/ARCHITECTURE.md` | none | Not touched. |"]);
    expect(await check(task)).toEqual([expect.stringContaining("DS_MODULE_NOT_COVERED packages/api")]);
    // A worktree whose harness predates the tool is not checked.
    await rm(path.join(task, ".ai/tools/check-docs-sync"));
    await expect(check(task)).resolves.toEqual([]);
  });
});
