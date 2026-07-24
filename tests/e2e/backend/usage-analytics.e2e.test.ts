import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectAndCreateTask } from "./helpers/e2e-actions.js";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";

describe("task usage analytics", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("ingests native Claude request events into the active task worktree", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    const task = await connectAndCreateTask(env.app, repo, "usage-e2e");

    const ingest = await env.app.inject({
      method: "POST",
      url: "/api/telemetry/v1/logs",
      payload: payload("architect", "launch-1", "session-1", "claude-opus-5", 400, 50, 300, 100, 25_000)
    });
    expect(ingest.statusCode).toBe(200);

    const response = await env.app.inject({
      method: "GET",
      url: `/api/tasks/${task.taskSlug}/usage-analytics`
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      taskSlug: task.taskSlug,
      totals: {
        inputTokens: 400,
        outputTokens: 50,
        cacheReadTokens: 300,
        cacheCreationTokens: 100,
        costUsd: 0.025,
        requestCount: 1,
        sessionCount: 1
      },
      byRole: expect.arrayContaining([
        expect.objectContaining({ role: "architect", inputTokens: 400 })
      ]),
      byModel: [expect.objectContaining({ model: "claude-opus-5", inputTokens: 400 })]
    });
    expect(await fs.stat(path.join(task.worktreePath, ".ai/vcm/telemetry/usage.json"))).toBeDefined();
  });

  it("drops telemetry when no task is active", async () => {
    const env = await createMockClaudeE2eApp();
    cleanups.push(() => env.close());
    const repo = await createE2eRepo();
    cleanups.push(() => repo.cleanup());
    await env.app.inject({ method: "POST", url: "/api/projects/connect", payload: { repoPath: repo.repoRoot } });

    const response = await env.app.inject({
      method: "POST",
      url: "/api/telemetry/v1/logs",
      payload: payload("coder", "launch-1", "session-1", "claude-sonnet-5", 10, 1, 0, 0, 10)
    });

    expect(response.statusCode).toBe(200);
  });
});

function payload(
  role: string,
  launchId: string,
  sessionId: string,
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
  costMicros: number
) {
  const stringAttribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const intAttribute = (key: string, value: number) => ({ key, value: { intValue: String(value) } });
  return {
    resourceLogs: [{
      resource: { attributes: [stringAttribute("vcm.role", role), stringAttribute("vcm.launch_id", launchId)] },
      scopeLogs: [{
        logRecords: [{
          timeUnixNano: "1000000",
          attributes: [
            stringAttribute("event.name", "api_request"),
            intAttribute("event.sequence", 1),
            stringAttribute("session.id", sessionId),
            stringAttribute("model", model),
            intAttribute("input_tokens", input),
            intAttribute("output_tokens", output),
            intAttribute("cache_read_tokens", cacheRead),
            intAttribute("cache_creation_tokens", cacheCreation),
            intAttribute("cost_usd_micros", costMicros)
          ]
        }]
      }]
    }]
  };
}
