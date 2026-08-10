import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter, type FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import type { CommandResult, CommandRunner, CommandRunnerOptions } from "../../../src/backend/adapters/command-runner.js";
import type { TerminalRuntime } from "../../../src/backend/runtime/terminal-runtime.js";
import { createGateReviewService } from "../../../src/backend/services/gate-review-service.js";
import type { CodeDiffSource, GateReviewGate } from "../../../src/shared/types/gate-review.js";
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
      reportPollIntervalMs: 5
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
      line: undefined,
      location: undefined
    }]);
    expect(record.callbackStatus).toBe("sent");
    expect(record.reportPath).toBe(".ai/vcm/gate-reviews/architecture-plan-review.md");
    const requestId = record.requestId;
    expect(requestId).toBeDefined();
    const requestReportPath = path.join(
      taskWorktree(tmpRepo),
      ".ai/vcm/gate-reviews/requests",
      `${requestId}.report.md`
    );
    const requestReport = await readFile(requestReportPath, "utf8");
    expect(requestReport).toContain("Decision: request_changes");
    expect(await readFile(
      path.join(taskWorktree(tmpRepo), ".ai/vcm/gate-reviews/architecture-plan-review.md"),
      "utf8"
    )).toBe(requestReport);
    const requestRecord = JSON.parse(await readFile(
      path.join(taskWorktree(tmpRepo), ".ai/vcm/gate-reviews/requests", `${requestId}.json`),
      "utf8"
    ));
    expect(requestRecord).toMatchObject({
      decision: "request_changes",
      summary: "Missing proof point.",
      reportPath: `.ai/vcm/gate-reviews/requests/${requestId}.report.md`,
      latestReportPath: ".ai/vcm/gate-reviews/architecture-plan-review.md"
    });
    expect(requestRecord.findings).toEqual(record.findings);
    expect(requestRecord.inputSnapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourcePath: ".ai/vcm/handoffs/architecture-plan.md",
        status: "captured"
      })
    ]));
    const planSnapshot = requestRecord.inputSnapshots.find(
      (snapshot: { sourcePath: string }) => snapshot.sourcePath === ".ai/vcm/handoffs/architecture-plan.md"
    );
    expect(planSnapshot?.snapshotPath).toBe(
      `.ai/vcm/gate-reviews/requests/${requestId}.inputs/handoffs/architecture-plan.md`
    );
    await writeFile(
      path.join(taskWorktree(tmpRepo), ".ai/vcm/handoffs/architecture-plan.md"),
      "# Architecture Plan\n\nRewritten after the request.\n",
      "utf8"
    );
    expect(await readFile(path.join(taskWorktree(tmpRepo), planSnapshot.snapshotPath), "utf8"))
      .toBe(validArchitecturePlan());

    expect(runnerCalls.some((call) => call.command === "git" && call.args[0] === "diff")).toBe(true);
    expect(sessionStarts).toEqual(["reviewer"]);
    expect(activityCalls).toEqual([
      "running:reviewer",
      "running:project-manager"
    ]);
    expect(roundCalls).toEqual([
      "round:UserPromptSubmit:reviewer",
      "round:UserPromptSubmit:project-manager"
    ]);
    const gatePrompt = writes.find((write) => write.includes("[VCM GATE REVIEW]")) ?? "";
    expect(gatePrompt).toContain("Task: demo-task");
    expect(gatePrompt).toContain(`Worktree: ${taskWorktree(tmpRepo)}`);
    expect(gatePrompt).toContain(`Report: ${requestReportPath}`);
    expect(gatePrompt).toContain("Complete every Architecture Analysis field");
    expect(gatePrompt).toContain(
      `.ai/vcm/handoffs/architecture-plan.md -> .ai/vcm/gate-reviews/requests/${requestId}.inputs/handoffs/architecture-plan.md`
    );
    expect(gatePrompt).toContain("Do not substitute a later rewritten live artifact.");
    expect(gatePrompt).not.toContain("Findings, when present");
    expect(writes.join("")).toContain("[VCM GATE REVIEW CALLBACK]");
    expect(writes.join("")).toContain("decision: request_changes");
    expect(writes.join("")).toContain(`request_id: ${requestId}`);
    expect(writes.join("")).toContain(`input_hash: ${record.inputHash}`);
  });

  it("keeps a newer request authoritative when a cancelled request completes late", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-stale-completion-"));
    await writeHarnessFiles(tmpRepo);

    const baseFs = createNodeFileSystemAdapter();
    let blockedReportPath: string | undefined;
    let releaseLateRead: (() => void) | undefined;
    let markLateReadStarted: (() => void) | undefined;
    const lateReadStarted = new Promise<void>((resolve) => {
      markLateReadStarted = resolve;
    });
    const lateReadRelease = new Promise<void>((resolve) => {
      releaseLateRead = resolve;
    });
    const fsAdapter: FileSystemAdapter = {
      ...baseFs,
      async readText(targetPath) {
        if (!blockedReportPath && targetPath.includes("/gate-reviews/requests/") && targetPath.endsWith(".report.md")) {
          blockedReportPath = targetPath;
          markLateReadStarted?.();
          await lateReadRelease;
        }
        return baseFs.readText(targetPath);
      }
    };
    const writes: string[] = [];
    const sessionStarts: string[] = [];
    const service = createGateReviewService({
      fs: fsAdapter,
      runner: createRunner(tmpRepo, []),
      runtime: createRuntime(tmpRepo, writes, "approve"),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["architecture-plan"]),
      sessionService: createSessionService(sessionStarts),
      roundService: createRoundService(),
      reportPollIntervalMs: 5
    });

    const first = await service.requestReviewGate(tmpRepo, "demo-task", "architecture-plan");
    const firstRequestId = first.record.requestId!;
    await lateReadStarted;

    const retryWhileRunning = await service.retryReviewGate(tmpRepo, "demo-task", "architecture-plan");
    expect(retryWhileRunning.status).toBe("running");
    expect(retryWhileRunning.record.requestId).toBe(firstRequestId);
    await expect(service.updateSettings(tmpRepo, "demo-task", {
      gates: { "architecture-plan": false }
    })).rejects.toMatchObject({ code: "GATE_REVIEW_RUNNING" });
    await expect(service.cancelReviewGate(tmpRepo, "demo-task", "architecture-plan", {
      requestId: "stale-request-id",
      reason: "Wrong request"
    })).rejects.toMatchObject({ code: "GATE_REVIEW_REQUEST_MISMATCH" });

    const cancelled = await service.cancelReviewGate(tmpRepo, "demo-task", "architecture-plan", {
      requestId: firstRequestId,
      reason: "Replace obsolete inputs"
    });
    expect(cancelled.activeGate).toBeNull();
    expect(cancelled.gates["architecture-plan"].status).toBe("pending");
    expect(sessionStarts).toContain("restart:reviewer");

    await writeFile(
      path.join(taskWorktree(tmpRepo), ".ai/vcm/handoffs/architecture-plan.md"),
      validArchitecturePlan().replace("One scoped change.", "Replacement scoped change."),
      "utf8"
    );
    const second = await service.requestReviewGate(tmpRepo, "demo-task", "architecture-plan");
    const secondRequestId = second.record.requestId!;
    expect(secondRequestId).not.toBe(firstRequestId);
    await waitFor(async () => {
      const state = await service.getState(tmpRepo!, "demo-task");
      return state.gates["architecture-plan"].status === "completed";
    });

    releaseLateRead?.();
    await waitFor(async () => {
      const request = JSON.parse(await readFile(
        path.join(taskWorktree(tmpRepo!), ".ai/vcm/gate-reviews/requests", `${firstRequestId}.json`),
        "utf8"
      ));
      return request.status === "stale_completion";
    });

    const finalState = await service.getState(tmpRepo, "demo-task");
    expect(finalState.activeGate).toBeNull();
    expect(finalState.gates["architecture-plan"]).toMatchObject({
      requestId: secondRequestId,
      status: "completed",
      decision: "approve"
    });
    const stableReport = await readFile(
      path.join(taskWorktree(tmpRepo), ".ai/vcm/gate-reviews/architecture-plan-review.md"),
      "utf8"
    );
    expect(stableReport).toContain(`Request: ${secondRequestId}`);
    expect(stableReport).not.toContain(`Request: ${firstRequestId}`);
    expect(writes.filter((value) => value.includes("[VCM GATE REVIEW CALLBACK]")).length).toBe(1);
  });

  it("does not start Reviewer when the project switch is disabled", async () => {
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

  it("does not start architecture-plan review before the architecture brief is confirmed", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-unconfirmed-brief-"));
    await writeHarnessFiles(tmpRepo);
    await writeFile(
      path.join(taskWorktree(tmpRepo), ".ai/vcm/handoffs/architecture-brief.md"),
      validArchitectureBrief().replace("Architecture Brief Status: confirmed", "Architecture Brief Status: interviewing"),
      "utf8"
    );
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

    expect(result.status).toBe("failed_to_start");
    expect(result.message).toContain("architecture-brief.md is not confirmed");
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

  it("does not start validation-adequacy review for in-progress Tester evidence", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-incomplete-report-"));
    await writeHarnessFiles(tmpRepo);
    await writeFile(
      path.join(taskWorktree(tmpRepo), ".ai/vcm/handoffs/test-report.md"),
      incompleteTestReport(),
      "utf8"
    );
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

    expect(result.status).toBe("failed_to_start");
    expect(result.message).toContain(
      ".ai/vcm/handoffs/test-report.md is incomplete and cannot start validation-adequacy review"
    );
    expect(state.gates["validation-adequacy"].status).toBe("failed");
    expect(sessionStarts).toEqual([]);
  });

  it.each(["repair-required", "production-change-required"] as const)(
    "does not start validation-adequacy review while test infrastructure is %s",
    async (status) => {
      tmpRepo = await mkdtemp(path.join(os.tmpdir(), `vcm-gate-review-test-infrastructure-${status}-`));
      await writeHarnessFiles(tmpRepo);
      await writeFile(
        path.join(taskWorktree(tmpRepo), ".ai/vcm/handoffs/test-report.md"),
        testInfrastructureFailureReport(status),
        "utf8"
      );
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

      expect(result.status).toBe("failed_to_start");
      expect(result.message).toContain(`Test Infrastructure Status is ${status}`);
      expect(sessionStarts).toEqual([]);
    }
  );

  it("invalidates validation-adequacy approval when current code or test evidence changes", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-report-hash-"));
    await writeHarnessFiles(tmpRepo);
    const taskRoot = taskWorktree(tmpRepo);
    await writeFile(path.join(taskRoot, ".ai/vcm/handoffs/test-report.md"), validTestReport(), "utf8");
    let trackedEvidence = "100644 blob-a 0\tsrc/feature.ts\n100644 test-a 0\ttests/feature.test.ts\n";
    const writes: string[] = [];
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, [], {
        "ls-files -s -- . :(exclude).ai/vcm/** :(exclude)docs/**": () => trackedEvidence
      }),
      runtime: createRuntime(tmpRepo, writes, "approve"),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["validation-adequacy"]),
      sessionService: createSessionService(),
      roundService: createRoundService(),
      reportPollIntervalMs: 5
    });

    expect((await service.requestReviewGate(tmpRepo, "demo-task", "validation-adequacy")).status).toBe("started");
    await waitFor(async () => (await service.getState(tmpRepo!, "demo-task")).gates["validation-adequacy"].status === "completed");
    expect((await service.requestReviewGate(tmpRepo, "demo-task", "validation-adequacy")).status).toBe("already_approved");
    expect(writes.find((write) => write.includes("Gate: validation-adequacy"))).toContain(
      "Complete every Validation Analysis field"
    );

    trackedEvidence = "100644 blob-b 0\tsrc/feature.ts\n100644 test-b 0\ttests/feature.test.ts\n";
    expect((await service.requestReviewGate(tmpRepo, "demo-task", "validation-adequacy")).status).toBe("started");
    await waitFor(async () => (await service.getState(tmpRepo!, "demo-task")).gates["validation-adequacy"].status === "completed");
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
      reportPollIntervalMs: 5
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
      "Gate: architecture-plan\nRequest: manual-request\nDecision: approve\nSummary: Format only.\n\n## Findings\n\nNone.\n",
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

  it("rejects validation reports without complete validation analysis", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-validation-contract-"));
    await writeHarnessFiles(tmpRepo);
    const taskRoot = taskWorktree(tmpRepo);
    await writeFile(path.join(taskRoot, ".ai/vcm/handoffs/test-report.md"), validTestReport(), "utf8");
    const reportDir = path.join(taskRoot, ".ai/vcm/gate-reviews");
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, "validation-adequacy-review.md"),
      "Gate: validation-adequacy\nRequest: manual-request\nDecision: approve\nSummary: Test report says pass.\n\n## Findings\n\nNone.\n",
      "utf8"
    );
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, []),
      runtime: createRuntime(tmpRepo, []),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["validation-adequacy"]),
      sessionService: createSessionService(),
      roundService: createRoundService()
    });

    await expect(service.readReport(tmpRepo, "demo-task", "validation-adequacy")).rejects.toMatchObject({
      code: "GATE_REVIEW_VALIDATION_ANALYSIS_MISSING"
    });
  });

  it("rejects code-diff reports without complete code analysis", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-code-analysis-contract-"));
    await writeHarnessFiles(tmpRepo);
    const reportDir = path.join(taskWorktree(tmpRepo), ".ai/vcm/gate-reviews");
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, "code-diff-review.md"),
      "Gate: code-diff\nRequest: manual-request\nDecision: approve\nSummary: Diff looks good.\n\n## Findings\n\nNone.\n",
      "utf8"
    );
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, []),
      runtime: createRuntime(tmpRepo, []),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["code-diff"]),
      sessionService: createSessionService(),
      roundService: createRoundService()
    });

    await expect(service.readReport(tmpRepo, "demo-task", "code-diff")).rejects.toMatchObject({
      code: "GATE_REVIEW_CODE_DIFF_ANALYSIS_MISSING"
    });
  });

  it("requires code-diff findings to identify a file and line or symbol", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-code-finding-location-"));
    await writeHarnessFiles(tmpRepo);
    const reportDir = path.join(taskWorktree(tmpRepo), ".ai/vcm/gate-reviews");
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, "code-diff-review.md"),
      [
        "Gate: code-diff",
        "Request: manual-request",
        "Decision: request_changes",
        "Summary: A code issue was found.",
        "",
        ...codeDiffAnalysisLines(),
        "## Findings",
        "",
        "### high: Unlocated code issue",
        "- Finding Scope: implementation",
        "- Evidence: changed behavior is wrong",
        "- Expected: behavior follows the contract",
        "- Gap: implementation contradicts the contract",
        "- Risk: runtime failure",
        ""
      ].join("\n"),
      "utf8"
    );
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, []),
      runtime: createRuntime(tmpRepo, []),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["code-diff"]),
      sessionService: createSessionService(),
      roundService: createRoundService()
    });

    await expect(service.readReport(tmpRepo, "demo-task", "code-diff")).rejects.toMatchObject({
      code: "GATE_REVIEW_CODE_DIFF_FINDING_LOCATION_MISSING"
    });
  });

  it("requires code-diff findings to classify their affected scope", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-code-finding-scope-"));
    await writeHarnessFiles(tmpRepo);
    const reportDir = path.join(taskWorktree(tmpRepo), ".ai/vcm/gate-reviews");
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, "code-diff-review.md"),
      [
        "Gate: code-diff",
        "Request: manual-request",
        "Decision: request_changes",
        "Summary: A code issue was found.",
        "",
        ...codeDiffAnalysisLines(),
        "## Findings",
        "",
        "### high: Unclassified code issue",
        "- File: tests/e2e/runner.sh",
        "- Line Or Symbol: run_drill",
        "- Evidence: the runner exits before checking the healthy result",
        "- Expected: the runner reaches the final assertion",
        "- Gap: the zero-count path aborts under pipefail",
        "- Risk: healthy behavior cannot be validated",
        ""
      ].join("\n"),
      "utf8"
    );
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, []),
      runtime: createRuntime(tmpRepo, []),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["code-diff"]),
      sessionService: createSessionService(),
      roundService: createRoundService()
    });

    await expect(service.readReport(tmpRepo, "demo-task", "code-diff")).rejects.toMatchObject({
      code: "GATE_REVIEW_CODE_DIFF_FINDING_LOCATION_MISSING",
      message: expect.stringContaining("Finding Scope")
    });
  });

  it("rejects validation approval when Tester evidence is incomplete", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-validation-input-"));
    await writeHarnessFiles(tmpRepo);
    const taskRoot = taskWorktree(tmpRepo);
    await writeFile(
      path.join(taskRoot, ".ai/vcm/handoffs/test-report.md"),
      "# Test Report\n\nTest Result: pass\n",
      "utf8"
    );
    const reportDir = path.join(taskRoot, ".ai/vcm/gate-reviews");
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, "validation-adequacy-review.md"),
      [
        "Gate: validation-adequacy",
        "Request: manual-request",
        "Decision: approve",
        "Summary: The incomplete report claims pass.",
        "",
        ...validationAnalysisLines(),
        "## Findings",
        "",
        "None.",
        ""
      ].join("\n"),
      "utf8"
    );
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, []),
      runtime: createRuntime(tmpRepo, []),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["validation-adequacy"]),
      sessionService: createSessionService(),
      roundService: createRoundService()
    });

    await expect(service.readReport(tmpRepo, "demo-task", "validation-adequacy")).rejects.toMatchObject({
      code: "GATE_REVIEW_VALIDATION_INPUT_INCOMPLETE"
    });
  });

  it("accepts validation approval for a user-approved failed coverage gap", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-approved-gap-"));
    await writeHarnessFiles(tmpRepo);
    const taskRoot = taskWorktree(tmpRepo);
    await writeFile(
      path.join(taskRoot, ".ai/vcm/handoffs/test-report.md"),
      approvedGapTestReport(),
      "utf8"
    );
    const reportDir = path.join(taskRoot, ".ai/vcm/gate-reviews");
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, "validation-adequacy-review.md"),
      [
        "Gate: validation-adequacy",
        "Request: manual-request",
        "Decision: approve",
        "Summary: The failed result and exact user-approved gap are fully recorded.",
        "",
        ...validationAnalysisLines().map((line) => line === "- User Approval And Gap Disposition: none"
          ? "- User Approval And Gap Disposition: exact user approval matches the retained gap"
          : line),
        "## Findings",
        "",
        "None.",
        ""
      ].join("\n"),
      "utf8"
    );
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, []),
      runtime: createRuntime(tmpRepo, []),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["validation-adequacy"]),
      sessionService: createSessionService(),
      roundService: createRoundService()
    });

    await expect(service.readReport(tmpRepo, "demo-task", "validation-adequacy")).resolves.toMatchObject({
      gate: "validation-adequacy",
      decision: "approve"
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
      "show --format= --name-only --find-renames abc1234": "src/feature.ts",
      "show --format= --stat --find-renames abc1234": " src/feature.ts | 10 +++++",
      "show --format= --binary --find-renames abc1234": "diff --git a/src/feature.ts b/src/feature.ts\n",
      "show --format= --name-only --find-renames bcd2345": "tests/feature.test.ts",
      "show --format= --stat --find-renames bcd2345": " tests/feature.test.ts | 8 ++++",
      "show --format= --binary --find-renames bcd2345": "diff --git a/tests/feature.test.ts b/tests/feature.test.ts\n"
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
      reportPollIntervalMs: 5
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
    expect(prompt).toContain("Code sources: coder");
    expect(prompt).toContain("Complete every Code Diff Analysis field");
    expect(prompt).toContain("- .ai/vcm/handoffs/coder-completion.md");
    expect(prompt).toContain("- .ai/vcm/handoffs/test-report.md");
    expect(prompt).toContain("- .ai/vcm/gate-reviews/validation-adequacy-review.md");
    expect(prompt).toContain("Reviewable commits:");
    expect(prompt).toContain("- abc1234 implement route");
    expect(prompt).toContain("git show --find-renames abc1234");
    expect(runnerCalls.some((call) => call.args.join(" ") === "show --format= --binary --find-renames abc1234")).toBe(true);
  });

  it("excludes Harness commits from mixed code-diff input", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-harness-filter-"));
    await writeHarnessFiles(tmpRepo);
    const runnerCalls: Array<{ command: string; args: string[]; options?: CommandRunnerOptions }> = [];
    const runner = createRunner(tmpRepo, runnerCalls, {
      "rev-parse HEAD": ({ cwd }) => cwd === tmpRepo ? "base-sha" : "head-sha",
      "merge-base --is-ancestor base-sha head-sha": "",
      "log --oneline --reverse base-sha..head-sha": [
        "abc1234 implement route",
        "har1234 [VCM Harness] Update rust-analyzer configuration",
        "bcd2345 add tests",
        "near123 [VCM harness] Lowercase marker is ordinary"
      ].join("\n"),
      "show --format= --name-only --find-renames abc1234": "src/feature.ts",
      "show --format= --stat --find-renames abc1234": " src/feature.ts | 4 ++",
      "show --format= --binary --find-renames abc1234": "diff --git a/src/feature.ts b/src/feature.ts\n",
      "show --format= --name-only --find-renames bcd2345": "tests/feature.test.ts",
      "show --format= --stat --find-renames bcd2345": " tests/feature.test.ts | 4 ++",
      "show --format= --binary --find-renames bcd2345": "diff --git a/tests/feature.test.ts b/tests/feature.test.ts\n",
      "show --format= --name-only --find-renames near123": "docs/note.md",
      "show --format= --stat --find-renames near123": " docs/note.md | 1 +",
      "show --format= --binary --find-renames near123": "diff --git a/docs/note.md b/docs/note.md\n"
    });
    const writes: string[] = [];
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner,
      runtime: createRuntime(tmpRepo, writes, "approve"),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["code-diff"]),
      sessionService: createSessionService(),
      roundService: createRoundService(),
      reportPollIntervalMs: 5
    });

    expect((await service.requestReviewGate(tmpRepo, "demo-task", "code-diff", {
      codeDiffSource: "coder"
    })).status).toBe("started");
    await waitFor(async () => (await service.getState(tmpRepo!, "demo-task")).gates["code-diff"].status === "completed");

    const record = (await service.getState(tmpRepo, "demo-task")).gates["code-diff"];
    expect(record.commits).toEqual([
      "abc1234 implement route",
      "bcd2345 add tests",
      "near123 [VCM harness] Lowercase marker is ordinary"
    ]);
    expect(record.changedFiles).toEqual(["src/feature.ts", "tests/feature.test.ts", "docs/note.md"]);
    const prompt = writes.find((write) => write.includes("[VCM GATE REVIEW]")) ?? "";
    expect(prompt).not.toContain("har1234");
    expect(prompt).not.toContain("rust-analyzer");
    expect(runnerCalls.some((call) => call.args.includes("har1234"))).toBe(false);
  });

  it("advances the code-diff checkpoint when a range contains only Harness commits", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-harness-only-"));
    await writeHarnessFiles(tmpRepo);
    let head = "harness-head";
    const sessionStarts: string[] = [];
    const runner = createRunner(tmpRepo, [], {
      "rev-parse HEAD": ({ cwd }) => cwd === tmpRepo ? "base-sha" : head,
      "merge-base --is-ancestor base-sha harness-head": "",
      "merge-base --is-ancestor harness-head code-head": "",
      "log --oneline --reverse base-sha..harness-head": "har1234 [VCM Harness] Refresh harness",
      "log --oneline --reverse harness-head..code-head": "abc1234 implement route",
      "show --format= --name-only --find-renames abc1234": "src/feature.ts",
      "show --format= --stat --find-renames abc1234": " src/feature.ts | 4 ++",
      "show --format= --binary --find-renames abc1234": "diff --git a/src/feature.ts b/src/feature.ts\n"
    });
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner,
      runtime: createRuntime(tmpRepo, [], "approve"),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["code-diff"]),
      sessionService: createSessionService(sessionStarts),
      roundService: createRoundService(),
      reportPollIntervalMs: 5
    });

    const harnessOnly = await service.requestReviewGate(tmpRepo, "demo-task", "code-diff", {
      codeDiffSource: "coder"
    });
    expect(harnessOnly.status).toBe("not_required");
    expect(harnessOnly.message).toBe("No non-Harness commits to review.");
    expect(harnessOnly.record).toMatchObject({
      status: "not_required",
      baseCommit: "base-sha",
      headCommit: "harness-head",
      commits: [],
      changedFiles: []
    });
    expect(sessionStarts).toEqual([]);

    head = "code-head";
    const codeReview = await service.requestReviewGate(tmpRepo, "demo-task", "code-diff", {
      codeDiffSource: "coder"
    });
    expect(codeReview.status).toBe("started");
    expect(codeReview.record.baseCommit).toBe("harness-head");
    await waitFor(async () => (await service.getState(tmpRepo!, "demo-task")).gates["code-diff"].status === "completed");
  });

  it.each<CodeDiffSource>(["coder", "architect-debug", "architect-diagnosis"])(
    "does not start %s code-diff before Tester writes a terminal test report",
    async (codeDiffSource) => {
      tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-code-diff-no-test-report-"));
      await writeHarnessFiles(tmpRepo);
      await rm(path.join(taskWorktree(tmpRepo), ".ai/vcm/handoffs/test-report.md"), { force: true });
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

      const result = await service.requestReviewGate(tmpRepo, "demo-task", "code-diff", {
        codeDiffSource
      });

      expect(result.status).toBe("failed_to_start");
      expect(result.message).toContain("code-diff requires completed Tester validation");
      expect(result.message).toContain("test-report.md is incomplete");
      expect(sessionStarts).toEqual([]);
    }
  );

  it("requires current validation-adequacy approval before code-diff when that gate is enabled", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-code-diff-validation-order-"));
    await writeHarnessFiles(tmpRepo);
    const runner = createRunner(tmpRepo, [], {
      "rev-parse HEAD": ({ cwd }) => cwd === tmpRepo ? "base-sha" : "head-sha",
      "merge-base --is-ancestor base-sha head-sha": "",
      "log --oneline --reverse base-sha..head-sha": "abc1234 implement route\nbcd2345 add tests",
      "show --format= --name-only --find-renames abc1234": "src/feature.ts",
      "show --format= --stat --find-renames abc1234": " src/feature.ts | 2 +",
      "show --format= --binary --find-renames abc1234": "diff --git a/src/feature.ts b/src/feature.ts\n",
      "show --format= --name-only --find-renames bcd2345": "tests/feature.test.ts",
      "show --format= --stat --find-renames bcd2345": " tests/feature.test.ts | 2 +",
      "show --format= --binary --find-renames bcd2345": "diff --git a/tests/feature.test.ts b/tests/feature.test.ts\n"
    });
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner,
      runtime: createRuntime(tmpRepo, [], "approve"),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["validation-adequacy", "code-diff"]),
      sessionService: createSessionService(),
      roundService: createRoundService(),
      reportPollIntervalMs: 5
    });

    const premature = await service.requestReviewGate(tmpRepo, "demo-task", "code-diff", {
      codeDiffSource: "coder"
    });
    expect(premature.status).toBe("failed_to_start");
    expect(premature.message).toContain("validation-adequacy Gate to complete successfully");

    expect((await service.requestReviewGate(tmpRepo, "demo-task", "validation-adequacy")).status).toBe("started");
    await waitFor(async () => {
      const record = (await service.getState(tmpRepo!, "demo-task")).gates["validation-adequacy"];
      return record.status === "completed" && record.decision === "approve";
    });

    expect((await service.requestReviewGate(tmpRepo, "demo-task", "code-diff", {
      codeDiffSource: "coder"
    })).status).toBe("started");
    await waitFor(async () => {
      const record = (await service.getState(tmpRepo!, "demo-task")).gates["code-diff"];
      return record.status === "completed" && record.decision === "approve";
    });
  });

  it("rejects code-diff when Tester evidence changes after validation-adequacy approval", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-code-diff-stale-validation-"));
    await writeHarnessFiles(tmpRepo);
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner: createRunner(tmpRepo, [], {
        "rev-parse HEAD": ({ cwd }) => cwd === tmpRepo ? "base-sha" : "head-sha",
        "merge-base --is-ancestor base-sha head-sha": "",
        "log --oneline --reverse base-sha..head-sha": "abc1234 implement route",
        "show --format= --name-only --find-renames abc1234": "src/feature.ts",
        "show --format= --stat --find-renames abc1234": " src/feature.ts | 4 ++",
        "show --format= --binary --find-renames abc1234": "diff --git a/src/feature.ts b/src/feature.ts\n"
      }),
      runtime: createRuntime(tmpRepo, [], "approve"),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["validation-adequacy", "code-diff"]),
      sessionService: createSessionService(),
      roundService: createRoundService(),
      reportPollIntervalMs: 5
    });

    expect((await service.requestReviewGate(tmpRepo, "demo-task", "validation-adequacy")).status).toBe("started");
    await waitFor(async () => {
      const record = (await service.getState(tmpRepo!, "demo-task")).gates["validation-adequacy"];
      return record.status === "completed" && record.decision === "approve";
    });
    await writeFile(
      path.join(taskWorktree(tmpRepo), ".ai/vcm/handoffs/test-report.md"),
      validTestReport().replace("npm test -- feature.test.ts: pass.", "npm test -- feature.test.ts --runInBand: pass."),
      "utf8"
    );

    const result = await service.requestReviewGate(tmpRepo, "demo-task", "code-diff", {
      codeDiffSource: "coder"
    });
    expect(result.status).toBe("failed_to_start");
    expect(result.message).toContain("current validation-adequacy approval");
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
      "show --format= --name-only --find-renames abc1234": "src/feature.ts",
      "show --format= --stat --find-renames abc1234": " src/feature.ts | 2 +-",
      "show --format= --binary --find-renames abc1234": "diff --git a/src/feature.ts b/src/feature.ts\n"
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
      reportPollIntervalMs: 5
    });

    const result = await service.requestReviewGate(tmpRepo, "demo-task", "code-diff", {
      codeDiffSource: "architect-debug"
    });

    expect(result.status).toBe("started");
    await waitFor(async () => (await service.getState(tmpRepo!, "demo-task")).gates["code-diff"].status === "completed");
    const prompt = writes.find((write) => write.includes("[VCM GATE REVIEW]")) ?? "";
    expect(prompt).toContain("Code sources: architect-debug");
    expect(prompt).toContain("- .ai/vcm/handoffs/role-commands/architect.md");
    expect(prompt).toContain("- .ai/vcm/handoffs/architect-debug.md");
    expect(prompt).not.toContain("- .ai/vcm/handoffs/coder-completion.md");
  });

  it("uses the diagnosis artifact for architect-diagnosis code diffs", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-diagnosis-source-"));
    await writeHarnessFiles(tmpRepo);
    await writeFile(
      path.join(taskWorktree(tmpRepo), ".ai/vcm/handoffs/architecture-diagnosis.md"),
      validArchitectureDiagnosis(),
      "utf8"
    );
    const runner = createRunner(tmpRepo, [], {
      "rev-parse HEAD": ({ cwd }) => cwd === tmpRepo ? "base-sha" : "head-sha",
      "merge-base --is-ancestor base-sha head-sha": "",
      "log --oneline --reverse base-sha..head-sha": "abc1234 repair ownership",
      "show --format= --name-only --find-renames abc1234": "src/feature.ts",
      "show --format= --stat --find-renames abc1234": " src/feature.ts | 8 ++++----",
      "show --format= --binary --find-renames abc1234": "diff --git a/src/feature.ts b/src/feature.ts\n"
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
      reportPollIntervalMs: 5
    });

    const result = await service.requestReviewGate(tmpRepo, "demo-task", "code-diff", {
      codeDiffSource: "architect-diagnosis"
    });

    expect(result.status).toBe("started");
    await waitFor(async () => (await service.getState(tmpRepo!, "demo-task")).gates["code-diff"].status === "completed");
    const prompt = writes.find((write) => write.includes("[VCM GATE REVIEW]")) ?? "";
    expect(prompt).toContain("Code sources: architect-diagnosis");
    expect(prompt).toContain("- .ai/vcm/handoffs/architecture-diagnosis.md");
    expect(prompt).not.toContain("- .ai/vcm/handoffs/role-commands/architect.md");
  });

  it("retains original evidence sources when rejected code is fixed by Architect", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-gate-review-source-chain-"));
    await writeHarnessFiles(tmpRepo);
    let head = "coder-head";
    const writes: string[] = [];
    const runner = createRunner(tmpRepo, [], {
      "rev-parse HEAD": ({ cwd }) => cwd === tmpRepo ? "base-sha" : head,
      "merge-base --is-ancestor base-sha coder-head": "",
      "merge-base --is-ancestor base-sha debug-head": "",
      "log --oneline --reverse base-sha..coder-head": "abc1234 implement feature",
      "log --oneline --reverse base-sha..debug-head": "abc1234 implement feature\ndef5678 fix rejected code",
      "show --format= --name-only --find-renames abc1234": "src/feature.ts",
      "show --format= --stat --find-renames abc1234": " src/feature.ts | 8 +++++---",
      "show --format= --binary --find-renames abc1234": "diff --git a/src/feature.ts b/src/feature.ts\n+coder\n",
      "show --format= --name-only --find-renames def5678": "src/feature.ts",
      "show --format= --stat --find-renames def5678": " src/feature.ts | 2 +-",
      "show --format= --binary --find-renames def5678": "diff --git a/src/feature.ts b/src/feature.ts\n+debug\n"
    });
    const service = createGateReviewService({
      fs: createNodeFileSystemAdapter(),
      runner,
      runtime: createRuntime(tmpRepo, writes),
      projectService: createProjectService(),
      taskService: createTaskService(tmpRepo),
      appSettings: createAppSettings(["code-diff"]),
      sessionService: createSessionService(),
      roundService: createRoundService(),
      reportPollIntervalMs: 5
    });

    expect((await service.requestReviewGate(tmpRepo, "demo-task", "code-diff", {
      codeDiffSource: "coder"
    })).status).toBe("started");
    await waitFor(async () => (await service.getState(tmpRepo!, "demo-task")).gates["code-diff"].status === "completed");

    head = "debug-head";
    expect((await service.requestReviewGate(tmpRepo, "demo-task", "code-diff", {
      codeDiffSource: "architect-debug"
    })).status).toBe("started");
    await waitFor(async () => (await service.getState(tmpRepo!, "demo-task")).gates["code-diff"].status === "completed");

    const record = (await service.getState(tmpRepo, "demo-task")).gates["code-diff"];
    expect(record.baseCommit).toBe("base-sha");
    expect(record.codeDiffSources).toEqual(["coder", "architect-debug"]);
    const prompt = writes.filter((write) => write.includes("[VCM GATE REVIEW]")).at(-1) ?? "";
    expect(prompt).toContain("Code sources: coder -> architect-debug");
    expect(prompt).toContain("- .ai/vcm/handoffs/coder-completion.md");
    expect(prompt).toContain("- .ai/vcm/handoffs/architect-debug.md");
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
  await writeFile(path.join(repoRoot, ".claude/agents/reviewer.md"), "# VCM Reviewer\n", "utf8");
  await writeFile(path.join(taskRepoRoot, "CLAUDE.md"), "# CLAUDE\n", "utf8");
  await writeFile(path.join(taskRepoRoot, ".claude/agents/reviewer.md"), "# VCM Reviewer\n", "utf8");
  await writeFile(path.join(taskRepoRoot, ".claude/skills/vcm-gate-review/SKILL.md"), "# Gate Review Skill\n", "utf8");
  await writeFile(path.join(taskRepoRoot, ".ai/tools/request-gate-review"), "#!/usr/bin/env python3\n", "utf8");
  await writeFile(path.join(taskRepoRoot, ".ai/vcm/handoffs/architecture-brief.md"), validArchitectureBrief(), "utf8");
  await writeFile(
    path.join(taskRepoRoot, ".ai/vcm/handoffs/architecture-evidence.md"),
    validArchitectureEvidence(),
    "utf8"
  );
  await writeFile(path.join(taskRepoRoot, ".ai/vcm/handoffs/architecture-plan.md"), validArchitecturePlan(), "utf8");
  await writeFile(path.join(taskRepoRoot, ".ai/vcm/handoffs/coder-completion.md"), validCoderCompletion(), "utf8");
  await writeFile(path.join(taskRepoRoot, ".ai/vcm/handoffs/architect-debug.md"), validArchitectDebug(), "utf8");
  await writeFile(path.join(taskRepoRoot, ".ai/vcm/handoffs/architecture-diagnosis.md"), validArchitectureDiagnosis(), "utf8");
  await writeFile(path.join(taskRepoRoot, ".ai/vcm/handoffs/test-report.md"), validTestReport(), "utf8");
}

