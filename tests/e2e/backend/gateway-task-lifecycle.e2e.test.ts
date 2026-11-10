// Drives a whole task from a phone through the Gateway: create the task, ask PM
// for the work, let PM run the Code-Change Flow under real Workflow Control and
// Gate Review, receive PM's final reply, ask PM for the PR, close the task, and
// start the next task. Every user action is a chat message on the mock
// channel; every role is a scripted mock Claude Code session.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderWorkflowProgress } from "../../../src/backend/services/workflow-control-service.js";
import type { GateReviewGate } from "../../../src/shared/types/gate-review.js";
import type { DispatchableRole } from "../../../src/shared/types/role.js";
import type { WorkflowFlow, WorkflowProgressDocument } from "../../../src/shared/types/workflow.js";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo, git } from "./helpers/e2e-repo.js";
import {
  bindGatewayLarkApp,
  connectProject,
  requestGateReview,
  setGatewayConnection,
  sleep,
  updateGateSettings,
  updateGatewaySettings,
  waitFor,
  writeCompleteArchitecturePlan,
  writeConfirmedArchitectureBrief,
  writeReadyCoderCompletion
} from "./helpers/e2e-actions.js";
import {
  acceptedFinalAcceptance,
  validTestReport,
  writeApproveGateReport,
  writeBatchTranslations
} from "./helpers/e2e-flow-fixtures.js";

const cleanups: Array<() => Promise<void>> = [];
const PHONE = { fromUserId: "phone-user", chatId: "phone-chat" };
const WAIT_MS = 30_000;

// The user writes Chinese; Gateway translation (on whenever Gateway is on)
// turns it into the English instruction PM receives.
const PHONE_TO_ENGLISH: Record<string, string> = {
  "做一个手机功能。": "Build the phone feature.",
  "准备 draft PR。": "Prepare the draft PR.",
  "开始第二个任务。": "Start the second task."
};

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.shift()?.();
  }
}, 30_000);

