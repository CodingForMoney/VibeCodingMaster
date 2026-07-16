import { createHash } from "node:crypto";
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
      appSettings: createAppSettings(["architecture-plan", "validation-adequacy", "code-diff"]),
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
    expect(record.findings).toEqual([{
      severity: "high",
      title: "Missing proof point",
      evidence: "plan has no proof",
      expected: "proof point exists",
      gap: "no proof",
      risk: "coder ambiguity",
      file: undefined,
      line: undefined
    }]);
    expect(record.callbackStatus).toBe("sent");
    expect(record.reportPath).toBe(".ai/vcm/gate-reviews/architecture-plan-review.md");

    expect(runnerCalls.some((call) => call.command === "git" && call.args[0] === "diff")).toBe(true);
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
    expect(gatePrompt).toContain("Complete every Architecture Analysis field");
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

  it("does not start architecture-plan review when the architecture plan is missing", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-missing-plan-"));
    await writeHarnessFiles(tmpRepo);
    await rm(path.join(taskWorktree(tmpRepo), ".ai/vcm/handoffs/architecture-plan.md"), { force: true });
    const sessionStarts: string[] = [];
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, []),
      runtime: createRuntime(tmpRepo, []),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["architecture-plan"]),
      sessionService: createSessionService(sessionStarts),
      roundService: createRoundService()
    });

    const result = await service.requestReviewGate(tmpRepo, "demo-task", "architecture-plan");
    const state = await service.getState(tmpRepo, "demo-task");

    expect(result.status).toBe("not_required");
    expect(result.message).toContain("architecture-plan.md is missing");
    expect(state.gates["architecture-plan"].status).toBe("not_required");
    expect(sessionStarts).toEqual([]);
  });

  it("does not start validation-adequacy review when the test report is empty", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-empty-report-"));
    await writeHarnessFiles(tmpRepo);
    await writeFile(path.join(taskWorktree(tmpRepo), ".ai/vcm/handoffs/test-report.md"), "\n\n", "utf8");
    const sessionStarts: string[] = [];
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, []),
      runtime: createRuntime(tmpRepo, []),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["validation-adequacy"]),
      sessionService: createSessionService(sessionStarts),
      roundService: createRoundService()
    });

    const result = await service.requestReviewGate(tmpRepo, "demo-task", "validation-adequacy");
    const state = await service.getState(tmpRepo, "demo-task");

    expect(result.status).toBe("not_required");
    expect(result.message).toContain("test-report.md is empty");
    expect(state.gates["validation-adequacy"].status).toBe("not_required");
    expect(sessionStarts).toEqual([]);
  });

  it("reuses validation-adequacy approval when only the architecture plan changed", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-report-hash-"));
    await writeHarnessFiles(tmpRepo);
    const taskRoot = taskWorktree(tmpRepo);
    const testReport = "# Test Report\nAll checks covered.\n";
    await writeFile(path.join(taskRoot, ".ai/vcm/handoffs/test-report.md"), testReport, "utf8");
    await mkdir(path.join(taskRoot, ".ai/vcm/gate-reviews"), { recursive: true });
    await writeFile(
      path.join(taskRoot, ".ai/vcm/gate-reviews/index.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        activeGate: null,
        updatedAt: "2026-06-13T00:00:00.000Z",
        gates: {
          "validation-adequacy": {
            gate: "validation-adequacy",
            required: true,
            status: "completed",
            decision: "approve",
            reportPath: ".ai/vcm/gate-reviews/validation-adequacy-review.md",
            promptPath: ".ai/vcm/gate-reviews/requests/approved.prompt.md",
            inputHash: gateCoreHash(".ai/vcm/handoffs/test-report.md", testReport),
            updatedAt: "2026-06-13T00:00:00.000Z"
          }
        }
      }),
      "utf8"
    );
    await writeFile(path.join(taskRoot, ".ai/vcm/handoffs/architecture-plan.md"), "# Architecture Plan\nChanged.\n", "utf8");
    const sessionStarts: string[] = [];
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, []),
      runtime: createRuntime(tmpRepo, []),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["validation-adequacy"]),
      sessionService: createSessionService(sessionStarts),
      roundService: createRoundService()
    });

    const result = await service.requestReviewGate(tmpRepo, "demo-task", "validation-adequacy");

    expect(result.status).toBe("already_approved");
    expect(sessionStarts).toEqual([]);
  });

  it("invalidates architecture approval when scaffold evidence changes", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-scaffold-hash-"));
    await writeHarnessFiles(tmpRepo);
    let workingDiff = "";
    const runner = createRunner(tmpRepo, [], {
      "rev-parse HEAD": "head-sha",
      "diff --binary -- . :(exclude).ai/vcm/**": () => workingDiff,
      "diff --cached --binary -- . :(exclude).ai/vcm/**": "",
      "ls-files --others --exclude-standard -- . :(exclude).ai/vcm/**": ""
    });
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner,
      runtime: createRuntime(tmpRepo, [], "approve"),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["architecture-plan"]),
      sessionService: createSessionService(),
      roundService: createRoundService(),
      reportPollIntervalMs: 5,
      reportTimeoutMs: 500
    });

    expect((await service.requestReviewGate(tmpRepo, "demo-task", "architecture-plan")).status).toBe("started");
    await waitFor(async () => (await service.getState(tmpRepo!, "demo-task")).gates["architecture-plan"].status === "completed");
    expect((await service.requestReviewGate(tmpRepo, "demo-task", "architecture-plan")).status).toBe("already_approved");

    workingDiff = "diff --git a/src/scaffold.ts b/src/scaffold.ts\n+export const changed = true;\n";
    expect((await service.requestReviewGate(tmpRepo, "demo-task", "architecture-plan")).status).toBe("started");
    await waitFor(async () => (await service.getState(tmpRepo!, "demo-task")).gates["architecture-plan"].status === "completed");
  });

  it("rejects architecture reports without complete architecture analysis", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-analysis-contract-"));
    await writeHarnessFiles(tmpRepo);
    const reportDir = path.join(taskWorktree(tmpRepo), ".ai/vcm/gate-reviews");
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, "architecture-plan-review.md"),
      "Gate: architecture-plan\nDecision: approve\nSummary: Format only.\n",
      "utf8"
    );
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, []),
      runtime: createRuntime(tmpRepo, []),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["architecture-plan"]),
      sessionService: createSessionService(),
      roundService: createRoundService()
    });

    await expect(service.readReport(tmpRepo, "demo-task", "architecture-plan")).rejects.toMatchObject({
      code: "GATE_REVIEW_ARCHITECTURE_ANALYSIS_MISSING"
    });
  });

  it("starts code-diff review for the current unreviewed commit range", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-code-diff-"));
    await writeHarnessFiles(tmpRepo);
    const runnerCalls: Array<{ command: string; args: string[]; options?: CommandRunnerOptions }> = [];
    const runner = createRunner(tmpRepo, runnerCalls, {
      "rev-parse HEAD": ({ cwd }) => cwd === tmpRepo ? "base-sha" : "head-sha",
      "merge-base --is-ancestor base-sha head-sha": "",
      "log --oneline --reverse base-sha..head-sha": "abc1234 implement route\nbcd2345 add tests",
      "diff --name-only --find-renames base-sha..head-sha": "src/feature.ts\ntests/feature.test.ts",
      "diff --stat --find-renames base-sha..head-sha": " src/feature.ts | 10 +++++\n 1 file changed",
      "diff --binary --find-renames base-sha..head-sha": "diff --git a/src/feature.ts b/src/feature.ts\n"
    });
    const writes: string[] = [];
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner,
      runtime: createRuntime(tmpRepo, writes),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["code-diff"]),
      sessionService: createSessionService(),
      roundService: createRoundService(),
      reportPollIntervalMs: 5,
      reportTimeoutMs: 500
    });

    const result = await service.requestReviewGate(tmpRepo, "demo-task", "code-diff", {
      codeDiffSource: "coder"
    });

    expect(result.status).toBe("started");
    await waitFor(async () => {
      const state = await service.getState(tmpRepo!, "demo-task");
      return state.gates["code-diff"].status === "completed";
    });

    const state = await service.getState(tmpRepo, "demo-task");
    const record = state.gates["code-diff"];
    expect(record.baseCommit).toBe("base-sha");
    expect(record.headCommit).toBe("head-sha");
    expect(record.commits).toEqual(["abc1234 implement route", "bcd2345 add tests"]);
    expect(record.changedFiles).toEqual(["src/feature.ts", "tests/feature.test.ts"]);
    expect(record.codeDiffSource).toBe("coder");
    const prompt = writes.find((write) => write.includes("[VCM GATE REVIEW]")) ?? "";
    expect(prompt).toContain("Gate: code-diff");
    expect(prompt).toContain("This code-diff gate reviews the new commits from one PM route flow");
    expect(prompt).toContain("Code source: coder");
    expect(prompt).toContain("- .ai/vcm/handoffs/coder-completion.md");
    expect(prompt).not.toContain("- .ai/vcm/handoffs/test-report.md");
    expect(prompt).toContain("Base commit: base-sha");
    expect(prompt).toContain("Head commit: head-sha");
    expect(prompt).toContain("- abc1234 implement route");
    expect(runnerCalls.some((call) => call.args.join(" ") === "diff --binary --find-renames base-sha..head-sha")).toBe(true);
  });

  it("fails code-diff start when the worktree has uncommitted changes", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-code-diff-dirty-"));
    await writeHarnessFiles(tmpRepo);
    const sessionStarts: string[] = [];
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, [], {
        "status --porcelain=v1": " M src/feature.ts\n?? scratch.txt"
      }),
      runtime: createRuntime(tmpRepo, []),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["code-diff"]),
      sessionService: createSessionService(sessionStarts),
      roundService: createRoundService()
    });

    const result = await service.requestReviewGate(tmpRepo, "demo-task", "code-diff", {
      codeDiffSource: "coder"
    });
    const state = await service.getState(tmpRepo, "demo-task");

    expect(result.status).toBe("failed_to_start");
    expect(result.message).toContain("code-diff requires committed inputs");
    expect(state.gates["code-diff"].status).toBe("failed");
    expect(state.gates["code-diff"].error).toContain("M src/feature.ts");
    expect(sessionStarts).toEqual([]);
  });

  it("rejects code-diff requests without a code source", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-code-source-"));
    await writeHarnessFiles(tmpRepo);
    const sessionStarts: string[] = [];
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, []),
      runtime: createRuntime(tmpRepo, []),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["code-diff"]),
      sessionService: createSessionService(sessionStarts),
      roundService: createRoundService()
    });

    const result = await service.requestReviewGate(tmpRepo, "demo-task", "code-diff");

    expect(result.status).toBe("failed_to_start");
    expect(result.message).toContain("--source coder, --source architect-debug, or --source architect-diagnosis");
    expect(sessionStarts).toEqual([]);
  });

  it("uses the current Architect route command for architect-debug code diffs", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-debug-source-"));
    await writeHarnessFiles(tmpRepo);
    const runner = createRunner(tmpRepo, [], {
      "rev-parse HEAD": ({ cwd }) => cwd === tmpRepo ? "base-sha" : "head-sha",
      "merge-base --is-ancestor base-sha head-sha": "",
      "log --oneline --reverse base-sha..head-sha": "abc1234 fix debug path",
      "diff --name-only --find-renames base-sha..head-sha": "src/feature.ts",
      "diff --stat --find-renames base-sha..head-sha": " src/feature.ts | 2 +-",
      "diff --binary --find-renames base-sha..head-sha": "diff --git a/src/feature.ts b/src/feature.ts\n"
    });
    const writes: string[] = [];
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner,
      runtime: createRuntime(tmpRepo, writes),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["code-diff"]),
      sessionService: createSessionService(),
      roundService: createRoundService(),
      reportPollIntervalMs: 5,
      reportTimeoutMs: 500
    });

    const result = await service.requestReviewGate(tmpRepo, "demo-task", "code-diff", {
      codeDiffSource: "architect-debug"
    });

    expect(result.status).toBe("started");
    await waitFor(async () => (await service.getState(tmpRepo!, "demo-task")).gates["code-diff"].status === "completed");
    const prompt = writes.find((write) => write.includes("[VCM GATE REVIEW]")) ?? "";
    expect(prompt).toContain("Code source: architect-debug");
    expect(prompt).toContain("- .ai/vcm/handoffs/role-commands/architect.md");
    expect(prompt).not.toContain("- .ai/vcm/handoffs/coder-completion.md");
  });

  it("uses the diagnosis artifact for architect-diagnosis code diffs", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-diagnosis-source-"));
    await writeHarnessFiles(tmpRepo);
    await writeFile(
      path.join(taskWorktree(tmpRepo), ".ai/vcm/handoffs/architecture-diagnosis.md"),
      "# Architecture Diagnosis\n",
      "utf8"
    );
    const runner = createRunner(tmpRepo, [], {
      "rev-parse HEAD": ({ cwd }) => cwd === tmpRepo ? "base-sha" : "head-sha",
      "merge-base --is-ancestor base-sha head-sha": "",
      "log --oneline --reverse base-sha..head-sha": "abc1234 repair ownership",
      "diff --name-only --find-renames base-sha..head-sha": "src/feature.ts",
      "diff --stat --find-renames base-sha..head-sha": " src/feature.ts | 8 ++++----",
      "diff --binary --find-renames base-sha..head-sha": "diff --git a/src/feature.ts b/src/feature.ts\n"
    });
    const writes: string[] = [];
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner,
      runtime: createRuntime(tmpRepo, writes),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["code-diff"]),
      sessionService: createSessionService(),
      roundService: createRoundService(),
      reportPollIntervalMs: 5,
      reportTimeoutMs: 500
    });

    const result = await service.requestReviewGate(tmpRepo, "demo-task", "code-diff", {
      codeDiffSource: "architect-diagnosis"
    });

    expect(result.status).toBe("started");
    await waitFor(async () => (await service.getState(tmpRepo!, "demo-task")).gates["code-diff"].status === "completed");
    const prompt = writes.find((write) => write.includes("[VCM GATE REVIEW]")) ?? "";
    expect(prompt).toContain("Code source: architect-diagnosis");
    expect(prompt).toContain("- .ai/vcm/handoffs/architecture-diagnosis.md");
    expect(prompt).not.toContain("- .ai/vcm/handoffs/role-commands/architect.md");
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
    expect(state.gates["code-diff"].required).toBe(false);
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
  calls: Array<{ command: string; args: string[]; options?: CommandRunnerOptions }>,
  gitOutputs: Record<string, string | ((input: { cwd?: string }) => string)> = {}
): CommandRunner {
  return {
    async run(command: string, args: string[] = [], options?: CommandRunnerOptions): Promise<CommandResult> {
      calls.push({ command, args, options });
      if (command === "git") {
        const key = args.join(" ");
        const output = gitOutputs[key];
        if (typeof output === "function") {
          return { stdout: output({ cwd: options?.cwd }), stderr: "", exitCode: 0 };
        }
        if (typeof output === "string") {
          return { stdout: output, stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: `unexpected command: ${command}`, exitCode: 1 };
    }
  };
}

function createRuntime(
  repoRoot: string,
  writes: string[],
  decision: "approve" | "request_changes" = "request_changes"
): TerminalRuntime {
  return {
    write(sessionId, data) {
      writes.push(data);
      if (sessionId !== "gate-session" || !data.includes("Gate:")) {
        return;
      }
      const gate = /Gate:\s*([a-z-]+)/.exec(data)?.[1] ?? "architecture-plan";
      const requestId = /Request:\s*([a-z0-9_.-]+)/i.exec(data)?.[1] ?? "request-id";
      const architectureAnalysis = gate === "architecture-plan"
        ? [
            "## Architecture Analysis",
            "",
            "- Evidence Read: architecture-plan.md, source files, and callers",
            "- End-To-End Flow: entry to owner to completion",
            "- Scope Fit: accepted scope is covered",
            "- Code Reality: plan was compared with current code",
            "- Ownership: state ownership was checked",
            "- Data Flow: data flow was traced",
            "- Lifecycle: completion and failure were checked",
            "- Invariants: project invariants were checked",
            "- Boundaries And Public Surface: callers and consumers were checked",
            "- Failure Model: retries and failures were checked",
            "- Coder Readiness: implementation decisions are complete",
            ""
          ]
        : [];
      const findings = decision === "request_changes"
        ? [
            "## Findings",
            "",
            "### high: Missing proof point",
            "- Evidence: plan has no proof",
            "- Expected: proof point exists",
            "- Gap: no proof",
            "- Risk: coder ambiguity"
          ]
        : ["## Findings", "", "None."];
      void writeFile(
        path.join(taskWorktree(repoRoot), ".ai/vcm/gate-reviews", `${gate}-review.md`),
        [
          `Gate: ${gate}`,
          `Request: ${requestId}`,
          `Decision: ${decision}`,
          decision === "request_changes" ? "Summary: Missing proof point." : "Summary: Approved.",
          "",
          ...architectureAnalysis,
          ...findings
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

function gateCoreHash(relativePath: string, content: string): string {
  const digest = createHash("sha256");
  digest.update(relativePath);
  digest.update(content);
  return digest.digest("hex");
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
