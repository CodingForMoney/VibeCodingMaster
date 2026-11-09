// Scenario tests for the fixed Project Manager rules. Each scenario walks one
// rule branch the way PM and the roles follow it: roles commit code, tests,
// and docs in a real Git worktree and write their handoffs, PM proposes the
// routes the rules prescribe through Workflow Control, and PM requests the
// Gates the rules prescribe from the real Gate Review service. A scripted
// Reviewer only supplies each Gate's decision. A rule route the controller
// rejects, or a prescribed Gate that fails to start, fails the scenario, so
// the rules and the code they depend on cannot drift apart unnoticed.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { createCommandRunner } from "../../../src/backend/adapters/command-runner.js";
import { createNodeFileSystemAdapter, type FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import type { TerminalRuntime } from "../../../src/backend/runtime/terminal-runtime.js";
import { createGateReviewService, type GateReviewService } from "../../../src/backend/services/gate-review-service.js";
import {
  GATE_ANALYSIS_FIELDS,
  GATE_ANALYSIS_HEADINGS
} from "../../../src/backend/services/managed-artifact-validation.js";
import {
  createWorkflowControlService,
  parseWorkflowProgress,
  renderWorkflowProgress,
  type WorkflowControlContext,
  type WorkflowControlService
} from "../../../src/backend/services/workflow-control-service.js";
import {
  renderArchitectDebugTemplate,
  renderArchitectureBriefTemplate,
  renderArchitectureDiagnosisTemplate,
  renderArchitectureEvidenceTemplate,
  renderArchitecturePlanTemplate,
  renderCoderCompletionTemplate,
  renderFinalAcceptanceTemplate,
  renderTestReportTemplate
} from "../../../src/backend/templates/handoff.js";
import type { CodeDiffFindingScope, CodeDiffSource, GateReviewGate } from "../../../src/shared/types/gate-review.js";
import type { DispatchableRole } from "../../../src/shared/types/role.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";
import type { WorkflowFlow, WorkflowProgressDocument } from "../../../src/shared/types/workflow.js";

const TASK_SLUG = "demo-task";
const execFileAsync = promisify(execFile);
const roots: string[] = [];

// Each scenario owns its repository, so scenarios run concurrently and their
// repositories are removed once every scenario has finished.
const SCENARIOS = { concurrent: true, timeout: 120_000 };

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const DOCS_ONLY: ScriptedReview = { decision: "request_changes", scopes: ["docs-only"] };
const TEST_ONLY: ScriptedReview = { decision: "request_changes", scopes: ["test-only"] };
const IMPLEMENTATION: ScriptedReview = { decision: "request_changes", scopes: ["implementation"] };
const CHANGES: ScriptedReview = { decision: "request_changes" };

describe("Project Manager rule scenarios: Code-Change Flow", SCENARIOS, () => {
  it("plans, implements, validates, reviews, and accepts", async () => {
    const s = await createScenario();
    await s.enterCodeChangeValidation();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "coder");
    await s.accept();
  });

  it("rejects a route the rules do not allow", async () => {
    const s = await createScenario();
    await s.enterCodeChangeValidation();
    await s.gate("validation-adequacy");
    await s.expectRouteDenied("coder");
  });

  it("Validation Revision: routes a validation-adequacy rejection to Tester and reruns the Gate", async () => {
    const s = await createScenario();
    await s.enterCodeChangeValidation();
    await s.gate("validation-adequacy", undefined, CHANGES);
    await s.route("tester", undefined, "validation-adequacy report");
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "coder");
    await s.accept();
  });

  it("Tester Code-Diff Correction: repeats Tester validation and both Gates", async () => {
    const s = await createScenario();
    await s.enterCodeChangeValidated();
    await s.gate("code-diff", "coder", TEST_ONLY);
    await s.route("tester", undefined, "test-only code-diff report");
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "coder");
    await s.accept();
  });

  it("Docs Code-Diff Correction: reruns only code-diff after Architect corrects the docs", async () => {
    const s = await createScenario();
    await s.enterCodeChangeValidated();
    await s.gate("code-diff", "coder", DOCS_ONLY);
    await s.route("architect", undefined, "docs-only code-diff report");
    await s.architectCorrectsDocs();
    await s.gate("code-diff", "coder");
    await s.accept();
  });

  it("Docs Code-Diff Correction: routes a test-only finding left by the rerun to Tester", async () => {
    const s = await createScenario();
    await s.enterCodeChangeValidated();
    await s.gate("code-diff", "coder", { decision: "request_changes", scopes: ["docs-only", "test-only"] });
    await s.route("architect", undefined, "docs-only and test-only code-diff report");
    await s.architectCorrectsDocs();
    await s.gate("code-diff", "coder", TEST_ONLY);
    await s.route("tester", undefined, "remaining test-only finding");
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "coder");
    await s.accept();
  });

  it("Docs Coverage Correction: routes a docs coverage start failure to Architect", async () => {
    let uncovered = ["Module src is not covered by the plan's Docs Impact."];
    const s = await createScenario({ docsCoverageFindings: () => uncovered });
    await s.enterCodeChangeValidated();
    expect(await s.gateFailsToStart("code-diff", "coder")).toMatch(/^Docs coverage check failed:/);
    await s.route("architect", undefined, "docs coverage failure");
    await s.architectCorrectsDocs();
    uncovered = [];
    await s.gate("code-diff", "coder");
    await s.accept();
  });

  it("Code-Diff Correction: enters Architect Debug Branch for an implementation finding", async () => {
    const s = await createScenario();
    await s.enterCodeChangeValidated();
    await s.gate("code-diff", "coder", IMPLEMENTATION);
    await s.route("architect", "architect-debug", "implementation code-diff finding");
    await s.debugFixes();
    await s.route("tester", undefined, "Debug fix");
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "architect-debug");
    await s.accept();
  });

  it("Tester Failure: enters Architect Debug Branch and returns through validation", async () => {
    const s = await createScenario();
    await s.enterCodeChangeTester();
    await s.testerValidates("fail");
    await s.route("architect", "architect-debug", "Tester failure");
    await s.debugFixes();
    await s.route("tester", undefined, "Debug fix");
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "architect-debug");
    await s.accept();
  });

  it("Final Acceptance Follow-Up: reruns code-diff after an Architect documentation follow-up", async () => {
    const s = await createScenario();
    await s.enterCodeChangeValidated();
    await s.gate("code-diff", "coder");
    await s.accept("needs-architect-follow-up");
    await s.route("architect", undefined, "Final Acceptance documentation follow-up");
    await s.architectCorrectsDocs();
    await s.gate("code-diff", "coder");
    await s.accept();
  });

  it("Final Acceptance Follow-Up: repeats validation and both Gates after a Coder follow-up", async () => {
    const s = await createScenario();
    await s.enterCodeChangeValidated();
    await s.gate("code-diff", "coder");
    await s.accept("needs-coder-follow-up");
    await s.route("coder", undefined, "Final Acceptance Coder follow-up");
    await s.coderImplements();
    await s.route("tester", undefined, "Coder follow-up");
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "coder");
    await s.accept();
  });

  it("User-Approved Post-Validation Work: repeats validation and both Gates", async () => {
    const s = await createScenario();
    await s.enterCodeChangeValidated();
    await s.gate("code-diff", "coder");
    await s.route("tester", undefined, "user-approved extra coverage", {
      followUpApprovalText: "Yes, add the extra regression coverage in this task."
    });
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "coder");
    await s.accept();
  });
});

