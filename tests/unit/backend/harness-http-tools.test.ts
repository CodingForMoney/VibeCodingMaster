import { execFile, execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderRequestGateReviewTool } from "../../../src/backend/templates/harness/gate-review.js";
import { renderRequestArchitectRestartTool } from "../../../src/backend/templates/harness/restart-architect-skill.js";
import { renderResolveDurableDocAssignmentTool } from "../../../src/backend/templates/harness/resolve-durable-doc-assignment.js";
import { renderAskUserTool } from "../../../src/backend/templates/harness/vcm-ask-user-skill.js";
import { renderUpdateTaskStateTool } from "../../../src/backend/templates/harness/vcm-task-state-skill.js";

interface RecordedRequest {
  url: string;
  body: unknown;
}

let projectRoot: string;
let toolsRoot: string;
let server: Server;
let apiUrl: string;
let requests: RecordedRequest[];
let respond: (request: RecordedRequest, response: ServerResponse) => void;

beforeAll(async () => {
  projectRoot = await mkdtemp(path.join(os.tmpdir(), "vcm-http-tools-"));
  toolsRoot = path.join(projectRoot, ".ai/tools");
  await mkdir(toolsRoot, { recursive: true });
  // A project root declared as an ES module must not change how tools load.
  await writeFile(path.join(projectRoot, "package.json"), "{\"type\":\"module\"}\n");
  await writeFile(path.join(toolsRoot, "package.json"), "{\"type\":\"commonjs\"}\n");
  for (const [name, content] of [
    ["vcm-ask-user", renderAskUserTool()],
    ["update-task-state", renderUpdateTaskStateTool()],
    ["request-architect-restart", renderRequestArchitectRestartTool()],
    ["resolve-durable-doc-assignment", renderResolveDurableDocAssignmentTool()],
    ["request-gate-review", renderRequestGateReviewTool()],
    ["vcm-artifact", await readFile(path.join(process.cwd(), "scripts/harness-tools/vcm-artifact"), "utf8")]
  ] as const) {
    await writeFile(path.join(toolsRoot, name), content);
    await chmod(path.join(toolsRoot, name), 0o755);
  }
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const recorded = { url: request.url ?? "", body: raw ? JSON.parse(raw) : undefined };
      requests.push(recorded);
      respond(recorded, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(projectRoot, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  respond = (_request, response) => json(response, 200, { ok: true });
});

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function runTool(name: string, args: string[], env: Record<string, string | undefined>) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(path.join(toolsRoot, name), args, {
      cwd: projectRoot,
      env: { PATH: process.env.PATH, VCM_API_URL: apiUrl, VCM_TASK_SLUG: "demo task", ...env }
    }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

describe("harness HTTP tools", () => {
  it("registers a PM user question and reports the awaiting state", async () => {
    respond = (_request, response) => json(response, 200, { awaitingUser: { question: "Ship?" } });

    const result = await runTool("vcm-ask-user", ["--question", "  Ship?  "], { VCM_ROLE: "project-manager" });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: "awaiting_user", state: { awaitingUser: { question: "Ship?" } } });
    expect(requests).toEqual([{ url: "/api/tasks/demo%20task/ask-user", body: { question: "Ship?" } }]);
  });

  it("refuses user questions from other roles, empty questions, and rejected requests", async () => {
    const otherRole = await runTool("vcm-ask-user", ["--question", "Ship?"], { VCM_ROLE: "coder" });
    expect(otherRole.code).toBe(2);
    expect(JSON.parse(otherRole.stdout).status).toBe("failed");

    const empty = await runTool("vcm-ask-user", ["--question=   "], { VCM_ROLE: "project-manager" });
    expect(empty.code).toBe(2);
    expect(JSON.parse(empty.stdout).message).toBe("A non-empty user question is required.");

    respond = (_request, response) => json(response, 409, { error: { message: "dispatch pending" } });
    const rejected = await runTool("vcm-ask-user", ["--question", "Ship?"], { VCM_ROLE: "project-manager" });
    expect(rejected.code).toBe(1);
    expect(JSON.parse(rejected.stdout).message).toContain("VCM rejected the user question: HTTP 409");

    const missing = await runTool("vcm-ask-user", [], { VCM_ROLE: "project-manager" });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("error: the following arguments are required: --question");
    expect(requests).toHaveLength(1);
  });

  it("declares task state with repeated evidence and never fails the caller", async () => {
    respond = (_request, response) => json(response, 200, { declared: { step: "plan" } });

    const updated = await runTool("update-task-state", [
      "--flow", "code-change", "--step", "plan", "--resume-point=none", "--evidence", "a.md", "--evidence", "b.md"
    ], { VCM_ROLE: "project-manager" });

    expect(updated.code).toBe(0);
    expect(JSON.parse(updated.stdout)).toEqual({ status: "updated", state: { declared: { step: "plan" } } });
    expect(requests[0]).toEqual({
      url: "/api/tasks/demo%20task/workflow-state",
      body: { flow: "code-change", step: "plan", resumePoint: "none", evidenceRefs: ["a.md", "b.md"] }
    });

    respond = (_request, response) => json(response, 500, {});
    const failed = await runTool("update-task-state", ["--step", "plan"], { VCM_ROLE: "project-manager" });
    expect(failed.code).toBe(0);
    expect(JSON.parse(failed.stdout).message).toContain("Task state was not updated: HTTP Error 500");

    const empty = await runTool("update-task-state", [], { VCM_ROLE: "project-manager" });
    expect(JSON.parse(empty.stdout).message).toBe("No task workflow fields were supplied.");
  });

  it("schedules the Architect restart and surfaces backend rejections", async () => {
    respond = (_request, response) => json(response, 200, { status: "scheduled", sessionId: "s1", memoryCandidatePath: "c.md" });

    const scheduled = await runTool("request-architect-restart", [], { VCM_ROLE: "architect" });

    expect(scheduled.code).toBe(0);
    expect(JSON.parse(scheduled.stdout)).toEqual({
      status: "scheduled",
      taskSlug: "demo task",
      sessionId: "s1",
      memoryCandidatePath: "c.md"
    });
    expect(requests[0].url).toBe("/api/tasks/demo%20task/sessions/architect/restart-after-planning");

    respond = (_request, response) => json(response, 409, { error: { message: "planning incomplete" } });
    const rejected = await runTool("request-architect-restart", [], { VCM_ROLE: "architect" });
    expect(rejected.code).toBe(2);
    expect(JSON.parse(rejected.stdout)).toEqual({ status: "rejected", message: "planning incomplete" });

    const wrongRole = await runTool("request-architect-restart", [], { VCM_ROLE: "coder" });
    expect(wrongRole.code).toBe(2);
  });

  it("records a durable-document owner and validates the owner choice", async () => {
    const accepted = await runTool("resolve-durable-doc-assignment", [
      "--assignment", "a-1", "--owner", "tester"
    ], { VCM_ROLE: "project-manager" });

    expect(accepted.code).toBe(0);
    expect(JSON.parse(accepted.stdout)).toEqual({ status: "accepted" });
    expect(requests[0]).toEqual({
      url: "/api/projects/harness/memory/assignments/owner",
      body: { taskSlug: "demo task", assignmentId: "a-1", owner: "tester" }
    });

    const invalid = await runTool("resolve-durable-doc-assignment", [
      "--assignment", "a-1", "--owner", "reviewer"
    ], { VCM_ROLE: "project-manager" });
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("invalid choice: 'reviewer'");
  });

  it("submits a managed artifact, removes the candidate, and reports backend errors", async () => {
    const candidate = path.join(toolsRoot, "candidate.md");
    await writeFile(candidate, "# Test Report\n");
    respond = (_request, response) => json(response, 200, {
      ok: true, kind: "test-report", path: ".ai/vcm/handoffs/test-report.md", mode: "final", status: "complete"
    });
    const env = { VCM_ROLE: "tester", VCM_RUNTIME_SESSION_TOKEN: "token-1" };

    const accepted = await runTool("vcm-artifact", ["test-report", "--file", candidate], env);

    expect(accepted.code).toBe(0);
    expect(accepted.stdout).toBe("VCM artifact accepted: test-report -> .ai/vcm/handoffs/test-report.md (final, complete)");
    expect(requests[0]).toEqual({
      url: "/api/tasks/demo%20task/artifacts/submit",
      body: { kind: "test-report", mode: "final", role: "tester", runtimeSessionToken: "token-1", content: "# Test Report\n" }
    });
    await expect(readFile(candidate, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(candidate, "# Test Report\n");
    respond = (_request, response) => json(response, 422, { error: { message: "validation failed", hint: "fix it" } });
    const rejected = await runTool("vcm-artifact", ["test-report", "--file", candidate, "--mode", "draft", "--path", "x.md"], env);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toBe("VCM artifact submission failed: validation failed\nfix it");
    expect((requests[1].body as { mode: string; path: string })).toMatchObject({ mode: "draft", path: "x.md" });
    await expect(readFile(candidate, "utf8")).resolves.toBe("# Test Report\n");

    const badMode = await runTool("vcm-artifact", ["test-report", "--file", candidate, "--mode", "partial"], env);
    expect(badMode.code).toBe(2);
    const missingToken = await runTool("vcm-artifact", ["test-report", "--file", candidate], { VCM_ROLE: "tester" });
    expect(missingToken.code).toBe(1);
    expect(missingToken.stderr).toContain("VCM_RUNTIME_SESSION_TOKEN is required");
  });

  it("requests a Gate Review through the VCM API and reports rejections", async () => {
    respond = (_request, response) => json(response, 200, {
      status: "started", record: { requestPath: "r.json", reportPath: "r.report.md" }
    });

    const started = await runTool("request-gate-review", ["--gate", "code-diff", "--source", "coder"], {});

    expect(started.code).toBe(0);
    expect(started.stdout).toBe("started\ngate=code-diff\nrequest=r.json\nreport=r.report.md");
    expect(requests[0]).toEqual({ url: "/api/tasks/demo%20task/gate-review/code-diff/request", body: { codeDiffSource: "coder" } });

    const plan = await runTool("request-gate-review", ["--gate", "architecture-plan"], {});
    expect(plan.code).toBe(0);
    expect(requests[1].body).toEqual({ codeDiffSource: null });

    respond = (_request, response) => json(response, 409, { error: { message: "gate disabled" } });
    const rejected = await runTool("request-gate-review", ["--gate", "architecture-plan"], {});
    expect(rejected.code).toBe(2);
    expect(rejected.stdout).toBe("failed_to_start\ngate=architecture-plan\nreason=gate disabled");

    const noSource = await runTool("request-gate-review", ["--gate", "code-diff"], {});
    expect(noSource.code).toBe(2);
    expect(noSource.stdout).toContain("reason=code-diff requires --source coder");
    expect(requests).toHaveLength(3);
  });

  it("records a local Gate Review request when the VCM API is not configured", async () => {
    const indexPath = path.join(projectRoot, ".ai/vcm/gate-reviews/index.json");
    const local = { VCM_API_URL: undefined, VCM_TASK_SLUG: undefined };
    try {
      const missing = await runTool("request-gate-review", ["--gate", "architecture-plan"], local);
      expect(missing.code).toBe(2);
      expect(missing.stdout).toContain("enable state is indeterminate");

      execFileSync("git", ["init", "-q"], { cwd: projectRoot });
      await mkdir(path.dirname(indexPath), { recursive: true });
      await writeFile(indexPath, JSON.stringify({ enabled: true, gates: { "architecture-plan": { required: true } } }));
      const notReady = await runTool("request-gate-review", ["--gate", "architecture-plan"], local);
      expect(notReady.stdout).toBe("not_required\ngate=architecture-plan\nmessage=.ai/vcm/handoffs/architecture-plan.md is missing.");

      await mkdir(path.join(projectRoot, ".ai/vcm/handoffs"), { recursive: true });
      await writeFile(path.join(projectRoot, ".ai/vcm/handoffs/architecture-plan.md"), "# Plan\n");
      const started = await runTool("request-gate-review", ["--gate", "architecture-plan"], local);
      expect(started.code).toBe(0);
      expect(started.stdout).toMatch(/^started\ngate=architecture-plan\nrequest=\.ai\/vcm\/gate-reviews\/requests\/\d{8}T\d{6}Z-architecture-plan-[0-9a-f]{8}\.json\n/);
      const index = JSON.parse(await readFile(indexPath, "utf8"));
      expect(index.activeGate).toBe("architecture-plan");
      expect(index.gates["architecture-plan"]).toMatchObject({ status: "running", inputHash: expect.stringMatching(/^[0-9a-f]{64}$/) });

      index.gates["architecture-plan"] = { ...index.gates["architecture-plan"], status: "completed", decision: "approve" };
      await writeFile(indexPath, JSON.stringify(index));
      const approved = await runTool("request-gate-review", ["--gate", "architecture-plan"], local);
      expect(approved.stdout).toBe("already_approved\ngate=architecture-plan\nreport=.ai/vcm/gate-reviews/architecture-plan-review.md");
    } finally {
      await rm(path.join(projectRoot, ".git"), { recursive: true, force: true });
      await rm(path.join(projectRoot, ".ai/vcm"), { recursive: true, force: true });
    }
  });
});
