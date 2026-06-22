import type { RoleName } from "../../shared/types/role.js";
import type { ClaudeModel, ClaudePermissionMode, SessionEffort } from "../../shared/types/session.js";
import { VcmError } from "../errors.js";
import type { CommandRunner } from "./command-runner.js";

export interface ClaudeAdapter {
  isAvailable(command?: string): Promise<boolean>;
  getVersion(command?: string): Promise<string>;
  buildRoleStartCommand(
    role: RoleName,
    command?: string,
    permissionMode?: ClaudePermissionMode,
    claudeSessionId?: string,
    resume?: boolean,
    model?: ClaudeModel,
    effort?: SessionEffort
  ): { command: string; args: string[]; display: string };
}

export function createClaudeAdapter(runner: CommandRunner): ClaudeAdapter {
  return {
    async isAvailable(command = "claude") {
      const result = await runner.run(command, ["--version"]);
      return result.exitCode === 0;
    },
    async getVersion(command = "claude") {
      const result = await runner.run(command, ["--version"]);
      if (result.exitCode !== 0) {
        throw new VcmError({
          code: "CLAUDE_UNAVAILABLE",
          message: `Claude Code command is not available: ${command}`,
          statusCode: 400,
          hint: "Install Claude Code or configure a valid claude command path."
        });
      }

      return result.stdout.trim();
    },
    buildRoleStartCommand(role, command = "claude", permissionMode = "default", claudeSessionId, resume = false, model = "default", effort = "default") {
      const args = ["--agent", role];
      if (claudeSessionId) {
        args.push(resume ? "--resume" : "--session-id", claudeSessionId);
      }
      args.push("--model", model);
      if (effort === "ultracode") {
        args.push("--settings", JSON.stringify({ ultracode: true }));
      } else if (effort !== "default") {
        args.push("--effort", effort);
      }
      if (permissionMode === "bypassPermissions") {
        args.push("--permission-mode", "bypassPermissions");
      }

      return {
        command,
        args,
        display: [command, ...args].map(formatDisplayArg).join(" ")
      };
    }
  };
}

function formatDisplayArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
