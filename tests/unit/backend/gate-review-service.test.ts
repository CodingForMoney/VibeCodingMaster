import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import type { CommandResult, CommandRunner, CommandRunnerOptions } from "../../../src/backend/adapters/command-runner.js";
import type { TerminalRuntime } from "../../../src/backend/runtime/terminal-runtime.js";
import { createGateReviewService } from "../../../src/backend/services/gate-review-service.js";
import type { GateReviewGate } from "../../../src/shared/types/gate-review.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";

let tmpRepo: string | undefined;

afterEach(async () => {
  if (tmpRepo) {
    await rm(tmpRepo, { recursive: true, force: true });
    tmpRepo = undefined;
  }
});

describe("gate-review-service", () => {
  it("runs a requested gate, records the report decision, and calls back project-manager", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-"));
    await writeHarnessFiles(tmpRepo);

    const runnerCalls: Array<{ command: string; args: string[]; options?: CommandRunnerOptions }> = [];
    const runner = createRunner(tmpRepo, runnerCalls);
    const writes: string[] = [];
    const sessionStarts: string[] = [];
    const activityCalls: string[] = [];
    const roundCalls: string[] = [];
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner,
      runtime: createRuntime(tmpRepo, writes),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["architecture-plan", "validation-adequacy", "final-diff"]),
      sessionService: createSessionService(sessionStarts, activityCalls),
      roundService: createRoundService(roundCalls),
      reportPollIntervalMs: 5,
      reportTimeoutMs: 500
    });

    const result = await service.requestReviewGate(tmpRepo, "demo-task", "architecture-plan");

    expect(result.status).toBe("started");
    await waitFor(async () => {
      const state = await service.getState(tmpRepo!, "demo-task");
      const record = state.gates["architecture-plan"];
      return record.status === "completed" && record.callbackStatus === "sent";
    });

    const state = await service.getState(tmpRepo, "demo-task");
    const record = state.gates["architecture-plan"];
    expect(state.activeGate).toBeNull();
    expect(record.decision).toBe("request_changes");
    expect(record.callbackStatus).toBe("sent");
    expect(record.reportPath).toBe(".ai/vcm/gate-reviews/architecture-plan-review.md");

    expect(runnerCalls.some((call) => call.command === "git" && call.args.join(" ") === "status --porcelain=v1")).toBe(true);
    expect(runnerCalls.some((call) => call.command === "git" && call.args.join(" ") === "diff --binary")).toBe(true);
    expect(sessionStarts).toEqual(["gate-reviewer"]);
    expect(activityCalls).toEqual([
      "running:gate-reviewer",
      "idle:gate-reviewer",
      "running:project-manager"
    ]);
    expect(roundCalls).toEqual([
      "round:UserPromptSubmit:gate-reviewer",
      "round:Stop:gate-reviewer",
      "round:UserPromptSubmit:project-manager"
    ]);
    const gatePrompt = writes.find((write) => write.includes("[VCM GATE REVIEW]")) ?? "";
    expect(gatePrompt).toContain("Task: demo-task");
    expect(gatePrompt).toContain(`Worktree: ${taskWorktree(tmpRepo)}`);
    expect(gatePrompt).toContain(`Report: ${path.join(taskWorktree(tmpRepo), ".ai/vcm/gate-reviews/architecture-plan-review.md")}`);
    expect(gatePrompt).not.toContain("Findings, when present");
    expect(writes.join("")).toContain("[VCM GATE REVIEW CALLBACK]");
    expect(writes.join("")).toContain("decision: request_changes");
  });

  it("does not start Gate Reviewer when the project switch is disabled", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-disabled-"));
    await writeHarnessFiles(tmpRepo);
    const runnerCalls: Array<{ command: string; args: string[]; options?: CommandRunnerOptions }> = [];
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, runnerCalls),
      runtime: createRuntime(tmpRepo, []),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings([]),
      sessionService: createSessionService(),
      roundService: createRoundService()
    });

    const result = await service.requestReviewGate(tmpRepo, "demo-task", "architecture-plan");

    expect(result.status).toBe("disabled");
  });

  it("updates gate settings from disabled state without enabling stale gates", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-settings-"));
    await writeHarnessFiles(tmpRepo);
    const appSettings = createAppSettings([]);
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, []),
      runtime: createRuntime(tmpRepo, []),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings,
      sessionService: createSessionService(),
      roundService: createRoundService()
    });

    const state = await service.updateSettings(tmpRepo, "demo-task", {
      gates: { "architecture-plan": true }
    });

    expect(state.enabled).toBe(true);
    expect(state.gates["architecture-plan"].required).toBe(true);
    expect(state.gates["validation-adequacy"].required).toBe(false);
    expect(state.gates["final-diff"].required).toBe(false);
    expect(appSettings.getStoredRequiredGates()).toEqual(["architecture-plan"]);

    const disabledState = await service.updateSettings(tmpRepo, "demo-task", {
      gates: { "architecture-plan": false }
    });

    expect(disabledState.enabled).toBe(false);
    expect(appSettings.getStoredRequiredGates()).toEqual([]);
  });
});

