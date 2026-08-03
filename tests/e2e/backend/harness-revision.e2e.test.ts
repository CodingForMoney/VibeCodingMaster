import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RoleName } from "../../../src/shared/types/role.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import {
  connectAndCreateTask,
  injectOk,
  startRole
} from "./helpers/e2e-actions.js";
import { createMockClaudeE2eApp } from "./helpers/e2e-app.js";
import { createE2eRepo } from "./helpers/e2e-repo.js";

const ROLES: RoleName[] = [
  "project-manager",
  "architect",
  "coder",
  "tester",
  "reviewer",
  "translator",
  "harness-engineer"
];

describe("backend E2E task worktree harness revision", () => {
  it("tracks every task-scoped role against the active worktree revision", async () => {
    const repo = await createE2eRepo();
    const env = await createMockClaudeE2eApp();

    try {
      const task = await connectAndCreateTask(env.app, repo, "harness-revision");
      await writeRevision(repo.repoRoot, 99);
      await writeRevision(task.worktreePath, 3);

      for (const role of ROLES) {
        await expect(startRole(env.app, task.taskSlug, role)).resolves.toMatchObject({
          taskSlug: task.taskSlug,
          role,
          harnessRevision: 3,
          harnessCurrentRevision: 3,
          harnessOutdated: false
        });
      }

      await writeRevision(task.worktreePath, 4);
      const outdatedResponse = await injectOk(env.app, {
        method: "GET",
        url: `/api/tasks/${task.taskSlug}/sessions`
      });
      const outdated = outdatedResponse.json<RoleSessionRecord[]>();
      expect(outdated).toHaveLength(ROLES.length);
      for (const role of ROLES) {
        expect(outdated.find((session) => session.role === role)).toMatchObject({
          harnessRevision: 3,
          harnessCurrentRevision: 4,
          harnessOutdated: true
        });
      }

      for (const role of ["translator", "harness-engineer"] satisfies RoleName[]) {
        const notifiedResponse = await injectOk(env.app, {
          method: "POST",
          url: `/api/tasks/${task.taskSlug}/sessions/${role}/notify-harness`
        });
        expect(notifiedResponse.json<RoleSessionRecord>()).toMatchObject({
          taskSlug: task.taskSlug,
          role,
          harnessRevision: 4,
          harnessCurrentRevision: 4,
          harnessOutdated: false
        });
      }
    } finally {
      await env.close();
      await repo.cleanup();
    }
  });
});

async function writeRevision(repoRoot: string, revision: number): Promise<void> {
  const harnessDir = path.join(repoRoot, ".ai", "vcm", "harness");
  await fs.mkdir(harnessDir, { recursive: true });
  await fs.writeFile(path.join(harnessDir, "revision.json"), `${JSON.stringify({
    version: 1,
    revision,
    updatedAt: "2026-08-03T00:00:00.000Z"
  }, null, 2)}\n`, "utf8");
}