describe("backend E2E Gateway task lifecycle", () => {
  it("runs a task from the phone to completion, closes it, and starts the next task", async () => {
    const env = await createMockClaudeE2eApp({ workflowControl: true });
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    await connectProject(env.app, repo.repoRoot);

    const phone = {
      send(text: string) {
        env.mockGateway.enqueueText(text, PHONE);
      },
      // Waits for a reply sent after `since` that satisfies the check.
      async reply(since: number, label: string, check: (text: string) => boolean, timeoutMs = WAIT_MS): Promise<string> {
        let found: string | undefined;
        try {
          await waitFor(() => {
            found = env.mockGateway.sentTexts.slice(since).map((item) => item.text).find(check);
            expect(found, label).toBeDefined();
          }, timeoutMs);
        } catch (error) {
          throw new Error([
            `Phone never received: ${label}`,
            "Messages sent to the phone:",
            ...env.mockGateway.sentTexts.map((item, index) => `--- ${index}\n${item.text}`),
            "Where the task stands:",
            await describeTasks()
          ].join("\n"), { cause: error });
        }
        return found!;
      },
      get sentCount() {
        return env.mockGateway.sentTexts.length;
      }
    };

    const describeTasks = async () => {
      const lines: string[] = [];
      for (const task of await env.deps.taskService.listTasks(repo.repoRoot)) {
        if (task.cleanupStatus === "cleaned") continue;
        const progress = await env.deps.workflowControlService!.getProgress({
          taskRepoRoot: task.worktreePath,
          taskSlug: task.taskSlug,
          stateRoot: ".ai/vcm",
          handoffDir: ".ai/vcm/handoffs"
        }).catch((error: Error) => ({ error: error.message }));
        const gates = await env.deps.gateReviewService.getState(repo.repoRoot, task.taskSlug)
          .then((state) => Object.values(state.gates).map((gate) => `${gate.gate}:${gate.status}/${gate.decision ?? "-"}`).join(" "))
          .catch((error: Error) => error.message);
        lines.push(`task ${task.taskSlug}: progress ${JSON.stringify(progress)}`, `  gates ${gates}`);
        for (const session of env.mockRuntime.listSessions(task.taskSlug)) {
          const writes = env.mockRuntime.getWrites(session.id).filter((write) => write.trim() && write !== "\r");
          lines.push(`  ${session.role} ${session.status}: last prompt ${JSON.stringify((writes.at(-1) ?? "").slice(0, 160))}`);
        }
      }
      return lines.join("\n");
    };

    // PM's tools: Workflow Progress through vcm-workflow-review, and Gate
    // requests through request-gate-review.
    const pm = {
      async submitProgress(taskSlug: string, update: (current: WorkflowProgressDocument) => WorkflowProgressDocument) {
        const task = await env.deps.taskService.loadTask(repo.repoRoot, taskSlug);
        const current = await env.deps.workflowControlService!.getProgress({
          taskRepoRoot: task.worktreePath,
          taskSlug,
          stateRoot: ".ai/vcm",
          handoffDir: ".ai/vcm/handoffs"
        });
        const session = await env.deps.sessionService.getRoleSession(repo.repoRoot, taskSlug, "project-manager");
        const response = await env.app.inject({
          method: "POST",
          url: `/api/tasks/${taskSlug}/artifacts/submit`,
          payload: {
            role: "project-manager",
            runtimeSessionToken: session?.runtimeSessionToken,
            kind: "workflow-progress",
            mode: "final",
            content: renderWorkflowProgress(update(current))
          }
        });
        expect(response.statusCode, response.body).toBe(200);
      },
      route(taskSlug: string, targetRole: DispatchableRole, evidence: string, requestedFlow?: WorkflowFlow) {
        return pm.submitProgress(taskSlug, (current) => ({
          ...current,
          revision: current.revision + 1,
          proposal: { requestedFlow, targetRole, evidence }
        }));
      },
      complete(taskSlug: string) {
        return pm.submitProgress(taskSlug, (current) => ({
          ...current,
          revision: current.revision + 1,
          status: "completed",
          proposal: undefined
        }));
      },
      async requestGate(taskSlug: string, gate: GateReviewGate) {
        const result = await requestGateReview(env.app, taskSlug, gate, gate === "code-diff" ? { codeDiffSource: "coder" } : {});
        expect(result.status, result.message).toBe("started");
      }
    };

    const first = "gw-first";
    env.mockRuntime.onPrompt("reviewer", "[VCM GATE REVIEW]", writeApproveGateReport, { once: false });
    env.mockRuntime.onPrompt("translator", "Translate each <VCM_TEXT>", (ctx) =>
      writeBatchTranslations(ctx, (source) => PHONE_TO_ENGLISH[source] ?? `译文：${source}`), { once: false });

    env.mockRuntime.onPrompt("project-manager", "Build the phone feature.", async (ctx) => {
      await ctx.userPromptSubmit();
      await pm.route(first, "architect", "The user asked for the phone feature.", "code-change");
      await ctx.writeFile(".ai/vcm/handoffs/messages/project-manager-architect.md", route("task", "Plan the phone feature."));
      await ctx.appendTranscriptText("Routing the phone feature to Architect.");
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("architect", "Plan the phone feature.", async (ctx) => {
      await ctx.userPromptSubmit();
      await writeConfirmedArchitectureBrief(ctx.cwd, first);
      await writeCompleteArchitecturePlan(ctx.cwd, first, "Implement the phone feature in src/phone.txt with Tester evidence.");
      await ctx.writeFile(
        ".ai/vcm/handoffs/messages/architect-project-manager.md",
        route("result", "Phone feature plan ready.", ".ai/vcm/handoffs/architecture-plan.md")
      );
      await ctx.appendTranscriptText("Plan written.");
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("project-manager", "Phone feature plan ready.", async (ctx) => {
      await ctx.userPromptSubmit();
      await pm.requestGate(first, "architecture-plan");
      await ctx.appendTranscriptText("Requested the architecture-plan Gate.");
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("project-manager", /gate: architecture-plan[\s\S]*decision: approve/, async (ctx) => {
      await ctx.userPromptSubmit();
      await pm.route(first, "coder", "The architecture-plan Gate approved the plan.");
      await ctx.writeFile(
        ".ai/vcm/handoffs/messages/project-manager-coder.md",
        route("task", "Implement the phone feature.", ".ai/vcm/handoffs/architecture-plan.md")
      );
      await ctx.appendTranscriptText("Routing to Coder.");
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("coder", "Implement the phone feature.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeFile("src/phone.txt", "phone feature\n");
      await writeReadyCoderCompletion(ctx.cwd, first, "src/phone.txt");
      await git(ctx.cwd, "add", "src/phone.txt");
      await git(ctx.cwd, "commit", "-m", "implement the phone feature");
      await ctx.writeFile(
        ".ai/vcm/handoffs/messages/coder-project-manager.md",
        route("result", "Phone feature implemented.", ".ai/vcm/handoffs/coder-completion.md")
      );
      await ctx.appendTranscriptText("Implemented.");
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("project-manager", "Phone feature implemented.", async (ctx) => {
      await ctx.userPromptSubmit();
      await pm.route(first, "tester", "Coder completed the implementation.");
      await ctx.writeFile(
        ".ai/vcm/handoffs/messages/project-manager-tester.md",
        route("task", "Validate the phone feature.", ".ai/vcm/handoffs/coder-completion.md")
      );
      await ctx.appendTranscriptText("Routing to Tester.");
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("tester", "Validate the phone feature.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeFile("tests/phone.test.txt", "phone feature test\n");
      await ctx.writeFile(".ai/vcm/handoffs/test-report.md", validTestReport());
      await git(ctx.cwd, "add", "tests/phone.test.txt");
      await git(ctx.cwd, "commit", "-m", "validate the phone feature");
      await ctx.writeFile(
        ".ai/vcm/handoffs/messages/tester-project-manager.md",
        route("result", "Phone feature validated.", ".ai/vcm/handoffs/test-report.md")
      );
      await ctx.appendTranscriptText("Validated.");
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("project-manager", "Phone feature validated.", async (ctx) => {
      await ctx.userPromptSubmit();
      await pm.requestGate(first, "validation-adequacy");
      await ctx.appendTranscriptText("Requested the validation-adequacy Gate.");
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("project-manager", /gate: validation-adequacy[\s\S]*decision: approve/, async (ctx) => {
      await ctx.userPromptSubmit();
      await pm.requestGate(first, "code-diff");
      await ctx.appendTranscriptText("Requested the code-diff Gate.");
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("project-manager", /gate: code-diff[\s\S]*decision: approve/, async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.writeFile(".ai/vcm/handoffs/final-acceptance.md", acceptedFinalAcceptance(first));
      await pm.complete(first);
      await ctx.appendTranscriptText("The phone feature is done: Final Acceptance accepted.");
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("project-manager", "Prepare the draft PR.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("Draft PR ready: https://example.test/pull/1");
      await ctx.stop();
    });
    env.mockRuntime.onPrompt("project-manager", "Start the second task.", async (ctx) => {
      await ctx.userPromptSubmit();
      await ctx.appendTranscriptText("The second task's PM is ready.");
      await ctx.stop();
    });

    expect((await bindGatewayLarkApp(env.app, { appId: "mock-app", appSecret: "mock-secret", larkDomain: "lark" })).status)
      .toBe("confirmed");
    await setGatewayConnection(env.app, true);
    expect((await updateGatewaySettings(env.app, { enabled: true, channel: "lark", translationEnabled: true })).running)
      .toBe(true);

    // 1. Create the task from the phone; Gateway starts its role sessions.
    let since = phone.sentCount;
    phone.send(`/create-task ${first} Phone feature`);
    const created = await phone.reply(since, "task created", (text) => text.includes(`Task created and initialized: ${first}`));
    expect(created).toContain("project-manager");
    // Gate Review settings are app-wide and set from the desktop.
    await updateGateSettings(env.app, first, {
      "architecture-plan": true,
      "validation-adequacy": true,
      "code-diff": true
    });

    // 2. Ask PM for the work; the whole Code-Change Flow runs without the
    // phone, and only PM's final reply comes back.
    since = phone.sentCount;
    phone.send("做一个手机功能。");
    await phone.reply(
      since,
      "PM final reply",
      (text) => text.includes("The phone feature is done: Final Acceptance accepted."),
      90_000
    );
    const gates = await env.deps.gateReviewService.getState(repo.repoRoot, first);
    for (const gate of ["architecture-plan", "validation-adequacy", "code-diff"] as const) {
      expect(gates.gates[gate], gate).toMatchObject({ status: "completed", decision: "approve" });
    }
    const firstTask = await env.deps.taskService.loadTask(repo.repoRoot, first);
    expect((await env.deps.workflowControlService!.getProgress({
      taskRepoRoot: firstTask.worktreePath,
      taskSlug: first,
      stateRoot: ".ai/vcm",
      handoffDir: ".ai/vcm/handoffs"
    })).status).toBe("completed");

    // 3. Ask PM for the PR after the flow completed.
    since = phone.sentCount;
    phone.send("准备 draft PR。");
    await phone.reply(since, "PR reply", (text) => text.includes("Draft PR ready: https://example.test/pull/1"));

    // 4. Close the task with the two-step confirmation.
    since = phone.sentCount;
    phone.send("/close-task");
    await phone.reply(since, "close prompt", (text) => text.includes(`Confirm with: /close-task confirm ${first}`));
    since = phone.sentCount;
    phone.send(`/close-task confirm ${first}`);
    const closed = await phone.reply(since, "close result", (text) => text.includes(`Closed task: ${first}`));
    expect(closed).toContain("branch deleted: yes");
    // The task's commits were never merged, and close reports that only
    // after it has force-deleted the branch.
    expect(closed).toMatch(/2 commit\(s\) not contained in main; close force-deletes the branch/);
    // Nothing may recreate the removed worktree, such as the pending
    // translation of PM's last reply.
    await sleep(2_000);
    await expect(fs.access(firstTask.worktreePath)).rejects.toThrow();

    // 5. Start the next task from the phone and talk to its PM.
    const second = "gw-second";
    since = phone.sentCount;
    phone.send(`/create-task ${second} Second phone task`);
    await phone.reply(since, "second task created", (text) => text.includes(`Task created and initialized: ${second}`));
    since = phone.sentCount;
    phone.send("开始第二个任务。");
    await phone.reply(since, "second task PM reply", (text) => text.includes("The second task's PM is ready."));
    const status = await env.deps.gatewayService.getStatus();
    expect(status.currentTaskSlug).toBe(second);
    const secondTask = await env.deps.taskService.loadTask(repo.repoRoot, second);
    await expect(fs.access(path.join(secondTask.worktreePath, "src/phone.txt"))).rejects.toThrow();
  }, 240_000);
});

function route(type: "task" | "result", body: string, artifactRef?: string): string {
  return [
    "---",
    `type: ${type}`,
    ...(artifactRef ? [`artifact_refs: ${artifactRef}`] : []),
    "---",
    body,
    ""
  ].join("\n");
}
