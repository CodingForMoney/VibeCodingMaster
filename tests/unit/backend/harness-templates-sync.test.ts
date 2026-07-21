import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createHarnessService } from "../../../src/backend/services/harness-service.js";
import { renderLegacyProjectCodingStandardsTemplate } from "../../../src/backend/templates/harness/project-coding-standards.js";

const execFileAsync = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const installerPath = path.join(appRoot, "scripts/install-vcm-harness.mjs");
const approvedExampleRoot = path.join(appRoot, "example/rust-layered");

const EXACT_EXAMPLE_HARNESS_PATHS = [
  ".ai/tools/check-durable-docs",
  ".ai/tools/generate-module-index",
  ".ai/tools/generate-public-surface",
  ".ai/tools/request-gate-review",
  ".ai/tools/update-task-state",
  ".ai/tools/check-scaffold-ledger",
  ".ai/tools/run-long-check",
  ".ai/tools/vcm-bash-guard",
  ".ai/tools/watch-job",
  ".claude/agents/architect.md",
  ".claude/agents/coder.md",
  ".claude/agents/gate-reviewer.md",
  ".claude/agents/harness-engineer.md",
  ".claude/agents/project-manager.md",
  ".claude/agents/tester.md",
  ".claude/agents/translator.md",
  ".claude/agents/vcm-coder-worker.md",
  ".claude/skills/vcm-architecture-interview/SKILL.md",
  ".claude/skills/vcm-final-acceptance/SKILL.md",
  ".claude/skills/vcm-gate-review/SKILL.md",
  ".claude/skills/vcm-harness-bootstrap/SKILL.md",
  ".claude/skills/vcm-long-running-validation/SKILL.md",
  ".claude/skills/vcm-report-harness-issue/SKILL.md",
  ".claude/skills/vcm-propose-memory/SKILL.md",
  ".claude/skills/vcm-route-message/SKILL.md",
  ".claude/skills/vcm-task-state/SKILL.md",
  ".github/pull_request_template.md",
  "docs/CODING_STANDARDS.md",
  "docs/GLOSSARY.md"
] as const;

let tmpRepo: string | undefined;

afterEach(async () => {
  if (tmpRepo) {
    await rm(tmpRepo, { recursive: true, force: true });
    tmpRepo = undefined;
  }
});

