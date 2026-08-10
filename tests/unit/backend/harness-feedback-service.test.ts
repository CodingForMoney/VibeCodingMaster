import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import type { TerminalRuntime, TerminalSession } from "../../../src/backend/runtime/terminal-runtime.js";
import { createHarnessFeedbackService } from "../../../src/backend/services/harness-feedback-service.js";
import type { RoleName } from "../../../src/shared/types/role.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";

let tmpRepo: string | undefined;

afterEach(async () => {
  if (tmpRepo) {
    await rm(tmpRepo, { recursive: true, force: true });
    tmpRepo = undefined;
  }
});

describe("harness-feedback-service", () => {
  it("lists pending feedback without dispatching it to Harness Engineer", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-harness-feedback-"));
    await mkdir(path.join(tmpRepo, ".ai/vcm/harness-feedback/pending"), { recursive: true });
    await writeFile(
      path.join(tmpRepo, ".ai/vcm/harness-feedback/pending/2026-01-01-coder-routing.md"),
      renderFeedback("Route message skill is unclear", "coder"),
      "utf8"
    );

    const writes: string[] = [];
    const service = createHarnessFeedbackService({
      fs: createNodeFileSystemAdapter(),
      runtime: createRuntime(writes),
      sessionService: createSessionService(),
      now: createClock()
    });

    const state = await service.getState(tmpRepo, "demo-task");

    expect(state.status).toBe("queued");
    expect(state.queuedCount).toBe(1);
    expect(state.pending[0]).toMatchObject({
      title: "Route message skill is unclear",
      reporterRole: "coder",
      taskSlug: "demo-task",
      source: "role-feedback"
    });
    expect(writes).toEqual([]);
  });

  it("sends one selected pending feedback to Harness Engineer without removing it", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-harness-feedback-send-"));
    const feedbackPath = ".ai/vcm/harness-feedback/pending/2026-01-01-coder-routing.md";
    await mkdir(path.join(tmpRepo, ".ai/vcm/harness-feedback/pending"), { recursive: true });
    await writeFile(
      path.join(tmpRepo, feedbackPath),
      renderFeedback("Route message skill is unclear", "coder"),
      "utf8"
    );

    const writes: string[] = [];
    const service = createHarnessFeedbackService({
      fs: createNodeFileSystemAdapter(),
      runtime: createRuntime(writes),
      sessionService: createSessionService(),
      now: createClock()
    });

    const session = await service.sendPendingFeedback(tmpRepo, {
      taskSlug: "demo-task",
      feedbackPath
    });

    expect(session.role).toBe("harness-engineer");
    expect(writes.join("\n")).toContain("[VCM Harness Feedback]");
    expect(writes.join("\n")).toContain(path.join(tmpRepo, feedbackPath));
    expect(writes.join("\n")).toContain("Report your findings and proposed changes to the user.");
    expect((await service.getState(tmpRepo)).queuedCount).toBe(1);
  });

  it("rejects a feedback path that is not in the pending Inbox", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-harness-feedback-invalid-"));
    const service = createHarnessFeedbackService({
      fs: createNodeFileSystemAdapter(),
      runtime: createRuntime([]),
      sessionService: createSessionService(),
      now: createClock()
    });

    await expect(service.sendPendingFeedback(tmpRepo, {
      taskSlug: "demo-task",
      feedbackPath: ".ai/vcm/harness-feedback/pending/missing.md"
    })).rejects.toThrow("no longer pending");
  });

  it("starts a task harness retrospective only after final acceptance is complete", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-harness-retrospective-"));
    const taskRepoRoot = path.join(tmpRepo, ".claude/worktrees/demo-task");
    await mkdir(path.join(taskRepoRoot, ".ai/vcm/handoffs"), { recursive: true });
    await writeFile(
      path.join(taskRepoRoot, ".ai/vcm/handoffs/final-acceptance.md"),
      renderFinalAcceptance("accepted"),
      "utf8"
    );

    const writes: string[] = [];
    const service = createHarnessFeedbackService({
      fs: createNodeFileSystemAdapter(),
      runtime: createRuntime(writes),
      sessionService: createSessionService(),
      now: createClock()
    });

    const state = await service.startTaskRetrospective(tmpRepo, {
      taskSlug: "demo-task",
      taskRepoRoot,
      handoffDir: ".ai/vcm/handoffs",
      trigger: "manual"
    });

    expect(state.status).toBe("idle");
    expect(writes.join("\n")).toContain("[VCM Task Harness Retrospective]");
    expect(writes.join("\n")).toContain("Review the completed task from the current active task worktree.");
    expect(writes.join("\n")).toContain(`Pending Feedback Directory: ${path.join(tmpRepo, ".ai/vcm/harness-feedback/pending")}`);
    expect(writes.join("\n")).toContain("Pending Feedback:\nnone");
    expect(writes.join("\n")).toContain("Write the analysis to Result Path:");
    expect(writes.join("\n")).toContain(".ai/vcm/harness-feedback/task-retrospectives/demo-task.md");
    expect(writes.join("\n")).toContain("Write the report directly to that path. Do not use vcm-artifact.");
    expect(writes.join("\n")).not.toContain("vcm-artifact retrospective-report");
    expect(writes.join("\n")).not.toContain("Auto Memory Review:");

    const marker = JSON.parse(await readFile(
      path.join(tmpRepo, ".ai/vcm/harness-feedback/task-retrospectives/demo-task.json"),
      "utf8"
    ));
    expect(marker).toMatchObject({
      taskSlug: "demo-task",
      trigger: "manual",
      status: "running",
      analysisPath: ".ai/vcm/harness-feedback/task-retrospectives/demo-task.md"
    });

    await writeFile(
      path.join(tmpRepo, ".ai/vcm/harness-feedback/task-retrospectives/demo-task.md"),
      `# Task Harness Retrospective: demo-task

## Findings
None.

## Feedback Dispositions
None.

## Recommended Harness Changes
None.

## VCM Issue Drafts
None.
`,
      "utf8"
    );
    await expect(service.handleTaskRetrospectiveHook(tmpRepo, {
      taskSlug: "demo-task",
      eventName: "Stop",
      memoryReviewStatus: "idle"
    })).resolves.toBe(true);
    const completedMarker = JSON.parse(await readFile(
      path.join(tmpRepo, ".ai/vcm/harness-feedback/task-retrospectives/demo-task.json"),
      "utf8"
    ));
    expect(completedMarker.status).toBe("completed");

    await expect(service.startTaskRetrospective(tmpRepo, {
      taskSlug: "demo-task",
      taskRepoRoot,
      handoffDir: ".ai/vcm/handoffs",
      trigger: "manual"
    })).rejects.toThrow("already been triggered");
  });

  it("includes Auto Memory review in the same task retrospective turn", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-harness-retrospective-memory-"));
    const taskRepoRoot = path.join(tmpRepo, ".claude/worktrees/demo-task");
    await mkdir(path.join(taskRepoRoot, ".ai/vcm/handoffs"), { recursive: true });
    await writeFile(
      path.join(taskRepoRoot, ".ai/vcm/handoffs/final-acceptance.md"),
      renderFinalAcceptance("accepted"),
      "utf8"
    );

    const writes: string[] = [];
    const service = createHarnessFeedbackService({
      fs: createNodeFileSystemAdapter(),
      runtime: createRuntime(writes),
      sessionService: createSessionService(),
      autoMemoryService: {
        async prepareTaskRetrospectiveReview() {
          return {
            runId: "memory-run",
            roleDraftsPath: path.join(taskRepoRoot, "memory-run/drafts"),
            currentMemoryPath: path.join(taskRepoRoot, "memory-run/before"),
            activeMemoryPaths: [
              path.join(taskRepoRoot, "CLAUDE.md"),
              path.join(taskRepoRoot, ".claude/agents/architect.md")
            ],
            proposalCandidates: [{
              id: "architect:add:1",
              source: "architect",
              operation: "add",
              target: "shared",
              content: "Backend hooks own lifecycle completion."
            }],
            reviewResultPath: path.join(taskRepoRoot, "memory-run/review-result.json"),
            planningCandidatePath: path.join(taskRepoRoot, "memory-run/architect-planning.md")
          };
        },
        async cancelTaskRetrospectiveReview() {
          return undefined;
        }
      },
      now: createClock()
    });

    await service.startTaskRetrospective(tmpRepo, {
      taskSlug: "demo-task",
      taskRepoRoot,
      handoffDir: ".ai/vcm/handoffs",
      trigger: "auto"
    });

    const prompt = writes.join("\n");
    expect(prompt).toContain("[VCM Task Harness Retrospective]");
    expect(prompt).toContain("Auto Memory Review:");
    expect(prompt).toContain(`Role drafts: ${path.join(taskRepoRoot, "memory-run/drafts")}`);
    expect(prompt).toContain(`Current memory snapshot: ${path.join(taskRepoRoot, "memory-run/before")}`);
    expect(prompt).toContain(`Architect planning-session candidate: ${path.join(taskRepoRoot, "memory-run/architect-planning.md")}`);
    expect(prompt).toContain(`- ${path.join(taskRepoRoot, "CLAUDE.md")}`);
    expect(prompt).toContain("Apply the reviewed result directly to the listed <VCM-memory> blocks");
    expect(prompt).toContain("commit only the changed active memory files with message [VCM Harness] Update VCM memory");
    expect(prompt).not.toContain("Write the complete reviewed memory set to:");
    expect(prompt).toContain("Before evaluating proposals, review every substantive entry in every current memory snapshot");
    expect(prompt).toContain("architect:add:1 | source=architect | operation=add");
    expect(prompt).toContain(`Write the complete machine-readable review to: ${path.join(taskRepoRoot, "memory-run/review-result.json")}`);
    expect(prompt).toContain("For every existing entry and proposal");
    expect(prompt).toContain("Durable document assignments: <count>");
    const marker = JSON.parse(await readFile(
      path.join(tmpRepo, ".ai/vcm/harness-feedback/task-retrospectives/demo-task.json"),
      "utf8"
    ));
    expect(marker).toMatchObject({ status: "running", memoryRunId: "memory-run" });
  });

  it("marks an incomplete retrospective failed and allows it to be started again", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-harness-retrospective-retry-"));
    const taskRepoRoot = path.join(tmpRepo, ".claude/worktrees/demo-task");
    await mkdir(path.join(taskRepoRoot, ".ai/vcm/handoffs"), { recursive: true });
    await writeFile(
      path.join(taskRepoRoot, ".ai/vcm/handoffs/final-acceptance.md"),
      renderFinalAcceptance("accepted"),
      "utf8"
    );
    const service = createHarnessFeedbackService({
      fs: createNodeFileSystemAdapter(),
      runtime: createRuntime([]),
      sessionService: createSessionService(),
      now: createClock()
    });

    await service.startTaskRetrospective(tmpRepo, {
      taskSlug: "demo-task",
      taskRepoRoot,
      handoffDir: ".ai/vcm/handoffs",
      trigger: "manual"
    });
    await service.handleTaskRetrospectiveHook(tmpRepo, {
      taskSlug: "demo-task",
      eventName: "Stop",
      memoryReviewStatus: "idle"
    });
    const failedMarker = JSON.parse(await readFile(
      path.join(tmpRepo, ".ai/vcm/harness-feedback/task-retrospectives/demo-task.json"),
      "utf8"
    ));
    expect(failedMarker).toMatchObject({
      status: "failed",
      error: "Harness Engineer did not write a valid Task Harness Retrospective report: Report is empty."
    });

    await expect(service.startTaskRetrospective(tmpRepo, {
      taskSlug: "demo-task",
      taskRepoRoot,
      handoffDir: ".ai/vcm/handoffs",
      trigger: "manual"
    })).resolves.toMatchObject({ version: 1 });
  });

  it("assigns every pending feedback file to Task Harness Retrospective", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-harness-retrospective-feedback-"));
    const taskRepoRoot = path.join(tmpRepo, ".claude/worktrees/demo-task");
    await mkdir(path.join(taskRepoRoot, ".ai/vcm/handoffs"), { recursive: true });
    await writeFile(
      path.join(taskRepoRoot, ".ai/vcm/handoffs/final-acceptance.md"),
      renderFinalAcceptance("accepted"),
      "utf8"
    );
    const pendingDir = path.join(tmpRepo, ".ai/vcm/harness-feedback/pending");
    await mkdir(pendingDir, { recursive: true });
    await writeFile(path.join(pendingDir, "02-tester.md"), renderFeedback("Tester feedback", "tester"), "utf8");
    await writeFile(path.join(pendingDir, "01-coder.md"), renderFeedback("Coder feedback", "coder"), "utf8");

    const writes: string[] = [];
    const service = createHarnessFeedbackService({
      fs: createNodeFileSystemAdapter(),
      runtime: createRuntime(writes),
      sessionService: createSessionService(),
      now: createClock()
    });

    await service.startTaskRetrospective(tmpRepo, {
      taskSlug: "demo-task",
      taskRepoRoot,
      handoffDir: ".ai/vcm/handoffs",
      trigger: "manual"
    });

    const prompt = writes.join("\n");
    expect(prompt).toContain(`Pending Feedback Directory: ${pendingDir}`);
    expect(prompt).toContain(`- ${path.join(pendingDir, "01-coder.md")}`);
    expect(prompt).toContain(`- ${path.join(pendingDir, "02-tester.md")}`);
    expect(prompt.indexOf("01-coder.md")).toBeLessThan(prompt.indexOf("02-tester.md"));
    expect(prompt).toContain("Record every disposition in the retrospective report");
    expect(prompt).toContain("### Feedback: <exact assigned absolute path>");
    expect(prompt).toContain("Do not edit or delete pending feedback files");
    expect(prompt).toContain("VCM removes the assigned files after validating every disposition");
    const marker = JSON.parse(await readFile(
      path.join(tmpRepo, ".ai/vcm/harness-feedback/task-retrospectives/demo-task.json"),
      "utf8"
    ));
    expect(marker.pendingFeedbackPaths).toEqual([
      ".ai/vcm/harness-feedback/pending/01-coder.md",
      ".ai/vcm/harness-feedback/pending/02-tester.md"
    ]);
  });

  it("removes only the feedback assigned when an accepted retrospective completes", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-harness-retrospective-cleanup-"));
    const taskRepoRoot = path.join(tmpRepo, ".claude/worktrees/demo-task");
    await mkdir(path.join(taskRepoRoot, ".ai/vcm/handoffs"), { recursive: true });
    await writeFile(
      path.join(taskRepoRoot, ".ai/vcm/handoffs/final-acceptance.md"),
      renderFinalAcceptance("accepted"),
      "utf8"
    );
    const pendingDir = path.join(tmpRepo, ".ai/vcm/harness-feedback/pending");
    await mkdir(pendingDir, { recursive: true });
    const assigned = ["01-coder.md", "02-tester.md"];
    for (const name of assigned) {
      await writeFile(path.join(pendingDir, name), renderFeedback(name, "coder"), "utf8");
    }
    const service = createHarnessFeedbackService({
      fs: createNodeFileSystemAdapter(),
      runtime: createRuntime([]),
      sessionService: createSessionService(),
      now: createClock()
    });

    await service.startTaskRetrospective(tmpRepo, {
      taskSlug: "demo-task",
      taskRepoRoot,
      handoffDir: ".ai/vcm/handoffs",
      trigger: "manual"
    });
    await writeFile(path.join(pendingDir, "03-late.md"), renderFeedback("Late feedback", "coder"), "utf8");
    await writeFile(
      path.join(tmpRepo, ".ai/vcm/harness-feedback/task-retrospectives/demo-task.md"),
      renderRetrospectiveReport(assigned.map((name) => path.join(pendingDir, name))),
      "utf8"
    );

    await service.handleTaskRetrospectiveHook(tmpRepo, {
      taskSlug: "demo-task",
      eventName: "Stop",
      memoryReviewStatus: "idle"
    });

    for (const name of assigned) {
      await expect(readFile(path.join(pendingDir, name), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(readFile(path.join(pendingDir, "03-late.md"), "utf8")).resolves.toContain("Late feedback");
    const marker = JSON.parse(await readFile(
      path.join(tmpRepo, ".ai/vcm/harness-feedback/task-retrospectives/demo-task.json"),
      "utf8"
    ));
    expect(marker.status).toBe("completed");
  });

  it("keeps assigned feedback when the retrospective omits a disposition", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-harness-retrospective-invalid-feedback-"));
    const taskRepoRoot = path.join(tmpRepo, ".claude/worktrees/demo-task");
    await mkdir(path.join(taskRepoRoot, ".ai/vcm/handoffs"), { recursive: true });
    await writeFile(
      path.join(taskRepoRoot, ".ai/vcm/handoffs/final-acceptance.md"),
      renderFinalAcceptance("accepted"),
      "utf8"
    );
    const pendingDir = path.join(tmpRepo, ".ai/vcm/harness-feedback/pending");
    await mkdir(pendingDir, { recursive: true });
    const assigned = ["01-coder.md", "02-tester.md"];
    for (const name of assigned) {
      await writeFile(path.join(pendingDir, name), renderFeedback(name, "coder"), "utf8");
    }
    const service = createHarnessFeedbackService({
      fs: createNodeFileSystemAdapter(),
      runtime: createRuntime([]),
      sessionService: createSessionService(),
      now: createClock()
    });
    await service.startTaskRetrospective(tmpRepo, {
      taskSlug: "demo-task",
      taskRepoRoot,
      handoffDir: ".ai/vcm/handoffs",
      trigger: "manual"
    });
    await writeFile(
      path.join(tmpRepo, ".ai/vcm/harness-feedback/task-retrospectives/demo-task.md"),
      renderRetrospectiveReport([path.join(pendingDir, assigned[0])]),
      "utf8"
    );

    await service.handleTaskRetrospectiveHook(tmpRepo, {
      taskSlug: "demo-task",
      eventName: "Stop",
      memoryReviewStatus: "idle"
    });

    for (const name of assigned) {
      await expect(readFile(path.join(pendingDir, name), "utf8")).resolves.toContain(name);
    }
    const marker = JSON.parse(await readFile(
      path.join(tmpRepo, ".ai/vcm/harness-feedback/task-retrospectives/demo-task.json"),
      "utf8"
    ));
    expect(marker).toMatchObject({ status: "failed" });
    expect(marker.error).toContain(path.join(pendingDir, assigned[1]));
  });

  it("does not start a task harness retrospective for a follow-up final-acceptance decision", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-harness-retrospective-follow-up-"));
    const taskRepoRoot = path.join(tmpRepo, ".claude/worktrees/demo-task");
    await mkdir(path.join(taskRepoRoot, ".ai/vcm/handoffs"), { recursive: true });
    await writeFile(
      path.join(taskRepoRoot, ".ai/vcm/handoffs/final-acceptance.md"),
      renderFinalAcceptance("needs-coder-follow-up"),
      "utf8"
    );
    const service = createHarnessFeedbackService({
      fs: createNodeFileSystemAdapter(),
      runtime: createRuntime([]),
      sessionService: createSessionService(),
      now: createClock()
    });

    await expect(service.startTaskRetrospective(tmpRepo, {
      taskSlug: "demo-task",
      taskRepoRoot,
      handoffDir: ".ai/vcm/handoffs",
      trigger: "manual"
    })).rejects.toThrow("requires a completed code-change flow");
  });
});

