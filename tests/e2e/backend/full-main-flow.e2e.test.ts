import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo, git } from "./helpers/e2e-repo.js";
import {
  connectAndCreateTask,
  getGateState,
  requestGateReview,
  sleep,
  startRole,
  updateGateSettings,
  waitFor
} from "./helpers/e2e-actions.js";
import type { GateReviewGate } from "../../../src/shared/types/gate-review.js";
import type { MockClaudePromptContext } from "./helpers/mock-claude-runtime.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("backend E2E complete VCM flow with mock Claude Code", () => {
  it("runs architecture, code, test, gate callbacks, and final acceptance through backend orchestration", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "mock-main-flow");
    await updateGateSettings(env.app, task.taskSlug, {
      "architecture-plan": true,
      "code-diff": true,
      "validation-adequacy": true
    });

    env.mockRuntime.onPrompt("gate-reviewer", "[VCM GATE REVIEW]", writeApproveGateReport, { once: false });

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
      await ctx.writeFile(".ai/vcm/handoffs/architecture-plan.md", [
        "# Architecture Plan",
        "",
        "Accepted Scope: complete mocked feature.",
        "Implementation Plan: add src/feature.txt and verify it with tester evidence.",
        ""
      ].join("\n"));
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
      await ctx.writeFile(".ai/vcm/handoffs/coder-completion.md", [
        "# Coder Completion",
        "",
        "Decision: ready_for_review",
        "Validation: L0/L1 mock checks passed.",
        ""
      ].join("\n"));
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
      await ctx.appendTranscriptText("Coder result received.");
      await ctx.stop();
    });

    env.mockRuntime.onPrompt("project-manager", /gate: code-diff[\s\S]*decision: approve/, async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Code diff gate approved. Routing to Tester.");
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
      await ctx.writeFile(".ai/vcm/handoffs/test-report.md", [
        "# Test Report",
        "",
        "Decision: pass",
        "Evidence: mock tester checked src/feature.txt.",
        ""
      ].join("\n"));
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
    });

    env.mockRuntime.onPrompt("project-manager", /gate: validation-adequacy[\s\S]*decision: approve/, async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Validation gate approved. Final acceptance complete.");
      await ctx.writeFile(".ai/vcm/handoffs/final-acceptance.md", [
        "# Final Acceptance",
        "",
        "Decision: accepted",
        "Evidence: architecture, code diff, and validation gates approved.",
        ""
      ].join("\n"));
      await ctx.stop();
    });

    await startRole(env.app, task.taskSlug, "project-manager");
    await startRole(env.app, task.taskSlug, "architect");
    await startRole(env.app, task.taskSlug, "coder");
    await startRole(env.app, task.taskSlug, "tester");
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

    await requestGateReview(env.app, task.taskSlug, "code-diff", { codeDiffSource: "coder" });
    await waitForGate(env.app, task.taskSlug, "code-diff");
    await waitForFile(path.join(task.worktreePath, ".ai/vcm/handoffs/test-report.md"));
    await env.mockRuntime.waitForIdle();

    await requestGateReview(env.app, task.taskSlug, "validation-adequacy");
    await waitForGate(env.app, task.taskSlug, "validation-adequacy");
    await waitForFile(path.join(task.worktreePath, ".ai/vcm/handoffs/final-acceptance.md"));
    await env.mockRuntime.waitForIdle();

    const finalAcceptance = await fs.readFile(path.join(task.worktreePath, ".ai/vcm/handoffs/final-acceptance.md"), "utf8");
    expect(finalAcceptance).toContain("Decision: accepted");
    const gateState = await getGateState(env.app, task.taskSlug);
    expect(gateState.gates["architecture-plan"]).toMatchObject({ status: "completed", decision: "approve" });
    expect(gateState.gates["code-diff"]).toMatchObject({ status: "completed", decision: "approve" });
    expect(gateState.gates["validation-adequacy"]).toMatchObject({ status: "completed", decision: "approve" });
  });
});

async function writeApproveGateReport(ctx: MockClaudePromptContext): Promise<void> {
  const gate = matchPromptField(ctx.prompt, "Gate") as GateReviewGate;
  const request = matchPromptField(ctx.prompt, "Request");
  const report = matchPromptField(ctx.prompt, "Report");
  if (!gate || !request || !report) {
    throw new Error(`Unable to parse gate prompt:\n${ctx.prompt}`);
  }
  await ctx.writeOutput(`Gate ${gate} approved\n`);
  await ctx.writeAbsoluteFile(report, [
    `Gate: ${gate}`,
    `Request: ${request}`,
    "Decision: approve",
    `Summary: ${gate} approved in complete flow E2E.`,
    ""
  ].join("\n"));
}

function matchPromptField(prompt: string, field: string): string | undefined {
  return prompt.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

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
