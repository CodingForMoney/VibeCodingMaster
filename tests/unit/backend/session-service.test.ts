import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../../src/shared/types/project.js";
import type { RoleName } from "../../../src/shared/types/role.js";
import {
  CLAUDE_EFFORT_OPTIONS,
  type ClaudeModel,
  type SessionEffort
} from "../../../src/shared/types/session.js";
import type { CreateTerminalSessionInput, TerminalRuntime, TerminalSession } from "../../../src/backend/runtime/terminal-runtime.js";
import { createSessionRegistry } from "../../../src/backend/runtime/session-registry.js";
import { createSessionService } from "../../../src/backend/services/session-service.js";
import { claudeTranscriptPath } from "../../../src/backend/services/claude-transcript-service.js";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";

const TASK_WORKTREE = "/repo/.claude/worktrees/demo-task";

describe("createSessionService", () => {
  it("keeps Max effort in Claude Code options", () => {
    expect(CLAUDE_EFFORT_OPTIONS.map((option) => option.value)).toContain("max");
  });

  it("persists Claude session ids after the first UserPromptSubmit hook and resumes them after registry loss", async () => {
    const fs = createMemoryFs();
    const firstRuntimeInputs: CreateTerminalSessionInput[] = [];
    const firstService = createTestSessionService(fs, firstRuntimeInputs);

    const started = await firstService.startRoleSession("/repo", "demo-task", "architect", {
      permissionMode: "default"
    });
    expect(started.claudeSessionId).toBe("");
    expect(started.transcriptPath).toBeUndefined();
    expect(started.command).not.toContain("--session-id");
    expect(firstRuntimeInputs[0]?.args).not.toContain("--session-id");
    await expect(fs.pathExists(`${TASK_WORKTREE}/.ai/vcm/sessions/demo-task.json`)).resolves.toBe(false);

    const hooked = await firstService.recordRoleHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "architect",
      eventName: "UserPromptSubmit",
      sessionId: "architect-real-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/architect-real-session.jsonl`,
      cwd: TASK_WORKTREE
    });
    expect(hooked?.claudeSessionId).toBe("architect-real-session");

    const secondRuntimeInputs: CreateTerminalSessionInput[] = [];
    const secondService = createTestSessionService(fs, secondRuntimeInputs);
    const recovered = await secondService.listRoleSessions("/repo", "demo-task");
    expect(recovered).toMatchObject([
      {
        role: "architect",
        status: "resumable",
        claudeSessionId: "architect-real-session",
        transcriptPath: `${TASK_WORKTREE}/.claude/projects/architect-real-session.jsonl`
      }
    ]);

    const resumed = await secondService.resumeRoleSession("/repo", "demo-task", "architect");
    expect(resumed.claudeSessionId).toBe("architect-real-session");
    expect(resumed.transcriptPath).toBe(`${TASK_WORKTREE}/.claude/projects/architect-real-session.jsonl`);
    expect(secondRuntimeInputs[0]?.args).toEqual([
      "--agent",
      "architect",
      "--resume",
      "architect-real-session",
      "--model",
      "default"
    ]);
  });

  it("does not persist a fresh Claude session id from non-prompt hooks", async () => {
    const fs = createMemoryFs();
    const service = createTestSessionService(fs, []);

    await service.startRoleSession("/repo", "demo-task", "coder");
    const stopped = await service.recordRoleHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "coder",
      eventName: "Stop",
      sessionId: "coder-stop-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/coder-stop-session.jsonl`,
      cwd: TASK_WORKTREE
    });

    expect(stopped).toBeUndefined();
    await expect(fs.pathExists(`${TASK_WORKTREE}/.ai/vcm/sessions/demo-task.json`)).resolves.toBe(false);

    const prompted = await service.recordRoleHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "coder",
      eventName: "UserPromptSubmit",
      sessionId: "coder-prompt-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/coder-prompt-session.jsonl`,
      cwd: TASK_WORKTREE
    });

    expect(prompted?.claudeSessionId).toBe("coder-prompt-session");
    await expect(fs.pathExists(`${TASK_WORKTREE}/.ai/vcm/sessions/demo-task.json`)).resolves.toBe(true);
  });

  it("starts project-manager sessions with VCM environment instead of pasted context", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const writes: string[] = [];
    const service = createTestSessionService(fs, runtimeInputs, writes);

    await service.startRoleSession("/repo", "demo-task", "project-manager");

    expect(writes).toHaveLength(0);
    expect(runtimeInputs[0]?.env).toMatchObject({
      VCM_API_URL: "http://127.0.0.1:4173",
      VCM_TASK_REPO_ROOT: TASK_WORKTREE,
      VCM_TASK_SLUG: "demo-task",
      VCM_ROLE: "project-manager"
    });
    expect(runtimeInputs[0]?.env?.VCM_SESSION_ID).toBeUndefined();
  });

  it("starts role sessions with the selected Claude model", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs);

    const started = await service.startRoleSession("/repo", "demo-task", "coder", {
      model: "claude-opus-4-8[1m]"
    });

    expect(started.model).toBe("claude-opus-4-8[1m]");
    expect(runtimeInputs[0]?.args).toEqual([
      "--agent",
      "coder",
      "--model",
      "claude-opus-4-8[1m]"
    ]);
  });

  it("starts role sessions with the selected Claude effort", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs);

    const started = await service.startRoleSession("/repo", "demo-task", "architect", {
      effort: "high"
    });

    expect(started.effort).toBe("high");
    expect(runtimeInputs[0]?.args).toEqual([
      "--agent",
      "architect",
      "--model",
      "default",
      "--effort",
      "high"
    ]);
  });

  it("starts Gate Reviewer as a task-scoped Claude Code session", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs, [], {
      worktreePath: TASK_WORKTREE
    });

    const started = await service.startRoleSession("/repo", "demo-task", "gate-reviewer", {
      permissionMode: "bypassPermissions",
      model: "claude-opus-4-8[1m]",
      effort: "high"
    });

    expect(started.role).toBe("gate-reviewer");
    expect(started.taskSlug).toBe("demo-task");
    expect(started.model).toBe("claude-opus-4-8[1m]");
    expect(started.effort).toBe("high");
    expect(started.claudeSessionId).toBe("");
    expect(started.transcriptPath).toBeUndefined();
    expect(runtimeInputs[0]?.command).toBe("claude");
    expect(runtimeInputs[0]?.cwd).toBe(TASK_WORKTREE);
    expect(runtimeInputs[0]?.args).toEqual([
      "--agent",
      "gate-reviewer",
      "--model",
      "claude-opus-4-8[1m]",
      "--effort",
      "high",
      "--permission-mode",
      "bypassPermissions"
    ]);
    expect(runtimeInputs[0]?.env).toMatchObject({
      VCM_TASK_REPO_ROOT: TASK_WORKTREE,
      VCM_TASK_SLUG: "demo-task",
      VCM_ROLE: "gate-reviewer"
    });
    await expect(fs.pathExists("/repo/.ai/vcm/gate-reviewer/session.json")).resolves.toBe(false);
    await expect(fs.pathExists(`${TASK_WORKTREE}/.ai/vcm/sessions/demo-task.json`)).resolves.toBe(false);

    await service.recordRoleHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "gate-reviewer",
      eventName: "UserPromptSubmit",
      sessionId: "gate-reviewer-real-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/gate-reviewer-real-session.jsonl`,
      cwd: TASK_WORKTREE
    });
    await expect(fs.pathExists(`${TASK_WORKTREE}/.ai/vcm/sessions/demo-task.json`)).resolves.toBe(true);
  });

  it("keeps Gate Reviewer sessions isolated per task", async () => {
    const fs = createMemoryFs();
    const firstRuntimeInputs: CreateTerminalSessionInput[] = [];
    const firstService = createTestSessionService(fs, firstRuntimeInputs);

    await firstService.startRoleSession("/repo", "demo-task", "gate-reviewer");
    await firstService.recordRoleHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "gate-reviewer",
      eventName: "UserPromptSubmit",
      sessionId: "gate-demo-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/gate-demo-session.jsonl`,
      cwd: TASK_WORKTREE
    });

    const secondRuntimeInputs: CreateTerminalSessionInput[] = [];
    const secondService = createTestSessionService(fs, secondRuntimeInputs);
    const recovered = await secondService.getRoleSession("/repo", "another-task", "gate-reviewer");
    expect(recovered).toBeUndefined();

    const nextTask = await secondService.startRoleSession("/repo", "another-task", "gate-reviewer");
    expect(nextTask.claudeSessionId).toBe("");
    expect(nextTask.taskSlug).toBe("another-task");
    expect(secondRuntimeInputs[0]?.cwd).toBe("/repo/.claude/worktrees/another-task");
    expect(secondRuntimeInputs[0]?.args).toEqual([
      "--agent",
      "gate-reviewer",
      "--model",
      "default"
    ]);
  });

  it("persists Translator sessions under project translation runtime state", async () => {
    const fs = createMemoryFs();
    const firstRuntimeInputs: CreateTerminalSessionInput[] = [];
    const firstService = createTestSessionService(fs, firstRuntimeInputs, [], {
      worktreePath: TASK_WORKTREE
    });

    const started = await firstService.startProjectTranslatorSession("/repo", {
      taskSlug: "demo-task",
      model: "default",
      effort: "xhigh"
    });

    expect(started.taskSlug).toBe("__project__");
    // Project-level tool sessions launch from the base repoRoot anchor; the task
    // worktree is entered afterwards via `/cd`, while VCM_TASK_REPO_ROOT still
    // exposes the active task root independently of pty cwd.
    expect(firstRuntimeInputs[0]?.cwd).toBe("/repo");
    expect(firstRuntimeInputs[0]?.env).toMatchObject({
      VCM_TASK_REPO_ROOT: TASK_WORKTREE,
      VCM_TASK_SLUG: "__project__",
      VCM_ROLE: "translator"
    });
    expect(firstRuntimeInputs[0]?.logPath).toBeUndefined();
    await expect(fs.pathExists("/repo/.ai/vcm/translations/session.json")).resolves.toBe(false);
    await expect(fs.pathExists("/repo/.claude/worktrees/demo-task/.ai/vcm/sessions/demo-task.json"))
      .resolves.toBe(false);

    const hooked = await firstService.recordProjectTranslatorHookEvent("/repo", {
      eventName: "UserPromptSubmit",
      sessionId: "translator-real-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/translator-real-session.jsonl`,
      cwd: TASK_WORKTREE
    });
    expect(hooked?.claudeSessionId).toBe("translator-real-session");

    const secondRuntimeInputs: CreateTerminalSessionInput[] = [];
    const secondService = createTestSessionService(fs, secondRuntimeInputs);
    const recovered = await secondService.getProjectTranslatorSession("/repo");
    expect(recovered).toMatchObject({
      role: "translator",
      taskSlug: "__project__",
      status: "resumable",
      claudeSessionId: "translator-real-session"
    });
    const resumed = await secondService.resumeProjectTranslatorSession("/repo", {
      taskSlug: "demo-task"
    });
    expect(resumed.claudeSessionId).toBe("translator-real-session");
    expect(secondRuntimeInputs[0]?.args).toEqual([
      "--agent",
      "translator",
      "--resume",
      "translator-real-session",
      "--model",
      "default",
      "--effort",
      "xhigh"
    ]);
  });

  it("clears Translator session ids on restart until the next prompt hook", async () => {
    const fs = createMemoryFs();
    const service = createTestSessionService(fs, [], [], {
      worktreePath: TASK_WORKTREE
    });

    await service.startProjectTranslatorSession("/repo", {
      taskSlug: "demo-task"
    });
    await service.recordProjectTranslatorHookEvent("/repo", {
      eventName: "UserPromptSubmit",
      sessionId: "translator-old-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/translator-old-session.jsonl`,
      cwd: TASK_WORKTREE
    });
    await expect(fs.pathExists("/repo/.ai/vcm/translations/session.json")).resolves.toBe(true);

    const restarted = await service.restartProjectTranslatorSession("/repo", {
      taskSlug: "demo-task"
    });

    expect(restarted.claudeSessionId).toBe("");
    expect(restarted.transcriptPath).toBeUndefined();
    await expect(fs.pathExists("/repo/.ai/vcm/translations/session.json")).resolves.toBe(false);
    await expect(createTestSessionService(fs, []).getProjectTranslatorSession("/repo")).resolves.toBeUndefined();

    const hooked = await service.recordProjectTranslatorHookEvent("/repo", {
      eventName: "UserPromptSubmit",
      sessionId: "translator-new-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/translator-new-session.jsonl`,
      cwd: TASK_WORKTREE
    });

    expect(hooked?.claudeSessionId).toBe("translator-new-session");
    await expect(fs.pathExists("/repo/.ai/vcm/translations/session.json")).resolves.toBe(true);
  });

  it("clears Harness Engineer session ids on restart until the next prompt hook", async () => {
    const fs = createMemoryFs();
    const service = createTestSessionService(fs, [], [], {
      worktreePath: TASK_WORKTREE
    });

    await service.startProjectHarnessEngineerSession("/repo", {
      taskSlug: "demo-task"
    });
    await service.recordProjectHarnessEngineerHookEvent("/repo", {
      eventName: "UserPromptSubmit",
      sessionId: "harness-old-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/harness-old-session.jsonl`,
      cwd: TASK_WORKTREE
    });
    await expect(fs.pathExists("/repo/.ai/vcm/harness-engineer/session.json")).resolves.toBe(true);

    const restarted = await service.restartProjectHarnessEngineerSession("/repo", {
      taskSlug: "demo-task"
    });

    expect(restarted.claudeSessionId).toBe("");
    expect(restarted.transcriptPath).toBeUndefined();
    await expect(fs.pathExists("/repo/.ai/vcm/harness-engineer/session.json")).resolves.toBe(false);
    await expect(createTestSessionService(fs, []).getProjectHarnessEngineerSession("/repo")).resolves.toBeUndefined();

    const hooked = await service.recordProjectHarnessEngineerHookEvent("/repo", {
      eventName: "UserPromptSubmit",
      sessionId: "harness-new-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/harness-new-session.jsonl`,
      cwd: TASK_WORKTREE
    });

    expect(hooked?.claudeSessionId).toBe("harness-new-session");
    await expect(fs.pathExists("/repo/.ai/vcm/harness-engineer/session.json")).resolves.toBe(true);
  });

  it("starts Translator as a project-scoped Claude Code session", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs);

    const started = await service.startProjectTranslatorSession("/repo", {
      taskSlug: "demo-task",
      model: "default",
      effort: "medium"
    });

    expect(started.command).toContain("--agent translator");
    expect(runtimeInputs[0]?.cwd).toBe("/repo");
    expect(runtimeInputs[0]?.args).toEqual([
      "--agent",
      "translator",
      "--model",
      "default",
      "--effort",
      "medium"
    ]);
    expect(runtimeInputs[0]?.args).not.toContain("--sandbox");
  });

  it("resumes Translator with selected permission, model, and effort from ensure", async () => {
    const fs = createMemoryFs();
    const firstService = createTestSessionService(fs, []);
    await firstService.startProjectTranslatorSession("/repo", {
      taskSlug: "demo-task"
    });
    await firstService.recordProjectTranslatorHookEvent("/repo", {
      eventName: "UserPromptSubmit",
      sessionId: "translator-ensure-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/translator-ensure-session.jsonl`,
      cwd: TASK_WORKTREE
    });

    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const secondService = createTestSessionService(fs, runtimeInputs);
    const resumed = await secondService.ensureProjectTranslatorSession("/repo", {
      taskSlug: "demo-task",
      permissionMode: "bypassPermissions",
      model: "claude-opus-4-8[1m]",
      effort: "high"
    });

    expect(resumed.claudeSessionId).toBe("translator-ensure-session");
    expect(resumed.permissionMode).toBe("bypassPermissions");
    expect(resumed.model).toBe("claude-opus-4-8[1m]");
    expect(resumed.effort).toBe("high");
    expect(runtimeInputs[0]?.args).toEqual([
      "--agent",
      "translator",
      "--resume",
      "translator-ensure-session",
      "--model",
      "claude-opus-4-8[1m]",
      "--effort",
      "high",
      "--permission-mode",
      "bypassPermissions"
    ]);
  });

  it("moves a running Translator session to the active task worktree with /cd", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const writes: string[] = [];
    const service = createTestSessionService(fs, runtimeInputs, writes, {
      worktreePaths: {
        "demo-task": TASK_WORKTREE,
        "other-task": "/repo/.claude/worktrees/other-task"
      }
    });

    await service.startProjectTranslatorSession("/repo", {
      taskSlug: "demo-task"
    });
    await service.recordProjectTranslatorHookEvent("/repo", {
      eventName: "UserPromptSubmit",
      sessionId: "translator-move-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/translator-move-session.jsonl`,
      cwd: TASK_WORKTREE
    });
    const moved = await service.ensureProjectTranslatorSession("/repo", {
      taskSlug: "other-task"
    });

    expect(moved.claudeSessionId).toBe("translator-move-session");
    expect(moved.cwd).toBe("/repo/.claude/worktrees/other-task");
    expect(moved.previousCwd).toBe(TASK_WORKTREE);
    // writes[0..1] are the start-time `/cd` into the original worktree (the
    // session launches at repoRoot first); the move emits the second `/cd`.
    expect(writes[0]).toContain(`/cd ${TASK_WORKTREE}`);
    expect(writes[2]).toContain('/cd /repo/.claude/worktrees/other-task');
    expect(writes[3]).toBe("\r");
    // #16: `/cd` must NOT relocate the transcript anchor. The transcriptPath
    // stays at its first-launch (hook-recorded) value and is not recomputed
    // against the new `/cd` target worktree.
    expect(moved.transcriptPath).toBe(
      `${TASK_WORKTREE}/.claude/projects/translator-move-session.jsonl`
    );
    expect(moved.transcriptPath).not.toContain("other-task");

    const persisted = await fs.readJson<{ record: { cwd: string; previousCwd?: string } }>("/repo/.ai/vcm/translations/session.json");
    expect(persisted.record.cwd).toBe("/repo/.claude/worktrees/other-task");
    expect(persisted.record.previousCwd).toBe(TASK_WORKTREE);
  });

  it("resumes a Translator from the base repoRoot anchor before moving it to a new task worktree", async () => {
    const fs = createMemoryFs();
    const firstService = createTestSessionService(fs, [], [], {
      worktreePaths: {
        "demo-task": TASK_WORKTREE,
        "other-task": "/repo/.claude/worktrees/other-task"
      }
    });
    await firstService.startProjectTranslatorSession("/repo", {
      taskSlug: "demo-task"
    });
    await firstService.recordProjectTranslatorHookEvent("/repo", {
      eventName: "UserPromptSubmit",
      sessionId: "translator-resume-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/translator-resume-session.jsonl`,
      cwd: TASK_WORKTREE
    });

    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const writes: string[] = [];
    const secondService = createTestSessionService(fs, runtimeInputs, writes, {
      worktreePaths: {
        "demo-task": TASK_WORKTREE,
        "other-task": "/repo/.claude/worktrees/other-task"
      }
    });
    const resumed = await secondService.resumeProjectTranslatorSession("/repo", {
      taskSlug: "other-task"
    });

    expect(resumed.claudeSessionId).toBe("translator-resume-session");
    // Resume anchors at repoRoot (not the persisted task cwd, which may be gone),
    // then `/cd` migrates the live session into the active task worktree.
    expect(runtimeInputs[0]?.cwd).toBe("/repo");
    expect(runtimeInputs[0]?.args).toEqual([
      "--agent",
      "translator",
      "--resume",
      "translator-resume-session",
      "--model",
      "default",
      "--effort",
      "medium"
    ]);
    expect(writes[0]).toContain('/cd /repo/.claude/worktrees/other-task');
    expect(writes[1]).toBe("\r");
    expect(resumed.cwd).toBe("/repo/.claude/worktrees/other-task");
    // #16 second root cause: the transcript is anchored at the first-launch cwd
    // (repoRoot) and must NOT follow the `/cd` target. Resume re-anchors the
    // persisted (stale, task-worktree-derived) transcriptPath back to repoRoot,
    // self-healing it, so the translation panel reads the real transcript.
    expect(resumed.transcriptPath).toBe(
      claudeTranscriptPath("/repo", "translator-resume-session")
    );
    expect(resumed.transcriptPath).not.toContain("worktrees/other-task");
  });

  it("does not re-issue /cd when resume restores the session into the same task worktree", async () => {
    const fs = createMemoryFs();
    const firstService = createTestSessionService(fs, [], [], {
      worktreePath: TASK_WORKTREE
    });
    await firstService.startProjectTranslatorSession("/repo", {
      taskSlug: "demo-task"
    });
    await firstService.recordProjectTranslatorHookEvent("/repo", {
      eventName: "UserPromptSubmit",
      sessionId: "translator-resume-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/translator-resume-session.jsonl`,
      cwd: TASK_WORKTREE
    });

    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const writes: string[] = [];
    const secondService = createTestSessionService(fs, runtimeInputs, writes, {
      worktreePath: TASK_WORKTREE
    });
    const resumed = await secondService.resumeProjectTranslatorSession("/repo", {
      taskSlug: "demo-task"
    });

    expect(resumed.claudeSessionId).toBe("translator-resume-session");
    // Spawn still anchors at repoRoot (#16), but `claude --resume` restores the
    // session's last cwd (the same task worktree), so the cwd already equals the
    // target and NO `/cd` is issued — `/cd` is on-demand, only on an actual switch.
    expect(runtimeInputs[0]?.cwd).toBe("/repo");
    expect(resumed.cwd).toBe(TASK_WORKTREE);
    expect(writes.some((write) => write.includes("/cd"))).toBe(false);
  });

  it("emits /cd as a bare unquoted path so a worktree path with spaces is sent intact (#16 de-quote)", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const writes: string[] = [];
    const SPACEY_WORKTREE = "/repo/.claude/worktrees/space task";
    const service = createTestSessionService(fs, runtimeInputs, writes, {
      worktreePaths: { "demo-task": TASK_WORKTREE, "spacey-task": SPACEY_WORKTREE }
    });

    await service.startProjectTranslatorSession("/repo", { taskSlug: "demo-task" });
    await service.recordProjectTranslatorHookEvent("/repo", {
      eventName: "UserPromptSubmit",
      sessionId: "translator-spaces-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/translator-spaces-session.jsonl`,
      cwd: TASK_WORKTREE
    });
    const moved = await service.ensureProjectTranslatorSession("/repo", { taskSlug: "spacey-task" });

    expect(moved.cwd).toBe(SPACEY_WORKTREE);
    // De-quote (#16): Claude Code's `/cd` takes the literal remainder of the line, so
    // VCM emits the path bare. A worktree path with spaces must therefore arrive whole
    // and UNQUOTED (the prior `/cd "<path>"` form put quotes into the path and failed,
    // and quoting would also not protect spaces here). Whether Claude actually changes
    // into the directory is empirical (depends on Claude Code's `/cd` parser).
    const cdToSpacey = writes.find((write) => write.includes("space task"));
    expect(cdToSpacey).toContain(`/cd ${SPACEY_WORKTREE}`);
    expect(cdToSpacey).not.toContain('"');
  });

  it("moves a Translator session to the base repository cwd before task cleanup", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const writes: string[] = [];
    const service = createTestSessionService(fs, runtimeInputs, writes);

    await service.startProjectTranslatorSession("/repo", {
      taskSlug: "demo-task"
    });
    await service.recordProjectTranslatorHookEvent("/repo", {
      eventName: "UserPromptSubmit",
      sessionId: "translator-safe-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/translator-safe-session.jsonl`,
      cwd: TASK_WORKTREE
    });
    const moved = await service.moveProjectTranslatorSessionToSafeCwd("/repo");

    expect(moved.claudeSessionId).toBe("translator-safe-session");
    expect(moved.cwd).toBe("/repo");
    expect(moved.previousCwd).toBe(TASK_WORKTREE);
    // writes[0..1] are the start-time `/cd` into the worktree; the safe-cwd move
    // emits the second `/cd` back to the base repoRoot.
    expect(writes[0]).toContain(`/cd ${TASK_WORKTREE}`);
    expect(writes[2]).toContain('/cd /repo');
    expect(writes[3]).toBe("\r");
  });

  it("rebuilds a fresh Translator session when resume by id fails", async () => {
    const fs = createMemoryFs();
    const firstService = createTestSessionService(fs, []);
    await firstService.startProjectTranslatorSession("/repo", { taskSlug: "demo-task" });
    await firstService.recordProjectTranslatorHookEvent("/repo", {
      eventName: "UserPromptSubmit",
      sessionId: "translator-stale-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/translator-stale-session.jsonl`,
      cwd: TASK_WORKTREE
    });
    await expect(fs.pathExists("/repo/.ai/vcm/translations/session.json")).resolves.toBe(true);

    // The first launch attempt (a resume of the stale id) exits immediately,
    // simulating `claude --resume <stale-id>` failing to reopen the session.
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const secondService = createTestSessionService(fs, runtimeInputs, [], { exitedCalls: [1] });
    const rebuilt = await secondService.resumeProjectTranslatorSession("/repo", { taskSlug: "demo-task" });

    expect(runtimeInputs).toHaveLength(2);
    expect(runtimeInputs[0]?.args).toContain("--resume");
    expect(runtimeInputs[0]?.args).toContain("translator-stale-session");
    expect(runtimeInputs[1]?.args).not.toContain("--resume");
    expect(runtimeInputs[1]?.args).not.toContain("translator-stale-session");
    expect(rebuilt.claudeSessionId).toBe("");
    await expect(fs.pathExists("/repo/.ai/vcm/translations/session.json")).resolves.toBe(false);
  });

  it("rebuilds a fresh Harness Engineer session when resume by id fails", async () => {
    const fs = createMemoryFs();
    const firstService = createTestSessionService(fs, []);
    await firstService.startProjectHarnessEngineerSession("/repo", { taskSlug: "demo-task" });
    await firstService.recordProjectHarnessEngineerHookEvent("/repo", {
      eventName: "UserPromptSubmit",
      sessionId: "harness-stale-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/harness-stale-session.jsonl`,
      cwd: TASK_WORKTREE
    });
    await expect(fs.pathExists("/repo/.ai/vcm/harness-engineer/session.json")).resolves.toBe(true);

    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const secondService = createTestSessionService(fs, runtimeInputs, [], { exitedCalls: [1] });
    const rebuilt = await secondService.resumeProjectHarnessEngineerSession("/repo", { taskSlug: "demo-task" });

    expect(runtimeInputs).toHaveLength(2);
    expect(runtimeInputs[0]?.args).toContain("--resume");
    expect(runtimeInputs[0]?.args).toContain("harness-stale-session");
    expect(runtimeInputs[1]?.args).not.toContain("--resume");
    expect(runtimeInputs[1]?.args).not.toContain("harness-stale-session");
    expect(rebuilt.claudeSessionId).toBe("");
    await expect(fs.pathExists("/repo/.ai/vcm/harness-engineer/session.json")).resolves.toBe(false);
  });

  it("starts Harness Engineer as a project-scoped Claude Code session", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs);

    const started = await service.startProjectHarnessEngineerSession("/repo", {
      taskSlug: "demo-task",
      permissionMode: "bypassPermissions",
      model: "claude-opus-4-8[1m]",
      effort: "medium"
    });

    expect(started.role).toBe("harness-engineer");
    expect(started.taskSlug).toBe("__project_harness_engineer__");
    expect(started.command).toContain("--agent harness-engineer");
    expect(runtimeInputs[0]?.cwd).toBe("/repo");
    expect(runtimeInputs[0]?.env).toMatchObject({
      VCM_TASK_REPO_ROOT: TASK_WORKTREE,
      VCM_TASK_SLUG: "__project_harness_engineer__",
      VCM_ROLE: "harness-engineer"
    });
    expect(runtimeInputs[0]?.args).toEqual([
      "--agent",
      "harness-engineer",
      "--model",
      "claude-opus-4-8[1m]",
      "--effort",
      "medium",
      "--permission-mode",
      "bypassPermissions"
    ]);
    await expect(fs.pathExists("/repo/.ai/vcm/harness-engineer/session.json")).resolves.toBe(false);
    await expect(fs.pathExists("/repo/.claude/worktrees/demo-task/.ai/vcm/sessions/demo-task.json"))
      .resolves.toBe(false);

    await service.recordProjectHarnessEngineerHookEvent("/repo", {
      eventName: "UserPromptSubmit",
      sessionId: "harness-engineer-real-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/harness-engineer-real-session.jsonl`,
      cwd: TASK_WORKTREE
    });
    await expect(fs.pathExists("/repo/.ai/vcm/harness-engineer/session.json")).resolves.toBe(true);
  });

  it("marks sessions outdated when harness revision advances and notifies them", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const writes: string[] = [];
    const service = createTestSessionService(fs, runtimeInputs, writes);

    const started = await service.startRoleSession("/repo", "demo-task", "architect");
    expect(started.harnessRevision).toBe(0);
    expect(started.harnessCurrentRevision).toBe(0);
    expect(started.harnessOutdated).toBe(false);

    await fs.writeJson("/repo/.ai/vcm/harness/revision.json", {
      version: 1,
      revision: 1,
      updatedAt: "2026-05-29T00:00:00.000Z"
    });

    const [outdated] = await service.listRoleSessions("/repo", "demo-task");
    expect(outdated).toMatchObject({
      role: "architect",
      harnessRevision: 0,
      harnessCurrentRevision: 1,
      harnessOutdated: true
    });

    const notified = await service.notifyRoleHarnessUpdated("/repo", "demo-task", "architect");
    expect(notified).toMatchObject({
      role: "architect",
      harnessRevision: 1,
      harnessCurrentRevision: 1,
      harnessOutdated: false,
      lastHarnessNotifyAt: "2026-05-29T00:00:00.000Z"
    });
    expect(writes[0]).toContain("VCM harness was updated.");
    expect(writes[0]).toContain(".claude/agents/architect.md");
    expect(writes[1]).toBe("\r");
  });

  it("passes Gate Reviewer effort through Claude Code settings", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs);

    const started = await service.startRoleSession("/repo", "demo-task", "gate-reviewer", {
      model: "claude-sonnet-4-6[1m]",
      effort: "max"
    });

    expect(started.effort).toBe("max");
    expect(runtimeInputs[0]?.args).toContain("--agent");
    expect(runtimeInputs[0]?.args).toContain("gate-reviewer");
    expect(runtimeInputs[0]?.args).toContain("--effort");
    expect(runtimeInputs[0]?.args).toContain("max");
  });

  it("starts Claude Code sessions with ultracode settings", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs);

    const started = await service.startRoleSession("/repo", "demo-task", "architect", {
      model: "fable",
      effort: "ultracode"
    });

    expect(started.effort).toBe("ultracode");
    expect(runtimeInputs[0]?.args).toContain("--settings");
    expect(runtimeInputs[0]?.args).toContain("{\"ultracode\":true}");
    expect(runtimeInputs[0]?.args).not.toContain("--effort");
  });

  it("starts role sessions inside the task worktree when one exists", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs, [], {
      worktreePath: "/repo/.claude/worktrees/demo-task"
    });

    const started = await service.startRoleSession("/repo", "demo-task", "architect");

    expect(started.cwd).toBe("/repo/.claude/worktrees/demo-task");
    expect(started.transcriptPath).toBeUndefined();
    expect(runtimeInputs[0]?.cwd).toBe("/repo/.claude/worktrees/demo-task");
    expect(runtimeInputs[0]?.env).toMatchObject({
      VCM_TASK_REPO_ROOT: "/repo/.claude/worktrees/demo-task"
    });
    expect(runtimeInputs[0]?.logPath).toBeUndefined();
    await expect(fs.pathExists("/repo/.claude/worktrees/demo-task/.ai/vcm/sessions/demo-task.json"))
      .resolves.toBe(false);
    await expect(fs.pathExists("/repo/.ai/vcm/sessions/demo-task.json"))
      .resolves.toBe(false);

    await service.recordRoleHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "architect",
      eventName: "UserPromptSubmit",
      sessionId: "architect-worktree-session",
      transcriptPath: "/repo/.claude/worktrees/demo-task/.claude/projects/architect-worktree-session.jsonl",
      cwd: "/repo/.claude/worktrees/demo-task"
    });

    const recoveredService = createTestSessionService(fs, [], [], {
      worktreePath: "/repo/.claude/worktrees/demo-task"
    });
    await expect(recoveredService.listRoleSessions("/repo", "demo-task")).resolves.toMatchObject([{
      role: "architect",
      status: "resumable",
      claudeSessionId: "architect-worktree-session"
    }]);
  });


  it("restarts with a fresh Claude session instead of resuming the persisted one", async () => {
    const fs = createMemoryFs();
    const firstRuntimeInputs: CreateTerminalSessionInput[] = [];
    const firstService = createTestSessionService(fs, firstRuntimeInputs);

    await firstService.startRoleSession("/repo", "demo-task", "coder");
    expect(firstRuntimeInputs[0]?.args).not.toContain("--session-id");
    await firstService.recordRoleHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "coder",
      eventName: "UserPromptSubmit",
      sessionId: "coder-old-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/coder-old-session.jsonl`,
      cwd: TASK_WORKTREE
    });

    const secondRuntimeInputs: CreateTerminalSessionInput[] = [];
    const secondService = createTestSessionService(fs, secondRuntimeInputs);
    const restarted = await secondService.restartRoleSession("/repo", "demo-task", "coder");

    expect(restarted.claudeSessionId).toBe("");
    expect(restarted.transcriptPath).toBeUndefined();
    expect(secondRuntimeInputs[0]?.args).toEqual([
      "--agent",
      "coder",
      "--model",
      "default"
    ]);
    expect(secondRuntimeInputs[0]?.args).not.toContain("--resume");

    const cleared = await fs.readJson<{
      roles: { coder?: { id: string | null; claudeSessionId?: string; status: string; record?: unknown } };
    }>(`${TASK_WORKTREE}/.ai/vcm/sessions/demo-task.json`);
    expect(cleared.roles.coder).toEqual({
      id: null,
      status: "not_started"
    });
    await expect(createTestSessionService(fs, []).getRoleSession("/repo", "demo-task", "coder"))
      .resolves.toBeUndefined();

    const hooked = await secondService.recordRoleHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "coder",
      eventName: "UserPromptSubmit",
      sessionId: "coder-new-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/coder-new-session.jsonl`,
      cwd: TASK_WORKTREE
    });
    expect(hooked?.claudeSessionId).toBe("coder-new-session");

    const recovered = await createTestSessionService(fs, []).getRoleSession("/repo", "demo-task", "coder");
    expect(recovered?.claudeSessionId).toBe("coder-new-session");
  });

  it("normalizes legacy dangerously skip permission records to bypassPermissions", async () => {
    const fs = createMemoryFs();
    await fs.writeJson(`${TASK_WORKTREE}/.ai/vcm/sessions/demo-task.json`, {
      version: 1,
      taskSlug: "demo-task",
      updatedAt: "2026-05-29T00:00:00.000Z",
      roles: {
        "project-manager": { id: null, status: "not_started" },
        architect: { id: null, status: "not_started" },
        coder: {
          id: "runtime_legacy",
          claudeSessionId: "00000000-0000-4000-8000-000000000004",
          status: "running",
          record: {
            id: "runtime_legacy",
            claudeSessionId: "00000000-0000-4000-8000-000000000004",
            taskSlug: "demo-task",
            role: "coder",
            status: "running",
            activityStatus: "idle",
            command: "claude --agent coder --dangerously-skip-permissions",
            permissionMode: "dangerously-skip-permissions",
            cwd: TASK_WORKTREE,
            terminalBackend: "node-pty",
            updatedAt: "2026-05-29T00:00:00.000Z"
          }
        },
        reviewer: { id: null, status: "not_started" }
      }
    });
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs);

    const recovered = await service.getRoleSession("/repo", "demo-task", "coder");
    expect(recovered?.permissionMode).toBe("bypassPermissions");

    await service.resumeRoleSession("/repo", "demo-task", "coder");
    expect(runtimeInputs[0]?.args).toEqual([
      "--agent",
      "coder",
      "--resume",
      "00000000-0000-4000-8000-000000000004",
      "--model",
      "default",
      "--permission-mode",
      "bypassPermissions"
    ]);
  });

  it("records Claude hook activity separately from terminal process status", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const service = createTestSessionService(fs, runtimeInputs);
    const started = await service.startRoleSession("/repo", "demo-task", "coder");

    expect(started).toMatchObject({
      status: "running",
      activityStatus: "idle"
    });
    const prompted = await service.recordClaudeHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "coder",
      eventName: "UserPromptSubmit",
      claudeSessionId: "coder-real-session",
      transcriptPath: `${TASK_WORKTREE}/.claude/projects/coder-real-session.jsonl`,
      cwd: TASK_WORKTREE
    });
    expect(prompted).toMatchObject({
      claudeSessionId: "coder-real-session",
      activityStatus: "running"
    });

    const running = await service.markRoleActivityRunning("/repo", "demo-task", "coder");
    expect(running).toMatchObject({
      status: "running",
      activityStatus: "running",
      lastTurnStartedAt: "2026-05-29T00:00:00.000Z"
    });

    const manuallyIdle = await service.markRoleActivityIdle("/repo", "demo-task", "coder");
    expect(manuallyIdle).toMatchObject({
      status: "running",
      activityStatus: "idle",
      lastTurnEndedAt: "2026-05-29T00:00:00.000Z"
    });

    await service.markRoleActivityRunning("/repo", "demo-task", "coder");
    const idle = await service.recordClaudeHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "coder",
      eventName: "Stop",
      claudeSessionId: "coder-real-session"
    });
    expect(idle).toMatchObject({
      status: "running",
      activityStatus: "idle",
      lastTurnEndedAt: "2026-05-29T00:00:00.000Z"
    });

    await service.markRoleActivityRunning("/repo", "demo-task", "coder");
    const failed = await service.recordClaudeHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "coder",
      eventName: "StopFailure",
      claudeSessionId: "coder-real-session"
    });
    expect(failed).toMatchObject({
      status: "running",
      activityStatus: "idle",
      lastTurnEndedAt: "2026-05-29T00:00:00.000Z"
    });

    await service.markRoleActivityRunning("/repo", "demo-task", "coder");
    const compacted = await service.recordClaudeHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "coder",
      eventName: "PostCompact",
      claudeSessionId: "coder-real-session",
      transcriptPath: "/Users/sheldon/.claude/projects/demo/compact.jsonl"
    });
    expect(compacted).toMatchObject({
      status: "running",
      activityStatus: "running",
      transcriptPath: "/Users/sheldon/.claude/projects/demo/compact.jsonl",
      lastCompactAt: "2026-05-29T00:00:00.000Z"
    });
  });

  it("records Gate Reviewer hook activity on the task-scoped session", async () => {
    const fs = createMemoryFs();
    const service = createTestSessionService(fs, []);
    const started = await service.startRoleSession("/repo", "demo-task", "gate-reviewer");

    expect(started.claudeSessionId).not.toBe("claude_session_123");
    expect(started.claudeSessionId).toBe("");

    const running = await service.recordRoleHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "gate-reviewer",
      eventName: "UserPromptSubmit",
      sessionId: "claude_session_123",
      transcriptPath: "/Users/sheldon/.claude/projects/-repo-.claude-worktrees-demo-task/claude_session_123.jsonl",
      cwd: TASK_WORKTREE,
      allowSessionMismatch: true
    });
    expect(running).toMatchObject({
      role: "gate-reviewer",
      taskSlug: "demo-task",
      claudeSessionId: "claude_session_123",
      transcriptPath: "/Users/sheldon/.claude/projects/-repo-.claude-worktrees-demo-task/claude_session_123.jsonl",
      cwd: TASK_WORKTREE,
      activityStatus: "running",
      lastTurnStartedAt: "2026-05-29T00:00:00.000Z"
    });

    const idle = await service.recordRoleHookEvent("/repo", {
      taskSlug: "demo-task",
      role: "gate-reviewer",
      eventName: "Stop",
      sessionId: "claude_session_123",
      allowSessionMismatch: true
    });
    expect(idle).toMatchObject({
      activityStatus: "idle",
      lastTurnEndedAt: "2026-05-29T00:00:00.000Z"
    });
  });
});