function validArchitectureEvidence(): string {
  return `# Architecture Evidence: demo-task

Architecture Evidence Status: complete

## Planning Boundary
Feature boundary.

## Entry Points And Behavior Paths
Entry to completion.

## State And Lifecycle
Owned state lifecycle.

## Callers And Consumers
Current callers and consumers.

## Existing Assumptions
Verified assumptions.

## Related Class Inventories
Complete related class inventory.

## External Boundaries
No external boundary change.

## Code And Docs Conflicts
None.

## Evidence Commands
LSP and source reads.
`;
}

function validArchitecturePlan(): string {
  return `# Architecture Plan: demo-task

Planning Result: complete

## Accepted Scope
Deliver the accepted behavior.

## Current Code Reality

### Planning Boundary
Feature boundary.

### Code Reading Evidence
Current implementation and callers were read.

### Existing Behavior Trace
Entry to completion.

### Code / Docs Conflicts
None.

## Architecture Decision

### Changed Behavior Flow
Entry to owner to completion.

### Ownership
Existing service owns state.

### Data Flow
Request to service to result.

### Lifecycle
Start, completion, and failure are explicit.

### Boundaries
Existing module boundary.

### Invariants
Single source of truth.

### Failure Model
Errors propagate to the caller.

### Decision Rationale
Use the existing boundary.

## Module/File Plan
One scoped change.

## Public Surface Impact
None.

## Scaffold Manifest
No scaffold items.

## Scaffold Build Evidence
Compile check passed at scaffold commit.

## Tester Coverage Hints
Cover changed behavior.

## Docs Impact
None.

## Known Risks
None.

## Coder Handoff Notes
Implement the plan.
`;
}

