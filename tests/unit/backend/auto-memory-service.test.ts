import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createAutoMemoryService } from "../../../src/backend/services/auto-memory-service.js";
import {
  renderVcmMemoryBlock,
  replaceVcmMemoryBlock
} from "../../../src/backend/templates/harness/memory-block.js";
import {
  createDefaultLaunchTemplate,
  createDefaultToolSessionDefaults
} from "../../../src/shared/types/app-settings.js";
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

  it("commits manual memory block edits in the task worktree and can revert them", async () => {
    const context = await createContext(false);
    const service = context.service;
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
      "CLAUDE.md",
      "Use the project event bus for lifecycle notifications.\n"
    );

    expect(await readText(context.taskRepoRoot, "CLAUDE.md")).toContain("project event bus");
    await expect(readText(context.baseRepoRoot, "CLAUDE.md")).rejects.toThrow();
    expect(context.gitCommits).toEqual([{ message: "chore: update VCM memory", paths: ["CLAUDE.md"] }]);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].canRevert).toBe(true);

    const reverted = await service.revertRun(context.baseRepoRoot, context.taskRepoRoot, state.runs[0].runId);
    expect(await readText(context.taskRepoRoot, "CLAUDE.md")).toContain("No accumulated project memory yet");
    expect(context.gitCommits.at(-1)).toEqual({ message: "chore: revert VCM memory", paths: ["CLAUDE.md"] });
    expect(reverted.runs[0].status).toBe("reverted");
  });

  it("collects role drafts before retrospective and applies its reviewed memory", async () => {
    const context = await createContext(true);
    const sharedMemoryHostPath = path.join(context.taskRepoRoot, "CLAUDE.md");
    await writeFile(
      sharedMemoryHostPath,
      replaceVcmMemoryBlock(
        await readFile(sharedMemoryHostPath, "utf8"),
        "Lifecycle completion is inferred by each client.\n"
      ),
      "utf8"
    );
    const planningCandidatePath = path.join(
      context.taskRepoRoot,
      ".ai/vcm/memory-review/candidates/architect/planning.md"
    );
    await mkdir(path.dirname(planningCandidatePath), { recursive: true });
    await writeFile(planningCandidatePath, [
      "# Memory Proposal",
      "Decision: update",
      "",
      "## Add",
      "### Item 1",
      "Target: shared",
      "Content: Planning discovered backend-owned lifecycle state.",
      "Reason: Workflow roles need the lifecycle owner across future tasks.",
      "Impact if absent: Roles may infer lifecycle completion independently.",
      "Durable doc disposition: memory",
      "Durable doc path: none",
      "Evidence: .ai/vcm/handoffs/architecture-evidence.md",
      "",
      "## Update",
      "none",
      "",
      "## Remove",
      "none",
      ""
    ].join("\n"), "utf8");
    const finalAcceptancePath = path.join(context.taskRepoRoot, ".ai/vcm/handoffs/final-acceptance.md");
    await mkdir(path.dirname(finalAcceptancePath), { recursive: true });
    await writeFile(
      finalAcceptancePath,
      renderFinalAcceptanceTemplate("demo")
        .replaceAll("TBD", "None.")
        .replace(
          "accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|needs-docs-sync|blocked-by-user-decision",
          "accepted"
        ),
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
    expect(state.status).toBe("idle");
    expect(context.terminalWrites).toHaveLength(0);

    state = await context.service.reconcileTask({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      handoffDir: ".ai/vcm/handoffs",
      roundReady: true,
      requestTrigger: "manual"
    });
    expect(state.status).toBe("collecting");
    expect(state.active?.currentRole).toBe("project-manager");
    expect(state.active?.trigger).toBe("manual");
    expect(state.active?.drafts[0]).toMatchObject({
      role: "project-manager",
      status: "dispatched"
    });
    const planningCandidateSnapshot = path.join(
      context.taskRepoRoot,
      ".ai/vcm/memory-review/runs",
      state.active!.runId,
      "sources/architect-planning.md"
    );
    await expect(readFile(planningCandidateSnapshot, "utf8")).resolves.toContain(
      "Planning discovered backend-owned lifecycle state."
    );

    const activeStatePath = path.join(context.taskRepoRoot, ".ai/vcm/memory-review/state.json");
    const legacyState = JSON.parse(await readFile(activeStatePath, "utf8")) as {
      drafts: Array<{ status: string }>;
    };
    legacyState.drafts[0].status = "running";
    await writeFile(activeStatePath, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");
    state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.active?.drafts[0].status).toBe("dispatched");
    await expect(readFile(activeStatePath, "utf8")).resolves.toContain('"status": "dispatched"');

    for (const role of ["project-manager", "architect", "coder", "tester"] as const) {
      state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
      const draft = state.active?.drafts.find((item) => item.role === role);
      expect(draft).toBeDefined();
      if (role === "architect") {
        const writes = context.terminalWrites.join("");
        expect(writes).toContain(planningCandidateSnapshot);
        expect(writes).toContain(
          "Carry forward only facts that remain verified after implementation and testing."
        );
      }
      await mkdir(path.dirname(path.join(context.taskRepoRoot, draft!.path)), { recursive: true });
      await writeFile(
        path.join(context.taskRepoRoot, draft!.path),
        noChangeMemoryProposal(),
        "utf8"
      );
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
    expect(context.terminalWrites.join("")).toContain(planningCandidateSnapshot);
    expect(context.terminalWrites.join("")).not.toContain("[VCM Task Harness Review: Memory Review]");
    await expect(context.service.getTaskRetrospectiveReadiness({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      handoffDir: ".ai/vcm/handoffs",
      roundReady: true
    })).resolves.toEqual({ ready: true, disposition: "reviewing", trigger: "manual" });
    const retrospectiveReportPath = path.join(
      context.baseRepoRoot,
      ".ai/vcm/harness-feedback/task-retrospectives/demo.md"
    );
    const memoryReview = await context.service.prepareTaskRetrospectiveReview(
      context.taskRepoRoot,
      retrospectiveReportPath
    );
    expect(memoryReview).toMatchObject({
      runId: state.active!.runId,
      planningCandidatePath: planningCandidateSnapshot
    });
    expect(memoryReview?.roleDraftsPath).toContain(`${state.active!.runId}/drafts`);
    expect(memoryReview?.currentMemoryPath).toContain(`${state.active!.runId}/before`);
    expect(memoryReview?.reviewedMemoryPath).toContain(`${state.active!.runId}/after`);
    const reviewedSharedPath = path.join(
      memoryReview!.reviewedMemoryPath,
      "CLAUDE.md"
    );
    await mkdir(path.dirname(retrospectiveReportPath), { recursive: true });
    await writeFile(
      retrospectiveReportPath,
      memoryReviewReport(["project-manager", "architect", "coder", "tester"]),
      "utf8"
    );
    await writeFile(reviewedSharedPath, "Lifecycle completion is owned by backend hooks.\n", "utf8");
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
    expect(await readText(context.taskRepoRoot, "CLAUDE.md")).toContain("Lifecycle completion is owned by backend hooks");
    expect(context.gitCommits.at(-1)?.message).toBe("chore: update VCM memory");
    expect(context.terminalWrites.some((entry) => entry.includes("[VCM Task Harness Review: Memory Review]"))).toBe(false);
    await expect(context.service.getTaskRetrospectiveReadiness({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      handoffDir: ".ai/vcm/handoffs",
      roundReady: true
    })).resolves.toEqual({ ready: true, disposition: "completed", trigger: "manual" });

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

  it("does not apply Harness Engineer memory edits outside an active retrospective review", async () => {
    const context = await createContext(false);
    const current = await readText(context.taskRepoRoot, "CLAUDE.md");
    await writeFile(
      path.join(context.taskRepoRoot, "CLAUDE.md"),
      replaceVcmMemoryBlock(current, "Unreviewed Harness Engineer edit.\n"),
      "utf8"
    );

    await expect(context.service.handleHarnessEngineerHook({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      eventName: "Stop"
    })).resolves.toBe(false);

    const state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.runs).toHaveLength(0);
    expect(context.gitCommits).toHaveLength(0);
  });

  it("does not mix existing host-file changes into a memory commit", async () => {
    const context = await createContext(false);
    context.setGitDiff("existing CLAUDE.md change");

    await expect(context.service.updateFile(
      context.baseRepoRoot,
      context.taskRepoRoot,
      "demo",
      "CLAUDE.md",
      "New memory must not be applied.\n"
    )).rejects.toMatchObject({ code: "MEMORY_HOST_FILE_DIRTY" });

    expect(await readText(context.taskRepoRoot, "CLAUDE.md")).not.toContain("New memory must not be applied");
    expect(context.gitCommits).toHaveLength(0);
  });

  it("discards active memory work when Auto Memory is disabled", async () => {
    const context = await createContext(true);
    const finalAcceptancePath = path.join(context.taskRepoRoot, ".ai/vcm/handoffs/final-acceptance.md");
    await mkdir(path.dirname(finalAcceptancePath), { recursive: true });
    await writeFile(
      finalAcceptancePath,
      renderFinalAcceptanceTemplate("demo")
        .replaceAll("TBD", "None.")
        .replace(
          "accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|needs-docs-sync|blocked-by-user-decision",
          "accepted"
        ),
      "utf8"
    );
    await context.service.reconcileTask({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      handoffDir: ".ai/vcm/handoffs",
      roundReady: true,
      requestTrigger: "manual"
    });

    context.setAutoMemoryEnabled(false);
    await expect(context.service.handleRoleHook({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      role: "project-manager",
      eventName: "Stop"
    })).resolves.toBe(true);

    const state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.status).toBe("idle");
    expect(state.runs).toHaveLength(0);
  });

  async function createContext(autoMemoryEnabled: boolean) {
    root = await mkdtemp(path.join(os.tmpdir(), "vcm-auto-memory-"));
    const baseRepoRoot = path.join(root, "repo");
    const taskRepoRoot = path.join(root, "task");
    await mkdir(baseRepoRoot, { recursive: true });
    await mkdir(taskRepoRoot, { recursive: true });
    await seedMemoryHosts(taskRepoRoot);
    const terminalWrites: string[] = [];
    const gitCommits: Array<{ message: string; paths: string[] }> = [];
    let gitDiff = "";
    let memoryEnabled = autoMemoryEnabled;
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
      git: {
        async getDiff() {
          return gitDiff;
        },
        async commitPaths(_repoRoot, message, paths) {
          gitCommits.push({ message, paths });
          return `commit-${gitCommits.length}`;
        }
      },
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
            autoMemoryEnabled: memoryEnabled,
            translationEnabled: false,
            translationAutoSendEnabled: false,
            translationTargetLanguage: "zh-CN",
            translationOutputMode: "pm-final-only",
            launchTemplate: createDefaultLaunchTemplate(),
            toolSessionDefaults: createDefaultToolSessionDefaults()
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
    return {
      baseRepoRoot,
      taskRepoRoot,
      terminalWrites,
      gitCommits,
      service,
      setAutoMemoryEnabled(enabled: boolean) {
        memoryEnabled = enabled;
      },
      setGitDiff(diff: string) {
        gitDiff = diff;
      }
    };
  }
});

