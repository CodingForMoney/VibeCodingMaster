import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createUsageAnalyticsService } from "../../../src/backend/services/usage-analytics-service.js";

describe("usage-analytics-service", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("aggregates every launch by role and model while deduplicating retried batches", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vcm-usage-"));
    tempRoots.push(root);
    const service = createUsageAnalyticsService({
      fs: createNodeFileSystemAdapter(),
      now: () => "2026-07-22T08:00:00.000Z"
    });
    const firstBatch = otlpPayload([
      event("project-manager", "launch-pm-1", 1, "claude-fable-5", "session-pm-1", {
        input: 100,
        output: 10,
        cacheRead: 80,
        cacheCreation: 20,
        costMicros: 1_250
      }),
      event("project-manager", "launch-pm-2", 1, "claude-fable-5", "session-pm-2", {
        input: 200,
        output: 15,
        cacheRead: 160,
        cacheCreation: 40,
        costMicros: 2_500
      }),
      event("architect", "launch-architect-1", 1, "claude-opus-5", "session-architect-1", {
        input: 300,
        output: 25,
        cacheRead: 240,
        cacheCreation: 60,
        costMicros: 3_750
      }),
      event("coder", "launch-ccr", 1, "gpt-5.6-sol", "session-ccr", {
        input: 9_999,
        output: 9_999,
        cacheRead: 9_999,
        cacheCreation: 9_999,
        costMicros: 9_999
      })
    ]);

    await service.ingest(root, ".ai/vcm", firstBatch);
    await service.ingest(root, ".ai/vcm", firstBatch);

    const report = await service.getReport(root, ".ai/vcm", "demo");
    expect(report.updatedAt).toBe("2026-07-22T08:00:00.000Z");
    expect(report.totals).toEqual({
      inputTokens: 600,
      outputTokens: 50,
      cacheReadTokens: 480,
      cacheCreationTokens: 120,
      costUsd: 0.0075,
      requestCount: 3,
      sessionCount: 3
    });
    expect(report.byRole.find((entry) => entry.role === "project-manager")).toMatchObject({
      inputTokens: 300,
      outputTokens: 25,
      requestCount: 2,
      sessionCount: 2
    });
    expect(report.byRole).toHaveLength(7);
    expect(report.byModel).toEqual([
      expect.objectContaining({ model: "claude-fable-5", inputTokens: 300, sessionCount: 2 }),
      expect.objectContaining({ model: "claude-opus-5", inputTokens: 300, sessionCount: 1 })
    ]);
    expect(await fs.readdir(path.join(root, ".ai/vcm/telemetry"))).toEqual(["usage.json"]);
  });

  it("serializes concurrent batches without losing requests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vcm-usage-concurrent-"));
    tempRoots.push(root);
    const service = createUsageAnalyticsService({ fs: createNodeFileSystemAdapter() });

    await Promise.all([
      service.ingest(root, ".ai/vcm", otlpPayload([
        event("tester", "launch-test-1", 1, "claude-sonnet-5", "session-test-1", { input: 10 })
      ])),
      service.ingest(root, ".ai/vcm", otlpPayload([
        event("tester", "launch-test-2", 1, "claude-sonnet-5", "session-test-2", { input: 20 })
      ]))
    ]);

    const report = await service.getReport(root, ".ai/vcm", "demo");
    expect(report.totals).toMatchObject({ inputTokens: 30, requestCount: 2, sessionCount: 2 });
  });

  it("returns all seven zero-valued roles before any usage is received", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vcm-usage-empty-"));
    tempRoots.push(root);
    const service = createUsageAnalyticsService({ fs: createNodeFileSystemAdapter() });

    const report = await service.getReport(root, ".ai/vcm", "demo");

    expect(report.updatedAt).toBeNull();
    expect(report.byRole.map((entry) => entry.role)).toEqual([
      "project-manager",
      "architect",
      "coder",
      "tester",
      "gate-reviewer",
      "translator",
      "harness-engineer"
    ]);
    expect(report.totals.requestCount).toBe(0);
  });
});

interface EventValues {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  costMicros?: number;
}

function event(
  role: string,
  launchId: string,
  sequence: number,
  model: string,
  sessionId: string,
  values: EventValues
) {
  return {
    resource: {
      attributes: [
        attribute("vcm.role", role),
        attribute("vcm.launch_id", launchId)
      ]
    },
    logRecord: {
      timeUnixNano: String(1_000_000 + sequence),
      attributes: [
        attribute("event.name", "api_request"),
        intAttribute("event.sequence", sequence),
        attribute("session.id", sessionId),
        attribute("model", model),
        intAttribute("input_tokens", values.input ?? 0),
        intAttribute("output_tokens", values.output ?? 0),
        intAttribute("cache_read_tokens", values.cacheRead ?? 0),
        intAttribute("cache_creation_tokens", values.cacheCreation ?? 0),
        intAttribute("cost_usd_micros", values.costMicros ?? 0)
      ]
    }
  };
}

function otlpPayload(events: Array<ReturnType<typeof event>>) {
  return {
    resourceLogs: events.map(({ resource, logRecord }) => ({
      resource,
      scopeLogs: [{ logRecords: [logRecord] }]
    }))
  };
}

function attribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function intAttribute(key: string, value: number) {
  return { key, value: { intValue: String(value) } };
}
