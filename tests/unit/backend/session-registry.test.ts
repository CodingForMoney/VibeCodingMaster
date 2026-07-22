import { describe, expect, it } from "vitest";
import { createSessionRegistry } from "../../../src/backend/runtime/session-registry.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";

describe("createSessionRegistry", () => {
  it("replaces the previous record for the same task role", () => {
    const registry = createSessionRegistry();
    registry.upsert(createSession("old-session", "2026-07-22T00:00:00.000Z"));
    registry.upsert(createSession("new-session", "2026-07-22T00:01:00.000Z"));

    expect(registry.list("task-1").map((session) => session.id)).toEqual(["new-session"]);
    expect(registry.get("old-session")).toBeUndefined();
    expect(registry.getByRole("task-1", "project-manager")?.id).toBe("new-session");
  });
});

function createSession(id: string, updatedAt: string): RoleSessionRecord {
  return {
    id,
    claudeSessionId: "",
    repoRoot: "/repo",
    taskSlug: "task-1",
    role: "project-manager",
    status: "running",
    activityStatus: "idle",
    command: "claude --agent project-manager",
    cwd: "/repo/.claude/worktrees/task-1",
    terminalBackend: "node-pty",
    startedAt: updatedAt,
    updatedAt,
    exitCode: null
  };
}
