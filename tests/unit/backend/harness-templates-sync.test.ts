import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createHarnessService } from "../../../src/backend/services/harness-service.js";

const execFileAsync = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const installerPath = path.join(appRoot, "scripts/install-vcm-harness.mjs");

let tmpRepo: string | undefined;

afterEach(async () => {
  if (tmpRepo) {
    await rm(tmpRepo, { recursive: true, force: true });
    tmpRepo = undefined;
  }
});

describe("harness templates stay in sync with the script installer", () => {
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
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
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