describe("Project Manager rule scenarios: Code-Change Flow branches before validation", SCENARIOS, () => {
  it("Architecture Plan Revision: reruns the architecture-plan Gate after Architect revises the plan", async () => {
    const s = await createScenario();
    await s.route("architect", "code-change", "user request");
    s.architectPlans();
    await s.gate("architecture-plan", undefined, CHANGES);
    await s.route("architect", undefined, "architecture-plan Gate report");
    s.architectRevisesPlan();
    await s.gate("architecture-plan");
    await s.route("coder", undefined, "approved architecture plan");
    await s.coderImplements();
    await s.route("tester", undefined, "completed implementation");
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "coder");
    await s.accept();
  });

  it("Coder Failure Debug: enters Architect Debug Branch from a failed Coder result", async () => {
    const s = await createScenario();
    await s.route("architect", "code-change", "user request");
    s.architectPlans();
    await s.gate("architecture-plan");
    await s.route("coder", undefined, "approved architecture plan");
    await s.coderImplements("failed");
    await s.route("architect", "architect-debug", "Coder failure");
    await s.debugFixes();
    await s.route("tester", undefined, "Debug fix");
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "architect-debug");
    await s.accept();
  });

  it("Tester Test-Infrastructure Repair: routes Tester again and continues from its passing result", async () => {
    const s = await createScenario();
    await s.enterCodeChangeTester();
    await s.testerValidates("fail", "repair-required");
    await s.route("tester", undefined, "test-infrastructure repair");
    await s.testerValidates("pass", "repaired");
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "coder");
    await s.accept();
  });
});

