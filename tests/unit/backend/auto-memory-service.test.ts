import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createAutoMemoryService } from "../../../src/backend/services/auto-memory-service.js";
import { createDefaultLaunchTemplate } from "../../../src/shared/types/app-settings.js";
import type { RoleName } from "../../../src/shared/types/role.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import { renderFinalAcceptanceTemplate } from "../../../src/backend/templates/handoff.js";

describe("auto-memory-service", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("applies manual memory edits to canonical and task memory and can revert them", async () => {
    const context = await createContext(false);
    const service = context.service;
    await service.ensureTaskSnapshot(context.baseRepoRoot, context.taskRepoRoot);
    await expect(service.getTaskRetrospectiveReadiness({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      handoffDir: ".ai/vcm/handoffs",
      roundReady: true
    })).resolves.toEqual({ ready: true, disposition: "disabled" });

    const state = await service.updateFile(
      context.baseRepoRoot,
      context.taskRepoRoot,
      "demo",
      ".ai/vcm/memory/shared.md",
      "# Shared Memory\n\nUse the project event bus for lifecycle notifications.\n"
    );

    expect(await readText(context.baseRepoRoot, ".ai/vcm/memory/shared.md")).toContain("project event bus");
    expect(await readText(context.taskRepoRoot, ".ai/vcm/memory/shared.md")).toContain("project event bus");
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].canRevert).toBe(true);

    const reverted = await service.revertRun(context.baseRepoRoot, context.taskRepoRoot, state.runs[0].runId);
    expect(await readText(context.baseRepoRoot, ".ai/vcm/memory/shared.md")).toContain("No accumulated project memory yet");
    expect(reverted.runs[0].status).toBe("reverted");
  });

  it("collects role drafts sequentially and applies Harness Engineer reviewed memory", async () => {
    const context = await createContext(true);
    const finalAcceptancePath = path.join(context.taskRepoRoot, ".ai/vcm/handoffs/final-acceptance.md");
    await mkdir(path.dirname(finalAcceptancePath), { recursive: true });
    await writeFile(
      finalAcceptancePath,
      renderFinalAcceptanceTemplate("demo")
        .replaceAll("TBD", "None.")
        .replace("## Decision\n\nNone.", "## Decision\n\naccepted"),
      "utf8"
    );

    await expect(context.service.getTaskRetrospectiveReadiness({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      handoffDir: ".ai/vcm/handoffs",
      roundReady: true
    })).resolves.toMatchObject({ ready: false, disposition: "pending" });

    let state = await context.service.reconcileTask({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      handoffDir: ".ai/vcm/handoffs",
      roundReady: true
    });
    expect(state.status).toBe("collecting");
    expect(state.active?.currentRole).toBe("project-manager");

    for (const role of ["project-manager", "architect", "coder", "tester"] as const) {
      state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
      const draft = state.active?.drafts.find((item) => item.role === role);
      expect(draft).toBeDefined();
      await mkdir(path.dirname(path.join(context.taskRepoRoot, draft!.path)), { recursive: true });
      await writeFile(path.join(context.taskRepoRoot, draft!.path), "# Memory Draft\n\nDecision: no-change\n", "utf8");
      await context.service.handleRoleHook({
        baseRepoRoot: context.baseRepoRoot,
        taskRepoRoot: context.taskRepoRoot,
        taskSlug: "demo",
        role,
        eventName: "Stop"
      });
    }

    state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.status).toBe("reviewing");
    const reviewedSharedPath = path.join(
      context.taskRepoRoot,
      ".ai/vcm/memory-review/runs",
      state.active!.runId,
      "after/shared.md"
    );
    await writeFile(reviewedSharedPath, "# Shared Memory\n\nLifecycle completion is owned by backend hooks.\n", "utf8");
    await context.service.handleHarnessEngineerHook({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      eventName: "Stop"
    });

    state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.status).toBe("idle");
    expect(state.runs[0].status).toBe("applied");
    expect(state.runs[0].diff).toContain("Lifecycle completion is owned by backend hooks");
    expect(await readText(context.baseRepoRoot, ".ai/vcm/memory/shared.md")).toContain("Lifecycle completion is owned by backend hooks");
    expect(context.terminalWrites.some((entry) => entry.includes("[VCM Auto Memory Review]"))).toBe(true);
    await expect(context.service.getTaskRetrospectiveReadiness({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      handoffDir: ".ai/vcm/handoffs",
      roundReady: true
    })).resolves.toEqual({ ready: true, disposition: "completed" });

    await writeFile(
      finalAcceptancePath,
      `${await readFile(finalAcceptancePath, "utf8")}\nUpdated acceptance evidence.\n`,
      "utf8"
    );
    await expect(context.service.getTaskRetrospectiveReadiness({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      handoffDir: ".ai/vcm/handoffs",
      roundReady: true
    })).resolves.toMatchObject({ ready: false, disposition: "pending" });
  });

  async function createContext(autoMemoryEnabled: boolean) {
    root = await mkdtemp(path.join(os.tmpdir(), "vcm-auto-memory-"));
    const baseRepoRoot = path.join(root, "repo");
    const taskRepoRoot = path.join(root, "task");
    await mkdir(baseRepoRoot, { recursive: true });
    await mkdir(taskRepoRoot, { recursive: true });
    const terminalWrites: string[] = [];
    const sessionFor = (role: RoleName): RoleSessionRecord => ({
      id: `session-${role}`,
      claudeSessionId: `claude-${role}`,
      taskSlug: "demo",
      role,
      status: "running",
      activityStatus: "idle",
      command: "claude",
      permissionMode: "bypassPermissions",
      model: "default",
      effort: "default",
      cwd: taskRepoRoot,
      terminalBackend: "node-pty",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });
    const service = createAutoMemoryService({
      fs: createNodeFileSystemAdapter(),
      runtime: {
        getSession() {
          return {} as never;
        },
        write(_sessionId, data) {
          terminalWrites.push(data);
        }
      },
      sessionService: {
        async getRoleSession(_repoRoot, _taskSlug, role) {
          return sessionFor(role);
        },
        async startRoleSession(_repoRoot, _taskSlug, role) {
          return sessionFor(role);
        },
        async resumeRoleSession(_repoRoot, _taskSlug, role) {
          return sessionFor(role);
        },
        async getProjectHarnessEngineerSession() {
          return sessionFor("harness-engineer");
        },
        async ensureProjectHarnessEngineerSession() {
          return sessionFor("harness-engineer");
        }
      },
      appSettings: {
        async getPreferences() {
          return {
            themeMode: "system",
            flowPauseAlerts: true,
            roleRetryEnabled: true,
            permissionRequestMode: "off",
            autoTaskHarnessReviewEnabled: false,
            autoMemoryEnabled,
            translationEnabled: false,
            translationAutoSendEnabled: false,
            translationTargetLanguage: "zh-CN",
            translationOutputMode: "pm-final-only",
            launchTemplate: createDefaultLaunchTemplate()
          };
        },
        async getGateReviewSettings() {
          return { enabled: false, requiredGates: [] };
        }
      },
      async isHarnessEngineerAvailable() {
        return true;
      },
      now: () => "2026-07-11T00:00:00.000Z"
    });
    return { baseRepoRoot, taskRepoRoot, terminalWrites, service };
  }
});

async function readText(repoRoot: string, relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}
