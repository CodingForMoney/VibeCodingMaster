import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const lines = content.replace(/^\s*\n/, "").trimEnd().split("\n");
  const commonIndent = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)?.[0].length ?? 0)
  );
  await writeFile(filePath, `${lines.map((line) => line.slice(commonIndent)).join("\n")}\n`);
}

async function installHarnessTools(repoRoot: string) {
  const toolsRoot = path.join(repoRoot, ".ai/tools");
  await mkdir(toolsRoot, { recursive: true });
  await cp(path.join(appRoot, "scripts/harness-tools/check-durable-docs"), path.join(toolsRoot, "check-durable-docs"));
  await cp(path.join(appRoot, ".ai/tools/check-scaffold-ledger"), path.join(toolsRoot, "check-scaffold-ledger"));
  await cp(path.join(appRoot, "scripts/harness-tools/generate-module-index"), path.join(toolsRoot, "generate-module-index"));
  await cp(path.join(appRoot, "scripts/harness-tools/generate-public-surface"), path.join(toolsRoot, "generate-public-surface"));
  await cp(path.join(appRoot, "scripts/harness-tools/run-long-check"), path.join(toolsRoot, "run-long-check"));
  await cp(path.join(appRoot, "scripts/harness-tools/watch-job"), path.join(toolsRoot, "watch-job"));
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
      app.get<{ Querystring: Record<string, string | undefined> }>("/tickets", async () => ({ tickets: [] }));
      app.patch<{ Params: { id: string } }>("/tickets/:id", async () => ({ id: "T-1" }));
      app.post<{ Params: { id: string } }>("/tickets/:id/comments", async () => ({ id: "comment-1" }));
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

async function createRustWorkspaceWithNestedTarget(repoRoot: string) {
  await writeSource(path.join(repoRoot, "Cargo.toml"), `
    [package]
    name = "demo-rust"
    version = "0.1.0"
    edition = "2021"
  `);
  await writeSource(path.join(repoRoot, "src/lib.rs"), `
    pub fn answer() -> u32 {
        42
    }
  `);
  await writeSource(path.join(repoRoot, "tests/integration.rs"), `
    #[test]
    fn answer_is_stable() {
        assert_eq!(demo_rust::answer(), 42);
    }
  `);
  await writeSource(path.join(repoRoot, "tests/fixture/src/lib.rs"), `
    pub fn fixture_value() -> u32 {
        7
    }
  `);
  await writeSource(path.join(repoRoot, "tests/fixture/target/debug/build/demo/out/generated.rs"), `
    pub const GENERATED: u32 = 99;
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
      expect.arrayContaining([
        "createApp",
        "GET /health",
        "GET /tickets",
        "PATCH /tickets/:id",
        "POST /tickets/:id/comments",
        "POST /tickets"
      ])
    );
  });

  it("excludes Rust target build outputs from module indexes", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-harness-tools-"));
    await installHarnessTools(tmpRepo);
    await createRustWorkspaceWithNestedTarget(tmpRepo);

    await execFileAsync("python3", [path.join(tmpRepo, ".ai/tools/generate-module-index")], { cwd: tmpRepo });
    const moduleIndex = JSON.parse(await readFile(path.join(tmpRepo, ".ai/generated/module-index.json"), "utf8"));
    const modules = moduleIndex.layers.flatMap(
      (layer: { modules: Array<{ files: { source: string[]; tests: string[] } }> }) => layer.modules
    );
    const files = modules.flatMap((module: { files: { source: string[]; tests: string[] } }) => [
      ...module.files.source,
      ...module.files.tests
    ]);

    expect(files).toEqual(expect.arrayContaining([
      "src/lib.rs",
      "tests/integration.rs",
      "tests/fixture/src/lib.rs"
    ]));
    expect(files.some((filePath: string) => filePath.includes("/target/"))).toBe(false);

    await expect(
      execFileAsync("python3", [path.join(tmpRepo, ".ai/tools/generate-module-index"), "--check"], { cwd: tmpRepo })
    ).resolves.toBeTruthy();
  });
});

describe("long-running validation tools", () => {
  async function startLongCheck(command: string[]) {
    const result = await execFileAsync(
      "python3",
      [
        path.join(tmpRepo!, ".ai/tools/run-long-check"),
        "--timeout",
        "10s",
        "--",
        ...command
      ],
      { cwd: tmpRepo }
    );
    const jobId = result.stdout.match(/^job: (.+)$/m)?.[1];
    expect(jobId).toBeTruthy();
    return jobId!;
  }

  async function watchLongCheck(jobId: string) {
    try {
      const result = await execFileAsync(
        "python3",
        [
          path.join(tmpRepo!, ".ai/tools/watch-job"),
          jobId,
          "--window",
          "5s",
          "--interval",
          "50ms"
        ],
        { cwd: tmpRepo }
      );
      return { exitCode: 0, stdout: result.stdout };
    } catch (error) {
      const failed = error as Error & { code?: number; stdout?: string };
      return { exitCode: failed.code, stdout: failed.stdout ?? "" };
    }
  }

  it("preserves direct validation command success and failure exit codes", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-long-check-"));
    await installHarnessTools(tmpRepo);

    const successJob = await startLongCheck([process.execPath, "-e", "process.exit(0)"]);
    await expect(watchLongCheck(successJob)).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("status: success")
    });

    const failedJob = await startLongCheck([process.execPath, "-e", "process.exit(7)"]);
    await expect(watchLongCheck(failedJob)).resolves.toMatchObject({
      exitCode: 1,
      stdout: expect.stringContaining("status: failed")
    });
    await expect(
      readFile(path.join(tmpRepo, ".ai/vcm/jobs", failedJob, "status.json"), "utf8")
    ).resolves.toContain('"exitCode": 7');
  }, 20_000);

  it("rejects shell command-string wrappers before creating a job", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-long-check-"));
    await installHarnessTools(tmpRepo);
    const runLongCheck = path.join(tmpRepo, ".ai/tools/run-long-check");

    await expect(
      execFileAsync(
        "python3",
        [
          runLongCheck,
          "--timeout",
          "10s",
          "--",
          "bash",
          "-c",
          "false | tail -n 1; echo done"
        ],
        { cwd: tmpRepo }
      )
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("command-string wrappers are not allowed")
    });

    await expect(
      execFileAsync(
        "python3",
        [
          runLongCheck,
          "--timeout",
          "10s",
          "--",
          "env",
          "DEMO=1",
          "sh",
          "-c",
          "false; echo done"
        ],
        { cwd: tmpRepo }
      )
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("command-string wrappers are not allowed")
    });

    await expect(access(path.join(tmpRepo, ".ai/vcm/jobs"))).rejects.toBeTruthy();
  });
});

describe("scaffold ledger audit", () => {
  async function createLedgerRepo(planRow: string, source: string) {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-scaffold-ledger-"));
    await installHarnessTools(tmpRepo);
    await execFileAsync("git", ["init"], { cwd: tmpRepo });
    await writeSource(path.join(tmpRepo, "src/lib.ts"), source);
    await execFileAsync("git", ["add", "src/lib.ts"], { cwd: tmpRepo });
    await writeSource(path.join(tmpRepo, ".ai/vcm/handoffs/architecture-plan.md"), `
      # Architecture Plan

      ## Scaffold Manifest

      | ID | Action | File | Symbol | Work | Freedom | Proof |
      | --- | --- | --- | --- | --- | --- | --- |
      ${planRow}
    `);
  }

  async function runLedgerAuditFailure() {
    try {
      await execFileAsync("python3", [path.join(tmpRepo!, ".ai/tools/check-scaffold-ledger")], { cwd: tmpRepo });
      throw new Error("expected scaffold ledger audit to fail");
    } catch (error) {
      return (error as Error & { stderr?: string }).stderr ?? "";
    }
  }

  it("accepts an exact ledger-to-marker mapping", async () => {
    await createLedgerRepo(
      "| SCF-001 | change | `src/lib.ts` | `run` | implement | local | compile |",
      "export function run() { // VCM:CODE SCF-001\n  return true;\n}"
    );

    await expect(
      execFileAsync("python3", [path.join(tmpRepo!, ".ai/tools/check-scaffold-ledger")], { cwd: tmpRepo })
    ).resolves.toMatchObject({ stdout: expect.stringContaining("ledger reconciliation clean") });
  });

  it("rejects asset rows and their missing markers", async () => {
    await createLedgerRepo(
      "| SCF-001 | asset | `dist/output.json` | output | generate | none | exists |",
      "export const ready = true;"
    );

    const stderr = await runLedgerAuditFailure();
    expect(stderr).toContain("action column is not exactly one of create/change/delete");
    expect(stderr).toContain("SCF-001 has no marker");
  });

  it("rejects missing and unmanifested markers", async () => {
    await createLedgerRepo(
      "| SCF-001 | change | `src/lib.ts` | `run` | implement | local | compile |",
      "// VCM:CODE SCF-002\nexport const ready = true;"
    );

    const stderr = await runLedgerAuditFailure();
    expect(stderr).toContain("SCF-001 has no marker");
    expect(stderr).toContain("marker SCF-002 has no ledger entry");
  });
});

describe("durable documentation audit", () => {
  it("accepts current-state durable docs backed by generated module facts", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-durable-docs-"));
    await installHarnessTools(tmpRepo);
    await writeSource(path.join(tmpRepo, "docs/known-issues.md"), `
      # Known Issues

      No known issues.
    `);
    await writeSource(path.join(tmpRepo, "docs/plans/current.md"), `
      # Current Plan

      Status: active
    `);
    await writeSource(path.join(tmpRepo, "docs/ARCHITECTURE.md"), `
      # Architecture

      | Layer | Module Count |
      | --- | ---: |
      | application | 1 |
    `);
    await writeSource(path.join(tmpRepo, "application/api/ARCHITECTURE.md"), `
      # API Architecture

      Owns request handling and response contracts.
    `);
    await writeSource(path.join(tmpRepo, "docs/TESTING.md"), `
      # Testing

      Run unit tests with \`npm test\`.
    `);
    await writeJson(path.join(tmpRepo, ".ai/generated/module-index.json"), {
      layers: [
        {
          name: "application",
          modules: [
            {
              name: "api",
              architectureDoc: "application/api/ARCHITECTURE.md"
            }
          ]
        }
      ]
    });

    const result = await execFileAsync("python3", [path.join(tmpRepo, ".ai/tools/check-durable-docs")], {
      cwd: tmpRepo
    });

    expect(result.stdout).toContain("Durable docs audit passed.");
  });

  it("rejects resolved issue history, completed active plans, stale generated facts, and task history", async () => {
    tmpRepo = await mkdtemp(path.join(os.tmpdir(), "vcm-durable-docs-"));
    await installHarnessTools(tmpRepo);
    await writeSource(path.join(tmpRepo, "docs/known-issues.md"), `
      # Known Issues

      ## KI-1 Stale entry

      - status: open
      - category: docs
      - affected modules/surfaces: docs
      - current gap: RESOLVED in the last task
      - impact: none
      - mitigation or workaround: None
      - resolution condition: remove this entry
      - related issues: None
    `);
    await writeSource(path.join(tmpRepo, "docs/plans/completed.md"), `
      # Completed Plan

      Status: completed
    `);
    await writeSource(path.join(tmpRepo, "docs/ARCHITECTURE.md"), `
      # Architecture

      SCF-001 introduced the module.

      | Layer | Module Count |
      | --- | ---: |
      | application | 1 |
    `);
    await writeSource(path.join(tmpRepo, "application/api/ARCHITECTURE.md"), `
      # API Architecture

      Tester confirmed this design.
    `);
    await writeSource(path.join(tmpRepo, "docs/TESTING.md"), `
      # Testing

      Reviewer-owned L2 validation.
    `);
    await writeJson(path.join(tmpRepo, ".ai/generated/module-index.json"), {
      layers: [
        {
          name: "application",
          modules: [
            { name: "api", architectureDoc: "application/api/ARCHITECTURE.md" },
            { name: "worker", architectureDoc: "application/worker/ARCHITECTURE.md" }
          ]
        }
      ]
    });

    let output = "";
    try {
      await execFileAsync("python3", [path.join(tmpRepo, ".ai/tools/check-durable-docs")], { cwd: tmpRepo });
    } catch (error) {
      output = (error as Error & { stdout?: string }).stdout ?? "";
    }

    expect(output).toContain("DD_KI_RESOLVED_HISTORY");
    expect(output).toContain("DD_ACTIVE_PLAN_TERMINAL");
    expect(output).toContain("DD_ARCH_TASK_LABEL");
    expect(output).toContain("DD_ARCH_GENERATED_COUNT");
    expect(output).toContain("DD_MODULE_ARCH_MISSING");
    expect(output).toContain("DD_TEST_LEGACY_OWNER");
  });
});
