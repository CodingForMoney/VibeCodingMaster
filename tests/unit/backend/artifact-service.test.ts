import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createArtifactService } from "../../../src/backend/services/artifact-service.js";
import { renderArchitectDebugTemplate, renderDocsUpdateReportTemplate } from "../../../src/backend/templates/handoff.js";
import type { DurableDocAssignmentState } from "../../../src/shared/types/memory.js";
import {
  GATE_ANALYSIS_FIELDS,
  parseGateReviewReportArtifact
} from "../../../src/backend/services/managed-artifact-validation.js";
import {
  ARCHITECT_PLANNING_MEMORY_CANDIDATE_PATH,
  architectPlanningCandidateSnapshotPath,
  durableDocAssignmentReportPath,
  memoryReviewRoleDraftPath
} from "../../../src/backend/services/memory-review-paths.js";

describe("createArtifactService", () => {
  it("prefers role-commands/<role>.md for role command paths", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);
    await fs.writeText("/repo/.ai/vcm/handoffs/role-commands/coder.md", "# ready");

    await expect(service.resolveRoleCommandPath({
      repoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      role: "coder"
    })).resolves.toBe(".ai/vcm/handoffs/role-commands/coder.md");
  });

  it("falls back to legacy role-commands/<role>-command.md files", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);
    await fs.writeText("/repo/.ai/vcm/handoffs/role-commands/coder-command.md", "# legacy");

    await expect(service.resolveRoleCommandPath({
      repoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      role: "coder"
    })).resolves.toBe(".ai/vcm/handoffs/role-commands/coder-command.md");
  });

  it("rejects placeholder role commands before dispatch", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);
    await fs.writeText("/repo/.ai/vcm/handoffs/role-commands/coder.md", "# coder\n\n## Objective\n\nTBD\n");

    await expect(service.readRoleCommand({
      repoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      role: "coder"
    })).rejects.toMatchObject({
      code: "ROLE_COMMAND_NOT_READY"
    });
  });

  it("creates and checks docs update, docs sync, and final acceptance artifacts", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);

    const created = await service.createArtifactTemplates({
      repoRoot: "/repo",
      taskSlug: "demo-task",
      handoffDir: ".ai/vcm/handoffs"
    });
    const summary = await service.listArtifacts({
      repoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs"
    });

    expect(created).toContain(".ai/vcm/handoffs/docs-update-report.md");
    expect(created).toContain(".ai/vcm/handoffs/docs-sync-report.md");
    expect(created).toContain(".ai/vcm/handoffs/final-acceptance.md");
    expect(created).toContain(".ai/vcm/handoffs/known-issues.md");
    expect(created).toContain(".ai/vcm/handoffs/coder-completion.md");
    expect(created).toContain(".ai/vcm/handoffs/architect-debug.md");
    expect(created).toContain(".ai/vcm/handoffs/architecture-brief.md");
    expect(summary.paths.architectureBriefPath).toBe(".ai/vcm/handoffs/architecture-brief.md");
    expect(summary.paths.docsUpdateReportPath).toBe(".ai/vcm/handoffs/docs-update-report.md");
    expect(summary.paths.docsSyncReportPath).toBe(".ai/vcm/handoffs/docs-sync-report.md");
    expect(summary.paths.finalAcceptancePath).toBe(".ai/vcm/handoffs/final-acceptance.md");
    expect(summary.paths.knownIssuesPath).toBe(".ai/vcm/handoffs/known-issues.md");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/role-commands/coder.md"))
      .resolves.toContain("## Worktree");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/role-commands/coder.md"))
      .resolves.toContain("Task repo root: /repo");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/role-commands/coder.md"))
      .resolves.toContain("Rule: only edit files under Task repo root.");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/coder-completion.md"))
      .resolves.toContain("## L0/L1 Validation");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/coder-completion.md"))
      .resolves.toContain("| ID | Action | Result | Marker State | Proof Evidence |");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/coder-completion.md"))
      .resolves.not.toContain("## Remaining Markers");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/architecture-plan.md"))
      .resolves.toContain("Planning Result: complete|incomplete|user clarification required");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/architecture-plan.md"))
      .resolves.toContain("| ID | Action | File | Symbol Or Site | Coder Work | Allowed Implementation Freedom | Behavior / Contract Proof Point |");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/architecture-plan.md"))
      .resolves.toContain("## Scaffold Build Evidence");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/architecture-plan.md"))
      .resolves.not.toContain("File / Action");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/architecture-plan.md"))
      .resolves.not.toContain("Expected VCM:CODE");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/architecture-plan.md"))
      .resolves.not.toContain("SCF-001");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/architecture-brief.md"))
      .resolves.toContain("Architecture Brief Status: interviewing|confirmed");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/architect-debug.md"))
      .resolves.toContain("## Confirmed Root Cause");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/architect-debug.md"))
      .resolves.toContain("## L2/L3 Validation");
    await expect(fs.readText("/repo/.ai/vcm/handoffs/architect-debug.md"))
      .resolves.toContain("## Final Disposition");
    expect(summary.checks.find((check) => check.kind === "docs-update-report")).toMatchObject({
      status: "incomplete",
      hasPlaceholder: true
    });
    expect(summary.checks.find((check) => check.kind === "docs-sync-report")).toMatchObject({
      status: "incomplete",
      hasPlaceholder: true
    });
    expect(summary.checks.find((check) => check.kind === "final-acceptance")).toMatchObject({
      status: "incomplete",
      hasPlaceholder: true
    });
    expect(summary.checks.find((check) => check.kind === "known-issues")).toMatchObject({
      status: "ok",
      hasPlaceholder: false
    });
  });

  it("validates and atomically replaces a role-owned handoff", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);
    const target = "/repo/.ai/vcm/handoffs/coder-completion.md";
    await fs.writeText(target, "previous accepted content\n");

    await expect(service.submitArtifact({
      repoRoot: "/repo",
      baseRepoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: "demo-task",
      kind: "coder-completion",
      mode: "final",
      role: "coder",
      content: "# invalid\n"
    })).rejects.toMatchObject({ code: "ARTIFACT_VALIDATION_FAILED" });
    await expect(fs.readText(target)).resolves.toBe("previous accepted content\n");

    const result = await service.submitArtifact({
      repoRoot: "/repo",
      baseRepoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: "demo-task",
      kind: "coder-completion",
      mode: "final",
      role: "coder",
      content: validCoderCompletion()
    });

    expect(result).toMatchObject({
      path: ".ai/vcm/handoffs/coder-completion.md",
      status: "ok"
    });
    await expect(fs.readText(target)).resolves.toBe(validCoderCompletion());
  });

  it("rejects an explanatory Architect Debug disposition without replacing accepted evidence", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);
    const target = "/repo/.ai/vcm/handoffs/architect-debug.md";
    await fs.writeText(target, "previous accepted debug evidence\n");
    const content = renderArchitectDebugTemplate("demo-task")
      .replace("Status: pending|completed", "Status: completed")
      .replace(
        "local fix completed|normal architecture plan required|user clarification required",
        "normal architecture plan required\n\nThe repair needs a normal plan."
      )
      .replaceAll("TBD", "Verified debug evidence.");

    await expect(service.submitArtifact({
      repoRoot: "/repo",
      baseRepoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: "demo-task",
      kind: "architect-debug",
      mode: "final",
      role: "architect",
      content
    })).rejects.toMatchObject({
      code: "ARTIFACT_VALIDATION_FAILED",
      message: expect.stringContaining("Final Disposition must contain exactly")
    });
    await expect(fs.readText(target)).resolves.toBe("previous accepted debug evidence\n");
  });

  it("rejects a submission from a role that does not own the artifact", async () => {
    const service = createArtifactService(createMemoryFs());

    await expect(service.submitArtifact({
      repoRoot: "/repo",
      baseRepoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: "demo-task",
      kind: "test-report",
      mode: "final",
      role: "coder",
      content: "# Test Report\n"
    })).rejects.toMatchObject({ code: "ARTIFACT_OWNER_MISMATCH" });
  });

  it("owns artifact kind, mode, and path policy in the backend contract", async () => {
    const service = createArtifactService(createMemoryFs());
    const base = {
      repoRoot: "/repo",
      baseRepoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: "demo-task"
    };

    await expect(service.submitArtifact({
      ...base,
      kind: "unknown-artifact",
      mode: "final",
      role: "coder",
      content: "content\n"
    })).rejects.toMatchObject({ code: "ARTIFACT_KIND_INVALID" });

    await expect(service.submitArtifact({
      ...base,
      kind: "coder-completion",
      mode: "final",
      role: "coder",
      artifactPath: ".ai/vcm/handoffs/alternate.md",
      content: validCoderCompletion()
    })).rejects.toMatchObject({
      code: "ARTIFACT_VALIDATION_FAILED",
      message: expect.stringContaining("--path is not allowed")
    });

    await expect(service.submitArtifact({
      ...base,
      kind: "route-message",
      mode: "draft",
      role: "coder",
      artifactPath: ".ai/vcm/handoffs/messages/coder-project-manager.md",
      content: "---\ntype: result\n---\nComplete.\n"
    })).rejects.toMatchObject({
      code: "ARTIFACT_VALIDATION_FAILED",
      message: expect.stringContaining("supports only final mode")
    });
  });

  it("accepts Docs Update Reports from every Docs-Only role and rejects unrelated roles", async () => {
    const service = createArtifactService(createMemoryFs());
    const content = [
      "# Docs Update Report: demo-task",
      "",
      "## Summary",
      "Updated documentation.",
      "## Assignment ID",
      "docs-only",
      "## Documents Updated",
      "docs/TESTING.md",
      "## Documents Reviewed And Left Unchanged",
      "None.",
      "## Evidence Reviewed",
      "Current tests.",
      "## Checks Performed",
      "Documentation audit passed.",
      "## Commit",
      "abc1234",
      "## Remaining Documentation Issues",
      "None.",
      "## Decision",
      "synced",
      ""
    ].join("\n");

    for (const role of ["architect", "coder", "tester"] as const) {
      await expect(service.submitArtifact({
        repoRoot: "/repo",
        baseRepoRoot: "/repo",
        handoffDir: ".ai/vcm/handoffs",
        taskSlug: "demo-task",
        kind: "docs-update-report",
        mode: "final",
        role,
        content
      })).resolves.toMatchObject({ status: "ok" });
    }

    await expect(service.submitArtifact({
      repoRoot: "/repo",
      baseRepoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: "demo-task",
      kind: "docs-update-report",
      mode: "final",
      role: "reviewer",
      content
    })).rejects.toMatchObject({ code: "ARTIFACT_OWNER_MISMATCH" });
  });

  it("isolates memory assignment reports and binds submission to the assigned role, path and ID", async () => {
    const fs = createMemoryFs();
    const assignment: DurableDocAssignmentState = {
      id: "run-doc-1", runId: "run", sourceMemoryPath: "CLAUDE.md", sourceEntry: "Fact",
      content: "Fact", reason: "Durable fact", evidence: ["src/app.ts"], targetPath: "docs/ARCHITECTURE.md",
      owner: "architect", status: "running", reportPath: durableDocAssignmentReportPath("run", "run-doc-1"),
      createdAt: "2026-09-09", updatedAt: "2026-09-09"
    };
    let active = true;
    const service = createArtifactService(fs, {
      getDurableDocAssignment: async (_repo, role) => active && role === assignment.owner ? assignment : undefined
    });
    const content = renderDocsUpdateReportTemplate("demo-task", assignment.id)
      .replace("## Commit\n\nTBD", "## Commit\n\nabc1234")
      .replaceAll("TBD", "Verified docs").replace("synced|unchanged|blocked", "synced");
    const request = {
      repoRoot: "/repo", baseRepoRoot: "/repo", handoffDir: ".ai/vcm/handoffs", taskSlug: "demo-task",
      kind: "docs-update-report", mode: "final" as const, role: "architect" as const, content,
      artifactPath: assignment.reportPath
    };
    await fs.writeText("/repo/.ai/vcm/handoffs/docs-update-report.md", "Unrelated Docs-Only report");
    await expect(service.submitArtifact(request)).resolves.toMatchObject({ path: assignment.reportPath, status: "ok" });
    expect(await fs.readText("/repo/.ai/vcm/handoffs/docs-update-report.md")).toBe("Unrelated Docs-Only report");
    for (const changes of [
      { artifactPath: undefined },
      { artifactPath: durableDocAssignmentReportPath("run", "run-doc-2") },
      { artifactPath: "../outside.md" },
      { content: content.replace(assignment.id, "wrong-id") },
      { role: "coder" as const }
    ]) {
      await expect(service.submitArtifact({ ...request, ...changes })).rejects.toMatchObject({ code: "ARTIFACT_VALIDATION_FAILED" });
    }
    expect(await fs.readText(`/repo/${assignment.reportPath}`)).toBe(content);
    for (const commit of ["`abc1234`", "abc1234 docs: updated", "abc1234\nExplanation", "abc1234\ndef5678"]) {
      await expect(service.submitArtifact({ ...request,
        content: content.replace("## Commit\n\nabc1234", `## Commit\n\n${commit}`)
      })).rejects.toMatchObject({
        code: "ARTIFACT_VALIDATION_FAILED", message: expect.stringContaining(`Received Commit: ${JSON.stringify(commit)}`)
      });
      expect(await fs.readText(`/repo/${assignment.reportPath}`)).toBe(content);
    }
    await expect(service.submitArtifact(request)).resolves.toMatchObject({ status: "ok" });
    active = false;
    await expect(service.submitArtifact(request)).rejects.toMatchObject({ code: "ARTIFACT_VALIDATION_FAILED" });
  });

  it("accepts incomplete coder evidence only as a draft", async () => {
    const service = createArtifactService(createMemoryFs());
    const incomplete = validCoderCompletion().replace(
      "Decision: ready_for_review",
      "Decision: incomplete"
    );

    await expect(service.submitArtifact({
      repoRoot: "/repo",
      baseRepoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: "demo-task",
      kind: "coder-completion",
      mode: "final",
      role: "coder",
      content: incomplete
    })).rejects.toMatchObject({ code: "ARTIFACT_VALIDATION_FAILED" });

    await expect(service.submitArtifact({
      repoRoot: "/repo",
      baseRepoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: "demo-task",
      kind: "coder-completion",
      mode: "draft",
      role: "coder",
      content: incomplete
    })).resolves.toMatchObject({ status: "ok" });
  });

  it("validates dynamic route messages and coder worker reports", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);
    const routePath = ".ai/vcm/handoffs/messages/coder-project-manager.md";
    const workerPath = ".ai/vcm/coder-workers/reports/worker-1.md";

    await service.submitArtifact({
      repoRoot: "/repo",
      baseRepoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: "demo-task",
      kind: "route-message",
      mode: "final",
      role: "coder",
      artifactPath: routePath,
      content: "---\ntype: result\nartifact_refs: .ai/vcm/handoffs/coder-completion.md\n---\n\nSummary:\nComplete.\n"
    });
    await service.submitArtifact({
      repoRoot: "/repo",
      baseRepoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: "demo-task",
      kind: "coder-worker-report",
      mode: "final",
      role: "coder",
      artifactPath: workerPath,
      content: validCoderWorkerReport()
    });

    await expect(fs.readText(`/repo/${routePath}`)).resolves.toContain("type: result");
    await expect(fs.readText(`/repo/${workerPath}`)).resolves.toContain("Implementation Result: success");
  });

  it("rejects a gate report the consumer cannot parse and preserves the accepted report", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);
    const requestId = "request-1";
    const reportPath = `.ai/vcm/gate-reviews/requests/${requestId}.report.md`;
    const requestPath = `/repo/.ai/vcm/gate-reviews/requests/${requestId}.json`;
    const targetPath = `/repo/${reportPath}`;
    await fs.writeJson(requestPath, {
      requestId,
      gate: "architecture-plan",
      reportPath
    });
    await fs.writeText(targetPath, "previous accepted report\n");

    const invalid = validArchitectureGateReport().replace("- Gap: Required behavior is absent.\n", "");
    await expect(service.submitArtifact({
      repoRoot: "/repo",
      baseRepoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: "demo-task",
      kind: "gate-review-report",
      mode: "final",
      role: "reviewer",
      artifactPath: reportPath,
      content: invalid
    })).rejects.toMatchObject({
      code: "ARTIFACT_VALIDATION_FAILED",
      message: expect.stringContaining("field Gap")
    });
    await expect(fs.readText(targetPath)).resolves.toBe("previous accepted report\n");

    const valid = validArchitectureGateReport();
    await expect(service.submitArtifact({
      repoRoot: "/repo",
      baseRepoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: "demo-task",
      kind: "gate-review-report",
      mode: "final",
      role: "reviewer",
      artifactPath: reportPath,
      content: valid
    })).resolves.toMatchObject({ path: reportPath, status: "accepted" });
    expect(parseGateReviewReportArtifact(await fs.readText(targetPath), {
      expectedGate: "architecture-plan",
      expectedRequestId: requestId
    }).errors).toEqual([]);
  });

  it("accepts only the Memory Proposal locations assigned to the submitting role", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);
    const content = validNoChangeMemoryProposal();

    await expect(service.submitArtifact({
      repoRoot: "/repo/task",
      baseRepoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: "demo-task",
      kind: "memory-proposal",
      mode: "final",
      role: "architect",
      artifactPath: ARCHITECT_PLANNING_MEMORY_CANDIDATE_PATH,
      content
    })).resolves.toMatchObject({ path: ARCHITECT_PLANNING_MEMORY_CANDIDATE_PATH });
    await expect(fs.readText(`/repo/task/${ARCHITECT_PLANNING_MEMORY_CANDIDATE_PATH}`))
      .resolves.toBe(content);

    const coderDraftPath = memoryReviewRoleDraftPath("run-1", "coder");
    await expect(service.submitArtifact({
      repoRoot: "/repo/task",
      baseRepoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: "demo-task",
      kind: "memory-proposal",
      mode: "final",
      role: "coder",
      artifactPath: coderDraftPath,
      content
    })).resolves.toMatchObject({ path: coderDraftPath });

    for (const [role, artifactPath] of [
      ["coder", ARCHITECT_PLANNING_MEMORY_CANDIDATE_PATH],
      ["architect", coderDraftPath],
      ["architect", architectPlanningCandidateSnapshotPath("run-1")],
      ["architect", ".ai/vcm/memory-review/candidates/architect/other.md"]
    ] as const) {
      await expect(service.submitArtifact({
        repoRoot: "/repo/task",
        baseRepoRoot: "/repo",
        handoffDir: ".ai/vcm/handoffs",
        taskSlug: "demo-task",
        kind: "memory-proposal",
        mode: "final",
        role,
        artifactPath,
        content
      })).rejects.toMatchObject({ code: "ARTIFACT_VALIDATION_FAILED" });
    }
  });

  it("allows Reviewer feedback and rejects tool-role workflow artifacts", async () => {
    const fs = createMemoryFs();
    const service = createArtifactService(fs);
    const feedbackPath = ".ai/vcm/harness-feedback/pending/reviewer-feedback.md";

    await expect(service.submitArtifact({
      repoRoot: "/repo/task",
      baseRepoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: "demo-task",
      kind: "harness-feedback",
      mode: "final",
      role: "reviewer",
      artifactPath: feedbackPath,
      content: validHarnessFeedback()
    })).resolves.toMatchObject({ path: feedbackPath });
    await expect(fs.readText(`/repo/${feedbackPath}`)).resolves.toContain("Reporter role: reviewer");

    await expect(service.submitArtifact({
      repoRoot: "/repo/task",
      baseRepoRoot: "/repo",
      handoffDir: ".ai/vcm/handoffs",
      taskSlug: "demo-task",
      kind: "memory-proposal",
      mode: "final",
      role: "translator",
      artifactPath: ".ai/vcm/memory-review/candidates/translator.md",
      content: "# Memory Proposal\n\nDecision: no-change\n\n## Add\nnone\n\n## Update\nnone\n\n## Remove\nnone\n"
    })).rejects.toMatchObject({ code: "ARTIFACT_OWNER_MISMATCH" });
  });

});

