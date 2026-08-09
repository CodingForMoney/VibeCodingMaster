import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const guardPath = path.join(appRoot, "scripts/harness-tools/vcm-subagent-guard");

interface GuardResult {
  decision?: string;
  reason?: string;
}

async function runGuard(role: string | undefined, payload: unknown): Promise<GuardResult> {
  const env = { ...process.env };
  if (role) {
    env.VCM_ROLE = role;
  } else {
    delete env.VCM_ROLE;
  }

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile("python3", [guardPath], { env }, (error, output) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(output.trim());
    });
    child.stdin?.write(typeof payload === "string" ? payload : JSON.stringify(payload));
    child.stdin?.end();
  });

  if (!stdout) {
    return {};
  }
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: {
      permissionDecision: string;
      permissionDecisionReason: string;
    };
  };
  return {
    decision: parsed.hookSpecificOutput.permissionDecision,
    reason: parsed.hookSpecificOutput.permissionDecisionReason
  };
}

function agent(subagentType?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tool_name: "Agent",
    tool_input: subagentType ? { subagent_type: subagentType } : {},
    ...extra
  };
}

describe("vcm-subagent-guard", () => {
  it("allows only each code role's assigned worker", async () => {
    await expect(runGuard("architect", agent("vcm-architect-scaffold-worker"))).resolves.toEqual({});
    await expect(runGuard("coder", agent("vcm-coder-worker"))).resolves.toEqual({});

    await expect(runGuard("architect", agent("vcm-coder-worker"))).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("vcm-architect-scaffold-worker")
    });
    await expect(runGuard("coder", agent("Explore"))).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("vcm-coder-worker")
    });
  });

  it.each([
    "project-manager",
    "tester",
    "reviewer",
    "translator",
    "harness-engineer"
  ])("denies subagents for %s", async (role) => {
    await expect(runGuard(role, agent("general-purpose"))).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("may not invoke subagents")
    });
  });

  it("denies missing, malformed, and nested worker requests", async () => {
    await expect(runGuard("coder", agent())).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("<missing>")
    });
    await expect(runGuard("architect", "not-json")).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("hook payload is invalid")
    });
    await expect(runGuard("coder", agent("vcm-coder-worker", { agent_id: "worker-1" }))).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("nested subagents")
    });
  });

  it("does not restrict non-VCM Claude sessions or non-Agent tools", async () => {
    await expect(runGuard(undefined, agent("general-purpose"))).resolves.toEqual({});
    await expect(runGuard("coder", { tool_name: "Read", tool_input: {} })).resolves.toEqual({});
  });
});
