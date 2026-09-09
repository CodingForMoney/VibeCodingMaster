import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderDocsUpdateReportTemplate,
  renderFinalAcceptanceTemplate
} from "../../../src/backend/templates/handoff.js";
import { replaceVcmMemoryBlock } from "../../../src/backend/templates/harness/memory-block.js";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo, git } from "./helpers/e2e-repo.js";
import {
  connectAndCreateTask,
  getWorkspaceState,
  injectOk,
  startHarnessEngineer,
  startRole,
  startTaskHarnessRetrospective,
  updatePreferences
} from "./helpers/e2e-actions.js";
import type { MockClaudePromptContext } from "./helpers/mock-claude-runtime.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.shift()?.();
  }
});

describe("backend E2E task harness retrospective with mock Claude Code", () => {
  it("does not dispatch Harness Engineer before final acceptance is ready", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-harness-review");

    const notReady = await env.app.inject({
      method: "POST",
      url: "/api/projects/harness/task-retrospective",
      payload: { taskSlug: task.taskSlug, trigger: "manual" }
    });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.body).toContain("TASK_FINAL_ACCEPTANCE_NOT_READY");

    const session = await injectOk(env.app, {
      method: "GET",
      url: `/api/projects/harness/engineer/session?taskSlug=${task.taskSlug}`
    });
    expect(session.json()).toBeNull();
  });

  it("reviews and applies role memory inside Task Harness Retrospective", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-memory-retrospective");
    const sharedMemoryPath = path.join(task.worktreePath, "CLAUDE.md");
    await fs.writeFile(
      sharedMemoryPath,
      replaceVcmMemoryBlock(await fs.readFile(sharedMemoryPath, "utf8"), [
        "# Shared Memory",
        "Cross-cutting verified facts.",
        "",
        "## Generated context",
        "Generated indexes record source lines, so comment-only edits and formatter",
        "line shifts invalidate freshness checks.",
        "",
        "## Lifecycle ownership",
        "Lifecycle completion is inferred by each client."
      ].join("\n")),
      "utf8"
    );
    await git(task.worktreePath, "add", "--", "CLAUDE.md");
    await git(task.worktreePath, "commit", "-m", "test: seed structured memory");
    await updatePreferences(env.app, { autoMemoryEnabled: true });
    const pmMemoryStarted = createDeferred();
    const releasePmMemory = createDeferred();

    env.mockRuntime.onPrompt("project-manager", "Complete task for memory review", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeFile(
        ".ai/vcm/handoffs/final-acceptance.md",
        acceptedFinalAcceptance(task.taskSlug)
      );
      await ctx.appendTranscriptText("Task accepted for memory review.");
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("project-manager", "[VCM Task Harness Review: Memory Proposal]", async (ctx) => {
      await ctx.userPromptSubmit();
      pmMemoryStarted.resolve();
      await releasePmMemory.promise;
      await writeNoChangeMemoryDraftResult(ctx);
    });
    for (const role of ["architect", "coder", "tester"] as const) {
      env.mockRuntime.onPrompt(role, "[VCM Task Harness Review: Memory Proposal]", writeNoChangeMemoryDraft);
    }
    env.mockRuntime.onPrompt("harness-engineer", "[VCM Task Harness Retrospective]", writeHarnessRetrospective);

    for (const role of ["project-manager", "architect", "coder", "tester"] as const) {
      await startRole(env.app, task.taskSlug, role);
    }
    const harnessSession = await startHarnessEngineer(env.app, task.taskSlug);
    expect(harnessSession.activityStatus).toBe("idle");
    const pmSession = env.mockRuntime.getSessionByRole(task.taskSlug, "project-manager");
    expect(pmSession).toBeDefined();
    env.mockRuntime.write(pmSession!.id, "Complete task for memory review");
    await env.mockRuntime.waitForIdle();

    await startTaskHarnessRetrospective(env.app, task.taskSlug);
    await pmMemoryStarted.promise;

    const activeMemoryRound = await getWorkspaceState(env.app, task.taskSlug);
    expect(activeMemoryRound.roundState).toMatchObject({
      status: "running",
      activeRole: "project-manager",
      activeTurnStartedAt: expect.any(String)
    });

    releasePmMemory.resolve();
    await env.mockRuntime.waitForIdle();

    const memoryBeforeRetrospective = await injectOk(env.app, {
      method: "GET",
      url: `/api/projects/harness/memory?taskSlug=${task.taskSlug}`
    });
    expect(memoryBeforeRetrospective.json()).toMatchObject({
      status: "reviewing",
      runs: []
    });
    expect(env.mockRuntime.getWrites(harnessSession.id).join("\n")).not.toContain("[VCM Task Harness Retrospective]");

    await env.deps.runtimeCoordinator.reconcileProject(repo.repoRoot, { taskSlug: task.taskSlug });
    await env.mockRuntime.waitForIdle();

    const completedMemory = await injectOk(env.app, {
      method: "GET",
      url: `/api/projects/harness/memory?taskSlug=${task.taskSlug}`
    });
    expect(completedMemory.json()).toMatchObject({
      status: "idle",
      runs: [expect.objectContaining({ status: "applied", trigger: "manual" })]
    });
    await expect(fs.readFile(path.join(task.worktreePath, "CLAUDE.md"), "utf8"))
      .resolves.toContain("Backend hooks own lifecycle completion.");
    await expect(git(task.worktreePath, "log", "-1", "--pretty=%s"))
      .resolves.toMatchObject({ stdout: "[VCM Harness] Update VCM memory\n" });

    const completedMemoryRound = await getWorkspaceState(env.app, task.taskSlug);
    expect(completedMemoryRound.roundState.status).toBe("stopped");
    expect(completedMemoryRound.roundState.activeTurnStartedAt).toBeUndefined();
    expect(completedMemoryRound.roundState.completedTurnCount).toBeGreaterThan(0);
    expect(completedMemoryRound.roundState.activeRole).not.toBe("harness-engineer");

    const harnessWrites = env.mockRuntime.getWrites(harnessSession.id).join("\n");
    expect(harnessWrites).not.toContain("[VCM Task Harness Review: Memory Review]");
    expect(harnessWrites).toContain("[VCM Task Harness Retrospective]");
    expect(harnessWrites).toContain("Auto Memory Review:");
    expect(harnessWrites).toContain("Existing memory entries:");
    expect(harnessWrites).toContain("Active memory files:");
    expect(harnessWrites).toContain("Apply the reviewed result directly to the listed <VCM-memory> blocks");
    expect(harnessWrites).toContain("Write the complete machine-readable review to:");
    expect(harnessWrites).not.toContain("Write the complete reviewed memory set to:");
    await expect(fs.readFile(
      path.join(repo.repoRoot, ".ai/vcm/harness-feedback/task-retrospectives", `${task.taskSlug}.md`),
      "utf8"
    )).resolves.toContain("Memory reviewed during retrospective.");
  });

  it("starts Task Harness Retrospective directly when Auto Memory is disabled", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-retrospective-no-memory");
    await updatePreferences(env.app, { autoMemoryEnabled: false });
    const pendingDir = path.join(repo.repoRoot, ".ai/vcm/harness-feedback/pending");
    const pendingFeedback = [
      path.join(pendingDir, "01-coder-routing.md"),
      path.join(pendingDir, "02-tester-validation.md")
    ];
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.writeFile(pendingFeedback[0], renderHarnessFeedback("Coder routing feedback", "coder"), "utf8");
    await fs.writeFile(pendingFeedback[1], renderHarnessFeedback("Tester validation feedback", "tester"), "utf8");

    env.mockRuntime.onPrompt("project-manager", "Complete task without memory", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeFile(
        ".ai/vcm/handoffs/final-acceptance.md",
        acceptedFinalAcceptance(task.taskSlug)
      );
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("harness-engineer", "[VCM Task Harness Retrospective]", writeHarnessRetrospective);

    await startRole(env.app, task.taskSlug, "project-manager");
    const harnessSession = await startHarnessEngineer(env.app, task.taskSlug);
    expect(harnessSession.activityStatus).toBe("idle");
    const startedHarnessSession = await injectOk(env.app, {
      method: "GET",
      url: `/api/projects/harness/engineer/session?taskSlug=${task.taskSlug}`
    });
    expect(startedHarnessSession.json()).toMatchObject({ id: harnessSession.id, activityStatus: "idle" });
    const pmSession = env.mockRuntime.getSessionByRole(task.taskSlug, "project-manager");
    expect(pmSession).toBeDefined();
    env.mockRuntime.write(pmSession!.id, "Complete task without memory");
    await env.mockRuntime.waitForIdle();

    const idleHarnessSession = await injectOk(env.app, {
      method: "GET",
      url: `/api/projects/harness/engineer/session?taskSlug=${task.taskSlug}`
    });
    expect(env.mockRuntime.getSession(harnessSession.id)).toBeDefined();
    expect(idleHarnessSession.json()).toMatchObject({ activityStatus: "idle" });

    await startTaskHarnessRetrospective(env.app, task.taskSlug);
    await env.mockRuntime.waitForIdle();

    const harnessWrites = env.mockRuntime.getWrites(harnessSession.id).join("\n");
    expect(harnessWrites).toContain("[VCM Task Harness Retrospective]");
    expect(harnessWrites).not.toContain("[VCM Task Harness Review: Memory Proposal]");
    expect(harnessWrites).not.toContain("[VCM Task Harness Review: Memory Review]");
    expect(harnessWrites).not.toContain("Auto Memory Review:");
    expect(harnessWrites).not.toContain("Write the complete reviewed memory set to:");
    expect(harnessWrites).toContain(`- ${pendingFeedback[0]}`);
    expect(harnessWrites).toContain(`- ${pendingFeedback[1]}`);
    const memoryState = await injectOk(env.app, {
      method: "GET",
      url: `/api/projects/harness/memory?taskSlug=${task.taskSlug}`
    });
    expect(memoryState.json()).toMatchObject({ status: "idle", runs: [] });
    const retrospective = await fs.readFile(
      path.join(repo.repoRoot, ".ai/vcm/harness-feedback/task-retrospectives", `${task.taskSlug}.md`),
      "utf8"
    );
    expect(retrospective).toContain(`### Feedback: ${pendingFeedback[0]}`);
    expect(retrospective).toContain(`### Feedback: ${pendingFeedback[1]}`);
    expect(retrospective).toContain("Decision: confirmed");
    await expect(fs.readdir(pendingDir)).resolves.toEqual([]);
    const feedbackState = await injectOk(env.app, {
      method: "GET",
      url: `/api/projects/harness/feedback?taskSlug=${task.taskSlug}`
    });
    expect(feedbackState.json()).toMatchObject({ status: "idle", queuedCount: 0, pending: [] });
  });

  it("keeps the retrospective open until moved memory is committed to durable documentation", async () => {
    const env = await createMockClaudeE2eApp({ workflowControl: true });
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-memory-durable-doc");
    await updatePreferences(env.app, { autoMemoryEnabled: true });
    const sourceEntry = "Lifecycle ownership belongs in durable architecture documentation.";
    const sharedPath = path.join(task.worktreePath, "CLAUDE.md");
    await fs.writeFile(
      sharedPath,
      replaceVcmMemoryBlock(await fs.readFile(sharedPath, "utf8"), `${sourceEntry}\n`),
      "utf8"
    );
    await git(task.worktreePath, "add", "--", "CLAUDE.md");
    await git(task.worktreePath, "commit", "-m", "test: seed memory for durable doc move");

    env.mockRuntime.onPrompt("project-manager", "Complete task with durable documentation move", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeFile(".ai/vcm/handoffs/final-acceptance.md", acceptedFinalAcceptance(task.taskSlug));
      await ctx.stop();
    });
    for (const role of ["project-manager", "architect", "coder", "tester"] as const) {
      env.mockRuntime.onPrompt(role, "[VCM Task Harness Review: Memory Proposal]", writeNoChangeMemoryDraft);
    }
    env.mockRuntime.onPrompt("harness-engineer", "[VCM Task Harness Retrospective]", async (ctx) => {
      await writeHarnessRetrospectiveWithDurableDocMove(ctx, sourceEntry);
    });
    env.mockRuntime.onPrompt("architect", "[VCM Durable Documentation Assignment]", async (ctx) => {
      await writeDurableArchitectureAssignment(ctx, async (content) => {
        const session = await env.deps.sessionService.getRoleSession(repo.repoRoot, task.taskSlug, "architect");
        await injectOk(env.app, {
          method: "POST", url: `/api/tasks/${task.taskSlug}/artifacts/submit`,
          payload: {
            kind: "docs-update-report", mode: "final", role: "architect",
            runtimeSessionToken: session!.runtimeSessionToken, content
          }
        });
      });
    });

    for (const role of ["project-manager", "architect", "coder", "tester"] as const) {
      await startRole(env.app, task.taskSlug, role);
    }
    await startHarnessEngineer(env.app, task.taskSlug);
    const pmSession = env.mockRuntime.getSessionByRole(task.taskSlug, "project-manager")!;
    env.mockRuntime.write(pmSession.id, "Complete task with durable documentation move");
    await env.mockRuntime.waitForIdle();

    await startTaskHarnessRetrospective(env.app, task.taskSlug);
    await env.mockRuntime.waitForIdle();
    await env.deps.runtimeCoordinator.reconcileProject(repo.repoRoot, { taskSlug: task.taskSlug });
    await env.mockRuntime.waitForIdle();

    const memoryState = (await injectOk(env.app, {
      method: "GET",
      url: `/api/projects/harness/memory?taskSlug=${task.taskSlug}`
    })).json();
    expect(memoryState).toMatchObject({
      status: "idle",
      runs: [expect.objectContaining({
        assignments: [expect.objectContaining({
          owner: "architect",
          status: "completed",
          targetPath: "docs/ARCHITECTURE.md"
        })]
      })]
    });
    await expect(fs.readFile(sharedPath, "utf8")).resolves.not.toContain(sourceEntry);
    await expect(fs.readFile(path.join(task.worktreePath, "docs/ARCHITECTURE.md"), "utf8"))
      .resolves.toContain("Lifecycle ownership is maintained by backend hooks.");
    const marker = JSON.parse(await fs.readFile(
      path.join(repo.repoRoot, ".ai/vcm/harness-feedback/task-retrospectives", `${task.taskSlug}.json`),
      "utf8"
    ));
    expect(marker.status).toBe("completed");
  });
});

