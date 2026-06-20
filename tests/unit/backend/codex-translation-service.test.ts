import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import type { TerminalRuntime } from "../../../src/backend/runtime/terminal-runtime.js";
import { createCodexTranslationService } from "../../../src/backend/services/codex-translation-service.js";
import type { SessionService } from "../../../src/backend/services/session-service.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";

let tmpRepo: string | undefined;

afterEach(async () => {
  if (tmpRepo) {
    await rm(tmpRepo, { recursive: true, force: true });
    tmpRepo = undefined;
  }
});

describe("codex-translation-service", () => {
  it("creates project translation layout, file jobs, and queue items", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-codex-translation-"));
    await writeFile(path.join(tmpRepo, "README.md"), "# Demo\n\nHello project.\n", "utf8");
    const fs = createNodeFileSystemAdapter();
    const service = createCodexTranslationService({ fs });

    const job = await service.createFileJob(tmpRepo, {
      sourcePath: "README.md",
      targetLanguage: "zh-CN"
    });
    const request = await fs.readJson<{
      baseRepoRoot: string;
      absolutePaths: { sourcePath: string; resultPath: string; finalResultPath: string };
      outputContract: { stagingResultPath: string; finalResultPath: string };
    }>(
      path.join(tmpRepo, job.requestPath)
    );
    const state = await service.getState(tmpRepo);

    expect(job.status).toBe("queued");
    expect(request.baseRepoRoot).toBe(tmpRepo);
    expect(request.absolutePaths.sourcePath).toBe(path.join(tmpRepo, "README.md"));
    expect(request.absolutePaths.resultPath).toBe(path.join(tmpRepo, job.resultPath));
    expect(request.absolutePaths.finalResultPath).toContain(path.join(tmpRepo, ".ai/vcm/translations/files/completed/"));
    expect(request.outputContract.stagingResultPath).toBe(job.resultPath);
    expect(request.outputContract.finalResultPath).toContain(".ai/vcm/translations/files/completed/");
    expect(job.resultPath).toContain(".ai/vcm/translations/runtime/files/jobs/");
    expect(state.queue.items).toHaveLength(1);
    expect(state.queue.items[0]).toMatchObject({
      type: "file",
      status: "queued",
      jobId: job.id,
      expectedResultPath: job.resultPath
    });
    expect(state.fileIndex.jobs[0]?.id).toBe(job.id);
  });

  it("removes obsolete Codex Translator terminal logs from the translation runtime", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-codex-translation-logs-"));
    await mkdir(path.join(tmpRepo, ".ai/vcm/translations/runtime"), { recursive: true });
    await writeFile(path.join(tmpRepo, ".ai/vcm/translations/runtime/codex-translator.log"), "runtime log", "utf8");
    await writeFile(path.join(tmpRepo, ".ai/vcm/translations/codex-translator.log"), "legacy log", "utf8");
    const fs = createNodeFileSystemAdapter();
    const service = createCodexTranslationService({ fs });

    await service.getState(tmpRepo);

    await expect(fs.pathExists(path.join(tmpRepo, ".ai/vcm/translations/runtime/codex-translator.log"))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(tmpRepo, ".ai/vcm/translations/codex-translator.log"))).resolves.toBe(false);
  });

  it("creates bootstrap runs and memory files", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-codex-bootstrap-"));
    await writeFile(path.join(tmpRepo, "README.md"), "# Demo\n", "utf8");
    const fs = createNodeFileSystemAdapter();
    const service = createCodexTranslationService({ fs });

    const run = await service.createBootstrapRun(tmpRepo, {
      targetLanguage: "zh-CN"
    });
    const request = await fs.readJson<{ baseRepoRoot: string; absolutePaths: { memoryDir: string; reportPath: string; candidatePaths: string[] } }>(
      path.join(tmpRepo, run.requestPath)
    );
    const state = await service.getState(tmpRepo);

    expect(run.candidatePaths).toContain("README.md");
    expect(request.baseRepoRoot).toBe(tmpRepo);
    expect(request.absolutePaths.memoryDir).toBe(path.join(tmpRepo, ".ai/vcm/translations/memory"));
    expect(request.absolutePaths.reportPath).toBe(path.join(tmpRepo, run.reportPath));
    expect(request.absolutePaths.candidatePaths).toContain(path.join(tmpRepo, "README.md"));
    expect(state.bootstrapIndex.runs[0]?.id).toBe(run.id);
    expect(state.queue.items[0]).toMatchObject({
      type: "bootstrap",
      jobId: run.id
    });
  });

  it("queues compact memory updates through the Codex Translator session", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-codex-memory-update-"));
    const fs = createNodeFileSystemAdapter();
    const writes: string[] = [];
    const service = createCodexTranslationService({
      fs,
      runtime: createRuntimeStub(writes),
      sessionService: createTranslatorSessionService([])
    });

    const queueItem = await service.createMemoryUpdate(tmpRepo, {
      taskSlug: "demo-task",
      targetLanguage: "zh-CN"
    });
    await waitForDispatcher();

    const request = await fs.readJson<{
      memoryBudget: { totalLimitBytes: number; currentTotalBytes: number };
      allowedWrites: string[];
      absolutePaths: { memoryFiles: Record<string, string> };
    }>(path.join(tmpRepo, queueItem.requestPath));
    let state = await service.getState(tmpRepo);
    const activeItem = state.queue.items.find((item) => item.id === queueItem.id);
    const prompt = writes.find((entry) => entry.includes("[VCM CODEX TRANSLATION TASK]"));

    expect(queueItem.type).toBe("memory-update");
    expect(state.queue.activeItemId).toBe(queueItem.id);
    expect(activeItem?.status).toBe("running");
    expect(request.memoryBudget.totalLimitBytes).toBe(80 * 1024);
    expect(request.memoryBudget.currentTotalBytes).toBeGreaterThan(0);
    expect(request.allowedWrites).toEqual([
      ".ai/vcm/translations/memory/glossary.md",
      ".ai/vcm/translations/memory/style-guide.md",
      ".ai/vcm/translations/memory/project-context.md",
      ".ai/vcm/translations/memory/decisions.md"
    ]);
    expect(request.absolutePaths.memoryFiles["glossary.md"]).toBe(path.join(tmpRepo, ".ai/vcm/translations/memory/glossary.md"));
    expect(prompt).toContain("Type: memory-update");
    expect(prompt).toContain("Hard memory budget: total core memory <= 81920 bytes.");
    expect(prompt).toContain("Do not create archive, reports, candidates");
    expect(prompt).toContain("Do not use apply_patch");
    expect(await fs.pathExists(path.join(tmpRepo, queueItem.requestPath))).toBe(true);

    await service.handleCodexHook(tmpRepo, "Stop", "demo-task");
    await waitForDispatcher();

    state = await service.getState(tmpRepo);
    expect(state.queue.activeItemId).toBeUndefined();
    expect(state.queue.items.some((item) => item.id === queueItem.id)).toBe(false);
    expect(await fs.pathExists(path.join(tmpRepo, queueItem.requestPath))).toBe(false);
  });

  it("fails memory updates that leave non-core memory artifacts", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-codex-memory-extra-"));
    const fs = createNodeFileSystemAdapter();
    const service = createCodexTranslationService({
      fs,
      runtime: createRuntimeStub([]),
      sessionService: createTranslatorSessionService([])
    });

    const queueItem = await service.createMemoryUpdate(tmpRepo, {
      taskSlug: "demo-task",
      targetLanguage: "zh-CN"
    });
    await waitForDispatcher();
    await fs.writeText(path.join(tmpRepo, ".ai/vcm/translations/memory/report.md"), "# Extra report\n");

    await service.handleCodexHook(tmpRepo, "Stop", "demo-task");

    const state = await service.getState(tmpRepo);
    const failedItem = state.queue.items.find((item) => item.id === queueItem.id);
    expect(failedItem?.status).toBe("failed");
    expect(failedItem?.error).toContain("Unexpected translation memory artifacts");
    expect(await fs.pathExists(path.join(tmpRepo, queueItem.requestPath))).toBe(true);
  });

  it("validates conversation result files", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-codex-conversation-"));
    const fs = createNodeFileSystemAdapter();
    const service = createCodexTranslationService({ fs });
    const resultPath = ".ai/vcm/translations/runtime/conversations/demo-task/codex-translator/results/result.txt";
    await fs.writeText(path.join(tmpRepo, resultPath), "你好");

    const result = await service.validateConversationResult(tmpRepo, {
      taskSlug: "demo-task",
      resultPath,
      sourceHash: "sha256:abc",
      targetLanguage: "zh-CN"
    });

    expect(result.translatedText).toBe("你好");
    expect(result.sourceHash).toBe("sha256:abc");
    expect(result.targetLanguage).toBe("zh-CN");
  });

  it("creates conversation jobs with a temporary result file contract", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-codex-conversation-job-"));
    const fs = createNodeFileSystemAdapter();
    const service = createCodexTranslationService({ fs });

    const job = await service.createConversationJob(tmpRepo, {
      taskSlug: "demo-task",
      role: "coder",
      direction: "user-input-to-english",
      sourceText: "请检查失败的测试。",
      sourceLanguage: "auto",
      targetLanguage: "en"
    });
    const request = await fs.readJson<{ baseRepoRoot: string; outputContract: { resultPath: string; absoluteResultPath: string }; sourceText: string }>(
      path.join(tmpRepo, job.requestPath)
    );
    const state = await service.getState(tmpRepo);

    expect(job.resultPath).toContain(".ai/vcm/translations/runtime/conversations/demo-task/coder/jobs/");
    expect(request.baseRepoRoot).toBe(tmpRepo);
    expect(request.outputContract.resultPath).toBe(job.resultPath);
    expect(request.outputContract.absoluteResultPath).toBe(path.join(tmpRepo, job.resultPath));
    expect(request.sourceText).toBe("请检查失败的测试。");
    expect(job.resultPath).toMatch(/result\.txt$/);
    expect(job.reportPath).toBeUndefined();
    expect(state.queue.items[0]).toMatchObject({
      type: "conversation",
      status: "queued",
      jobId: job.id,
      expectedResultPath: job.resultPath
    });
    expect(state.queue.items[0]?.reportPath).toBeUndefined();
  });

  it("dispatches conversation translation with inline source text and file output", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-codex-conversation-inline-"));
    const fs = createNodeFileSystemAdapter();
    const writes: string[] = [];
    const service = createCodexTranslationService({
      fs,
      runtime: createRuntimeStub(writes),
      sessionService: createTranslatorSessionService([])
    });

    const job = await service.createConversationJob(tmpRepo, {
      taskSlug: "demo-task",
      role: "coder",
      direction: "user-input-to-english",
      sourceText: "请检查失败的测试。",
      sourceLanguage: "auto",
      targetLanguage: "en",
      contextText: "The user is asking a coding agent to inspect a failing test."
    });
    await waitForDispatcher();

    const prompt = writes.find((entry) => entry.includes("Translate each <VCM_TEXT> item"));
    expect(prompt).toContain("Translate each <VCM_TEXT> item from auto to en.");
    expect(prompt).toContain("Result Path:");
    expect(prompt).toContain("<VCM_TEXT1>\n请检查失败的测试。\n</VCM_TEXT1>");
    expect(prompt).toContain("<VCM_RESULT1>");
    expect(prompt).not.toContain("sourceHash");
    expect(prompt).not.toContain("CONTEXT_TEXT");
    expect(prompt).not.toContain("Result JSON contract");
  });

  it("batches queued conversation translations into one prompt and result file", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-codex-conversation-batch-"));
    const fs = createNodeFileSystemAdapter();
    const writes: string[] = [];
    const service = createCodexTranslationService({
      fs,
      runtime: createRuntimeStub(writes),
      sessionService: createTranslatorSessionService([])
    });

    const first = await service.createConversationJob(tmpRepo, {
      taskSlug: "demo-task",
      role: "coder",
      direction: "cc-output-to-user",
      sourceText: "First output.",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      deferDispatch: true
    });
    const second = await service.createConversationJob(tmpRepo, {
      taskSlug: "demo-task",
      role: "coder",
      direction: "cc-output-to-user",
      sourceText: "Second output.",
      sourceLanguage: "en",
      targetLanguage: "zh-CN"
    });
    await waitForDispatcher();

    const state = await service.getState(tmpRepo);
    const firstItem = state.queue.items.find((item) => item.id === first.queueItemId);
    const secondItem = state.queue.items.find((item) => item.id === second.queueItemId);
    const prompt = writes.find((entry) => entry.includes("Translate each <VCM_TEXT> item"));

    expect(writes.filter((entry) => entry.includes("Translate each <VCM_TEXT> item"))).toHaveLength(1);
    expect(prompt).toContain("<VCM_TEXT1>\nFirst output.\n</VCM_TEXT1>");
    expect(prompt).toContain("<VCM_TEXT2>\nSecond output.\n</VCM_TEXT2>");
    expect(firstItem?.batchId).toBeTruthy();
    expect(firstItem?.batchId).toBe(secondItem?.batchId);
    expect(firstItem?.batchIndex).toBe(1);
    expect(secondItem?.batchIndex).toBe(2);
    expect(firstItem?.batchResultPath).toBe(secondItem?.batchResultPath);

    await fs.writeText(path.join(tmpRepo, firstItem!.batchResultPath!), [
      "<VCM_RESULT1>",
      "第一段译文",
      "<VCM_RESULT2>",
      "第二段译文"
    ].join("\n"));
    await service.handleCodexHook(tmpRepo, "Stop", "demo-task");

    await expect(service.validateConversationResult(tmpRepo, {
      taskSlug: "demo-task",
      resultPath: first.resultPath,
      sourceHash: first.sourceHash,
      targetLanguage: "zh-CN"
    })).resolves.toMatchObject({ translatedText: "第一段译文" });
    await expect(service.validateConversationResult(tmpRepo, {
      taskSlug: "demo-task",
      resultPath: second.resultPath,
      sourceHash: second.sourceHash,
      targetLanguage: "zh-CN"
    })).resolves.toMatchObject({ translatedText: "第二段译文" });
    expect(await fs.pathExists(path.join(tmpRepo, firstItem!.batchResultPath!))).toBe(false);
  });

  it("browses translatable source files and filters generated state", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-codex-browser-"));
    await mkdir(path.join(tmpRepo, "docs"), { recursive: true });
    await mkdir(path.join(tmpRepo, "node_modules/pkg"), { recursive: true });
    await mkdir(path.join(tmpRepo, ".ai/vcm/translations"), { recursive: true });
    await writeFile(path.join(tmpRepo, "README.md"), "# Demo\n", "utf8");
    await writeFile(path.join(tmpRepo, "docs/whitepaper.md"), "# Whitepaper\n", "utf8");
    await writeFile(path.join(tmpRepo, "docs/logo.png"), "not text", "utf8");
    await writeFile(path.join(tmpRepo, "node_modules/pkg/README.md"), "# Dependency\n", "utf8");
    await writeFile(path.join(tmpRepo, ".ai/vcm/translations/output.md"), "# Output\n", "utf8");
    const service = createCodexTranslationService({ fs: createNodeFileSystemAdapter() });

    const root = await service.browseSourceFiles(tmpRepo);
    expect(root.entries.map((entry) => entry.path)).toEqual(["docs", "README.md"]);

    const docs = await service.browseSourceFiles(tmpRepo, { path: "docs" });
    expect(docs.entries.map((entry) => entry.path)).toEqual(["docs/whitepaper.md"]);
    expect(docs.parentPath).toBe("");

    const searched = await service.browseSourceFiles(tmpRepo, { query: "white" });
    expect(searched.entries.map((entry) => entry.path)).toEqual(["docs/whitepaper.md"]);
  });

  it("refuses to promote over the source file", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-codex-promote-"));
    await writeFile(path.join(tmpRepo, "README.md"), "# Demo\n", "utf8");
    const fs = createNodeFileSystemAdapter();
    const service = createCodexTranslationService({ fs });
    const job = await service.createFileJob(tmpRepo, {
      sourcePath: "README.md",
      targetLanguage: "zh-CN"
    });
    const indexPath = path.join(tmpRepo, ".ai/vcm/translations/files/index.json");
    const index = await fs.readJson<{ jobs: Array<typeof job> }>(indexPath);
    index.jobs[0] = { ...index.jobs[0], status: "completed" };
    await fs.writeJsonAtomic(indexPath, index);
    await fs.writeText(path.join(tmpRepo, job.resultPath), "# Demo translated\n");
    await service.getState(tmpRepo);

    await expect(service.promoteFileJob(tmpRepo, job.id, "README.md"))
      .rejects.toMatchObject({
        code: "TRANSLATION_PROMOTE_SOURCE_OVERWRITE"
      });
  });

  it("retranslates files through the normal translate flow and replaces completed output", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-codex-retranslate-"));
    await writeFile(path.join(tmpRepo, "README.md"), "# Demo\n\nHello project.\n", "utf8");
    const fs = createNodeFileSystemAdapter();
    const writes: string[] = [];
    const service = createCodexTranslationService({
      fs,
      runtime: createRuntimeStub(writes),
      sessionService: createTranslatorSessionService([])
    });

    const first = await service.createFileJob(tmpRepo, {
      taskSlug: "demo-task",
      sourcePath: "README.md",
      targetLanguage: "zh-CN"
    });
    await waitForDispatcher();
    await fs.writeText(path.join(tmpRepo, first.resultPath), "# 旧译文\n");
    await service.handleCodexHook(tmpRepo, "Stop", "demo-task");

    let state = await service.getState(tmpRepo);
    const firstCompleted = state.fileIndex.jobs.find((job) => job.id === first.id);
    expect(firstCompleted?.status).toBe("completed");
    expect(firstCompleted?.resultPath).toContain(".ai/vcm/translations/files/completed/");
    expect(await fs.readText(path.join(tmpRepo, firstCompleted!.resultPath))).toBe("# 旧译文\n");

    await writeFile(path.join(tmpRepo, "README.md"), "# Demo\n\nHello updated project.\n", "utf8");
    const second = await service.createFileJob(tmpRepo, {
      taskSlug: "demo-task",
      sourcePath: "README.md",
      targetLanguage: "zh-CN"
    });
    expect(second.id).not.toBe(first.id);
    await waitForCondition(async () => {
      const nextState = await service.getState(tmpRepo!);
      return nextState.queue.activeItemId === second.queueItemId &&
        nextState.fileIndex.jobs.find((job) => job.id === second.id)?.status === "running";
    });

    await fs.writeText(path.join(tmpRepo, second.resultPath), "# 新译文\n");
    await service.handleCodexHook(tmpRepo, "Stop", "demo-task");
    state = await service.getState(tmpRepo);

    const completedJobs = state.fileIndex.jobs.filter((job) =>
      job.sourcePath === "README.md" &&
      job.targetLanguage === "zh-CN" &&
      job.translationProfile === "default" &&
      job.status === "completed"
    );
    expect(completedJobs.map((job) => job.id)).toEqual([second.id]);
    expect(completedJobs[0]?.resultPath).toBe(firstCompleted?.resultPath);
    expect(await fs.readText(path.join(tmpRepo, completedJobs[0]!.resultPath))).toBe("# 新译文\n");
    expect(state.fileIndex.jobs.some((job) => job.id === first.id)).toBe(false);
    expect(state.queue.items.some((item) => item.id === first.queueItemId || item.id === second.queueItemId)).toBe(false);
  });

  it("keeps the queue single-threaded and dispatches the next item after Stop", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-codex-queue-"));
    await writeFile(path.join(tmpRepo, "README.md"), "# Demo\n", "utf8");
    await writeFile(path.join(tmpRepo, "GUIDE.md"), "# Guide\n", "utf8");
    const fs = createNodeFileSystemAdapter();
    const writes: string[] = [];
    const starts: string[] = [];
    const service = createCodexTranslationService({
      fs,
      runtime: createRuntimeStub(writes),
      sessionService: createTranslatorSessionService(starts)
    });

    const first = await service.createFileJob(tmpRepo, {
      taskSlug: "demo-task",
      sourcePath: "README.md",
      targetLanguage: "zh-CN"
    });
    await waitForDispatcher();
    const second = await service.createFileJob(tmpRepo, {
      taskSlug: "demo-task",
      sourcePath: "GUIDE.md",
      targetLanguage: "zh-CN"
    });
    await waitForCondition(async () => {
      const queuedState = await service.getState(tmpRepo!);
      return queuedState.queue.activeItemId === first.queueItemId &&
        queuedState.fileIndex.jobs.find((job) => job.id === first.id)?.status === "running" &&
        queuedState.fileIndex.jobs.find((job) => job.id === second.id)?.status === "queued" &&
        writes.filter((entry) => entry.includes("[VCM CODEX TRANSLATION TASK]")).length === 1;
    });

    let state = await service.getState(tmpRepo);
    expect(state.queue.activeItemId).toBe(first.queueItemId);
    expect(state.fileIndex.jobs.find((job) => job.id === first.id)?.status).toBe("running");
    expect(state.fileIndex.jobs.find((job) => job.id === second.id)?.status).toBe("queued");
    expect(writes.filter((entry) => entry.includes("[VCM CODEX TRANSLATION TASK]"))).toHaveLength(1);
    expect(writes[0]).toContain(`Base Repository Root: ${tmpRepo}`);
    expect(writes[0]).toContain(path.join(tmpRepo, first.requestPath));
    expect(writes[0]).toContain(path.join(tmpRepo, first.resultPath));
    expect(writes[0]).toContain("Do not use apply_patch");

    await fs.writeText(path.join(tmpRepo, first.resultPath), "# Demo translated\n");
    await service.handleCodexHook(tmpRepo, "Stop", "demo-task");
    await waitForCondition(async () => {
      const nextState = await service.getState(tmpRepo!);
      return nextState.queue.activeItemId === second.queueItemId &&
        nextState.fileIndex.jobs.find((job) => job.id === first.id)?.status === "completed" &&
        nextState.fileIndex.jobs.find((job) => job.id === second.id)?.status === "running" &&
        writes.filter((entry) => entry.includes("[VCM CODEX TRANSLATION TASK]")).length === 2;
    });

    state = await service.getState(tmpRepo);
    const completedFirst = state.fileIndex.jobs.find((job) => job.id === first.id);
    expect(state.queue.activeItemId).toBe(second.queueItemId);
    expect(completedFirst?.status).toBe("completed");
    expect(completedFirst?.resultPath).toContain(".ai/vcm/translations/files/completed/");
    expect(await fs.pathExists(path.join(tmpRepo, completedFirst!.resultPath))).toBe(true);
    expect(await fs.pathExists(path.join(tmpRepo, first.requestPath))).toBe(false);
    expect(await fs.pathExists(path.join(tmpRepo, first.progressPath))).toBe(false);
    expect(await fs.pathExists(path.join(tmpRepo, first.reportPath))).toBe(false);
    expect(state.queue.items.some((item) => item.id === first.queueItemId)).toBe(false);
    expect(state.fileIndex.jobs.find((job) => job.id === second.id)?.status).toBe("running");
    expect(starts).toEqual(["start:codex-translator:gpt-5.5:medium"]);
    expect(writes.filter((entry) => entry.includes("[VCM CODEX TRANSLATION TASK]"))).toHaveLength(2);
  });
});