function validCoderCompletion(): string {
  return `# Coder Completion: demo-task

Decision: ready_for_review

## Scaffold Completion
All items complete.

## Changed Files
src/feature.ts

## Private Helpers Added
None.

## Manifest Deviations
None.

## Generated Context
Current.

## Baseline Tests Added Or Updated
tests/feature.test.ts

## L0/L1 Validation
Passed.

## Worker Results
None.

## Objective Failures
None.
`;
}

function validArchitectDebug(): string {
  return `# Architect Debug: demo-task

Status: completed

## PM-Routed Failure
Tester failure.

## Confirmed Root Cause
Confirmed root cause.

## Implementation
Implemented fix.

## Changed Files And Public Surface
src/feature.ts; no public surface change.

## Baseline Tests
Updated.

## Diagnostic And L0/L1 Validation
Passed.

## L2/L3 Validation
Applicable checks passed.

## Generated Context
Current.

## Remaining Failure Evidence
None.

## Final Disposition
Ready for Tester.
`;
}

function validArchitectureDiagnosis(): string {
  return `# Architecture Diagnosis: demo-task

## Diagnosis Boundary
Feature module.

## Documents And Runtime Evidence
Current evidence.

## Code Reading Closure
Complete.

## Current Architecture
Current ownership and flow.

## Previous Debug Failure
Recorded.

## Failure Trace
Entry to failure.

## Architecture Assessment
Broken ownership corrected.

## Required Architecture Direction
Restore single ownership.

## Implementation And Validation

### Changed Files And Public Surface
src/feature.ts; no public surface change.

### Baseline Tests
Updated.

### Diagnostic And L0/L1 Validation
Passed.

### L2/L3 Validation
Applicable checks passed.

### Generated Context
Current.

### Commit
abc1234

## Final Disposition
diagnosis implementation completed
`;
}