describe("Project Manager rule scenarios: Architect Debug Branch", SCENARIOS, () => {
  it("Docs Code-Diff Correction: the rerun code-diff reviews the docs and the flow completes", async () => {
    const s = await createScenario();
    await s.enterDebugBranchValidated();
    await s.gate("code-diff", "architect-debug", DOCS_ONLY);
    await s.route("architect", undefined, "docs-only code-diff report");
    await s.architectCorrectsDocs("architect-debug");
    await s.gate("code-diff", "architect-debug");
    await s.accept();
  });

  it("Code-Diff Revision after a docs correction: returns an implementation finding to Debug Mode", async () => {
    const s = await createScenario();
    await s.enterDebugBranchValidated();
    await s.gate("code-diff", "architect-debug", DOCS_ONLY);
    await s.route("architect", undefined, "docs-only code-diff report");
    await s.architectCorrectsDocs("architect-debug");
    await s.gate("code-diff", "architect-debug", IMPLEMENTATION);
    await s.route("architect", undefined, "implementation code-diff finding");
    await s.debugFixes();
    await s.route("tester", undefined, "Debug revision");
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "architect-debug");
    await s.accept();
  });

  it("Tester Code-Diff Correction: repeats Tester validation and both Gates", async () => {
    const s = await createScenario();
    await s.enterDebugBranchValidated();
    await s.gate("code-diff", "architect-debug", TEST_ONLY);
    await s.route("tester", undefined, "test-only code-diff report");
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "architect-debug");
    await s.accept();
  });

  it("Architecture Diagnosis: a failed Debug validation enters Diagnosis and completes from it", async () => {
    const s = await createScenario();
    await s.enterCodeChangeTester();
    await s.testerValidates("fail");
    await s.route("architect", "architect-debug", "Tester failure");
    await s.debugFixes();
    await s.route("tester", undefined, "Debug fix");
    await s.testerValidates("fail");
    await s.route("architect", "architecture-diagnosis", "Debug validation failed");
    await s.diagnosisFixes();
    await s.route("tester", undefined, "Diagnosis fix");
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "architect-diagnosis");
    await s.accept();
  });

  it("Final Acceptance Follow-Up: reruns code-diff after an Architect documentation follow-up", async () => {
    const s = await createScenario();
    await s.enterDebugBranchValidated();
    await s.gate("code-diff", "architect-debug");
    await s.accept("needs-architect-follow-up");
    // The branch returned to Code-Change, so its follow-ups route in Code-Change.
    await s.route("architect", "code-change", "Final Acceptance documentation follow-up");
    await s.architectCorrectsDocs();
    await s.gate("code-diff", "architect-debug");
    await s.accept();
  });

  it("runs as a standalone Debug Flow", async () => {
    const s = await createScenario({ requiredGates: ["validation-adequacy", "code-diff"] });
    await s.route("architect", "architect-debug", "user-reported defect");
    await s.debugFixes();
    await s.route("tester", undefined, "Debug fix");
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "architect-debug", DOCS_ONLY);
    await s.route("architect", undefined, "docs-only code-diff report");
    await s.architectCorrectsDocs("architect-debug");
    await s.gate("code-diff", "architect-debug");
    await s.accept();
  });
});

