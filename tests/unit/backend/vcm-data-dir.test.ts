import path from "node:path";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveVcmDataDir } from "../../../src/backend/vcm-data-dir.js";

describe("resolveVcmDataDir", () => {
  it("uses VCM_DATA_DIR when it is set", () => {
    expect(resolveVcmDataDir({ VCM_DATA_DIR: "/workspace/.ai/vcm" })).toBe("/workspace/.ai/vcm");
  });

  it("falls back to ~/.vcm when VCM_DATA_DIR is empty", () => {
    expect(resolveVcmDataDir({ VCM_DATA_DIR: "  " })).toBe(path.join(homedir(), ".vcm"));
  });
});
