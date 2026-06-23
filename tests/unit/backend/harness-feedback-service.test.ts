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
  it("dispatches one pending feedback item, waits for approval, then applies it", async () => {
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
    const runtime = createRuntime(writes);
    const service = createHarnessFeedbackService({
      fs: createNodeFileSystemAdapter(),
      runtime,
      sessionService: createSessionService(),
      now: createClock()
    });

    const analyzing = await service.getState(tmpRepo, "demo-task");
    expect(analyzing.status).toBe("analyzing");
    expect(analyzing.active?.title).toBe("Route message skill is unclear");
    expect(writes.join("\n")).toContain("[VCM Harness Feedback Analysis]");
    expect(writes.join("\n")).toContain("Route message skill is unclear");

    await writeFile(
      path.join(tmpRepo, ".ai/vcm/harness-feedback/active/2026-01-01-coder-routing/analysis.md"),
      "Diagnosis: valid. Proposed change: update vcm-route-message examples.\n",
      "utf8"
    );
    await service.recordHarnessEngineerHook(tmpRepo, "Stop");
    const awaiting = await service.getState(tmpRepo, "demo-task");
    expect(awaiting.status).toBe("awaiting_user_approval");
    expect(awaiting.active?.analysisContent).toContain("Diagnosis: valid");

    const applying = await service.decide(tmpRepo, {
      action: "approve",
      taskSlug: "demo-task",
      comment: "Keep it concise."
    });
    expect(applying.status).toBe("applying");
    expect(writes.join("\n")).toContain("[VCM Harness Feedback Approved]");
    expect(writes.join("\n")).toContain("Keep it concise.");

    await writeFile(
      path.join(tmpRepo, ".ai/vcm/harness-feedback/active/2026-01-01-coder-routing/apply-report.md"),
      "Committed abc1234.\n",
      "utf8"
    );
    await service.recordHarnessEngineerHook(tmpRepo, "Stop");
    const done = await service.getState(tmpRepo, "demo-task");
    expect(done.status).toBe("idle");
    expect(done.queuedCount).toBe(0);
    await expect(readFile(
      path.join(tmpRepo, ".ai/vcm/harness-feedback/completed/2026-01-01-coder-routing/apply-report.md"),
      "utf8"
    )).resolves.toContain("Committed abc1234");
  });
});

function createRuntime(writes: string[]): TerminalRuntime {
  const session: TerminalSession = {
    id: "session-1",
    taskSlug: "__project_harness_engineer__",
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
    async getProjectHarnessEngineerSession() {
      return record;
    },
    async ensureProjectHarnessEngineerSession() {
      return record;
    }
  };
}

function createClock() {
  let tick = 0;
  return () => `2026-01-01T00:00:0${tick++}.000Z`;
}