describe("Project Manager rule scenarios: Architecture Diagnosis Branch", SCENARIOS, () => {
  it("Docs Code-Diff Correction: the rerun code-diff reviews the docs and the flow completes", async () => {
    const s = await createScenario();
    await s.enterDiagnosisBranchValidated();
    await s.gate("code-diff", "architect-diagnosis", DOCS_ONLY);
    await s.route("architect", undefined, "docs-only code-diff report");
    await s.architectCorrectsDocs("architecture-diagnosis");
    await s.gate("code-diff", "architect-diagnosis");
    await s.accept();
  });

  it("Code-Diff Revision after a docs correction: returns an implementation finding to Diagnosis Mode", async () => {
    const s = await createScenario();
    await s.enterDiagnosisBranchValidated();
    await s.gate("code-diff", "architect-diagnosis", DOCS_ONLY);
    await s.route("architect", undefined, "docs-only code-diff report");
    await s.architectCorrectsDocs("architecture-diagnosis");
    await s.gate("code-diff", "architect-diagnosis", IMPLEMENTATION);
    await s.route("architect", undefined, "implementation code-diff finding");
    await s.diagnosisFixes();
    await s.route("tester", undefined, "Diagnosis revision");
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "architect-diagnosis");
    await s.accept();
  });

  it("Tester Code-Diff Correction: repeats Tester validation and both Gates", async () => {
    const s = await createScenario();
    await s.enterDiagnosisBranchValidated();
    await s.gate("code-diff", "architect-diagnosis", TEST_ONLY);
    await s.route("tester", undefined, "test-only code-diff report");
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "architect-diagnosis");
    await s.accept();
  });
});

describe("Project Manager rule scenarios: Architecture Diagnosis Branch validation", SCENARIOS, () => {
  it("Validation Revision: routes a validation-adequacy rejection to Tester and reruns the Gate", async () => {
    const s = await createScenario();
    await s.enterCodeChangeTester();
    await s.testerValidates("fail");
    await s.route("architect", "architect-debug", "Tester failure");
    await s.debugFixes();
    await s.route("tester", undefined, "Debug fix");
    await s.testerValidates("fail");
    await s.route("architect", "architecture-diagnosis", "Debug validation failed");
    await s.diagnosisFixes();
    await s.route("tester", undefined, "Diagnosis fix");
    await s.testerValidates();
    await s.gate("validation-adequacy", undefined, CHANGES);
    await s.route("tester", undefined, "validation-adequacy report");
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.gate("code-diff", "architect-diagnosis");
    await s.accept();
  });
});

describe("Project Manager rule scenarios: Validation-Only Flow", SCENARIOS, () => {
  it("validates, passes validation-adequacy, and completes without code-diff", async () => {
    const s = await createScenario({ requiredGates: ["validation-adequacy", "code-diff"] });
    await s.route("tester", "validation-only", "validation request");
    await s.testerValidates();
    await s.gate("validation-adequacy");
    await s.accept();
  });
});

type FinalAcceptanceDecision =
  | "accepted"
  | "needs-coder-follow-up"
  | "needs-architect-follow-up";

interface ScriptedReview {
  decision: "approve" | "request_changes";
  scopes?: CodeDiffFindingScope[];
}

interface ScenarioOptions {
  requiredGates?: GateReviewGate[];
  docsCoverageFindings?: () => string[];
}

async function createScenario(options: ScenarioOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vcm-rule-scenario-"));
  roots.push(root);
  const repoRoot = path.join(root, "repo");
  const taskRepoRoot = path.join(root, "task");
  await initRepository(repoRoot, taskRepoRoot);

  const fs = createNodeFileSystemAdapter();
  const context: WorkflowControlContext = {
    taskRepoRoot,
    stateRoot: ".ai/vcm",
    handoffDir: ".ai/vcm/handoffs",
    taskSlug: TASK_SLUG
  };
  await fs.ensureDir(path.join(taskRepoRoot, context.handoffDir));

  const reviews: Record<GateReviewGate, ScriptedReview[]> = {
    "architecture-plan": [],
    "validation-adequacy": [],
    "code-diff": []
  };
  const controller = createWorkflowControlService({ fs });
  const gates = createGateReviewService({
    fs,
    runner: createCommandRunner(),
    runtime: createScriptedReviewerRuntime(taskRepoRoot, reviews),
    projectService: {
      async loadConfig() {
        return { stateRoot: ".ai/vcm", handoffRoot: ".ai/vcm/handoffs", claudeCommand: "claude" } as never;
      }
    },
    taskService: {
      async loadTask(): Promise<TaskRecord> {
        return {
          version: 1,
          taskSlug: TASK_SLUG,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
          repoRoot,
          worktreePath: taskRepoRoot,
          branch: `feature/${TASK_SLUG}`,
          handoffDir: ".ai/vcm/handoffs",
          status: "running"
        };
      }
    },
    appSettings: {
      async getGateReviewSettings() {
        return {
          enabled: true,
          requiredGates: options.requiredGates ?? ["architecture-plan", "validation-adequacy", "code-diff"]
        };
      },
      async updateGateReviewSettings() {
        throw new Error("Scenarios do not change Gate settings.");
      }
    } as never,
    sessionService: createIdleSessionService(),
    roundService: { async recordRoleTurnEvent() { return {} as never; } },
    workflowControlService: controller,
    checkDocsCoverage: async () => options.docsCoverageFindings?.() ?? [],
    reportPollIntervalMs: 5
  });

  return new Scenario(fs, context, repoRoot, controller, gates, reviews);
}

