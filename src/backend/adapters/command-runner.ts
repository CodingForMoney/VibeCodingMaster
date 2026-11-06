import { execa } from "execa";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(command: string, args?: string[], options?: CommandRunnerOptions): Promise<CommandResult>;
}

export interface CommandRunnerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

export function createCommandRunner(): CommandRunner {
  return {
    async run(command, args = [], options = {}) {
      try {
        const result = await execa(command, args, {
          cwd: options.cwd,
          env: options.env,
          timeout: options.timeoutMs,
          input: options.input,
          reject: false
        });

        // A command that could not start, timed out, or died from a signal has
        // no exit code; it failed, so it must not read as a clean exit.
        const exitCode = result.exitCode ?? (result.failed ? 1 : 0);
        return {
          stdout: result.stdout,
          stderr: result.exitCode === undefined && result.failed
            ? [result.stderr, result.shortMessage].filter(Boolean).join("\n")
            : result.stderr,
          exitCode
        };
      } catch (error) {
        if (error instanceof Error) {
          return {
            stdout: "",
            stderr: error.message,
            exitCode: 1
          };
        }

        return {
          stdout: "",
          stderr: "Unknown command error",
          exitCode: 1
        };
      }
    }
  };
}
