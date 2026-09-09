import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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
import type { DurableDocAssignmentState } from "../../../src/shared/types/memory.js";
import {
  renderDocsUpdateReportTemplate,
  renderFinalAcceptanceTemplate
} from "../../../src/backend/templates/handoff.js";

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
    expect(context.gitCommits).toEqual([{ message: "[VCM Harness] Update VCM memory", paths: ["CLAUDE.md"] }]);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].canRevert).toBe(true);

    const reverted = await service.revertRun(context.baseRepoRoot, context.taskRepoRoot, state.runs[0].runId);
    expect(await readText(context.taskRepoRoot, "CLAUDE.md")).toContain("No accumulated project memory yet");
    expect(context.gitCommits.at(-1)).toEqual({ message: "chore: revert VCM memory", paths: ["CLAUDE.md"] });
    expect(reverted.runs[0].status).toBe("reverted");
  });

  it("collects role drafts before retrospective and records Harness Engineer committed memory", async () => {
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
    await expect(readFile(planningCandidatePath, "utf8")).resolves.toContain(
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
      planningCandidatePath: planningCandidateSnapshot,
      proposalCandidates: [
        {
          id: "architect-planning:add:1",
          source: "architect-planning",
          operation: "add",
          target: "shared",
          content: "Planning discovered backend-owned lifecycle state."
        }
      ]
    });
    expect(memoryReview?.roleDraftsPath).toContain(`${state.active!.runId}/drafts`);
    expect(memoryReview?.currentMemoryPath).toContain(`${state.active!.runId}/before`);
    expect(memoryReview?.activeMemoryPaths).toContain(sharedMemoryHostPath);
    await mkdir(path.dirname(retrospectiveReportPath), { recursive: true });
    await writeFile(
      retrospectiveReportPath,
      memoryReviewReport(),
      "utf8"
    );
    await writeFile(
      sharedMemoryHostPath,
      replaceVcmMemoryBlock(
        await readFile(sharedMemoryHostPath, "utf8"),
        "Lifecycle completion is owned by backend hooks.\n"
      ),
      "utf8"
    );
    context.recordHarnessCommit(["CLAUDE.md"]);
    await writeFile(
      memoryReview!.reviewResultPath,
      `${JSON.stringify({
        version: 1,
        runId: memoryReview!.runId,
        memoryCommit: "harness-memory-commit",
        decisions: [
          proposalDecision(
            "architect-planning:add:1",
            "Planning discovered backend-owned lifecycle state.",
            "Lifecycle completion is owned by backend hooks."
          ),
          existingDecision("shared", "Lifecycle completion is inferred by each client.", "update", "Lifecycle completion is owned by backend hooks."),
          ...defaultRoleMemoryDecisions()
        ],
        durableDocAssignments: []
      }, null, 2)}\n`,
      "utf8"
    );
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
    expect(context.gitCommits).toHaveLength(0);
    await expect(readFile(path.join(
      context.taskRepoRoot,
      ".ai/vcm/memory-review/runs",
      state.runs[0].runId,
      "after/CLAUDE.md"
    ), "utf8")).resolves.toBe("Lifecycle completion is owned by backend hooks.\n");
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

  it("removes moved memory before dispatching and completes a fixed-owner durable document assignment", async () => {
    const context = await createContext(true);
    const sourceEntry = "Lifecycle ownership must be documented for maintainers.";
    const review = await prepareHarnessMemoryReview(context, sourceEntry);
    const sharedPath = path.join(context.taskRepoRoot, "CLAUDE.md");
    await writeFile(
      sharedPath,
      replaceVcmMemoryBlock(await readFile(sharedPath, "utf8"), "No accumulated project memory yet.\n"),
      "utf8"
    );
    context.recordHarnessCommit(["CLAUDE.md"], "memory-move-commit");
    await writeFile(review.reviewResultPath, `${JSON.stringify({
      version: 1,
      runId: review.runId,
      memoryCommit: "memory-move-commit",
      decisions: [
        {
          ...existingDecision("shared", sourceEntry, "move-to-durable-doc", "none"),
          durableDocPath: "docs/ARCHITECTURE.md"
        },
        ...defaultRoleMemoryDecisions()
      ],
      durableDocAssignments: [{
        sourceMemoryPath: "CLAUDE.md",
        sourceEntry,
        targetPath: "docs/ARCHITECTURE.md",
        content: "Document lifecycle ownership in the architecture overview.",
        reason: "The architecture document is the durable source for maintainers.",
        evidence: ["src/backend/services/claude-hook-service.ts"]
      }]
    }, null, 2)}\n`, "utf8");

    await context.service.handleHarnessEngineerHook({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      eventName: "Stop"
    });

    let state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.status).toBe("documenting");
    expect(state.active?.assignments[0]).toMatchObject({
      owner: "architect",
      status: "running",
      targetPath: "docs/ARCHITECTURE.md"
    });
    expect(await readText(context.taskRepoRoot, "CLAUDE.md")).not.toContain(sourceEntry);
    expect(context.terminalWrites.join("\n")).toContain("[VCM Durable Documentation Assignment]");

    const writesBeforeRecovery = context.terminalWrites.length;
    await context.service.reconcileTask({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      handoffDir: ".ai/vcm/handoffs",
      roundReady: false
    });
    expect(context.terminalWrites.length).toBeGreaterThan(writesBeforeRecovery);
    expect(context.terminalWrites.slice(writesBeforeRecovery).join("\n"))
      .toContain("[VCM Durable Documentation Assignment]");
    state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.active?.assignments[0]).toMatchObject({
      owner: "architect",
      status: "running"
    });

    await mkdir(path.join(context.taskRepoRoot, "docs"), { recursive: true });
    await writeFile(
      path.join(context.taskRepoRoot, "docs/ARCHITECTURE.md"),
      "# Architecture\n\nLifecycle ownership is backend-owned.\n",
      "utf8"
    );
    context.recordHarnessCommit(["docs/ARCHITECTURE.md"], "docs-commit");
    const assignmentId = state.active!.assignments[0].id;
    await mkdir(path.dirname(path.join(context.taskRepoRoot, state.active!.assignments[0].reportPath)), { recursive: true });
    await writeFile(
      path.join(context.taskRepoRoot, state.active!.assignments[0].reportPath),
      renderDocsUpdateReportTemplate("demo", assignmentId)
        .replaceAll("TBD", "docs-commit")
        .replace("synced|unchanged|blocked", "synced"),
      "utf8"
    );
    await context.service.handleRoleHook({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      role: "architect",
      eventName: "Stop"
    });

    state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.active?.assignments[0].error).toBeUndefined();
    expect(state.status).toBe("idle");
    expect(state.runs[0].assignments[0]).toMatchObject({
      id: assignmentId,
      status: "completed",
      commit: "docs-commit"
    });
  });

  it("asks PM to resolve an unknown durable document owner and retains failures for retry", async () => {
    const context = await createContext(true);
    const sourceEntry = "Operations recovery guidance is durable project knowledge.";
    const review = await prepareHarnessMemoryReview(context, sourceEntry);
    const sharedPath = path.join(context.taskRepoRoot, "CLAUDE.md");
    await writeFile(
      sharedPath,
      replaceVcmMemoryBlock(await readFile(sharedPath, "utf8"), "No accumulated project memory yet.\n"),
      "utf8"
    );
    context.recordHarnessCommit(["CLAUDE.md"], "memory-owner-commit");
    await writeFile(review.reviewResultPath, `${JSON.stringify({
      version: 1,
      runId: review.runId,
      memoryCommit: "memory-owner-commit",
      decisions: [
        {
          ...existingDecision("shared", sourceEntry, "move-to-durable-doc", "none"),
          durableDocPath: "docs/OPERATIONS.md"
        },
        ...defaultRoleMemoryDecisions()
      ],
      durableDocAssignments: [{
        sourceMemoryPath: "CLAUDE.md",
        sourceEntry,
        targetPath: "docs/OPERATIONS.md",
        content: "Document operations recovery guidance.",
        reason: "Operators need a durable runbook.",
        evidence: ["src/backend/services/runtime-coordinator-service.ts"]
      }]
    }, null, 2)}\n`, "utf8");
    await context.service.handleHarnessEngineerHook({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      eventName: "Stop"
    });

    let state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    const assignmentId = state.active!.assignments[0].id;
    expect(state.active!.assignments[0].status).toBe("resolving-owner");
    expect(context.terminalWrites.join("\n")).toContain("[VCM Durable Documentation Owner Resolution]");
    await context.service.resolveDurableDocAssignmentOwner(
      context.baseRepoRoot,
      context.taskRepoRoot,
      assignmentId,
      "coder"
    );
    await context.service.handleRoleHook({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      role: "project-manager",
      eventName: "Stop"
    });
    state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.active!.assignments[0]).toMatchObject({ owner: "coder", status: "running" });

    await context.service.handleRoleHook({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      role: "coder",
      eventName: "StopFailure"
    });
    state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.active!.assignments[0].status).toBe("failed");
    await context.service.retryDurableDocAssignment(
      context.baseRepoRoot,
      context.taskRepoRoot,
      assignmentId
    );
    state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.active!.assignments[0]).toMatchObject({ owner: "coder", status: "running" });
  });

  it.each(["Stop", "StopFailure"] as const)("continues later assignments after %s failure and retains the failed content", async (eventName) => {
    const context = await createContext(true);
    const assignments = await prepareDocAssignments(context, ["docs/ARCHITECTURE.md", "docs/TESTING.md"]);
    await context.service.handleRoleHook({ ...docHook(context, "architect"), eventName });
    let state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.status).toBe("documenting");
    expect(state.active!.assignments.map((item) => item.status)).toEqual(["failed", "running"]);
    await writeDocResult(context, assignments[1], "testing-commit");
    await context.service.handleRoleHook(docHook(context, "tester"));
    state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.status).toBe("failed");
    expect(state.active!.error).toContain("docs/ARCHITECTURE.md");
    expect(state.active!.assignments.map((item) => item.status)).toEqual(["failed", "completed"]);
    expect(state.runs[0].assignments[0].content).toBe(assignments[0].content);
    expect(state.runs[0].error).toContain("Memory was applied");
    expect(await readText(context.taskRepoRoot, "CLAUDE.md")).not.toContain(assignments[0].sourceEntry);
    await expect(context.service.retryFailedReview(context.baseRepoRoot, context.taskRepoRoot))
      .rejects.toMatchObject({ code: "DURABLE_DOC_ASSIGNMENTS_FAILED" });
    context.setAutoMemoryEnabled(false);
    await context.service.reconcileTask({ ...docContext(context), handoffDir: ".ai/vcm/handoffs", roundReady: true });
    expect((await context.service.getState(context.baseRepoRoot, context.taskRepoRoot)).active!.assignments).toHaveLength(2);
    const runRoot = `.ai/vcm/memory-review/runs/${assignments[0].runId}`;
    expect(JSON.parse(await readText(context.taskRepoRoot, `${runRoot}/review-result.json`)).durableDocAssignments[0].sourceEntry)
      .toBe(assignments[0].sourceEntry);
    expect(await readText(context.taskRepoRoot, `${runRoot}/before/CLAUDE.md`)).toContain(assignments[0].sourceEntry);
  });

  it("continues after dispatch failure without retrying the failed role indefinitely", async () => {
    const context = await createContext(true);
    const assignments = await prepareDocAssignments(context, ["docs/ARCHITECTURE.md", "docs/TESTING.md"]);
    await context.service.handleRoleHook(docHook(context, "architect"));
    context.setRoleUnavailable("architect");
    context.setRoleBusy("tester", true);
    await context.service.retryDurableDocAssignment(context.baseRepoRoot, context.taskRepoRoot, assignments[0].id);
    context.setRoleBusy("tester", false);
    await writeDocResult(context, assignments[1], "testing-commit");
    await context.service.handleRoleHook(docHook(context, "tester"));
    const state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.status).toBe("failed");
    expect(state.active!.assignments[0].error).toContain("Unable to dispatch");
    expect(state.active!.assignments[1].status).toBe("completed");
  });

  it("accepts the actual documentation commit after HEAD advances", async () => {
    const context = await createContext(true);
    const [assignment] = await prepareDocAssignments(context, ["docs/ARCHITECTURE.md"]);
    await writeDocResult(context, assignment, "docs-commit-123");
    context.recordHarnessCommit(["src/unrelated.ts"], "unrelated-commit");
    await context.service.handleRoleHook(docHook(context, "architect"));
    const state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.status).toBe("idle");
    expect(state.runs[0].assignments[0].commit).toBe("docs-commit-123");
  });

  it.each(["missing", "wrong-file", "ambiguous", "before-baseline"])("rejects a %s commit without losing the assignment", async (failure) => {
    const context = await createContext(true);
    const [assignment] = await prepareDocAssignments(context, ["docs/ARCHITECTURE.md"]);
    await writeDocResult(context, assignment, "doc-123");
    context.recordHarnessCommit(["src/unrelated.ts"], "doc-456");
    const reported = { missing: "unknown", "wrong-file": "doc-456", ambiguous: "doc-", "before-baseline": "memory-move-commit" }[failure];
    await writeAssignmentReport(context, assignment, reported!);
    await context.service.handleRoleHook(docHook(context, "architect"));
    const state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.status).toBe("failed");
    expect(state.active!.assignments[0].error).toContain(failure === "wrong-file" ? "does not modify" : "must uniquely identify");
  });

  it("retries a corrected report after service restart without a new documentation commit, even with Auto Memory off", async () => {
    const context = await createContext(true);
    const [assignment] = await prepareDocAssignments(context, ["docs/ARCHITECTURE.md"]);
    await writeDocResult(context, assignment, "doc-123");
    await writeAssignmentReport(context, assignment, "wrong-commit");
    await context.service.handleRoleHook(docHook(context, "architect"));
    const failed = (await context.service.getState(context.baseRepoRoot, context.taskRepoRoot)).active!.assignments[0];
    context.recordHarnessCommit(["unrelated.md"], "unrelated-commit");
    context.setAutoMemoryEnabled(false);
    const restarted = context.createService();
    await restarted.retryDurableDocAssignment(context.baseRepoRoot, context.taskRepoRoot, assignment.id);
    expect((await restarted.getState(context.baseRepoRoot, context.taskRepoRoot)).active!.assignments[0].baseCommit).toBe(failed.baseCommit);
    expect(context.terminalWrites.join("\n")).toContain("Previous failure:");
    await writeAssignmentReport(context, assignment, "doc-123");
    await restarted.handleRoleHook(docHook(context, "architect"));
    expect((await restarted.getState(context.baseRepoRoot, context.taskRepoRoot)).runs[0].assignments[0])
      .toMatchObject({ status: "completed", commit: "doc-123" });
  });

  it("does not replace a running assignment when an earlier failed item is retried", async () => {
    const context = await createContext(true);
    const assignments = await prepareDocAssignments(context, ["docs/ARCHITECTURE.md", "docs/TESTING.md"]);
    await context.service.handleRoleHook(docHook(context, "architect"));
    context.setRoleBusy("tester", true);
    const before = context.terminalWrites.length;
    await context.service.retryDurableDocAssignment(context.baseRepoRoot, context.taskRepoRoot, assignments[0].id);
    expect(context.terminalWrites).toHaveLength(before);
    expect(await context.service.getDurableDocAssignment(context.taskRepoRoot, "architect")).toBeUndefined();
    expect(await context.service.getDurableDocAssignment(context.taskRepoRoot, "tester")).toMatchObject({ id: assignments[1].id });
    context.setRoleBusy("tester", false);
    await writeDocResult(context, assignments[1], "test-doc-commit");
    await context.service.handleRoleHook(docHook(context, "tester"));
    expect(await context.service.getDurableDocAssignment(context.taskRepoRoot, "architect")).toMatchObject({ id: assignments[0].id });
  });

  it("uses an assignment-specific report and ignores an unrelated Docs-Only report", async () => {
    const context = await createContext(true);
    const [assignment] = await prepareDocAssignments(context, ["docs/ARCHITECTURE.md"]);
    await writeDocResult(context, assignment, "doc-123");
    await writeFile(path.join(context.taskRepoRoot, ".ai/vcm/handoffs/docs-update-report.md"), "Unrelated docs report");
    await context.service.handleRoleHook(docHook(context, "architect"));
    expect((await context.service.getState(context.baseRepoRoot, context.taskRepoRoot)).status).toBe("idle");
    expect(await readText(context.taskRepoRoot, assignment.reportPath)).toContain(assignment.id);
  });

  it("accepts unchanged existing documentation on retry without any new commit", async () => {
    const context = await createContext(true);
    const [assignment] = await prepareDocAssignments(context, ["docs/ARCHITECTURE.md"]);
    await writeDocResult(context, assignment, "doc-123");
    await writeAssignmentReport(context, assignment, "wrong-commit");
    await context.service.handleRoleHook(docHook(context, "architect"));
    await context.service.retryDurableDocAssignment(context.baseRepoRoot, context.taskRepoRoot, assignment.id);
    await writeAssignmentReport(context, assignment, "none", "unchanged");
    await context.service.handleRoleHook(docHook(context, "architect"));
    expect((await context.service.getState(context.baseRepoRoot, context.taskRepoRoot)).status).toBe("idle");
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

  it("rejects reviewed memory that Harness Engineer did not commit", async () => {
    const context = await createContext(true);
    await prepareHarnessMemoryReview(context);
    const sharedMemoryHostPath = path.join(context.taskRepoRoot, "CLAUDE.md");
    await writeFile(
      sharedMemoryHostPath,
      replaceVcmMemoryBlock(
        await readFile(sharedMemoryHostPath, "utf8"),
        "Harness Engineer left this memory uncommitted.\n"
      ),
      "utf8"
    );
    context.setGitDiff("uncommitted memory diff");

    await context.service.handleHarnessEngineerHook({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      eventName: "Stop"
    });

    const state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.status).toBe("failed");
    expect(state.active?.error).toContain("left reviewed memory changes uncommitted");
    expect(context.gitCommits).toHaveLength(0);
  });

  it("records a no-change Harness Engineer review without requiring a commit", async () => {
    const context = await createContext(true);
    await prepareHarnessMemoryReview(context);

    await context.service.handleHarnessEngineerHook({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      eventName: "Stop"
    });

    const state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.status).toBe("idle");
    expect(state.runs[0]).toMatchObject({ status: "applied", diff: "No memory changes.\n" });
    expect(context.gitCommits).toHaveLength(0);
  });

  it("accepts a no-change review when memory blocks already contain extra trailing blank lines", async () => {
    const context = await createContext(true);
    for (const relativePath of [
      "CLAUDE.md",
      ".claude/agents/architect.md",
      ".claude/agents/tester.md",
      ".claude/agents/reviewer.md"
    ]) {
      const hostPath = path.join(context.taskRepoRoot, relativePath);
      const content = await readFile(hostPath, "utf8");
      await writeFile(hostPath, content.replace("\n</VCM-memory>", "\n\n</VCM-memory>"), "utf8");
    }
    await prepareHarnessMemoryReview(context);

    await context.service.handleHarnessEngineerHook({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      eventName: "Stop"
    });

    const state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.status).toBe("idle");
    expect(state.runs[0]).toMatchObject({ status: "applied", diff: "No memory changes.\n" });
    expect(context.gitCommits).toHaveLength(0);
  });

  it("treats each level-two memory section as one existing review entry", async () => {
    const context = await createContext(true);
    const sharedMemory = [
      "# Shared Memory",
      "Cross-cutting verified facts.",
      "",
      "## Generated context",
      "Generated indexes record source lines, so comment-only edits and formatter",
      "line shifts invalidate freshness checks.",
      "",
      "## Lifecycle ownership",
      "Backend hooks own lifecycle completion."
    ].join("\n");
    const review = await prepareHarnessMemoryReview(context, sharedMemory);
    const manifest = JSON.parse(await readFile(review.existingEntriesPath, "utf8")) as {
      entries: Array<{ itemId: string; target: string; memoryPath: string; entry: string }>;
    };
    const sharedEntries = manifest.entries.filter((entry) => entry.target === "shared");

    expect(sharedEntries).toHaveLength(2);
    expect(sharedEntries[0]).toMatchObject({
      memoryPath: "CLAUDE.md",
      entry: [
        "## Generated context",
        "Generated indexes record source lines, so comment-only edits and formatter",
        "line shifts invalidate freshness checks."
      ].join("\n")
    });
    expect(sharedEntries[1].entry).toBe("## Lifecycle ownership\nBackend hooks own lifecycle completion.");
    expect(manifest.entries.some((entry) => entry.entry === "# Shared Memory")).toBe(false);

    await context.service.handleHarnessEngineerHook({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      eventName: "Stop"
    });
    await expect(context.service.getState(context.baseRepoRoot, context.taskRepoRoot))
      .resolves.toMatchObject({ status: "idle", runs: [expect.objectContaining({ status: "applied" })] });
  });

  it("rejects a review result that omits an assigned semantic memory entry", async () => {
    const context = await createContext(true);
    const review = await prepareHarnessMemoryReview(context, [
      "## Generated context",
      "Generated indexes include source lines.",
      "",
      "## Lifecycle ownership",
      "Backend hooks own lifecycle completion."
    ].join("\n"));
    const result = JSON.parse(await readFile(review.reviewResultPath, "utf8")) as {
      decisions: Array<{ source: string; target: string }>;
    };
    const sharedDecisions = result.decisions.filter(
      (decision) => decision.source === "existing" && decision.target === "shared"
    );
    expect(sharedDecisions).toHaveLength(2);
    result.decisions.splice(result.decisions.indexOf(sharedDecisions[1]), 1);
    await writeFile(review.reviewResultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

    await context.service.handleHarnessEngineerHook({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      eventName: "Stop"
    });

    const state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state).toMatchObject({ status: "failed" });
    expect(state.active?.error).toContain("must contain exactly one decision for existing memory item");
    expect(state.active?.error).toContain("CLAUDE.md");
  });

  it("rejects a Harness Engineer commit that changes content outside a memory block", async () => {
    const context = await createContext(true);
    await prepareHarnessMemoryReview(context);
    const sharedMemoryHostPath = path.join(context.taskRepoRoot, "CLAUDE.md");
    await writeFile(
      sharedMemoryHostPath,
      `${await readFile(sharedMemoryHostPath, "utf8")}\nUnauthorized surrounding edit.\n`,
      "utf8"
    );
    context.recordHarnessCommit(["CLAUDE.md"]);

    await context.service.handleHarnessEngineerHook({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      eventName: "Stop"
    });

    const state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.status).toBe("failed");
    expect(state.active?.error).toContain("changed content outside the VCM memory block");
    expect(state.active?.error).toContain("after-block content differs at character");
    expect(state.active?.error).toContain("Unauthorized surrounding edit");
  });

  it("reports changes before a memory block with the first differing location", async () => {
    const context = await createContext(true);
    await prepareHarnessMemoryReview(context);
    const sharedMemoryHostPath = path.join(context.taskRepoRoot, "CLAUDE.md");
    await writeFile(
      sharedMemoryHostPath,
      `Unauthorized heading.\n${await readFile(sharedMemoryHostPath, "utf8")}`,
      "utf8"
    );
    context.recordHarnessCommit(["CLAUDE.md"]);

    await context.service.handleHarnessEngineerHook({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      eventName: "Stop"
    });

    const state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.status).toBe("failed");
    expect(state.active?.error).toContain("before-block content differs at character 0");
    expect(state.active?.error).toContain("Unauthorized heading");
  });

  it("rejects a Harness Engineer memory commit containing unrelated files", async () => {
    const context = await createContext(true);
    await prepareHarnessMemoryReview(context);
    const sharedMemoryHostPath = path.join(context.taskRepoRoot, "CLAUDE.md");
    await writeFile(
      sharedMemoryHostPath,
      replaceVcmMemoryBlock(
        await readFile(sharedMemoryHostPath, "utf8"),
        "Reviewed memory with an unrelated committed file.\n"
      ),
      "utf8"
    );
    context.recordHarnessCommit(["CLAUDE.md", "src/unrelated.ts"]);

    await context.service.handleHarnessEngineerHook({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      eventName: "Stop"
    });

    const state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
    expect(state.status).toBe("failed");
    expect(state.active?.error).toContain("contains files outside managed memory hosts: src/unrelated.ts");
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
    let headCommit = "base-commit";
    const commitHistory = [{ sha: headCommit, paths: [] as string[] }];
    const busyRoles = new Set<RoleName>();
    const unavailableRoles = new Set<RoleName>();
    let memoryEnabled = autoMemoryEnabled;
    const sessionFor = (role: RoleName): RoleSessionRecord => ({
      id: `session-${role}`,
      claudeSessionId: `claude-${role}`,
      taskSlug: "demo",
      role,
      status: "running",
      activityStatus: busyRoles.has(role) ? "running" : "idle",
      command: "claude",
      permissionMode: "bypassPermissions",
      model: "default",
      effort: "default",
      cwd: taskRepoRoot,
      terminalBackend: "node-pty",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });
    const createService = () => createAutoMemoryService({
      fs: createNodeFileSystemAdapter(),
      git: {
        async getDiff() {
          return gitDiff;
        },
        async getHeadCommit() {
          return headCommit;
        },
        async getChangedPaths(_repo, base, head) {
          if (base === `${head}^`) {
            return commitHistory.find((commit) => commit.sha === head)?.paths ?? [];
          }
          const start = commitHistory.findIndex((commit) => commit.sha === base);
          const end = commitHistory.findIndex((commit) => commit.sha === head);
          return [...new Set(commitHistory.slice(start + 1, end + 1).flatMap((commit) => commit.paths))];
        },
        async getCommitList(_repo, range) {
          const [base, head] = range.split("..");
          return commitHistory.slice(
            commitHistory.findIndex((commit) => commit.sha === base) + 1,
            commitHistory.findIndex((commit) => commit.sha === head) + 1
          ).map((commit) => ({ sha: commit.sha, subject: "test commit" }));
        },
        async commitPaths(_repoRoot, message, paths) {
          gitCommits.push({ message, paths });
          headCommit = `vcm-commit-${gitCommits.length}`;
          commitHistory.push({ sha: headCommit, paths });
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
          if (unavailableRoles.has(role)) {
            throw new Error(`${role} session is unavailable`);
          }
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
    const service = createService();
    return {
      baseRepoRoot,
      taskRepoRoot,
      terminalWrites,
      gitCommits,
      service,
      createService,
      setRoleBusy(role: RoleName, busy: boolean) {
        if (busy) busyRoles.add(role);
        else busyRoles.delete(role);
      },
      setRoleUnavailable(role: RoleName) {
        unavailableRoles.add(role);
      },
      setAutoMemoryEnabled(enabled: boolean) {
        memoryEnabled = enabled;
      },
      setGitDiff(diff: string) {
        gitDiff = diff;
      },
      recordHarnessCommit(paths: string[], commit = "harness-memory-commit") {
        commitHistory.push({ sha: commit, paths: [...paths] });
        headCommit = commit;
      }
    };
  }

  function docContext(context: Awaited<ReturnType<typeof createContext>>) {
    return { baseRepoRoot: context.baseRepoRoot, taskRepoRoot: context.taskRepoRoot, taskSlug: "demo" };
  }

  function docHook(context: Awaited<ReturnType<typeof createContext>>, role: RoleName) {
    return { ...docContext(context), role, eventName: "Stop" as const };
  }

  async function prepareDocAssignments(context: Awaited<ReturnType<typeof createContext>>, targets: string[]) {
    const entries = targets.map((target, index) => `## Fact ${index + 1}\nVerified knowledge for ${target}.`);
    const review = await prepareHarnessMemoryReview(context, entries.join("\n\n"));
    const result = JSON.parse(await readFile(review.reviewResultPath, "utf8"));
    result.decisions = result.decisions.map((decision: { target: string; entry: string }) => decision.target === "shared"
      ? { ...decision, decision: "move-to-durable-doc", finalContent: "none", durableDocPath: targets[entries.indexOf(decision.entry)] }
      : decision);
    result.memoryCommit = "memory-move-commit";
    result.durableDocAssignments = targets.map((targetPath, index) => ({
      sourceMemoryPath: "CLAUDE.md", sourceEntry: entries[index], targetPath,
      content: `Verified knowledge for ${targetPath}.`, reason: "Maintainer documentation is the correct owner.", evidence: ["src/module.ts"]
    }));
    const sharedPath = path.join(context.taskRepoRoot, "CLAUDE.md");
    await writeFile(sharedPath, replaceVcmMemoryBlock(await readFile(sharedPath, "utf8"), "No accumulated project memory yet.\n"));
    context.recordHarnessCommit(["CLAUDE.md"], result.memoryCommit);
    await writeFile(review.reviewResultPath, JSON.stringify(result));
    await context.service.handleHarnessEngineerHook({ ...docContext(context), eventName: "Stop" });
    return (await context.service.getState(context.baseRepoRoot, context.taskRepoRoot)).active!.assignments;
  }

  async function writeAssignmentReport(context: Awaited<ReturnType<typeof createContext>>, assignment: DurableDocAssignmentState, commit: string, decision = "synced") {
    const reportPath = path.join(context.taskRepoRoot, assignment.reportPath);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, renderDocsUpdateReportTemplate("demo", assignment.id)
      .replaceAll("TBD", commit).replace("synced|unchanged|blocked", decision));
  }

  async function writeDocResult(context: Awaited<ReturnType<typeof createContext>>, assignment: DurableDocAssignmentState, commit: string) {
    const targetPath = path.join(context.taskRepoRoot, assignment.targetPath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, assignment.content);
    context.recordHarnessCommit([assignment.targetPath], commit);
    await writeAssignmentReport(context, assignment, commit);
  }

  async function prepareHarnessMemoryReview(
    context: Awaited<ReturnType<typeof createContext>>,
    sharedMemory = "No accumulated project memory yet."
  ) {
    if (sharedMemory !== "No accumulated project memory yet.") {
      const sharedPath = path.join(context.taskRepoRoot, "CLAUDE.md");
      await writeFile(
        sharedPath,
        replaceVcmMemoryBlock(await readFile(sharedPath, "utf8"), `${sharedMemory}\n`),
        "utf8"
      );
    }
    const finalAcceptancePath = path.join(context.taskRepoRoot, ".ai/vcm/handoffs/final-acceptance.md");
    await mkdir(path.dirname(finalAcceptancePath), { recursive: true });
    await writeFile(finalAcceptancePath, acceptedFinalAcceptance("demo"), "utf8");
    await context.service.reconcileTask({
      baseRepoRoot: context.baseRepoRoot,
      taskRepoRoot: context.taskRepoRoot,
      taskSlug: "demo",
      handoffDir: ".ai/vcm/handoffs",
      roundReady: true,
      requestTrigger: "manual"
    });
    for (const role of ["project-manager", "architect", "coder", "tester"] as const) {
      const state = await context.service.getState(context.baseRepoRoot, context.taskRepoRoot);
      const draft = state.active?.drafts.find((item) => item.role === role);
      await mkdir(path.dirname(path.join(context.taskRepoRoot, draft!.path)), { recursive: true });
      await writeFile(path.join(context.taskRepoRoot, draft!.path), noChangeMemoryProposal(), "utf8");
      await context.service.handleRoleHook({
        baseRepoRoot: context.baseRepoRoot,
        taskRepoRoot: context.taskRepoRoot,
        taskSlug: "demo",
        role,
        eventName: "Stop"
      });
    }
    const retrospectiveReportPath = path.join(
      context.baseRepoRoot,
      ".ai/vcm/harness-feedback/task-retrospectives/demo.md"
    );
    const review = await context.service.prepareTaskRetrospectiveReview(context.taskRepoRoot, retrospectiveReportPath);
    await mkdir(path.dirname(retrospectiveReportPath), { recursive: true });
    await writeFile(retrospectiveReportPath, "# Task Harness Retrospective\n", "utf8");
    const manifest = JSON.parse(await readFile(review!.existingEntriesPath, "utf8")) as {
      entries: Array<{
        itemId: string;
        target: Parameters<typeof existingDecision>[0];
        entry: string;
      }>;
    };
    await writeFile(
      review!.reviewResultPath,
      `${JSON.stringify({
        version: 1,
        runId: review!.runId,
        memoryCommit: "none",
        decisions: manifest.entries.map((entry) => existingDecision(
          entry.target,
          entry.entry,
          "retain",
          entry.entry,
          entry.itemId
        )),
        durableDocAssignments: []
      }, null, 2)}\n`,
      "utf8"
    );
    return review!;
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

function acceptedFinalAcceptance(taskSlug: string): string {
  return renderFinalAcceptanceTemplate(taskSlug)
    .replaceAll("TBD", "None.")
    .replace(
      "accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|needs-docs-sync|blocked-by-user-decision",
      "accepted"
    );
}

function memoryReviewReport(): string {
  return [
    "# Task Harness Retrospective",
    "",
    "## Memory Review",
    "Existing memory reviewed: complete",
    "",
    "### Proposal Decisions",
    "#### Candidate architect-planning:add:1",
    "Source: architect-planning",
    "Operation: add",
    "Target: shared",
    "Candidate: Planning discovered backend-owned lifecycle state.",
    "Decision: keep-in-memory",
    "Final target: shared",
    "Why memory is necessary: Workflow roles need the backend lifecycle owner across future tasks.",
    "Impact if absent: Roles may infer lifecycle completion independently.",
    "Durable doc disposition: memory",
    "Durable doc analysis: This concise cross-task invariant belongs in shared memory.",
    "Durable doc path: none",
    "Evidence checked: .ai/vcm/handoffs/final-acceptance.md",
    "Final content: Lifecycle completion is owned by backend hooks.",
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

function existingDecision(
  target: "shared" | "project-manager" | "architect" | "coder" | "tester" | "reviewer" | "harness-engineer",
  entry: string,
  decision: "retain" | "update" | "remove" | "move-to-durable-doc",
  finalContent = entry,
  itemId = existingEntryItemId(target, entry)
) {
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

function existingEntryItemId(target: string, entry: string, index = 1): string {
  const normalized = entry.replace(/\r\n?/g, "\n").trim();
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `existing:${target}:${index}:${hash}`;
}

function defaultRoleMemoryDecisions() {
  return (["project-manager", "architect", "coder", "tester", "reviewer", "harness-engineer"] as const)
    .map((role) => existingDecision(role, "No accumulated project memory yet.", "retain"));
}

function proposalDecision(itemId: string, entry: string, finalContent: string) {
  return {
    itemId,
    source: "proposal",
    target: "shared",
    entry,
    decision: "keep-in-memory",
    reason: "Verified durable lifecycle ownership.",
    impactIfAbsent: "Future roles could infer lifecycle ownership incorrectly.",
    evidence: [".ai/vcm/handoffs/final-acceptance.md"],
    finalContent,
    durableDocPath: "none"
  };
}
