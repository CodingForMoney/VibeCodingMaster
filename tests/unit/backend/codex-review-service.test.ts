import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import type { CommandResult, CommandRunner, CommandRunnerOptions } from "../../../src/backend/adapters/command-runner.js";
import type { TerminalRuntime } from "../../../src/backend/runtime/terminal-runtime.js";
import { createCodexReviewService } from "../../../src/backend/services/codex-review-service.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";

let tmpRepo: string | undefined;

afterEach(async () => {
  if (tmpRepo) {
    await rm(tmpRepo, { recursive: true, force: true });
    tmpRepo = undefined;
  }
});

describe("codex-review-service", () => {
  it("runs a requested gate, records the report decision, and calls back project-manager", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-codex-review-"));
    await writeHarnessFiles(tmpRepo, { enabled: true });

    const runnerCalls: Array<{ command: string; args: string[]; options?: CommandRunnerOptions }> = [];
    const runner = createRunner(tmpRepo, runnerCalls);
    const writes: string[] = [];
    const service = createCodexReviewService({
      fs: createNodeFileSystemAdapter(),
      runner,
      runtime: createRuntime(writes),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      sessionService: createSessionService()
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
    expect(record.reportPath).toBe(".ai/vcm/codex-reviews/architecture-plan-review.md");

    const codexCall = runnerCalls.find((call) => call.command === "codex");
    expect(codexCall?.args).toContain("--ask-for-approval");
    expect(codexCall?.args).toContain("never");
    expect(codexCall?.args).toContain("--cd");
    expect(codexCall?.args).toContain(path.join(tmpRepo, ".ai/codex"));
    expect(codexCall?.args).toContain("--add-dir");
    expect(codexCall?.args).toContain(path.join(tmpRepo, ".ai/vcm/codex-reviews"));
    expect(codexCall?.args).toContain("--config");
    expect(codexCall?.args).toContain('model_reasoning_effort="xhigh"');
    expect(writes.join("")).toContain("[VCM CODEX REVIEW CALLBACK]");
    expect(writes.join("")).toContain("decision: request_changes");
  });

  it("does not run Codex when the project switch is disabled", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-codex-review-disabled-"));
    await writeHarnessFiles(tmpRepo, { enabled: false });
    const runnerCalls: Array<{ command: string; args: string[]; options?: CommandRunnerOptions }> = [];
    const service = createCodexReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, runnerCalls),
      runtime: createRuntime([]),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      sessionService: createSessionService()
    });

    const result = await service.requestReviewGate(tmpRepo, "demo-task", "architecture-plan");

    expect(result.status).toBe("disabled");
    expect(runnerCalls.some((call) => call.command === "codex")).toBe(false);
  });
});

async function writeHarnessFiles(repoRoot: string, options: { enabled: boolean }): Promise<void> {
  await mkdir(path.join(repoRoot, ".ai/codex/prompts"), { recursive: true });
  await mkdir(path.join(repoRoot, ".ai/vcm/handoffs"), { recursive: true });
  await writeFile(path.join(repoRoot, "CLAUDE.md"), "# CLAUDE\n", "utf8");
  await writeFile(path.join(repoRoot, ".ai/codex/AGENTS.md"), "# VCM Codex Reviewer\n", "utf8");
  await writeFile(path.join(repoRoot, ".ai/codex/prompts/architecture-plan-gate.md"), "# Codex Gate\n", "utf8");
  await writeFile(path.join(repoRoot, ".ai/vcm/handoffs/architecture-plan.md"), "# Architecture Plan\n", "utf8");
  await writeFile(path.join(repoRoot, ".ai/codex/config.toml"), `model = "test-model"
model_reasoning_effort = "xhigh"

[vcm.codex_review]
enabled = ${options.enabled ? "true" : "false"}
required_gates = ["architecture-plan", "validation-adequacy", "final-diff"]
`, "utf8");
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
      if (command === "codex") {
        const gate = options?.env?.VCM_CODEX_REVIEW_GATE ?? "architecture-plan";
        const requestId = options?.env?.VCM_CODEX_REVIEW_REQUEST_ID ?? "request-id";
        await writeFile(
          path.join(repoRoot, ".ai/vcm/codex-reviews", `${gate}-review.md`),
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
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: `unexpected command: ${command}`, exitCode: 1 };
    }
  };
}

function createRuntime(writes: string[]): TerminalRuntime {
  return {
    write(_sessionId, data) {
      writes.push(data);
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
        branch: "feature/demo-task",
        handoffDir: ".ai/vcm/handoffs",
        status: "running"
      };
    }
  };
}

function createSessionService() {
  const session: RoleSessionRecord = {
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
    logPath: ".ai/vcm/handoffs/logs/project-manager.log",
    updatedAt: "2026-06-13T00:00:00.000Z"
  };
  return {
    async getRoleSession() {
      return session;
    },
    async markRoleActivityRunning() {
      return {
        ...session,
        activityStatus: "running"
      };
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
