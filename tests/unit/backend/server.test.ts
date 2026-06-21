import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, getDefaultStaticDir, type ServerDeps } from "../../../src/backend/server.js";

describe("getDefaultStaticDir", () => {
  const originalCwd = process.cwd();
  const tempDirs: string[] = [];

  afterEach(async () => {
    process.chdir(originalCwd);
    await Promise.all(tempDirs.map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("resolves the frontend bundle from the VCM app root instead of the caller cwd", async () => {
    const callerCwd = await fs.mkdtemp(path.join(os.tmpdir(), "vcm-cwd-"));
    tempDirs.push(callerCwd);
    process.chdir(callerCwd);

    expect(getDefaultStaticDir()).toBe(path.join(getRepoRoot(), "dist-frontend"));
  });
});

describe("createServer", () => {
  it("cleans translation runtime for recent repositories on startup", async () => {
    const calls: string[] = [];
    const app = await createServer(createServerDepsStub(calls));

    await app.ready();
    await app.close();

    expect(calls).toEqual([
      "cleanup:/repo-one",
      "cleanup:/repo-two",
      "gateway:start",
      "gateway:stop"
    ]);
  });
});

function getRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function createServerDepsStub(calls: string[]): ServerDeps {
  return {
    appSettings: {} as never,
    projectService: {
      async getRecentRepositoryPaths() {
        return ["/repo-one", "/repo-two"];
      }
    } as never,
    taskService: {} as never,
    sessionService: {} as never,
    artifactService: {} as never,
    harnessService: {} as never,
    commandDispatcher: {} as never,
    claudeHookService: {} as never,
    codexHookService: {} as never,
    messageService: {} as never,
    gateReviewService: {} as never,
    codexTranslationService: {
      async cleanupStartupRuntime(repoRoot: string) {
        calls.push(`cleanup:${repoRoot}`);
      }
    } as never,
    roundService: {} as never,
    statusService: {} as never,
    translationService: {} as never,
    gatewayService: {
      async start() {
        calls.push("gateway:start");
      },
      async stop() {
        calls.push("gateway:stop");
      }
    } as never,
    runtime: {} as never,
    diagnosticsService: {
      getErrorRuntimeInfo() {
        return {};
      }
    } as never
  };
}