describe("harness templates stay in sync with the script installer", () => {
  it("renders fixed harness files from the approved rust-layered example", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-example-contract-"));
    await execFileAsync(process.execPath, [installerPath, tmpRepo]);

    for (const relativePath of EXACT_EXAMPLE_HARNESS_PATHS) {
      const approved = await readFile(path.join(approvedExampleRoot, relativePath), "utf8");
      const installed = await readFile(path.join(tmpRepo, relativePath), "utf8");
      expect(installed, `${relativePath}: installer must follow the approved example`).toBe(approved);
      if (relativePath !== "docs/GLOSSARY.md") {
        const selfHarness = await readFile(path.join(appRoot, relativePath), "utf8");
        expect(selfHarness, `${relativePath}: VCM self-harness must follow the approved example`).toBe(approved);
      }
    }

    for (const [relativePath, style] of [
      ["CLAUDE.md", "html"],
      ["docs/known-issues.md", "html"],
      [".gitignore", "hash"]
    ] as const) {
      const approved = extractManagedBlock(
        await readFile(path.join(approvedExampleRoot, relativePath), "utf8"),
        style
      );
      const installed = extractManagedBlock(await readFile(path.join(tmpRepo, relativePath), "utf8"), style);
      const selfHarness = extractManagedBlock(await readFile(path.join(appRoot, relativePath), "utf8"), style);
      expect(installed, `${relativePath}: installer managed block must follow the approved example`).toBe(approved);
      expect(selfHarness, `${relativePath}: VCM managed block must follow the approved example`).toBe(approved);
    }
  }, 30_000);

  it("reports every file as ok right after a fresh script install", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-harness-sync-"));
    await execFileAsync(process.execPath, [installerPath, tmpRepo]);

    const service = createHarnessService({ fs: createNodeFileSystemAdapter() });
    const status = await service.getHarnessStatus(tmpRepo);

    const drifted = status.files.filter((file) => file.action !== "ok");
    expect(
      drifted.map((file) => `${file.path}: ${file.action}`),
      "script installer output must exactly match the backend harness templates"
    ).toEqual([]);
    expect(status.needsApply).toBe(false);
  }, 30_000);

  it("migrates legacy managed documents without losing project content", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-managed-doc-migration-"));
    await mkdir(path.join(tmpRepo, "docs"), { recursive: true });
    await writeFile(path.join(tmpRepo, "docs/CODING_STANDARDS.md"), [
      renderLegacyProjectCodingStandardsTemplate().trimEnd(),
      "",
      "## Project Coding Standards",
      "",
      "- Use project formatting.",
      ""
    ].join("\n"), "utf8");
    await writeFile(
      path.join(tmpRepo, "docs/known-issues.md"),
      "# Known Issues\n\n## Existing Issue\n\nKeep this durable issue.\n",
      "utf8"
    );

    await execFileAsync(process.execPath, [installerPath, tmpRepo]);

    const codingStandards = await readFile(path.join(tmpRepo, "docs/CODING_STANDARDS.md"), "utf8");
    expect(codingStandards).toContain("<!-- VCM:BEGIN version=1 -->");
    expect(codingStandards).toContain("## Project Coding Standards\n\n- Use project formatting.");
    expect((codingStandards.match(/## Applies To/g) ?? [])).toHaveLength(1);

    const knownIssues = await readFile(path.join(tmpRepo, "docs/known-issues.md"), "utf8");
    expect(knownIssues).toContain("<!-- VCM:BEGIN version=1 -->");
    expect(knownIssues).toContain("## Existing Issue\n\nKeep this durable issue.");

    const manifest = JSON.parse(
      await readFile(path.join(tmpRepo, ".ai/vcm-harness-manifest.json"), "utf8")
    ) as { entries: Array<{ path: string; ownership: string }> };
    for (const filePath of ["docs/CODING_STANDARDS.md", "docs/known-issues.md"]) {
      expect(manifest.entries.find((entry) => entry.path === filePath)).toMatchObject({
        ownership: "managed-block"
      });
    }
  }, 30_000);

  it("does not rewrite the harness manifest for a version-only change", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-harness-manifest-"));
    await execFileAsync(process.execPath, [installerPath, tmpRepo]);
    const manifestPath = path.join(tmpRepo, ".ai/vcm-harness-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const staleManifest = {
      ...manifest,
      harnessVersion: "0.3.0-fixed"
    };
    await writeFile(manifestPath, `${JSON.stringify(staleManifest, null, 2)}\n`, "utf8");

    const { stdout } = await execFileAsync(process.execPath, [installerPath, tmpRepo]);
    const nextManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;

    expect(nextManifest.harnessVersion).toBe("0.3.0-fixed");
    expect(stdout).toContain("SKIP .ai/vcm-harness-manifest.json - version-only change ignored");
  }, 30_000);

  it("installs a Bash guard hook that survives stale CLAUDE_PROJECT_DIR and fails open when missing", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-harness-bash-hook-"));
    await execFileAsync(process.execPath, [installerPath, tmpRepo]);
    const childDir = path.join(tmpRepo, "nested", "cwd");
    await mkdir(childDir, { recursive: true });

    const settings = JSON.parse(await readFile(path.join(tmpRepo, ".claude/settings.json"), "utf8")) as {
      autoMemoryEnabled: boolean;
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.autoMemoryEnabled).toBe(false);
    const command = settings.hooks.PreToolUse[0]?.hooks[0]?.command;
    expect(command).toContain("git rev-parse --show-toplevel");
    expect(command).toContain("[ -n \"$guard\" ] || exit 0");

    const env = {
      ...process.env,
      VCM_TASK_SLUG: "demo-task",
      VCM_ROLE: "coder",
      CLAUDE_PROJECT_DIR: path.join(tmpRepo, ".claude", "worktrees", "removed")
    };
    const deniedOutput = execFileSync("sh", ["-c", command], {
      cwd: childDir,
      env,
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "sleep 100 &" } }),
      encoding: "utf8"
    });
    const denied = JSON.parse(deniedOutput) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");

    await unlink(path.join(tmpRepo, ".ai/tools/vcm-bash-guard"));
    const missingGuardOutput = execFileSync("sh", ["-c", command], {
      cwd: childDir,
      env,
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "sleep 100 &" } }),
      encoding: "utf8"
    });
    expect(missingGuardOutput).toBe("");
  }, 30_000);
});

function extractManagedBlock(content: string, style: "html" | "hash"): string {
  const pattern = style === "hash"
    ? /# VCM:BEGIN version=1[\s\S]*?# VCM:END/
    : /<!-- VCM:BEGIN version=1 -->[\s\S]*?<!-- VCM:END -->/;
  const match = content.match(pattern);
  if (!match) {
    throw new Error(`Missing ${style} VCM managed block.`);
  }
  return match[0];
}