function renderFinalAcceptance(decision: string): string {
  return [
    "# Final Acceptance",
    "",
    "## Decision",
    decision,
    "",
    "## Evidence Reviewed",
    "All handoffs.",
    "## Scope Traceability",
    "All changes traced.",
    "## Validation Summary",
    "Checks passed.",
    "## Review And Docs Sync",
    "Complete.",
    "## Known Issues Disposition",
    "None.",
    "## Gate Review Gates",
    "Complete.",
    "## Cleanup Readiness",
    "Ready.",
    "## Final User Summary",
    "Done."
  ].join("\n");
}

function renderRetrospectiveReport(feedbackPaths: string[]): string {
  const dispositions = feedbackPaths.flatMap((feedbackPath) => [
    `### Feedback: ${feedbackPath}`,
    "Decision: confirmed",
    "Evidence: Confirmed against task evidence.",
    "Impact: Reusable harness behavior.",
    "Required action: Track the confirmed finding.",
    ""
  ]);
  return [
    "# Task Harness Retrospective: demo-task",
    "",
    "## Findings",
    "Confirmed feedback reviewed.",
    "",
    "## Feedback Dispositions",
    ...dispositions,
    "## Recommended Harness Changes",
    "None.",
    "",
    "## VCM Issue Drafts",
    "None.",
    ""
  ].join("\n");
}