class Scenario {
  private revision = 0;
  private fileVersion = 0;

  constructor(
    readonly fs: FileSystemAdapter,
    readonly context: WorkflowControlContext,
    readonly repoRoot: string,
    readonly controller: WorkflowControlService,
    readonly gates: GateReviewService,
    readonly reviews: Record<GateReviewGate, ScriptedReview[]>
  ) {}

  // PM: propose and dispatch the route the rule prescribes.
  async route(
    targetRole: DispatchableRole,
    requestedFlow?: WorkflowFlow,
    evidence = `${targetRole} route`,
    extra: { followUpApprovalText?: string } = {}
  ): Promise<void> {
    const current = await this.progress();
    const revision = current.revision + 1;
    await this.controller.submitProgress(this.context, renderWorkflowProgress({
      ...current,
      revision,
      proposal: { targetRole, requestedFlow, evidence, ...extra }
    }));
    this.revision += 1;
    const messageId = `message-${this.revision}`;
    await this.controller.claimDispatch({
      ...this.context,
      routePath: `.ai/vcm/handoffs/messages/project-manager-${targetRole}.md`,
      targetRole,
      routeContentHash: `route-${this.revision}`,
      messageId
    });
    await this.controller.confirmDispatch(this.context, messageId);
  }

  // PM: request a Gate the rule prescribes. The Gate must start, and the
  // scripted Reviewer decision becomes its result.
  async gate(
    gate: GateReviewGate,
    source?: CodeDiffSource,
    review: ScriptedReview = { decision: "approve" }
  ): Promise<void> {
    this.reviews[gate].push(review);
    const result = await this.gates.requestReviewGate(this.repoRoot, TASK_SLUG, gate, source ? { codeDiffSource: source } : undefined);
    if (result.status !== "started") {
      throw new Error(`${gate} Gate did not start (${result.status}): ${result.message ?? result.record.error ?? ""}`);
    }
    // PM acts on a Gate result only after VCM delivers its callback, which
    // also records the callback on the Gate record.
    await waitFor(async () => {
      const record = (await this.gates.getState(this.repoRoot, TASK_SLUG)).gates[gate];
      return (record.status === "completed" || record.status === "failed")
        && record.callbackStatus !== undefined
        && record.callbackStatus !== "not_sent";
    });
    const record = (await this.gates.getState(this.repoRoot, TASK_SLUG)).gates[gate];
    if (record.status !== "completed" || record.decision !== review.decision) {
      throw new Error(`${gate} Gate ended ${record.status}/${record.decision ?? "none"}: ${record.error ?? ""}`);
    }
  }

  // PM: request a Gate the rule expects to fail to start, returning its message.
  async gateFailsToStart(gate: GateReviewGate, source?: CodeDiffSource): Promise<string> {
    const result = await this.gates.requestReviewGate(this.repoRoot, TASK_SLUG, gate, source ? { codeDiffSource: source } : undefined);
    expect(result.status).toBe("failed_to_start");
    return result.message ?? "";
  }

  // PM: write Final Acceptance and complete the flow when it is accepted.
  async accept(decision: FinalAcceptanceDecision = "accepted"): Promise<void> {
    this.writeHandoff("final-acceptance.md", renderFinalAcceptanceTemplate(TASK_SLUG), {}, [[
      "accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|blocked-by-user-decision",
      decision
    ]]);
    if (decision !== "accepted") {
      return;
    }
    const current = await this.progress();
    await this.controller.submitProgress(this.context, renderWorkflowProgress({
      ...current,
      revision: current.revision + 1,
      status: "completed",
      proposal: undefined
    }));
    expect((await this.progress()).status).toBe("completed");
  }

