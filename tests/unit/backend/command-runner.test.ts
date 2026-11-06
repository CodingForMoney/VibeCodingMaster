import { describe, expect, it } from "vitest";
import { createCommandRunner } from "../../../src/backend/adapters/command-runner.js";

describe("createCommandRunner", () => {
  const runner = createCommandRunner();

  it("returns the exit code and output of a command that ran", async () => {
    await expect(runner.run(process.execPath, ["-e", "process.stdout.write('out'); process.exit(3)"])).resolves.toEqual({
      stdout: "out",
      stderr: "",
      exitCode: 3
    });
  });

  it("reports a command that cannot start as a failure", async () => {
    const result = await runner.run("vcm-command-that-does-not-exist", ["--version"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ENOENT");
  });

  it("reports a timed-out command as a failure", async () => {
    const result = await runner.run(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/timed out/i);
  });
});
