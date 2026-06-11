import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createHarnessService } from "../../../src/backend/services/harness-service.js";

const execFileAsync = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const installerPath = path.join(appRoot, "scripts/install-vcm-harness.mjs");

let tmpRepo: string | undefined;

afterEach(async () => {
  if (tmpRepo) {
    await rm(tmpRepo, { recursive: true, force: true });
    tmpRepo = undefined;
  }
});

describe("harness templates stay in sync with the script installer", () => {
  it("reports every file as ok right after a fresh script install", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-harness-sync-"));
    await execFileAsync(process.execPath, [installerPath, tmpRepo]);

    const service = createHarnessService({ fs: createNodeFileSystemAdapter() });
    const status = await service.getHarnessStatus(tmpRepo);

    const drifted = status.files.filter((file) => file.action !== "ok");
    expect(
      drifted.map((file) => `${file.path}: ${file.action}`),
      "script installer output must exactly match the backend harness templates"
    ).toEqual([]);
    expect(status.needsApply).toBe(false);
  }, 30_000);
});