async function writeNoChangeMemoryDraft(ctx: MockClaudePromptContext): Promise<void> {
  await ctx.userPromptSubmit();
  await writeNoChangeMemoryDraftResult(ctx);
}

async function writeNoChangeMemoryDraftResult(ctx: MockClaudePromptContext): Promise<void> {
  const draftPath = matchPromptPath(ctx.prompt, "Assigned proposal path");
  await ctx.writeAbsoluteFile(draftPath, [
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
  ].join("\n"));
  await ctx.stop();
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function writeHarnessRetrospective(ctx: MockClaudePromptContext): Promise<void> {
  await ctx.userPromptSubmit();
  const resultPath = matchPromptPath(ctx.prompt, "Write the analysis to Result Path");
  const autoMemoryReview = ctx.prompt.includes("Auto Memory Review:");
  let memoryCommit = "none";
  let reviewResultPath: string | undefined;
  let memoryDecisions: ReturnType<typeof e2eExistingDecision>[] = [];
  if (autoMemoryReview) {
    const manifest = await readExistingMemoryManifest(ctx.prompt);
    memoryDecisions = manifest.entries.map((assigned) => e2eExistingDecision(
      assigned.itemId,
      assigned.target,
      assigned.entry,
      assigned.target === "shared" ? "update" : "retain",
      assigned.target === "shared" ? "Backend hooks own lifecycle completion." : assigned.entry
    ));
    await ctx.writeFile(
      "CLAUDE.md",
      replaceVcmMemoryBlock(
        await ctx.readFile("CLAUDE.md"),
        "Backend hooks own lifecycle completion.\n"
      )
    );
    await git(ctx.cwd, "add", "--", "CLAUDE.md");
    await git(ctx.cwd, "commit", "-m", "[VCM Harness] Update VCM memory");
    memoryCommit = (await git(ctx.cwd, "rev-parse", "HEAD")).stdout.trim();
    reviewResultPath = matchPromptPath(ctx.prompt, "Write the complete machine-readable review to");
    await ctx.writeAbsoluteFile(reviewResultPath, `${JSON.stringify({
      version: 1,
      runId: path.basename(path.dirname(reviewResultPath)),
      memoryCommit,
      decisions: memoryDecisions,
      durableDocAssignments: []
    }, null, 2)}\n`);
  }
  const pendingFeedback = matchPendingFeedbackPaths(ctx.prompt);
  const dispositions = pendingFeedback.flatMap((feedbackPath) => [
    `### Feedback: ${feedbackPath}`,
    "Decision: confirmed",
    "Evidence: Confirmed against task evidence.",
    "Impact: Reusable harness behavior.",
    "Required action: Track the confirmed finding.",
    ""
  ]);
  await ctx.writeAbsoluteFile(
    resultPath,
    [
      "# Task Harness Retrospective: demo-task",
      "",
      "## Findings",
      autoMemoryReview
        ? "Memory reviewed during retrospective."
        : "Auto Memory disabled; no memory review requested.",
      "",
      "## Feedback Dispositions",
      dispositions.length > 0 ? dispositions.join("\n") : "none",
      "",
      "## Recommended Harness Changes",
      "None.",
      "",
      "## VCM Issue Drafts",
      "None.",
      ...(autoMemoryReview
        ? [
            "",
            "## Memory Review",
            `Memory commit: ${memoryCommit}`,
            `Review result: ${reviewResultPath}`,
            "Durable document assignments: 0"
          ]
        : []),
      ""
    ].join("\n")
  );
  await ctx.stop();
}

async function writeHarnessRetrospectiveWithDurableDocMove(
  ctx: MockClaudePromptContext,
  sourceEntry: string
): Promise<void> {
  await ctx.userPromptSubmit();
  const resultPath = matchPromptPath(ctx.prompt, "Write the analysis to Result Path");
  const reviewResultPath = matchPromptPath(ctx.prompt, "Write the complete machine-readable review to");
  const manifest = await readExistingMemoryManifest(ctx.prompt);
  const decisions = manifest.entries.map((assigned) => {
    return assigned.target === "shared"
      ? {
          ...e2eExistingDecision(assigned.itemId, assigned.target, assigned.entry, "move-to-durable-doc", "none"),
          durableDocPath: "docs/ARCHITECTURE.md"
        }
      : e2eExistingDecision(assigned.itemId, assigned.target, assigned.entry, "retain", assigned.entry);
  });
  await ctx.writeFile(
    "CLAUDE.md",
    replaceVcmMemoryBlock(await ctx.readFile("CLAUDE.md"), "No accumulated project memory yet.\n")
  );
  await git(ctx.cwd, "add", "--", "CLAUDE.md");
  await git(ctx.cwd, "commit", "-m", "[VCM Harness] Update VCM memory");
  const memoryCommit = (await git(ctx.cwd, "rev-parse", "HEAD")).stdout.trim();
  await ctx.writeAbsoluteFile(reviewResultPath, `${JSON.stringify({
    version: 1,
    runId: path.basename(path.dirname(reviewResultPath)),
    memoryCommit,
    decisions,
    durableDocAssignments: [{
      sourceMemoryPath: "CLAUDE.md",
      sourceEntry,
      targetPath: "docs/ARCHITECTURE.md",
      content: "Lifecycle ownership is maintained by backend hooks.",
      reason: "Architecture ownership belongs in the durable architecture overview.",
      evidence: ["src/backend/services/claude-hook-service.ts"]
    }]
  }, null, 2)}\n`);
  await ctx.writeAbsoluteFile(resultPath, [
    "# Task Harness Retrospective: durable-doc",
    "",
    "## Findings",
    "Moved durable architecture knowledge out of memory.",
    "",
    "## Feedback Dispositions",
    "none",
    "",
    "## Recommended Harness Changes",
    "None.",
    "",
    "## VCM Issue Drafts",
    "None.",
    "",
    "## Memory Review",
    `Memory commit: ${memoryCommit}`,
    `Review result: ${reviewResultPath}`,
    "Durable document assignments: 1",
    ""
  ].join("\n"));
  await ctx.stop();
}

async function writeDurableArchitectureAssignment(ctx: MockClaudePromptContext, submit: (content: string) => Promise<void>): Promise<void> {
  await ctx.userPromptSubmit();
  const assignmentId = matchPromptPath(ctx.prompt, "Assignment ID");
  await ctx.writeFile(
    "docs/ARCHITECTURE.md",
    "# Architecture\n\nLifecycle ownership is maintained by backend hooks.\n"
  );
  await git(ctx.cwd, "add", "--", "docs/ARCHITECTURE.md");
  await git(ctx.cwd, "commit", "-m", "docs: record lifecycle ownership");
  const commit = (await git(ctx.cwd, "rev-parse", "HEAD")).stdout.trim();
  await submit(
    renderDocsUpdateReportTemplate(ctx.taskSlug, assignmentId)
      .replaceAll("TBD", commit)
      .replace("synced|unchanged|blocked", "synced")
  );
  await ctx.stop();
}

function matchPendingFeedbackPaths(prompt: string): string[] {
  const block = prompt.split("Pending Feedback:\n", 2)[1]?.split("\n\n", 1)[0]?.trim();
  if (!block || block === "none") {
    return [];
  }
  return block
    .split("\n")
    .map((line) => line.match(/^-\s+(.+)$/)?.[1]?.trim())
    .filter((feedbackPath): feedbackPath is string => Boolean(feedbackPath));
}

function renderHarnessFeedback(title: string, role: string): string {
  return [
    `# ${title}`,
    "",
    `- Reporter role: ${role}`,
    "- Task slug: mock-retrospective-no-memory",
    "- Summary: A reusable harness behavior needs review.",
    "- Observed problem: The role produced an ambiguous result.",
    "- Expected behavior: The harness should make the required behavior explicit.",
    "- Evidence: Current task handoff evidence.",
    "- Suspected harness area: role definition",
    "- Impact: The workflow can choose the wrong next action.",
    "- Urgency: medium",
    ""
  ].join("\n");
}

function e2eExistingDecision(itemId: string, target: string, entry: string, decision: string, finalContent: string) {
  return {
    itemId,
    source: "existing",
    target,
    entry,
    decision,
    reason: "Verified against final task evidence.",
    impactIfAbsent: "Future roles could lose durable project context.",
    evidence: [".ai/vcm/handoffs/final-acceptance.md"],
    finalContent,
    durableDocPath: "none"
  };
}

async function readExistingMemoryManifest(prompt: string): Promise<{
  entries: Array<{ itemId: string; target: string; memoryPath: string; entry: string }>;
}> {
  const manifestPath = matchPromptPath(prompt, "Existing memory entries");
  return JSON.parse(await fs.readFile(manifestPath, "utf8"));
}

function acceptedFinalAcceptance(taskSlug: string): string {
  return renderFinalAcceptanceTemplate(taskSlug)
    .replaceAll("TBD", "None.")
    .replace(
      "accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|needs-docs-sync|blocked-by-user-decision",
      "accepted"
    );
}

function matchPromptPath(prompt: string, field: string): string {
  const matched = prompt.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1]?.trim();
  if (!matched) {
    throw new Error(`Missing ${field} in prompt:\n${prompt}`);
  }
  return matched;
}
