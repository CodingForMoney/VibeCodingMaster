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
}

export function createCommandRunner(): CommandRunner {
  return {
    async run(command, args = [], options = {}) {
      try {
        const result = await execa(command, args, {
          cwd: options.cwd,
          env: options.env,
          reject: false
        });

        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode ?? 0
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