function validCoderCompletion(): string {
  return `# Coder Completion: demo-task

Decision: ready_for_review

## Scaffold Completion
Complete.

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

function validCoderWorkerReport(): string {
  return `# Coder Worker Report: worker-1

Worker State: completed
Implementation Result: success

## Assigned Scope
module-a

## Item Dispositions
All assigned items passed.

## Files Changed
src/feature.ts

## Tests Added Or Updated
tests/feature.test.ts

## L0/L1 Checks
Passed.

## Commit
abc1234

## Skipped Assigned Checks
None.

## Objective Failures
None.
`;
}

function validHarnessFeedback(): string {
  return `# Reusable Reviewer Finding

- Reporter role: reviewer
- Task slug: demo-task
- Summary: The review template omits required evidence.
- Observed problem: Reviewer repeatedly has to infer an unstated field.
- Expected behavior: The template includes the required evidence field.
- Evidence: Two review reports required manual correction.
- Suspected harness area: Reviewer template
- Impact: Review results are inconsistent.
- Urgency: medium
`;
}

function validNoChangeMemoryProposal(): string {
  return `# Memory Proposal
Decision: no-change

## Add
none

## Update
none

## Remove
none
`;
}

function validArchitectureGateReport(): string {
  return [
    "Gate: architecture-plan",
    "Request: request-1",
    "Decision: request_changes",
    "Summary: A required behavior is missing.",
    "",
    "## Architecture Analysis",
    "",
    ...GATE_ANALYSIS_FIELDS["architecture-plan"].map((field) => `- ${field}: Verified.`),
    "",
    "## Findings",
    "",
    "### high: Missing required behavior",
    "- Evidence: The reviewed scaffold omits the behavior.",
    "- Expected: The required behavior is present.",
    "- Gap: Required behavior is absent.",
    "- Risk: Coder cannot implement the accepted flow.",
    ""
  ].join("\n");
}

function createMemoryFs(): FileSystemAdapter {
  const files = new Map<string, string>();
  return {
    async pathExists(targetPath) {
      return files.has(targetPath);
    },
    async ensureDir() {},
    async readDir() {
      return [];
    },
    async readText(targetPath) {
      const value = files.get(targetPath);
      if (value === undefined) {
        throw new Error(`missing ${targetPath}`);
      }
      return value;
    },
    async writeText(targetPath, content) {
      files.set(targetPath, content);
    },
    async appendText(targetPath, content) {
      files.set(targetPath, `${files.get(targetPath) ?? ""}${content}`);
    },
    async readJson(targetPath) {
      return JSON.parse(await this.readText(targetPath));
    },
    async writeJson(targetPath, value) {
      await this.writeText(targetPath, `${JSON.stringify(value, null, 2)}\n`);
    },
    async writeJsonAtomic(targetPath, value) {
      await this.writeJson(targetPath, value);
    },
    async ensureFile(targetPath, content) {
      if (files.has(targetPath)) {
        return false;
      }
      files.set(targetPath, content);
      return true;
    }
  };
}
