import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("filesystem adapter readJson", () => {
  it("retries a file that is briefly missing during a rename-over", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "vcm-fs-read-json-"));
    const target = path.join(tmpDir, "queue.json");
    const fs = createNodeFileSystemAdapter();

    const reading = fs.readJson<{ ok: boolean }>(target);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await writeFile(target, "{\"ok\":true}\n", "utf8");

    await expect(reading).resolves.toEqual({ ok: true });
  });

  it("still reports a file that stays missing", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "vcm-fs-read-json-"));
    const fs = createNodeFileSystemAdapter();

    await expect(fs.readJson(path.join(tmpDir, "missing.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
