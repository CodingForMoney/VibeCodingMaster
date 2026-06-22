import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const appRoot = process.cwd();

let tmpRepo: string | undefined;

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeSource(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content.trimStart());
}

async function installHarnessTools(repoRoot: string) {
  const toolsRoot = path.join(repoRoot, ".ai/tools");
  await mkdir(toolsRoot, { recursive: true });
  await cp(path.join(appRoot, "scripts/harness-tools/generate-module-index"), path.join(toolsRoot, "generate-module-index"));
  await cp(path.join(appRoot, "scripts/harness-tools/generate-public-surface"), path.join(toolsRoot, "generate-public-surface"));
}

async function createTypescriptWorkspace(repoRoot: string) {
  await writeJson(path.join(repoRoot, "package.json"), {
    private: true,
    workspaces: ["apps/*", "packages/*"]
  });

  await writeJson(path.join(repoRoot, "packages/domain/package.json"), {
    name: "@demo/domain",
    type: "module",
    exports: {
      ".": {
        types: "./src/index.ts",
        import: "./src/index.ts"
      }
    }
  });
  await writeSource(path.join(repoRoot, "packages/domain/src/index.ts"), `
    export * from "./rules.js";
    export type { Ticket } from "./types.js";
  `);
  await writeSource(path.join(repoRoot, "packages/domain/src/rules.ts"), `
    export function computeSlaState(ticket: Ticket): string {
      return ticket.status;
    }

    export const TICKET_STATUSES = ["open", "closed"] as const;
  `);
  await writeSource(path.join(repoRoot, "packages/domain/src/types.ts"), `
    export interface Ticket {
      id: string;
      status: "open" | "closed";
    }
  `);
  await writeSource(path.join(repoRoot, "packages/domain/src/rules.test.ts"), `
    import { computeSlaState } from "./rules.js";
    computeSlaState({ id: "T-1", status: "open" });
  `);

  await writeJson(path.join(repoRoot, "packages/db/package.json"), {
    name: "@demo/db",
    type: "module",
    exports: "./src/index.ts",
    dependencies: {
      "@demo/domain": "workspace:*"
    }
  });
  await writeSource(path.join(repoRoot, "packages/db/src/index.ts"), `
    export class HelpdeskRepository {
      listTickets() {
        return [];
      }
    }
  `);

  await writeJson(path.join(repoRoot, "apps/api/package.json"), {
    name: "@demo/api",
    type: "module",
    dependencies: {
      "@demo/db": "workspace:*",
      "@demo/domain": "workspace:*"
    }
  });
  await writeSource(path.join(repoRoot, "apps/api/src/app.ts"), `
    import Fastify from "fastify";

    export async function createApp() {
      const app = Fastify();
      app.get("/health", async () => ({ ok: true }));
      app.post("/tickets", async () => ({ id: "T-1" }));
      return app;
    }
  `);

  await writeJson(path.join(repoRoot, "apps/web/package.json"), {
    name: "@demo/web",
    type: "module",
    dependencies: {
      "@demo/domain": "workspace:*"
    }
  });
  await writeSource(path.join(repoRoot, "apps/web/src/api.ts"), `
    export async function listTickets() {
      return [];
    }
  `);
}

afterEach(async () => {
  if (tmpRepo) {
    await rm(tmpRepo, { recursive: true, force: true });
    tmpRepo = undefined;
  }
});

describe("harness generated-context tools", () => {
  it("generates module and public-surface indexes for npm workspaces", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-harness-tools-"));
    await installHarnessTools(tmpRepo);
    await createTypescriptWorkspace(tmpRepo);

    await execFileAsync("python3", [path.join(tmpRepo, ".ai/tools/generate-module-index")], { cwd: tmpRepo });
    const moduleIndex = JSON.parse(await readFile(path.join(tmpRepo, ".ai/generated/module-index.json"), "utf8"));

    expect(moduleIndex.workspace).toMatchObject({
      type: "npm-workspaces",
      manifest: "package.json"
    });
    expect(moduleIndex.layers.map((layer: { name: string }) => layer.name)).toEqual(["apps", "packages"]);

    const modules = moduleIndex.layers.flatMap((layer: { modules: Array<{ name: string }> }) => layer.modules);
    expect(modules.map((module: { name: string }) => module.name)).toEqual([
      "@demo/api",
      "@demo/web",
      "@demo/db",
      "@demo/domain"
    ]);
    expect(modules.find((module: { name: string }) => module.name === "@demo/api")).toMatchObject({
      workspaceDependencies: ["@demo/db", "@demo/domain"],
      files: {
        source: ["apps/api/src/app.ts"]
      }
    });
    expect(modules.find((module: { name: string }) => module.name === "@demo/domain")).toMatchObject({
      files: {
        tests: ["packages/domain/src/rules.test.ts"]
      }
    });

    await execFileAsync("python3", [path.join(tmpRepo, ".ai/tools/generate-public-surface")], { cwd: tmpRepo });
    const publicSurface = JSON.parse(await readFile(path.join(tmpRepo, ".ai/generated/public-surface.json"), "utf8"));

    expect(publicSurface.visibility).toBe("project-public");
    const domainItems = publicSurface.modules.find((module: { name: string }) => module.name === "@demo/domain").items;
    expect(domainItems.map((item: { path: string }) => item.path)).toEqual(
      expect.arrayContaining(["computeSlaState", "TICKET_STATUSES", "Ticket"])
    );
    const apiItems = publicSurface.modules.find((module: { name: string }) => module.name === "@demo/api").items;
    expect(apiItems.map((item: { path: string }) => item.path)).toEqual(
      expect.arrayContaining(["createApp", "GET /health", "POST /tickets"])
    );
  });
});
