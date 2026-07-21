import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("CCR API key helper", () => {
  it("reads the write-only CCR key from the VCM data directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vcm-ccr-helper-"));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({
      ccr: { apiKey: "test-ccr-key" }
    }), "utf8");

    const result = await execFileAsync(process.execPath, [
      path.resolve("scripts/ccr-api-key-helper.mjs")
    ], {
      env: { ...process.env, VCM_DATA_DIR: dir }
    });

    expect(result.stdout).toBe("test-ccr-key\n");
  });
});