  // PM: a route the rules do not allow is refused by Workflow Control.
  async expectRouteDenied(targetRole: DispatchableRole, requestedFlow?: WorkflowFlow): Promise<void> {
    const current = await this.progress();
    await expect(this.controller.submitProgress(this.context, renderWorkflowProgress({
      ...current,
      revision: current.revision + 1,
      proposal: { targetRole, requestedFlow, evidence: "route outside the rules" }
    }))).rejects.toMatchObject({ code: "WORKFLOW_TRANSITION_DENIED" });
  }

  // Architect: interview, gather evidence, and write a complete plan.
  architectPlans(): void {
    this.writeHandoff("architecture-brief.md", renderArchitectureBriefTemplate(TASK_SLUG), {
      "Architecture Brief Status": "confirmed"
    });
    this.writeHandoff("architecture-evidence.md", renderArchitectureEvidenceTemplate(TASK_SLUG), {
      "Architecture Evidence Status": "complete"
    });
    this.writeHandoff("architecture-plan.md", renderArchitecturePlanTemplate(TASK_SLUG), {
      "Planning Result": "complete"
    });
  }

  // Coder: implement and report ready for review.
  async coderImplements(decision: "ready_for_review" | "failed" = "ready_for_review"): Promise<void> {
    await this.commit({ "src/feature.ts": this.nextVersion("feature implementation") }, "feat: implement feature");
    this.writeHandoff("coder-completion.md", renderCoderCompletionTemplate(TASK_SLUG), {
      Decision: decision
    });
  }

  // Tester: commit tests and replace the Test Report.
  async testerValidates(
    result: "pass" | "fail" = "pass",
    infrastructure: "none" | "repair-required" | "repaired" = "none"
  ): Promise<void> {
    await this.commit({ "tests/feature.test.ts": this.nextVersion("feature test") }, "test: cover feature");
    // A repaired defect is described in the Test Infrastructure subsections.
    const repairEvidence: Array<[string, string]> = infrastructure === "repaired"
      ? ["Affected Files", "Boundary Evidence", "Defect-Class Sweep", "Repair Commit"].map((heading) => [
          `### ${heading}\n\nNone.`,
          `### ${heading}\n\nRepaired test fixture evidence ${this.fileVersion}.`
        ])
      : [];
    this.writeHandoff("test-report.md", renderTestReportTemplate(TASK_SLUG), {
      "Test Result": result,
      "L3 Required": "no",
      Status: infrastructure
    }, repairEvidence, `${result} validation evidence ${this.fileVersion}`);
  }

  // Architect: revise the plan after an architecture-plan Gate rejection.
  architectRevisesPlan(): void {
    this.fileVersion += 1;
    this.writeHandoff("architecture-plan.md", renderArchitecturePlanTemplate(TASK_SLUG), {
      "Planning Result": "complete"
    }, [], `revised plan ${this.fileVersion}`);
  }

  // Architect Debug: commit a code fix and replace architect-debug.md.
  async debugFixes(): Promise<void> {
    await this.commit({ "src/feature.ts": this.nextVersion("debug fix") }, "fix: repair feature");
    this.writeDebugHandoff();
  }

  // Architecture Diagnosis: commit a code fix and replace architecture-diagnosis.md.
  async diagnosisFixes(): Promise<void> {
    await this.commit({ "src/feature.ts": this.nextVersion("diagnosis fix") }, "fix: repair feature design");
    this.writeDiagnosisHandoff();
  }

  // Architect Post-Validation Docs Correction: commit docs only. Production
  // code, tests, and architecture-plan.md stay unchanged; a Debug or Diagnosis
  // handoff is rewritten as the Current Handoff Contract requires.
  async architectCorrectsDocs(handoff?: "architect-debug" | "architecture-diagnosis"): Promise<void> {
    await this.commit({ "docs/ARCHITECTURE.md": this.nextVersion("architecture docs") }, "docs: correct architecture docs");
    if (handoff === "architect-debug") this.writeDebugHandoff();
    if (handoff === "architecture-diagnosis") this.writeDiagnosisHandoff();
  }

  // Runs Code-Change through planning, the architecture-plan Gate, and Coder,
  // and dispatches Tester.
  async enterCodeChangeTester(): Promise<void> {
    await this.route("architect", "code-change", "user request");
    this.architectPlans();
    await this.gate("architecture-plan");
    await this.route("coder", undefined, "approved architecture plan");
    await this.coderImplements();
    await this.route("tester", undefined, "completed implementation");
  }