function createRuntimeStub(writes: string[]): TerminalRuntime {
  return {
    async createSession() {
      throw new Error("not used");
    },
    getSession(sessionId) {
      return sessionId === "translator-session"
        ? {
            id: "translator-session",
            taskSlug: "demo-task",
            role: "codex-translator",
            status: "running",
            startedAt: "2026-06-20T00:00:00.000Z",
            exitCode: null
          }
        : undefined;
    },
    getSessionByRole() {
      return undefined;
    },
    listSessions() {
      return [];
    },
    write(_sessionId, data) {
      writes.push(data);
    },
    resize() {},
    async stop() {},
    async restart() {
      throw new Error("not used");
    },
    subscribe() {
      return () => {};
    }
  };
}

function createTranslatorSessionService(starts: string[]): Pick<SessionService, "getRoleSession" | "resumeRoleSession" | "startRoleSession"> {
  let session: RoleSessionRecord | undefined;
  const createSession = (): RoleSessionRecord => ({
    id: "translator-session",
    claudeSessionId: "codex-translator-session",
    taskSlug: "demo-task",
    role: "codex-translator",
    status: "running",
    activityStatus: "running",
    command: "codex",
    permissionMode: "default",
    model: "gpt-5.5",
    effort: "medium",
    cwd: "/repo/.ai/codex-translator",
    terminalBackend: "node-pty",
    logPath: ".ai/vcm/handoffs/logs/codex-translator.log",
    updatedAt: "2026-06-20T00:00:00.000Z"
  });
  return {
    async getRoleSession() {
      return session;
    },
    async resumeRoleSession(_repoRoot, _taskSlug, _role, input = {}) {
      starts.push(`resume:codex-translator:${input.model ?? "default"}:${input.effort ?? "default"}`);
      session = {
        ...createSession(),
        model: input.model ?? "gpt-5.5",
        effort: input.effort ?? "medium"
      };
      return session;
    },
    async startRoleSession(_repoRoot, _taskSlug, _role, input = {}) {
      starts.push(`start:codex-translator:${input.model ?? "default"}:${input.effort ?? "default"}`);
      session = {
        ...createSession(),
        model: input.model ?? "gpt-5.5",
        effort: input.effort ?? "medium"
      };
      return session;
    }
  };
}

function waitForDispatcher(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 90));
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for Codex translation dispatcher.");
}
