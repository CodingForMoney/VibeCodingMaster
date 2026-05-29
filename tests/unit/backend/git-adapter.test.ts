import { describe, expect, it } from "vitest";
import { createGitAdapter } from "../../../src/backend/adapters/git-adapter.js";
import type {
  CommandResult,
  CommandRunner,
  CommandRunnerOptions
} from "../../../src/backend/adapters/command-runner.js";

describe("createGitAdapter", () => {
  it("runs git metadata commands with a command-scoped safe.directory", async () => {
    const calls: RunnerCall[] = [];
    const adapter = createGitAdapter(createRunner(calls, {
      stdout: "true",
      stderr: "",
      exitCode: 0
    }));

    await expect(adapter.isRepo("/workspace")).resolves.toBe(true);

    expect(calls[0]).toMatchObject({
      command: "git",
      options: { cwd: "/workspace" }
    });
    expect(calls[0]?.args).toContain("safe.directory=/workspace");
    expect(calls[0]?.args.slice(-2)).toEqual(["rev-parse", "--is-inside-work-tree"]);
  });

  it("returns the git stderr as a repo validation hint", async () => {
    const adapter = createGitAdapter(createRunner([], {
      stdout: "",
      stderr: "fatal: detected dubious ownership in repository at '/workspace'",
      exitCode: 128
    }));

    const result = await adapter.checkRepo("/workspace");

    expect(result.isRepo).toBe(false);
    expect(result.hint).toContain("detected dubious ownership");
    expect(result.hint).toContain("git config --global --add safe.directory <repo-path>");
  });
});

interface RunnerCall {
  command: string;
  args: string[];
  options: CommandRunnerOptions;
}

function createRunner(calls: RunnerCall[], result: CommandResult): CommandRunner {
  return {
    async run(command, args = [], options = {}) {
      calls.push({ command, args, options });
      return result;
    }
  };
}