  // Leaves Tester's passing validation ready for the validation-adequacy Gate.
  async enterCodeChangeValidation(): Promise<void> {
    await this.enterCodeChangeTester();
    await this.testerValidates();
  }

  // Leaves passing validation and an approved validation-adequacy Gate ready
  // for code-diff.
  async enterCodeChangeValidated(): Promise<void> {
    await this.enterCodeChangeValidation();
    await this.gate("validation-adequacy");
  }

  // Fails Code-Change validation, fixes it in the Debug Branch, and leaves its
  // passing validation approved and ready for code-diff.
  async enterDebugBranchValidated(): Promise<void> {
    await this.enterCodeChangeTester();
    await this.testerValidates("fail");
    await this.route("architect", "architect-debug", "Tester failure");
    await this.debugFixes();
    await this.route("tester", undefined, "Debug fix");
    await this.testerValidates();
    await this.gate("validation-adequacy");
  }

  // Fails the Debug fix too, fixes it in the Diagnosis Branch, and leaves its
  // passing validation approved and ready for code-diff.
  async enterDiagnosisBranchValidated(): Promise<void> {
    await this.enterCodeChangeTester();
    await this.testerValidates("fail");
    await this.route("architect", "architect-debug", "Tester failure");
    await this.debugFixes();
    await this.route("tester", undefined, "Debug fix");
    await this.testerValidates("fail");
    await this.route("architect", "architecture-diagnosis", "Debug validation failed");
    await this.diagnosisFixes();
    await this.route("tester", undefined, "Diagnosis fix");
    await this.testerValidates();
    await this.gate("validation-adequacy");
  }

  private writeDebugHandoff(): void {
    this.writeHandoff("architect-debug.md", renderArchitectDebugTemplate(TASK_SLUG), { Status: "completed" }, [[
      "local fix completed|normal architecture plan required|user clarification required",
      "local fix completed"
    ]], `debug evidence ${this.fileVersion}`);
  }

  private writeDiagnosisHandoff(): void {
    this.writeHandoff("architecture-diagnosis.md", renderArchitectureDiagnosisTemplate(TASK_SLUG), {}, [[
      "analysis completed|diagnosis implementation completed|user clarification required",
      "diagnosis implementation completed"
    ]], `diagnosis evidence ${this.fileVersion}`);
  }

  private async progress(): Promise<WorkflowProgressDocument> {
    const progressPath = path.join(this.context.taskRepoRoot, this.context.handoffDir, "workflow-progress.md");
    if (!(await this.fs.pathExists(progressPath))) {
      return { taskSlug: TASK_SLUG, revision: 0, status: "not-started", history: [] };
    }
    return parseWorkflowProgress(await this.fs.readText(progressPath), TASK_SLUG);
  }

  private nextVersion(label: string): string {
    this.fileVersion += 1;
    return `// ${label} ${this.fileVersion}\n`;
  }