function validArchitectureBrief(): string {
  return [
    "# Architecture Brief: demo-task",
    "",
    "Architecture Brief Status: confirmed",
    "",
    "## Accepted Outcome",
    "",
    "Deliver the accepted behavior.",
    "",
    "## Confirmed User Decisions",
    "",
    "Preserve the current contract.",
    "",
    "## Existing Constraints",
    "",
    "Use the current worktree.",
    "",
    "## Unresolved User Decisions",
    "",
    "None.",
    "",
    "## User Confirmation",
    "",
    "Confirmed.",
    ""
  ].join("\n");
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
      const reportPath = /^Report:\s*(.+)$/m.exec(data)?.[1]?.trim()
        ?? path.join(taskWorktree(repoRoot), ".ai/vcm/gate-reviews/requests", `${requestId}.report.md`);
      const architectureAnalysis = gate === "architecture-plan"
        ? [
            "## Architecture Analysis",
            "",
            "- Evidence Read: architecture-plan.md, source files, and callers",
            "- Architecture Brief Fit: confirmed decisions are preserved",
            "- End-To-End Flow: entry to owner to completion",
            "- Scope Fit: accepted scope is covered",
            "- Code Reality: plan was compared with current code",
            "- Invalidated Assumptions: touched assumptions were checked",
            "- Existing-Class Completeness: related class members were reconstructed",
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
      const validationAnalysis = gate === "validation-adequacy"
        ? validationAnalysisLines()
        : [];
      const codeDiffAnalysis = gate === "code-diff"
        ? codeDiffAnalysisLines()
        : [];
      const findings = decision === "request_changes"
        ? [
            "## Findings",
            "",
            "### high: Missing proof point",
            ...(gate === "code-diff"
              ? ["- File: src/feature.ts", "- Line Or Symbol: feature", "- Finding Scope: implementation"]
              : []),
            "- Evidence: plan has no proof",
            "- Expected: proof point exists",
            "- Gap: no proof",
            "- Risk: coder ambiguity"
          ]
        : ["## Findings", "", "None."];
      void writeFile(
        reportPath,
        [
          `Gate: ${gate}`,
          `Request: ${requestId}`,
          `Decision: ${decision}`,
          decision === "request_changes" ? "Summary: Missing proof point." : "Summary: Approved.",
          "",
          ...architectureAnalysis,
          ...validationAnalysis,
          ...codeDiffAnalysis,
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
            role: sessionId === "gate-session" ? "reviewer" : "project-manager",
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
  const reviewerSession: RoleSessionRecord = {
    id: "gate-session",
    claudeSessionId: "gate-session-id",
    taskSlug: "demo-task",
    role: "reviewer",
    status: "running",
    activityStatus: "idle",
    command: "claude --agent reviewer",
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
      sessions.set(role, reviewerSession);
      return reviewerSession;
    },
    async startRoleSession(_repoRoot: string, _taskSlug: string, role: string) {
      starts.push(role);
      sessions.set(role, reviewerSession);
      return reviewerSession;
    },
    async restartRoleSession(_repoRoot: string, _taskSlug: string, role: string) {
      starts.push(`restart:${role}`);
      sessions.set(role, reviewerSession);
      return reviewerSession;
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

function validTestReport(): string {
  return [
    "# Test Report",
    "",
    "Test Result: pass",
    "",
    "## Evidence Reviewed",
    "src/feature.ts and tests/feature.test.ts.",
    "",
    "## Tests Added Or Updated",
    "tests/feature.test.ts.",
    "",
    "## Coverage Mapping",
    "Feature behavior -> L2 -> tests/feature.test.ts -> public entry path -> pass.",
    "",
    "## Validation Progress",
    "",
    "### Completed Validation",
    "L0, L1, and L2 completed.",
    "",
    "### Remaining Validation",
    "None.",
    "",
    "## L3 Coverage",
    "",
    "L3 Required: no",
    "",
    "### Trigger Assessment",
    "No mandatory L3 trigger applies.",
    "",
    "### Affected End-To-End Flows",
    "None.",
    "",
    "### L3 Commands And Evidence",
    "None.",
    "",
    "### Not-Required Evidence",
    "The fixture changes no externally observable end-to-end behavior, documented L3 path, lifecycle, external contract, or critical invariant; L2 completely proves it.",
    "",
    "## Commands Run Or Checked",
    "npm test -- feature.test.ts: pass.",
    "",
    "## Validation Results",
    "Pass.",
    "",
    "## Test Infrastructure",
    "",
    "Status: none",
    "",
    "### Affected Files",
    "None.",
    "",
    "### Boundary Evidence",
    "None.",
    "",
    "### Defect-Class Sweep",
    "None.",
    "",
    "### Repair Commit",
    "None.",
    "",
    "## Failed Expectations",
    "None.",
    "",
    "## Reproduction Steps",
    "None.",
    "",
    "## Skipped Checks With Reasons",
    "None.",
    "",
    "## Coverage Gaps",
    "None.",
    "",
    "## Blocking Validation Issues",
    "None.",
    "",
    "## User Approval Evidence",
    "None.",
    ""
  ].join("\n");
}

function testInfrastructureFailureReport(
  status: "repair-required" | "production-change-required"
): string {
  return validTestReport()
    .replace("Test Result: pass", "Test Result: fail")
    .replace("Status: none", `Status: ${status}`)
    .replace("### Affected Files\nNone.", "### Affected Files\ntests/e2e/runner.sh")
    .replace(
      "### Boundary Evidence\nNone.",
      "### Boundary Evidence\nThe failing path is isolated to the current test runner."
    )
    .replace(
      "### Defect-Class Sweep\nNone.",
      "### Defect-Class Sweep\nChecked every sibling runner using the same pipeline."
    )
    .replace(
      "## Blocking Validation Issues\nNone.",
      "## Blocking Validation Issues\nThe current test runner cannot validate its healthy path."
    );
}

function approvedGapTestReport(): string {
  return validTestReport()
    .replace("Test Result: pass", "Test Result: fail")
    .replace("## Coverage Gaps\nNone.", "## Coverage Gaps\nMissing live gateway coverage.")
    .replace(
      "## Blocking Validation Issues\nNone.",
      "## Blocking Validation Issues\nLive gateway validation remains unavailable."
    )
    .replace(
      "## User Approval Evidence\nNone.",
      "## User Approval Evidence\nUser approved retaining the live gateway coverage gap."
    );
}

function incompleteTestReport(): string {
  return validTestReport()
    .replace("Test Result: pass", "Test Result: incomplete")
    .replace(
      "### Remaining Validation\nNone.",
      "### Remaining Validation\nRun the remaining L2 integration matrix."
    );
}

function validationAnalysisLines(): string[] {
  return [
    "## Validation Analysis",
    "",
    "- Evidence Read: test report, implementation entry point, and actual tests",
    "- Changed Behavior And Risk: feature behavior and boundary risk",
    "- Coverage Mapping: behavior mapped to the named test case",
    "- Baseline Coverage: changed callable units covered",
    "- L2 Integration Coverage: required integration path covered",
    "- L3 Trigger Assessment: no mandatory L3 trigger",
    "- L3 End-To-End Coverage: not required",
    "- Boundary And Failure Coverage: relevant failure path covered",
    "- Public Contract Coverage: public behavior asserted",
    "- Test Integrity: real entry path and observable assertions inspected",
    "- Test Infrastructure: no unresolved test-infrastructure defect",
    "- Skips And Gaps: none",
    "- User Approval And Gap Disposition: none",
    "- Validation Readiness: ready",
    ""
  ];
}

function codeDiffAnalysisLines(): string[] {
  return [
    "## Code Diff Analysis",
    "",
    "- Commit Range And Sources: base-sha..head-sha from coder",
    "- Evidence Read: source evidence, diff, changed files, and callers",
    "- Changed Files And Symbols: src/feature.ts feature",
    "- Changed Behavior: feature behavior inspected",
    "- Source Evidence Fit: implementation matches governing evidence",
    "- Callers And Public Surface: callers and exports inspected",
    "- State Lifecycle And Failure Paths: applicable state and failures inspected",
    "- Coding Standards: project standards inspected",
    "- Baseline Test Integrity: changed tests and required baseline coverage inspected",
    "- Generated Context And Durable Docs: applicable context and docs inspected",
    "- Code Readiness: ready",
    ""
  ];
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