async function writeHarnessFiles(repoRoot: string): Promise<void> {
  const taskRepoRoot = taskWorktree(repoRoot);
  await mkdir(path.join(repoRoot, ".claude/agents"), { recursive: true });
  await mkdir(path.join(taskRepoRoot, ".claude/agents"), { recursive: true });
  await mkdir(path.join(taskRepoRoot, ".claude/skills/vcm-gate-review"), { recursive: true });
  await mkdir(path.join(taskRepoRoot, ".ai/tools"), { recursive: true });
  await mkdir(path.join(taskRepoRoot, ".ai/vcm/handoffs"), { recursive: true });
  await writeFile(path.join(repoRoot, "CLAUDE.md"), "# CLAUDE\n", "utf8");
  await writeFile(path.join(repoRoot, ".claude/agents/gate-reviewer.md"), "# VCM Gate Reviewer\n", "utf8");
  await writeFile(path.join(taskRepoRoot, "CLAUDE.md"), "# CLAUDE\n", "utf8");
  await writeFile(path.join(taskRepoRoot, ".claude/agents/gate-reviewer.md"), "# VCM Gate Reviewer\n", "utf8");
  await writeFile(path.join(taskRepoRoot, ".claude/skills/vcm-gate-review/SKILL.md"), "# Gate Review Skill\n", "utf8");
  await writeFile(path.join(taskRepoRoot, ".ai/tools/request-gate-review"), "#!/usr/bin/env python3\n", "utf8");
  await writeFile(path.join(taskRepoRoot, ".ai/vcm/handoffs/architecture-plan.md"), "# Architecture Plan\n", "utf8");
}

function taskWorktree(repoRoot: string): string {
  return path.join(repoRoot, ".claude/worktrees/demo-task");
}

function createRunner(
  repoRoot: string,
  calls: Array<{ command: string; args: string[]; options?: CommandRunnerOptions }>
): CommandRunner {
  return {
    async run(command: string, args: string[] = [], options?: CommandRunnerOptions): Promise<CommandResult> {
      calls.push({ command, args, options });
      if (command === "git") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: `unexpected command: ${command}`, exitCode: 1 };
    }
  };
}

function createRuntime(repoRoot: string, writes: string[]): TerminalRuntime {
  return {
    write(sessionId, data) {
      writes.push(data);
      if (sessionId !== "gate-session" || !data.includes("Gate:")) {
        return;
      }
      const gate = /Gate:\s*([a-z-]+)/.exec(data)?.[1] ?? "architecture-plan";
      const requestId = /Request:\s*([a-z0-9_.-]+)/i.exec(data)?.[1] ?? "request-id";
      void writeFile(
        path.join(taskWorktree(repoRoot), ".ai/vcm/gate-reviews", `${gate}-review.md`),
        [
          `Gate: ${gate}`,
          `Request: ${requestId}`,
          "Decision: request_changes",
          "Summary: Missing proof point.",
          "",
          "severity: high",
          "title: Missing proof point",
          "evidence: plan has no proof",
          "expected: proof point exists",
          "gap: no proof",
          "risk: coder ambiguity"
        ].join("\n"),
        "utf8"
      );
    },
    getSession(sessionId) {
      return sessionId === "pm-session" || sessionId === "gate-session"
        ? {
            id: sessionId,
            taskSlug: "demo-task",
            role: sessionId === "gate-session" ? "gate-reviewer" : "project-manager",
            status: "running",
            startedAt: "2026-06-13T00:00:00.000Z",
            exitCode: null
          }
        : undefined;
    }
  } as TerminalRuntime;
}