  private async commit(files: Record<string, string>, message: string): Promise<void> {
    for (const [relativePath, content] of Object.entries(files)) {
      const target = path.join(this.context.taskRepoRoot, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    await git(this.context.taskRepoRoot, ["add", "--", ...Object.keys(files)]);
    await git(this.context.taskRepoRoot, ["commit", "-q", "-m", message]);
  }

  // Fills a handoff template: `Field: a|b` lines take the given value or their
  // first option, exact replacements set whole-line options, and every TBD
  // becomes concrete evidence.
  private writeHandoff(
    fileName: string,
    template: string,
    fields: Record<string, string>,
    replacements: Array<[string, string]> = [],
    evidence = `evidence ${this.fileVersion}`
  ): void {
    const filled = template.split("\n").map((line) => {
      const match = /^(\s*(?:[-*]\s*)?)([A-Za-z][A-Za-z0-9 /-]*?):\s*([^|\s][^|]*(?:\|[^|]+)+)$/.exec(line);
      if (!match) return line;
      return `${match[1]}${match[2]}: ${fields[match[2]] ?? match[3].split("|")[0].trim()}`;
    }).join("\n");
    const content = replacements
      .reduce((current, [from, to]) => current.replace(from, to), filled)
      .replaceAll("TBD", `Verified ${evidence}.`);
    writeFileSync(path.join(this.context.taskRepoRoot, this.context.handoffDir, fileName), content);
  }
}

async function initRepository(repoRoot: string, taskRepoRoot: string): Promise<void> {
  mkdirSync(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-q", "-b", "main"]);
  const files: Record<string, string> = {
    ".gitignore": ".ai/vcm/\n",
    ".claude/agents/reviewer.md": "# Reviewer\n",
    "src/feature.ts": "// feature baseline\n",
    "tests/feature.test.ts": "// feature test baseline\n",
    "docs/ARCHITECTURE.md": "# Architecture\n"
  };
  for (const [relativePath, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repoRoot, relativePath)), { recursive: true });
    writeFileSync(path.join(repoRoot, relativePath), content);
  }
  await git(repoRoot, ["add", "--", "."]);
  await git(repoRoot, ["commit", "-q", "-m", "chore: baseline"]);
  await git(repoRoot, ["worktree", "add", "-q", "-b", `feature/${TASK_SLUG}`, taskRepoRoot]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-c", "user.name=Scenario", "-c", "user.email=scenario@example.com", ...args], { cwd });
}

// A Reviewer terminal that answers each Gate prompt with the next scripted
// decision, written as a complete report at the request's report path.
function createScriptedReviewerRuntime(
  taskRepoRoot: string,
  reviews: Record<GateReviewGate, ScriptedReview[]>
): TerminalRuntime {
  return {
    write(sessionId: string, data: string) {
      if (sessionId !== "reviewer-session") return;
      const gate = /Gate:\s*([a-z-]+)/.exec(data)?.[1] as GateReviewGate | undefined;
      const requestId = /Request:\s*([A-Za-z0-9_.-]+)/.exec(data)?.[1];
      if (!gate || !requestId || !(gate in reviews)) return;
      const review = reviews[gate].shift() ?? { decision: "approve" };
      const reportPath = path.join(taskRepoRoot, ".ai/vcm/gate-reviews/requests", `${requestId}.report.md`);
      writeFileSync(reportPath, renderReport(gate, requestId, review));
    },
    getSession(sessionId: string) {
      return { id: sessionId, status: "running" } as never;
    }
  } as TerminalRuntime;
}

function renderReport(gate: GateReviewGate, requestId: string, review: ScriptedReview): string {
  const findings = review.decision === "approve"
    ? ["None."]
    : (review.scopes?.length ? review.scopes : [undefined]).flatMap((scope, index) => [
        `### high: Finding ${index + 1}`,
        ...(gate === "code-diff"
          ? ["- File: src/feature.ts", "- Line Or Symbol: feature", `- Finding Scope: ${scope ?? "implementation"}`]
          : []),
        "- Evidence: the reviewed evidence shows the gap",
        "- Expected: the gap is closed",
        "- Gap: the gap remains",
        "- Risk: the task result is wrong",
        ""
      ]);
  return [
    `Gate: ${gate}`,
    `Request: ${requestId}`,
    `Decision: ${review.decision}`,
    `Summary: Scripted ${review.decision}.`,
    "",
    `## ${GATE_ANALYSIS_HEADINGS[gate]}`,
    "",
    ...GATE_ANALYSIS_FIELDS[gate].map((field) => `- ${field}: Verified.`),
    "",
    "## Findings",
    "",
    ...findings
  ].join("\n");
}

function createIdleSessionService() {
  const reviewer = {
    id: "reviewer-session",
    claudeSessionId: "reviewer-claude",
    taskSlug: TASK_SLUG,
    role: "reviewer",
    status: "running",
    activityStatus: "idle",
    command: "claude --agent reviewer",
    permissionMode: "default",
    cwd: "/repo",
    terminalBackend: "node-pty",
    updatedAt: "2026-11-01T00:00:00.000Z"
  } as RoleSessionRecord;
  const pm = { ...reviewer, id: "pm-session", role: "project-manager" } as RoleSessionRecord;
  let reviewerStarted = false;
  return {
    async getRoleSession(_repoRoot: string, _taskSlug: string, role: string) {
      if (role === "project-manager") return pm;
      return role === "reviewer" && reviewerStarted ? reviewer : undefined;
    },
    async startRoleSession() {
      reviewerStarted = true;
      return reviewer;
    },
    async resumeRoleSession() {
      reviewerStarted = true;
      return reviewer;
    },
    async restartRoleSession() {
      reviewerStarted = true;
      return reviewer;
    },
    // Scenarios run one role turn at a time, so every role is idle between them.
    async markRoleActivityRunning() {
      return reviewer;
    }
  };
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the Gate to finish.");
}
