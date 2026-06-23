import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter, type FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import type { TerminalRuntime } from "../../../src/backend/runtime/terminal-runtime.js";
import { createTranslationWorkerService } from "../../../src/backend/services/translation-worker-service.js";
import type { SessionService } from "../../../src/backend/services/session-service.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";

let tmpRepo: string | undefined;

afterEach(async () => {
  if (tmpRepo) {
    await rm(tmpRepo, { recursive: true, force: true });
    tmpRepo = undefined;
  }
});

describe("translator-translation-service", () => {
  it("creates project translation layout, file jobs, and queue items", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-translator-translation-"));
    await writeFile(path.join(tmpRepo, "README.md"), "# Demo\n\nHello project.\n", "utf8");
    const fs = createNodeFileSystemAdapter();
    const service = createTranslationWorkerService({ fs });

    const job = await service.createFileJob(tmpRepo, {
      taskSlug: "demo-task",
      sourcePath: "README.md",
      targetLanguage: "zh-CN"
    });
    const request = await fs.readJson<{
      baseRepoRoot: string;
      absolutePaths: { sourcePath: string; resultPath: string; finalResultPath: string };
      outputContract: { stagingResultPath: string; finalResultPath: string };
      chunking: { strategy: string; chunkCount: number };
      chunks: Array<{ index: number; sourcePath: string; translatedPath: string; sourceHash: string }>;
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
    expect(request.chunking).toMatchObject({ strategy: "line-boundary", chunkCount: 1 });
    expect(request.chunks).toHaveLength(1);
    expect(request.chunks[0]).toMatchObject({
      index: 1,
      sourcePath: expect.stringContaining("/chunks/0001.source.md"),
      translatedPath: expect.stringContaining("/chunks/0001.translated.md")
    });
    expect(await fs.readText(path.join(tmpRepo, request.chunks[0]!.sourcePath))).toBe("# Demo\n\nHello project.\n");
    expect(job.resultPath).toContain(".ai/vcm/translations/runtime/files/jobs/");
    expect(state.queue.items).toHaveLength(1);
    expect(state.queue.items[0]).toMatchObject({
      type: "file",
      status: "queued",
      jobId: job.id,
      expectedResultPath: job.resultPath
    });
    expect(state.fileIndex.jobs[0]?.id).toBe(job.id);
    await expect(fs.pathExists(path.join(tmpRepo, ".ai/vcm/translations/files/index.json"))).resolves.toBe(false);
  });

  it("cleans translation runtime state without removing durable translations or memory", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-translator-translation-startup-clean-"));
    await mkdir(path.join(tmpRepo, ".ai/vcm/translations/runtime/files/jobs/job-1/chunks"), { recursive: true });
    await mkdir(path.join(tmpRepo, ".ai/vcm/translations/runtime/conversations/jobs/job-2"), { recursive: true });
    await mkdir(path.join(tmpRepo, ".ai/vcm/translations/runtime/bootstrap/runs/run-1"), { recursive: true });
    await mkdir(path.join(tmpRepo, ".ai/vcm/translations/runtime/memory-updates/run-2"), { recursive: true });
    await mkdir(path.join(tmpRepo, ".ai/vcm/translations/files/completed"), { recursive: true });
    await mkdir(path.join(tmpRepo, ".ai/vcm/translations/memory"), { recursive: true });
    await writeFile(path.join(tmpRepo, ".ai/vcm/translations/runtime/queue.json"), "{}\n", "utf8");
    await writeFile(path.join(tmpRepo, ".ai/vcm/translations/runtime/files/jobs/job-1/request.json"), "{}\n", "utf8");
    await writeFile(path.join(tmpRepo, ".ai/vcm/translations/session.json"), "{}\n", "utf8");
    await writeFile(path.join(tmpRepo, ".ai/vcm/translations/files/completed/readme-zh-cn-default.md"), "# 译文\n", "utf8");
    await writeFile(path.join(tmpRepo, ".ai/vcm/translations/files/index.json"), `${JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      jobs: [
        createFileJobRecord("completed-job", "completed", ".ai/vcm/translations/files/completed/readme-zh-cn-default.md"),
        createFileJobRecord("running-job", "running", ".ai/vcm/translations/runtime/files/jobs/job-1/output.md"),
        createFileJobRecord("failed-job", "failed", ".ai/vcm/translations/runtime/files/jobs/job-2/output.md")
      ]
    })}\n`, "utf8");
    await mkdir(path.join(tmpRepo, ".ai/vcm/translations/bootstrap"), { recursive: true });
    await writeFile(path.join(tmpRepo, ".ai/vcm/translations/bootstrap/index.json"), `${JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      runs: [
        createBootstrapRunRecord("completed-bootstrap", "completed"),
        createBootstrapRunRecord("queued-bootstrap", "queued")
      ]
    })}\n`, "utf8");
    await writeFile(path.join(tmpRepo, ".ai/vcm/translations/memory/glossary.md"), "# Glossary\n", "utf8");
    const fs = createNodeFileSystemAdapter();
    const service = createTranslationWorkerService({ fs });

    await service.cleanupStartupRuntime(tmpRepo);
    const fileIndex = await fs.readJson<{ jobs: Array<{ id: string }> }>(path.join(tmpRepo, ".ai/vcm/translations/files/index.json"));
    const bootstrapIndex = await fs.readJson<{ runs: Array<{ id: string }> }>(path.join(tmpRepo, ".ai/vcm/translations/bootstrap/index.json"));

    await expect(fs.pathExists(path.join(tmpRepo, ".ai/vcm/translations/runtime"))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(tmpRepo, ".ai/vcm/translations/session.json"))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(tmpRepo, ".ai/vcm/translations/files/completed/readme-zh-cn-default.md"))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(tmpRepo, ".ai/vcm/translations/files/index.json"))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(tmpRepo, ".ai/vcm/translations/memory/glossary.md"))).resolves.toBe(true);
    expect(fileIndex.jobs.map((job) => job.id)).toEqual(["completed-job"]);
    expect(bootstrapIndex.runs.map((run) => run.id)).toEqual(["completed-bootstrap"]);
  });

  it("splits large file translation sources into VCM-managed chunk files", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-translator-translation-chunks-"));
    const source = Array.from({ length: 120 }, (_, index) => `## Section ${index + 1}\n\n${"Long sentence. ".repeat(12)}\n`).join("\n");
    await writeFile(path.join(tmpRepo, "WHITEPAPER.md"), source, "utf8");
    const fs = createNodeFileSystemAdapter();
    const service = createTranslationWorkerService({ fs });

    const job = await service.createFileJob(tmpRepo, {
      taskSlug: "demo-task",
      sourcePath: "WHITEPAPER.md",
      targetLanguage: "zh-CN",
      chunkSourceTokenTarget: 1000
    });
    const request = await fs.readJson<{
      sourceText?: string;
      chunking: { chunkCount: number };
      chunks: Array<{ index: number; sourcePath: string; translatedPath: string; sourceBytes: number }>;
    }>(path.join(tmpRepo, job.requestPath));

    expect(request.sourceText).toBeUndefined();
    expect(request.chunking.chunkCount).toBeGreaterThan(1);
    expect(request.chunks.length).toBe(request.chunking.chunkCount);
    expect(request.chunks[0]?.index).toBe(1);
    expect(request.chunks[0]?.translatedPath).toContain("/chunks/0001.translated.md");
    expect(await fs.readText(path.join(tmpRepo, request.chunks[0]!.sourcePath))).toContain("## Section 1");
    expect(request.chunks.every((chunk) => chunk.sourceBytes > 0)).toBe(true);
  });

  it("creates bootstrap runs and memory files", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-translator-bootstrap-"));
    await writeFile(path.join(tmpRepo, "README.md"), "# Demo\n", "utf8");
    const fs = createNodeFileSystemAdapter();
    const service = createTranslationWorkerService({ fs });

    const run = await service.createBootstrapRun(tmpRepo, {
      taskSlug: "demo-task",
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

  it("queues compact memory updates through the Translator session", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-translator-memory-update-"));
    const fs = createNodeFileSystemAdapter();
    const writes: string[] = [];
    const service = createTranslationWorkerService({
      fs,
      runtime: createRuntimeStub(writes),
      sessionService: createTranslatorSessionService([])
    });

    const queueItem = await service.createMemoryUpdate(tmpRepo, {
      taskSlug: "demo-task",
      targetLanguage: "zh-CN"
    });
    await waitForDispatcher();
    await waitForCondition(async () => {
      const nextState = await service.getState(tmpRepo!);
      const nextItem = nextState.queue.items.find((item) => item.id === queueItem.id);
      return nextState.queue.activeItemId === queueItem.id && nextItem?.status === "running";
    });

    const request = await fs.readJson<{
      memoryBudget: { totalLimitBytes: number; currentTotalBytes: number };
      allowedWrites: string[];
      absolutePaths: { memoryFiles: Record<string, string> };
    }>(path.join(tmpRepo, queueItem.requestPath));
    let state = await service.getState(tmpRepo);
    const activeItem = state.queue.items.find((item) => item.id === queueItem.id);
    const prompt = writes.find((entry) => entry.includes("[VCM TRANSLATION TASK]"));

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

    await service.handleTranslatorHook(tmpRepo, "Stop", "demo-task");
    await waitForDispatcher();

    state = await service.getState(tmpRepo);
    expect(state.queue.activeItemId).toBeUndefined();
    expect(state.queue.items.some((item) => item.id === queueItem.id)).toBe(false);
    expect(await fs.pathExists(path.join(tmpRepo, queueItem.requestPath))).toBe(false);
  });

  it("fails memory updates that leave non-core memory artifacts", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-translator-memory-extra-"));
    const fs = createNodeFileSystemAdapter();
    const service = createTranslationWorkerService({
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

    await service.handleTranslatorHook(tmpRepo, "Stop", "demo-task");

    const state = await service.getState(tmpRepo);
    const failedItem = state.queue.items.find((item) => item.id === queueItem.id);
    expect(failedItem?.status).toBe("failed");
    expect(failedItem?.error).toContain("Unexpected translation memory artifacts");
    expect(await fs.pathExists(path.join(tmpRepo, queueItem.requestPath))).toBe(true);
  });

  it("validates conversation result files", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-translator-conversation-"));
    const fs = createNodeFileSystemAdapter();
    const service = createTranslationWorkerService({ fs });
    const resultPath = ".ai/vcm/translations/runtime/conversations/jobs/result/result.txt";
    await fs.writeText(path.join(tmpRepo, resultPath), "你好");

    const result = await service.validateConversationResult(tmpRepo, {
      resultPath,
      sourceHash: "sha256:abc",
      targetLanguage: "zh-CN"
    });

    expect(result.translatedText).toBe("你好");
    expect(result.sourceHash).toBe("sha256:abc");
    expect(result.targetLanguage).toBe("zh-CN");
  });

  it("creates conversation jobs with a temporary result file contract", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-translator-conversation-job-"));
    const fs = createNodeFileSystemAdapter();
    const service = createTranslationWorkerService({ fs });

    const job = await service.createConversationJob(tmpRepo, {
      taskSlug: "demo-task",
      direction: "user-input-to-english",
      sourceText: "请检查失败的测试。",
      sourceLanguage: "auto",
      targetLanguage: "en"
    });
    const request = await fs.readJson<{
      baseRepoRoot: string;
      outputContract: { resultPath: string; absoluteResultPath: string };
      sourceText: string;
      taskSlug?: string;
      role?: string;
      job?: unknown;
      contextText?: string;
      sourceHash?: string;
    }>(
      path.join(tmpRepo, job.requestPath)
    );
    const state = await service.getState(tmpRepo);

    expect(job.resultPath).toContain(".ai/vcm/translations/runtime/conversations/jobs/");
    expect(request.baseRepoRoot).toBe(tmpRepo);
    expect(request.outputContract.resultPath).toBe(job.resultPath);
    expect(request.outputContract.absoluteResultPath).toBe(path.join(tmpRepo, job.resultPath));
    expect(request.sourceText).toBe("请检查失败的测试。");
    expect(request.taskSlug).toBeUndefined();
    expect(request.role).toBeUndefined();
    expect(request.job).toBeUndefined();
    expect(request.contextText).toBeUndefined();
    expect(request.sourceHash).toBeUndefined();
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
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-translator-conversation-inline-"));
    const fs = createNodeFileSystemAdapter();
    const writes: string[] = [];
    const service = createTranslationWorkerService({
      fs,
      runtime: createRuntimeStub(writes),
      sessionService: createTranslatorSessionService([])
    });

    const job = await service.createConversationJob(tmpRepo, {
      taskSlug: "demo-task",
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
    expect(prompt).not.toContain("Do not use apply_patch");
    expect(prompt).not.toContain("Do not delegate");
    expect(prompt).not.toContain("diagnostics");
  });

  it("batches queued conversation translations into one prompt and result file", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-translator-conversation-batch-"));
    const fs = createNodeFileSystemAdapter();
    const writes: string[] = [];
    const service = createTranslationWorkerService({
      fs,
      runtime: createRuntimeStub(writes),
      sessionService: createTranslatorSessionService([])
    });

    const first = await service.createConversationJob(tmpRepo, {
      taskSlug: "demo-task",
      direction: "cc-output-to-user",
      sourceText: "First output.",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      deferDispatch: true
    });
    const second = await service.createConversationJob(tmpRepo, {
      taskSlug: "demo-task",
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
    await service.handleTranslatorHook(tmpRepo, "Stop", "demo-task");

    const internalState = await service.getState(tmpRepo);
    const publicState = await service.getState(tmpRepo, { visibility: "public" });
    expect(internalState.queue.items.filter((item) => item.type === "conversation")).toHaveLength(2);
    expect(publicState.queue.items.filter((item) => item.type === "conversation")).toHaveLength(0);
    expect(publicState.queue.activeItemId).toBeUndefined();

    await expect(service.validateConversationResult(tmpRepo, {
      resultPath: first.resultPath,
      sourceHash: first.sourceHash,
      targetLanguage: "zh-CN"
    })).resolves.toMatchObject({ translatedText: "第一段译文" });
    await expect(service.validateConversationResult(tmpRepo, {
      resultPath: second.resultPath,
      sourceHash: second.sourceHash,
      targetLanguage: "zh-CN"
    })).resolves.toMatchObject({ translatedText: "第二段译文" });
    expect(await fs.pathExists(path.join(tmpRepo, firstItem!.batchResultPath!))).toBe(false);
  });

  it("browses translatable source files and filters generated state", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-translator-browser-"));
    await mkdir(path.join(tmpRepo, "docs"), { recursive: true });
    await mkdir(path.join(tmpRepo, "node_modules/pkg"), { recursive: true });
    await mkdir(path.join(tmpRepo, ".ai/vcm/translations"), { recursive: true });
    await writeFile(path.join(tmpRepo, "README.md"), "# Demo\n", "utf8");
    await writeFile(path.join(tmpRepo, "docs/whitepaper.md"), "# Whitepaper\n", "utf8");
    await writeFile(path.join(tmpRepo, "docs/logo.png"), "not text", "utf8");
    await writeFile(path.join(tmpRepo, "node_modules/pkg/README.md"), "# Dependency\n", "utf8");
    await writeFile(path.join(tmpRepo, ".ai/vcm/translations/output.md"), "# Output\n", "utf8");
    const service = createTranslationWorkerService({ fs: createNodeFileSystemAdapter() });

    const root = await service.browseSourceFiles(tmpRepo);
    expect(root.entries.map((entry) => entry.path)).toEqual(["docs", "README.md"]);

    const docs = await service.browseSourceFiles(tmpRepo, { path: "docs" });
    expect(docs.entries.map((entry) => entry.path)).toEqual(["docs/whitepaper.md"]);
    expect(docs.parentPath).toBe("");

    const searched = await service.browseSourceFiles(tmpRepo, { query: "white" });
    expect(searched.entries.map((entry) => entry.path)).toEqual(["docs/whitepaper.md"]);
  });

  it("refuses to promote over the source file", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-translator-promote-"));
    await writeFile(path.join(tmpRepo, "README.md"), "# Demo\n", "utf8");
    const fs = createNodeFileSystemAdapter();
    const service = createTranslationWorkerService({
      fs,
      runtime: createRuntimeStub([]),
      sessionService: createTranslatorSessionService([])
    });
    const job = await service.createFileJob(tmpRepo, {
      taskSlug: "demo-task",
      sourcePath: "README.md",
      targetLanguage: "zh-CN"
    });
    await waitForDispatcher();
    await writeCompletedFileTranslation(fs, tmpRepo, job, "# Demo translated\n");
    await service.handleTranslatorHook(tmpRepo, "Stop", "demo-task");

    await expect(service.promoteFileJob(tmpRepo, job.id, "README.md"))
      .rejects.toMatchObject({
        code: "TRANSLATION_PROMOTE_SOURCE_OVERWRITE"
      });
  });

  it("retranslates files through the normal translate flow and replaces completed output", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-translator-retranslate-"));
    await writeFile(path.join(tmpRepo, "README.md"), "# Demo\n\nHello project.\n", "utf8");
    const fs = createNodeFileSystemAdapter();
    const writes: string[] = [];
    const service = createTranslationWorkerService({
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
    await writeCompletedFileTranslation(fs, tmpRepo, first, "# 旧译文\n");
    await service.handleTranslatorHook(tmpRepo, "Stop", "demo-task");

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
    const duplicateWhileRunning = await service.createFileJob(tmpRepo, {
      taskSlug: "demo-task",
      sourcePath: "README.md",
      targetLanguage: "zh-CN"
    });
    expect(duplicateWhileRunning.id).toBe(second.id);
    await waitForCondition(async () => {
      const nextState = await service.getState(tmpRepo!);
      return nextState.queue.activeItemId === second.queueItemId &&
        nextState.fileIndex.jobs.find((job) => job.id === second.id)?.status === "running";
    });

    state = await service.getState(tmpRepo);
    const visibleJobsDuringRetranslate = state.fileIndex.jobs.filter((job) =>
      job.sourcePath === "README.md" &&
      job.targetLanguage === "zh-CN" &&
      job.translationProfile === "default"
    );
    expect(visibleJobsDuringRetranslate.map((job) => job.id)).toEqual([second.id]);
    expect(state.queue.items.filter((item) => item.jobId === second.id)).toHaveLength(1);
    const durableIndexDuringRetranslate = await fs.readJson<{ jobs: Array<{ id: string }> }>(
      path.join(tmpRepo, ".ai/vcm/translations/files/index.json")
    );
    expect(durableIndexDuringRetranslate.jobs.map((job) => job.id)).toEqual([first.id]);

    await writeCompletedFileTranslation(fs, tmpRepo, second, "# 新译文\n");
    await service.handleTranslatorHook(tmpRepo, "Stop", "demo-task");
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
    const durableIndexAfterRetranslate = await fs.readJson<{ jobs: Array<{ id: string }> }>(
      path.join(tmpRepo, ".ai/vcm/translations/files/index.json")
    );
    expect(durableIndexAfterRetranslate.jobs.map((job) => job.id)).toEqual([second.id]);
  });

  it("fails file translations that only write empty output and diagnostics", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-translator-empty-output-"));
    await writeFile(path.join(tmpRepo, "README.md"), "# Demo\n\nHello project.\n", "utf8");
    const fs = createNodeFileSystemAdapter();
    const service = createTranslationWorkerService({
      fs,
      runtime: createRuntimeStub([]),
      sessionService: createTranslatorSessionService([])
    });

    const job = await service.createFileJob(tmpRepo, {
      taskSlug: "demo-task",
      sourcePath: "README.md",
      targetLanguage: "zh-CN"
    });
    await waitForDispatcher();
    await fs.writeText(path.join(tmpRepo, job.resultPath), "");
    await fs.writeText(path.join(tmpRepo, job.reportPath), "# Translation Diagnostics\n\nStatus: blocked\nReason: not enough context.\n");

    await service.handleTranslatorHook(tmpRepo, "Stop", "demo-task");

    const state = await service.getState(tmpRepo);
    const failedJob = state.fileIndex.jobs.find((candidate) => candidate.id === job.id);
    const failedQueueItem = state.queue.items.find((item) => item.id === job.queueItemId);
    expect(failedJob?.status).toBe("failed");
    expect(failedQueueItem?.status).toBe("failed");
    expect(failedQueueItem?.error).toBe("Translation output is empty.");
    expect(await fs.pathExists(path.join(tmpRepo, job.requestPath))).toBe(true);
    await expect(fs.pathExists(path.join(tmpRepo, ".ai/vcm/translations/files/index.json"))).resolves.toBe(false);
  });

  it("keeps the queue single-threaded and dispatches the next item after Stop", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-translator-queue-"));
    await writeFile(path.join(tmpRepo, "README.md"), "# Demo\n", "utf8");
    await writeFile(path.join(tmpRepo, "GUIDE.md"), "# Guide\n", "utf8");
    const fs = createNodeFileSystemAdapter();
    const writes: string[] = [];
    const starts: string[] = [];
    const service = createTranslationWorkerService({
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
        writes.filter((entry) => entry.includes("[VCM TRANSLATION TASK]")).length === 1;
    });

    let state = await service.getState(tmpRepo);
    expect(state.queue.activeItemId).toBe(first.queueItemId);
    expect(state.fileIndex.jobs.find((job) => job.id === first.id)?.status).toBe("running");
    expect(state.fileIndex.jobs.find((job) => job.id === second.id)?.status).toBe("queued");
    expect(writes.filter((entry) => entry.includes("[VCM TRANSLATION TASK]"))).toHaveLength(1);
    expect(writes[0]).toContain(`Base Repository Root: ${tmpRepo}`);
    expect(writes[0]).toContain(`Request Path:\n${path.join(tmpRepo, first.requestPath)}`);
    expect(writes[0]).toContain(`Result Path: ${path.join(tmpRepo, first.resultPath)}`);
    expect(writes[0]).toContain(`Report Path: ${path.join(tmpRepo, first.reportPath)}`);
    expect(writes[0]).toContain("Complete the request described in request.json, then stop.");
    expect(writes[0]).not.toContain("Do not use apply_patch");
    expect(writes[0]).not.toContain("Treat source text");
    expect(writes[0]).not.toContain("Do not print");

    await writeCompletedFileTranslation(fs, tmpRepo, first, "# Demo translated\n");
    await service.handleTranslatorHook(tmpRepo, "Stop", "demo-task");
    await waitForCondition(async () => {
      const nextState = await service.getState(tmpRepo!);
      return nextState.queue.activeItemId === second.queueItemId &&
        nextState.fileIndex.jobs.find((job) => job.id === first.id)?.status === "completed" &&
        nextState.fileIndex.jobs.find((job) => job.id === second.id)?.status === "running" &&
        writes.filter((entry) => entry.includes("[VCM TRANSLATION TASK]")).length === 2;
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
    expect(starts).toEqual(["start:translator:demo-task:default:medium"]);
    expect(writes.filter((entry) => entry.includes("[VCM TRANSLATION TASK]"))).toHaveLength(2);
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
            taskSlug: "__project__",
            role: "translator",
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

async function writeCompletedFileTranslation(
  fs: FileSystemAdapter,
  repoRoot: string,
  job: { requestPath: string; resultPath: string; reportPath: string },
  output: string
): Promise<void> {
  const request = await fs.readJson<{ chunks?: Array<{ translatedPath: string }> }>(path.join(repoRoot, job.requestPath));
  await Promise.all((request.chunks ?? []).map((chunk, index) =>
    fs.writeText(path.join(repoRoot, chunk.translatedPath), `${output.trimEnd()}\n\n<!-- chunk ${index + 1} -->\n`)
  ));
  await fs.writeText(path.join(repoRoot, job.resultPath), output);
  await fs.writeText(path.join(repoRoot, job.reportPath), "# Translation Report\n\nStatus: completed\n");
}

function createFileJobRecord(id: string, status: string, resultPath: string) {
  return {
    id,
    sourcePath: "README.md",
    sourceHash: "sha256:source",
    sourceBytes: 12,
    targetLanguage: "zh-CN",
    translationProfile: "default",
    chunkSourceTokenTarget: 80000,
    dedupeKey: id,
    status,
    requestPath: `.ai/vcm/translations/runtime/files/jobs/${id}/request.json`,
    progressPath: `.ai/vcm/translations/runtime/files/jobs/${id}/progress.json`,
    resultPath,
    reportPath: `.ai/vcm/translations/runtime/files/jobs/${id}/report.md`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function createBootstrapRunRecord(id: string, status: string) {
  return {
    id,
    status,
    targetLanguage: "zh-CN",
    candidatePaths: ["README.md"],
    requestPath: `.ai/vcm/translations/runtime/bootstrap/runs/${id}/request.json`,
    reportPath: `.ai/vcm/translations/runtime/bootstrap/runs/${id}/report.md`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function createTranslatorSessionService(starts: string[]): Pick<SessionService, "ensureProjectTranslatorSession"> {
  let session: RoleSessionRecord | undefined;
  const createSession = (): RoleSessionRecord => ({
    id: "translator-session",
    claudeSessionId: "translator-session",
    taskSlug: "__project__",
    role: "translator",
    status: "running",
    activityStatus: "running",
    command: "translator",
    permissionMode: "default",
    model: "gpt-5.5",
    effort: "medium",
    cwd: "/repo",
    terminalBackend: "node-pty",
    updatedAt: "2026-06-20T00:00:00.000Z"
  });
  return {
    async ensureProjectTranslatorSession(_repoRoot, input = {}) {
      if (session) {
        return session;
      }
      starts.push(`start:translator:${input.taskSlug ?? "missing"}:${input.model ?? "default"}:${input.effort ?? "default"}`);
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
  throw new Error("Timed out waiting for translation dispatcher.");
}
