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
      [
        "# Route message skill is unclear",
        "",
        "Reporter role: coder",
        "Task slug: demo-task",
        "Summary: vcm-route-message examples miss blocked handoff wording.",
        "",
        "Observed problem: coder repeatedly writes an ambiguous blocked report."
      ].join("\n"),
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
    expect(writes.join("\n")).toContain("Write the analysis to Result Path:");
    expect(writes.join("\n")).toContain(".ai/vcm/harness-feedback/task-retrospectives/demo-task.md");

    const marker = JSON.parse(await readFile(
      path.join(tmpRepo, ".ai/vcm/harness-feedback/task-retrospectives/demo-task.json"),
      "utf8"
    ));
    expect(marker).toMatchObject({
      taskSlug: "demo-task",
      trigger: "manual",
      status: "triggered",
      analysisPath: ".ai/vcm/harness-feedback/task-retrospectives/demo-task.md"
    });

    await expect(service.startTaskRetrospective(tmpRepo, {
      taskSlug: "demo-task",
      taskRepoRoot,
      handoffDir: ".ai/vcm/handoffs",
      trigger: "manual"
    })).rejects.toThrow("already been triggered");
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
