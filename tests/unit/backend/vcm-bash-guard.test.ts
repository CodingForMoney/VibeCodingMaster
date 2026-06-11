import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const guardPath = path.join(appRoot, "scripts/harness-tools/vcm-bash-guard");

interface GuardPayload {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

async function runGuard(payload: GuardPayload): Promise<string | undefined> {
  const reason = await new Promise<string>((resolve, reject) => {
    const child = execFile("python3", [guardPath], (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
  });
  if (!reason) {
    return undefined;
  }
  const parsed = JSON.parse(reason) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  };
  expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  return parsed.hookSpecificOutput.permissionDecisionReason;
}

function bash(command: string, extra: Record<string, unknown> = {}): GuardPayload {
  return { tool_name: "Bash", tool_input: { command, ...extra } };
}

describe("vcm-bash-guard", () => {
  const denied: Array<[string, GuardPayload]> = [
    ["run_in_background", bash("cargo test", { run_in_background: true })],
    ["trailing &", bash("sleep 100 &")],
    ["mid-command &", bash("server --port 80 & curl localhost")],
    ["nohup", bash("nohup make build > out.log")],
    ["setsid", bash("setsid ./daemon")],
    ["disown", bash("./serve; disown")],
    ["& inside sh -c payload", bash("sh -c 'sleep 100 &'")],
    ["nohup inside bash -lc payload", bash("bash -lc 'nohup ./serve &'")],
    ["nested shell payload", bash("sh -c \"sh -c 'sleep 100 &'\"")],
    ["backgrounded watch-job", bash(".ai/tools/watch-job job-1 &")],
    ["nohup watch-job", bash("nohup .ai/tools/watch-job job-1")],
    ["backgrounded run-long-check wrapper", bash(".ai/tools/run-long-check --timeout 5m -- cargo test &")],
    ["nohup run-long-check wrapper", bash("nohup .ai/tools/run-long-check --timeout 5m -- cargo test")],
    ["setsid in run-long-check payload", bash(".ai/tools/run-long-check --timeout 5m -- setsid ./daemon")],
    ["background shell payload in run-long-check", bash('.ai/tools/run-long-check --timeout 5m -- sh -c "x & y"')]
  ];

  const allowed: Array<[string, GuardPayload]> = [
    ["&& chain", bash("npm test && echo done")],
    ["quoted ampersand", bash('echo "R&D dept & friends"')],
    ["fd redirect", bash("make 2>&1 | tail")],
    ["quoted ampersand inside sh -c", bash("sh -c 'echo \"a & b\"'")],
    ["plain watch-job", bash(".ai/tools/watch-job job-1 --window 8m")],
    ["plain run-long-check", bash(".ai/tools/run-long-check --timeout 5m -- cargo test")],
    ["non-Bash tool", { tool_name: "Read", tool_input: { file_path: "a&b.txt" } }]
  ];

  for (const [label, payload] of denied) {
    it(`denies ${label}`, async () => {
      const reason = await runGuard(payload);
      expect(reason, `${label} should be denied`).toBeDefined();
      expect(reason).toContain("vcm-long-running-validation");
    });
  }

  for (const [label, payload] of allowed) {
    it(`allows ${label}`, async () => {
      await expect(runGuard(payload)).resolves.toBeUndefined();
    });
  }
});
