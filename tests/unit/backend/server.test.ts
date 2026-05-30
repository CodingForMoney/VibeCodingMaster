import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultStaticDir } from "../../../src/backend/server.js";

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

function getRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}