function createTestSessionService(
  fs: FileSystemAdapter,
  runtimeInputs: CreateTerminalSessionInput[],
  writes: string[] = [],
  options: { sandboxMode?: string; worktreePath?: string; worktreePaths?: Record<string, string>; exitedCalls?: number[] } = {}
) {
  const worktreePath = options.worktreePath ?? TASK_WORKTREE;
  const resolveWorktreePath = (taskSlug: string) => options.worktreePaths?.[taskSlug]
    ?? (taskSlug === "demo-task" ? worktreePath : `/repo/.claude/worktrees/${taskSlug}`);
  return createSessionService({
    fs,
    runtime: createFakeRuntime(runtimeInputs, writes, { exitedCalls: options.exitedCalls }),
    registry: createSessionRegistry(),
    claude: {
      async isAvailable() {
        return true;
      },
      async getVersion() {
        return "2.1.156";
      },
      buildRoleStartCommand(
        role: RoleName,
        command = "claude",
        permissionMode = "default",
        claudeSessionId?: string,
        resume = false,
        model: ClaudeModel = "default",
        effort: SessionEffort = "default"
      ) {
        const args = ["--agent", role];
        if (claudeSessionId) {
          args.push(resume ? "--resume" : "--session-id", claudeSessionId);
        }
        args.push("--model", model);
        if (effort === "ultracode") {
          args.push("--settings", JSON.stringify({ ultracode: true }));
        } else if (effort !== "default") {
          args.push("--effort", effort);
        }
        if (permissionMode !== "default") {
          args.push("--permission-mode", permissionMode);
        }
        return { command, args, display: `${command} ${args.join(" ")}` };
      }
    },
    artifactService: {
      getHandoffPaths() {
        return {
          handoffDir: ".ai/vcm/handoffs",
          roleCommandsDir: ".ai/vcm/handoffs/role-commands",
          messagesDir: ".ai/vcm/handoffs/messages",
          roleCommandPaths: {
            architect: ".ai/vcm/handoffs/role-commands/architect.md",
            coder: ".ai/vcm/handoffs/role-commands/coder.md",
            reviewer: ".ai/vcm/handoffs/role-commands/reviewer.md"
          },
          architecturePlanPath: ".ai/vcm/handoffs/architecture-plan.md",
          knownIssuesPath: ".ai/vcm/handoffs/known-issues.md",
          reviewReportPath: ".ai/vcm/handoffs/review-report.md",
          docsSyncReportPath: ".ai/vcm/handoffs/docs-sync-report.md",
          finalAcceptancePath: ".ai/vcm/handoffs/final-acceptance.md"
        };
      }
    } as never,
    projectService: {
      async loadConfig(): Promise<ProjectConfig> {
        return {
          version: 1,
          repoRoot: "/repo",
          defaultRoles: ["project-manager", "architect", "coder", "reviewer"],
          handoffRoot: ".ai/vcm/handoffs",
          stateRoot: ".ai/vcm",
          terminalBackend: "node-pty",
          claudeCommand: "claude"
        };
      }
    },
    taskService: {
      async loadTask(_repoRoot: string, taskSlug = "demo-task") {
        const resolvedWorktreePath = resolveWorktreePath(taskSlug);
        return {
          version: 1,
          taskSlug,
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:00:00.000Z",
          repoRoot: "/repo",
          worktreePath: resolvedWorktreePath,
          branch: "feature",
          handoffDir: ".ai/vcm/handoffs",
          status: "created"
        };
      },
      async updateTaskStatus(_repoRoot: string, taskSlug = "demo-task") {
        const resolvedWorktreePath = resolveWorktreePath(taskSlug);
        return {
          version: 1,
          taskSlug,
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:00:00.000Z",
          repoRoot: "/repo",
          worktreePath: resolvedWorktreePath,
          branch: "feature",
          handoffDir: ".ai/vcm/handoffs",
          status: "running"
        };
      }
    } as never,
    apiUrl: "http://127.0.0.1:4173",
    sandboxMode: options.sandboxMode,
    now: () => "2026-05-29T00:00:00.000Z"
  });
}

