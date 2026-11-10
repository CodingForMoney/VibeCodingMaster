import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo, git } from "./helpers/e2e-repo.js";
import {
  connectAndCreateTask,
  getGateState,
  getWorkspaceState,
  requestGateReview,
  sleep,
  startHarnessEngineer,
  startRole,
  updatePreferences,
  updateGateSettings,
  waitFor,
  writeCompleteArchitecturePlan,
  writeConfirmedArchitectureBrief,
  writeReadyCoderCompletion
} from "./helpers/e2e-actions.js";
import type { GateReviewGate } from "../../../src/shared/types/gate-review.js";
import {
  acceptedFinalAcceptance,
  matchPromptField,
  validTestReport,
  writeApproveGateReport
} from "./helpers/e2e-flow-fixtures.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.shift()?.();
  }
});

describe("backend E2E complete VCM flow with mock Claude Code", () => {
  it("runs architecture, code, test, gate callbacks, and final acceptance through backend orchestration", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-main-flow");
    await writeConfirmedArchitectureBrief(task.worktreePath, task.taskSlug);
    await updateGateSettings(env.app, task.taskSlug, {
      "architecture-plan": true,
      "code-diff": true,
      "validation-adequacy": true
    });
    await updatePreferences(env.app, {
      autoTaskHarnessReviewEnabled: true,
      autoMemoryEnabled: false
    });
    let testerResultHandled = false;

    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", writeApproveGateReport, { once: false });
    env.mockRuntime.onPrompt("harness-engineer", "[VCM Task Harness Retrospective]", async (ctx) => {
      await ctx.userPromptSubmit();
      const resultPath = matchPromptField(ctx.prompt, "Write the analysis to Result Path");
      if (!resultPath) {
        throw new Error(`Unable to parse Harness Retrospective prompt:\n${ctx.prompt}`);
      }
      await ctx.writeAbsoluteFile(
        resultPath,
        [
          `# Task Harness Retrospective: ${task.taskSlug}`,
          "",
          "## Findings",
          "",
          "Complete main flow reviewed by Harness Engineer.",
          "",
          "## Feedback Dispositions",
          "",
          "None.",
          "",
          "## Recommended Harness Changes",
          "",
          "None.",
          "",
          "## VCM Issue Drafts",
          "",
          "None.",
          ""
        ].join("\n")
      );
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("project-manager", "Build the complete mocked feature", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Routing to Architect.");
      await ctx.writeFile(".ai/vcm/handoffs/messages/project-manager-architect.md", [
        "---",
        "type: task",
        "---",
        "Create the architecture plan for the complete mocked feature.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("architect", "Create the architecture plan for the complete mocked feature.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Architecture plan complete.");
      await writeCompleteArchitecturePlan(
        ctx.cwd,
        task.taskSlug,
        "Implement the complete mocked feature in src/feature.txt and verify it with Tester evidence."
      );
      await ctx.writeFile(".ai/vcm/handoffs/messages/architect-project-manager.md", [
        "---",
        "type: result",
        "artifact_refs: .ai/vcm/handoffs/architecture-plan.md",
        "---",
        "Architecture complete. Plan ready.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("project-manager", "Architecture complete. Plan ready.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Architecture result received.");
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("project-manager", /gate: architecture-plan[\s\S]*decision: approve/, async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Architecture gate approved. Routing to Coder.");
      await ctx.writeFile(".ai/vcm/handoffs/messages/project-manager-coder.md", [
        "---",
        "type: task",
        "artifact_refs: .ai/vcm/handoffs/architecture-plan.md",
        "---",
        "Implement the complete mocked feature from the approved architecture plan.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("coder", "Implement the complete mocked feature from the approved architecture plan.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Coder implementation complete.");
      await ctx.writeFile("src/feature.txt", "complete mocked feature\n");
      await writeReadyCoderCompletion(ctx.cwd, task.taskSlug, "src/feature.txt");
      await git(ctx.cwd, "add", "src/feature.txt");
      await git(ctx.cwd, "commit", "-m", "implement mocked feature");
      await ctx.writeFile(".ai/vcm/handoffs/messages/coder-project-manager.md", [
        "---",
        "type: result",
        "artifact_refs: .ai/vcm/handoffs/coder-completion.md",
        "---",
        "Coder complete. Commit ready.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("project-manager", "Coder complete. Commit ready.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Coder result received. Routing to Tester.");
      await ctx.writeFile(".ai/vcm/handoffs/messages/project-manager-tester.md", [
        "---",
        "type: task",
        "artifact_refs: .ai/vcm/handoffs/coder-completion.md",
        "---",
        "Validate the complete mocked feature.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("tester", "Validate the complete mocked feature.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Tester validation passed.");
      await ctx.writeFile("tests/feature.test.txt", "complete mocked feature test\n");
      await ctx.writeFile(".ai/vcm/handoffs/test-report.md", validTestReport());
      await git(ctx.cwd, "add", "tests/feature.test.txt");
      await git(ctx.cwd, "commit", "-m", "add mocked feature validation");
      await ctx.writeFile(".ai/vcm/handoffs/messages/tester-project-manager.md", [
        "---",
        "type: result",
        "artifact_refs: .ai/vcm/handoffs/test-report.md",
        "---",
        "Tester passed. Test report ready.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("project-manager", "Tester passed. Test report ready.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Tester result received.");
      await ctx.stop();
      testerResultHandled = true;
    });

    env.mockRuntime.onPrompt("project-manager", /gate: validation-adequacy[\s\S]*decision: approve/, async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Validation gate approved. Ready for code review.");
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("project-manager", /gate: code-diff[\s\S]*decision: approve/, async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Code diff gate approved. Final acceptance complete.");
      await ctx.writeFile(
        ".ai/vcm/handoffs/final-acceptance.md",
        acceptedFinalAcceptance(task.taskSlug)
      );
      await ctx.stop();
    });

    await startRole(env.app, task.taskSlug, "project-manager");
    await startRole(env.app, task.taskSlug, "architect");
    await startRole(env.app, task.taskSlug, "coder");
    await startRole(env.app, task.taskSlug, "tester");
    const harnessSession = await startHarnessEngineer(env.app, task.taskSlug);
    const pmSession = env.mockRuntime.getSessionByRole(task.taskSlug, "project-manager");
    expect(pmSession).toBeDefined();

    env.mockRuntime.write(pmSession!.id, "Build the complete mocked feature");
    await env.mockRuntime.waitForIdle();
    await expect(fs.readFile(path.join(task.worktreePath, ".ai/vcm/handoffs/architecture-plan.md"), "utf8"))
      .resolves.toContain("complete mocked feature");

    await requestGateReview(env.app, task.taskSlug, "architecture-plan");
    await waitForGate(env.app, task.taskSlug, "architecture-plan");
    await waitForFile(path.join(task.worktreePath, "src/feature.txt"));
    await env.mockRuntime.waitForIdle();

    await waitForFile(path.join(task.worktreePath, ".ai/vcm/handoffs/test-report.md"));
    await env.mockRuntime.waitForIdle();
    await waitFor(() => testerResultHandled);

    await requestGateReview(env.app, task.taskSlug, "validation-adequacy");
    await waitForGate(env.app, task.taskSlug, "validation-adequacy");
    await env.mockRuntime.waitForIdle();

    await requestGateReview(env.app, task.taskSlug, "code-diff", { codeDiffSource: "coder" });
    await waitForGate(env.app, task.taskSlug, "code-diff");
    await waitFor(async () => {
      const content = await fs.readFile(
        path.join(task.worktreePath, ".ai/vcm/handoffs/final-acceptance.md"),
        "utf8"
      );
      expect(content).toContain("## Decision\n\naccepted");
    });
    await env.mockRuntime.waitForIdle();

    const finalAcceptance = await fs.readFile(path.join(task.worktreePath, ".ai/vcm/handoffs/final-acceptance.md"), "utf8");
    expect(finalAcceptance).toContain("## Decision\n\naccepted");
    const gateState = await getGateState(env.app, task.taskSlug);
    expect(gateState.gates["architecture-plan"]).toMatchObject({ status: "completed", decision: "approve" });
    expect(gateState.gates["code-diff"]).toMatchObject({ status: "completed", decision: "approve" });
    expect(gateState.gates["validation-adequacy"]).toMatchObject({ status: "completed", decision: "approve" });
    expect(gateState.gates["code-diff"].changedFiles).toContain("tests/feature.test.txt");

    await waitFor(async () => {
      const workspace = await getWorkspaceState(env.app, task.taskSlug);
      expect(workspace.roundState.status).toBe("stopped");
      expect(workspace.roundState.roundId).toBeTruthy();
    });
    expect(env.mockRuntime.getWrites(harnessSession.id).join("\n"))
      .not.toContain("[VCM Task Harness Retrospective]");

    await env.deps.runtimeCoordinator.reconcileProject(repo.repoRoot, { taskSlug: task.taskSlug });
    await waitFor(async () => {
      expect(env.mockRuntime.getWrites(harnessSession.id).join("\n"))
        .toContain("[VCM Task Harness Retrospective]");
    }, 10_000);
    await env.mockRuntime.waitForIdle();
    await expect(fs.readFile(
      path.join(repo.repoRoot, ".ai/vcm/harness-feedback/task-retrospectives", `${task.taskSlug}.md`),
      "utf8"
    )).resolves.toContain("Complete main flow reviewed by Harness Engineer.");
    await expect(fs.readFile(
      path.join(repo.repoRoot, ".ai/vcm/harness-feedback/task-retrospectives", `${task.taskSlug}.json`),
      "utf8"
    )).resolves.toContain('"trigger": "auto"');
  });
});

async function waitForGate(app: Parameters<typeof getGateState>[0], taskSlug: string, gate: GateReviewGate): Promise<void> {
  await waitFor(async () => {
    const state = await getGateState(app, taskSlug);
    expect(state.gates[gate].status).toBe("completed");
  }, 2_000);
}

async function waitForFile(filePath: string): Promise<void> {
  await waitFor(async () => {
    await fs.access(filePath);
  }, 2_000);
  await sleep(20);
}
