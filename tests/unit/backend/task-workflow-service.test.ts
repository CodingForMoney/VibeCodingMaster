import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createTaskWorkflowService } from "../../../src/backend/services/task-workflow-service.js";

let root: string | undefined;

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe("createTaskWorkflowService", () => {
  it("stores PM declarations and dispatch checkpoints atomically", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "vcm-workflow-"));
    const service = createTaskWorkflowService({
      fs: createNodeFileSystemAdapter(),
      now: () => "2026-07-17T10:00:00.000Z"
    });
    const input = { taskRepoRoot: root, stateRoot: ".ai/vcm", taskSlug: "demo" };

    await service.declare(input, {
      flow: "code-change",
      step: "architect-planning",
      evidenceRefs: [".ai/vcm/handoffs/architecture-brief.md"]
    });
    const state = await service.recordPmDispatch(input, {
      step: "coder-implementation",
      branch: "none"
    }, {
      messageId: "msg-1",
      toRole: "coder"
    });

    expect(state).toMatchObject({
      revision: 2,
      declared: {
        flow: "code-change",
        step: "coder-implementation",
        evidenceRefs: [".ai/vcm/handoffs/architecture-brief.md"],
        updatedBy: "project-manager"
      },
      lastDispatch: {
        messageId: "msg-1",
        toRole: "coder"
      },
      warnings: []
    });
    expect(state.declared?.branch).toBeUndefined();
    const stored = JSON.parse(await readFile(path.join(root, ".ai/vcm/workflow/state.json"), "utf8"));
    expect(stored).toMatchObject({ revision: 2, taskSlug: "demo" });
  });

  it("ignores corrupt state and replaces it on the next declaration", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "vcm-workflow-corrupt-"));
    const statePath = path.join(root, ".ai/vcm/workflow/state.json");
    const fs = createNodeFileSystemAdapter();
    await fs.writeText(statePath, "{broken");
    const service = createTaskWorkflowService({ fs });
    const input = { taskRepoRoot: root, stateRoot: ".ai/vcm", taskSlug: "demo" };

    const degraded = await service.getState(input);
    expect(degraded.declared).toBeNull();
    expect(degraded.warnings[0]).toContain("could not be read");

    const repaired = await service.declare(input, { flow: "docs-only", step: "architect" });
    expect(repaired.warnings).toEqual([]);
    expect(repaired.declared).toMatchObject({ flow: "docs-only", step: "architect" });
  });

  it("renders restored context without granting a transition", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "vcm-workflow-context-"));
    const service = createTaskWorkflowService({ fs: createNodeFileSystemAdapter() });
    const input = { taskRepoRoot: root, stateRoot: ".ai/vcm", taskSlug: "demo" };
    const state = await service.declare(input, {
      flow: "code-change",
      step: "tester-validation",
      branch: "architect-debug",
      resumePoint: "tester-validation"
    });

    expect(service.renderPmResumeContext(state)).toContain("does not authorize or advance any workflow step");
    expect(service.renderPmResumeContext(state)).toContain("Branch: architect-debug");
  });

  it("ignores malformed declaration fields without throwing", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "vcm-workflow-invalid-"));
    const service = createTaskWorkflowService({ fs: createNodeFileSystemAdapter() });
    const input = { taskRepoRoot: root, stateRoot: ".ai/vcm", taskSlug: "demo" };
    await service.declare(input, { flow: "code-change", step: "coder" });

    const state = await service.declare(input, {
      flow: 42,
      step: { invalid: true }
    } as never);

    expect(state.declared).toMatchObject({ flow: "code-change", step: "coder" });
    expect(state.warnings).toEqual([]);
  });
});
