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
    const request = await fs.readJson<{ baseRepoRoot: string; absolutePaths: { sourcePath: string; resultPath: string } }>(
      path.join(tmpRepo, job.requestPath)
    );
    const state = await service.getState(tmpRepo);

    expect(job.status).toBe("queued");
    expect(request.baseRepoRoot).toBe(tmpRepo);
    expect(request.absolutePaths.sourcePath).toBe(path.join(tmpRepo, "README.md"));
    expect(request.absolutePaths.resultPath).toBe(path.join(tmpRepo, job.resultPath));
    expect(job.resultPath).toContain(".ai/vcm/translations/files/jobs/");
    expect(state.queue.items).toHaveLength(1);
    expect(state.queue.items[0]).toMatchObject({
      type: "file",
      status: "queued",
      jobId: job.id,
      expectedResultPath: job.resultPath
    });
    expect(state.fileIndex.jobs[0]?.id).toBe(job.id);
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

  it("validates conversation result files", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-codex-conversation-"));
    const fs = createNodeFileSystemAdapter();
    const service = createCodexTranslationService({ fs });
    const resultPath = ".ai/vcm/translations/conversations/demo-task/codex-translator/results/result.json";
    await fs.writeJson(path.join(tmpRepo, resultPath), {
      version: 1,
      id: "result",
      status: "completed",
      sourceHash: "sha256:abc",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      translatedText: "你好",
      notes: []
    });

    const result = await service.validateConversationResult(tmpRepo, {
      taskSlug: "demo-task",
      resultPath,
      sourceHash: "sha256:abc",
      targetLanguage: "zh-CN"
    });

    expect(result.translatedText).toBe("你好");
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

    expect(job.resultPath).toContain(".ai/vcm/translations/conversations/demo-task/coder/jobs/");
    expect(request.baseRepoRoot).toBe(tmpRepo);
    expect(request.outputContract.resultPath).toBe(job.resultPath);
    expect(request.outputContract.absoluteResultPath).toBe(path.join(tmpRepo, job.resultPath));
    expect(request.sourceText).toBe("请检查失败的测试。");
    expect(state.queue.items[0]).toMatchObject({
      type: "conversation",
      status: "queued",
      jobId: job.id,
      expectedResultPath: job.resultPath
    });
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

    await expect(service.promoteFileJob(tmpRepo, job.id, "README.md"))
      .rejects.toMatchObject({
        code: "TRANSLATION_PROMOTE_SOURCE_OVERWRITE"
      });
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
    await waitForDispatcher();

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
    await waitForDispatcher();

    state = await service.getState(tmpRepo);
    expect(state.queue.activeItemId).toBe(second.queueItemId);
    expect(state.fileIndex.jobs.find((job) => job.id === first.id)?.status).toBe("completed");
    expect(state.fileIndex.jobs.find((job) => job.id === second.id)?.status).toBe("running");
    expect(starts).toEqual(["start:codex-translator"]);
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
    effort: "xhigh",
    cwd: "/repo/.ai/codex-translator",
    terminalBackend: "node-pty",
    logPath: ".ai/vcm/handoffs/logs/codex-translator.log",
    updatedAt: "2026-06-20T00:00:00.000Z"
  });
  return {
    async getRoleSession() {
      return session;
    },
    async resumeRoleSession() {
      starts.push("resume:codex-translator");
      session = createSession();
      return session;
    },
    async startRoleSession() {
      starts.push("start:codex-translator");
      session = createSession();
      return session;
    }
  };
}

function waitForDispatcher(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 90));
}