async function seedMemoryHosts(taskRepoRoot: string): Promise<void> {
  const paths = [
    "CLAUDE.md",
    ".claude/agents/project-manager.md",
    ".claude/agents/architect.md",
    ".claude/agents/coder.md",
    ".claude/agents/tester.md",
    ".claude/agents/reviewer.md",
    ".claude/agents/harness-engineer.md"
  ];
  for (const relativePath of paths) {
    const absolutePath = path.join(taskRepoRoot, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(
      absolutePath,
      `# ${path.basename(relativePath)}\n\n${renderVcmMemoryBlock()}\n\n<!-- VCM:BEGIN version=1 -->\nRules\n<!-- VCM:END -->\n`,
      "utf8"
    );
  }
}

async function readText(repoRoot: string, relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function noChangeMemoryProposal(): string {
  return [
    "# Memory Proposal",
    "Decision: no-change",
    "",
    "## Add",
    "none",
    "",
    "## Update",
    "none",
    "",
    "## Remove",
    "none",
    ""
  ].join("\n");
}

function memoryReviewReport(roles: RoleName[]): string {
  return [
    "# Task Harness Retrospective",
    "",
    "## Memory Review",
    "Existing memory reviewed: complete",
    "",
    "### Proposal Dispositions",
    ...roles.map((role) => `- ${role}: no-change`),
    "",
    "### Existing Memory Decisions",
    "#### Item 1",
    "Target: shared",
    "Existing: Lifecycle completion is inferred by each client.",
    "Decision: update",
    "Reason: The lifecycle owner must match the current backend architecture.",
    "Impact if removed: Roles may infer lifecycle completion independently.",
    "Durable doc disposition: memory",
    "Durable doc path: none",
    "Evidence: src/backend/services/claude-hook-service.ts",
    "",
    "### Existing Memory Changes",
    "- retained: all verified entries",
    "- updated: none",
    "- removed: none",
    "",
    "Reviewed memory set: complete",
    ""
  ].join("\n");
}