function renderFeedback(title: string, role: string): string {
  return [
    `# ${title}`,
    "",
    `- Reporter role: ${role}`,
    "- Task slug: demo-task",
    "- Summary: Reusable harness behavior is unclear.",
    "- Observed problem: The role produced an ambiguous result.",
    "- Expected behavior: The harness should make the required behavior explicit.",
    "- Evidence: Current task route and handoff evidence.",
    "- Suspected harness area: role definition",
    "- Impact: The workflow can choose the wrong next action.",
    "- Urgency: medium",
    ""
  ].join("\n");
}

function createRuntime(writes: string[]): TerminalRuntime {
  const session: TerminalSession = {
    id: "session-1",
    taskSlug: "demo-task",
    role: "harness-engineer",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z"
  };
  return {
    async createSession() {
      return session;
    },
    getSession(sessionId: string) {
      return sessionId === session.id ? session : undefined;
    },
    getSessionByRole(_taskSlug: string, role: RoleName) {
      return role === "harness-engineer" ? session : undefined;
    },
    listSessions() {
      return [session];
    },
    write(_sessionId: string, data: string) {
      writes.push(data);
    },
    resize() {
      return undefined;
    },
    async stop() {
      return undefined;
    },
    async restart() {
      return session;
    },
    subscribe() {
      return () => undefined;
    },
    subscribeProcessExits() {
      return () => undefined;
    }
  };
}

function createSessionService() {
  const record: RoleSessionRecord = {
    id: "session-1",
    claudeSessionId: "claude-1",
    taskSlug: "__project_harness_engineer__",
    role: "harness-engineer",
    status: "running",
    activityStatus: "idle",
    command: "claude",
    permissionMode: "bypassPermissions",
    model: "default",
    effort: "medium",
    cwd: "/tmp/worktree",
    terminalBackend: "node-pty",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  return {
    async getRoleSession() {
      return record;
    },
    async startRoleSession() {
      return record;
    },
    async resumeRoleSession() {
      return record;
    }
  };
}

function createClock() {
  let tick = 0;
  return () => `2026-01-01T00:00:0${tick++}.000Z`;
}