function createFakeRuntime(
  inputs: CreateTerminalSessionInput[],
  writes: string[],
  options: { exitedCalls?: number[] } = {}
): TerminalRuntime {
  const sessions = new Map<string, TerminalSession>();
  const exitedCalls = new Set(options.exitedCalls ?? []);
  return {
    async createSession(input) {
      inputs.push(input);
      const callIndex = inputs.length;
      const exited = exitedCalls.has(callIndex);
      const session: TerminalSession = {
        id: `runtime_${callIndex}`,
        taskSlug: input.taskSlug,
        role: input.role,
        status: exited ? "exited" : "running",
        pid: exited ? undefined : 123,
        startedAt: "2026-05-29T00:00:00.000Z",
        // A live TUI emits output immediately, which the readiness wait keys off;
        // a failed launch exits and leaves no live runtime entry.
        lastOutputAt: exited ? undefined : "2026-05-29T00:00:00.000Z",
        exitCode: exited ? 1 : null
      };
      if (!exited) {
        sessions.set(session.id, session);
      }
      return session;
    },
    getSession(sessionId) {
      return sessions.get(sessionId);
    },
    getSessionByRole(taskSlug, role) {
      return [...sessions.values()].find((session) => session.taskSlug === taskSlug && session.role === role);
    },
    listSessions() {
      return [...sessions.values()];
    },
    write(_sessionId, data) {
      writes.push(data);
    },
    resize() {},
    async stop(sessionId) {
      sessions.delete(sessionId);
    },
    async restart(sessionId) {
      const current = sessions.get(sessionId);
      if (!current) {
        throw new Error("missing");
      }
      return current;
    },
    subscribe() {
      return () => {};
    }
  };
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
    },
    async removePath(targetPath) {
      files.delete(targetPath);
    }
  };
}