function createProjectService() {
  return {
    async loadConfig() {
      return {
        stateRoot: ".ai/vcm",
        handoffRoot: ".ai/vcm/handoffs",
        claudeCommand: "claude"
      };
    }
  };
}

function createTaskService(repoRoot: string) {
  return {
    async loadTask(): Promise<TaskRecord> {
      return {
        version: 1,
        taskSlug: "demo-task",
        createdAt: "2026-06-13T00:00:00.000Z",
        updatedAt: "2026-06-13T00:00:00.000Z",
        repoRoot,
        worktreePath: taskWorktree(repoRoot),
        branch: "feature/demo-task",
        handoffDir: ".ai/vcm/handoffs",
        status: "running"
      };
    }
  };
}

function createSessionService(starts: string[] = [], activityCalls: string[] = []) {
  const pmSession: RoleSessionRecord = {
    id: "pm-session",
    claudeSessionId: "claude-session",
    taskSlug: "demo-task",
    role: "project-manager",
    status: "running",
    activityStatus: "idle",
    command: "claude --agent project-manager",
    permissionMode: "default",
    cwd: "/repo",
    terminalBackend: "node-pty",
    updatedAt: "2026-06-13T00:00:00.000Z"
  };
  const gateSession: RoleSessionRecord = {
    id: "gate-session",
    claudeSessionId: "gate-session-id",
    taskSlug: "demo-task",
    role: "gate-reviewer",
    status: "running",
    activityStatus: "idle",
    command: "claude --agent gate-reviewer",
    permissionMode: "default",
    model: "default",
    cwd: "/repo",
    terminalBackend: "node-pty",
    updatedAt: "2026-06-13T00:00:00.000Z"
  };
  const sessions = new Map<string, RoleSessionRecord>([
    ["project-manager", pmSession]
  ]);
  return {
    async getRoleSession(_repoRoot: string, _taskSlug: string, role: string) {
      return sessions.get(role);
    },
    async resumeRoleSession(_repoRoot: string, _taskSlug: string, role: string) {
      starts.push(`resume:${role}`);
      sessions.set(role, gateSession);
      return gateSession;
    },
    async startRoleSession(_repoRoot: string, _taskSlug: string, role: string) {
      starts.push(role);
      sessions.set(role, gateSession);
      return gateSession;
    },
    async markRoleActivityRunning(_repoRoot: string, _taskSlug: string, role: string) {
      const session = sessions.get(role) ?? pmSession;
      activityCalls.push(`running:${role}`);
      const updated = {
        ...session,
        activityStatus: "running" as const
      };
      sessions.set(role, updated);
      return updated;
    },
    async markRoleActivityIdle(_repoRoot: string, _taskSlug: string, role: string) {
      const session = sessions.get(role) ?? pmSession;
      activityCalls.push(`idle:${role}`);
      const updated = {
        ...session,
        activityStatus: "idle" as const
      };
      sessions.set(role, updated);
      return updated;
    }
  };
}

function createRoundService(calls: string[] = []) {
  return {
    async recordRoleTurnEvent(input: { eventName: string; role: string }) {
      calls.push(`round:${input.eventName}:${input.role}`);
      return {} as never;
    }
  };
}

function createAppSettings(initialRequiredGates: GateReviewGate[] = []) {
  let requiredGates = [...initialRequiredGates];
  return {
    async getGateReviewSettings() {
      return {
        enabled: requiredGates.length > 0,
        requiredGates
      };
    },
    async updateGateReviewSettings(_repoRoot: string, _taskSlug: string, nextRequiredGates: GateReviewGate[]) {
      requiredGates = [...nextRequiredGates];
      return {
        enabled: requiredGates.length > 0,
        requiredGates
      };
    },
    getStoredRequiredGates() {
      return requiredGates;
    }
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}
