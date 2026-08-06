import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import { createCommandRunner } from "../../../src/backend/adapters/command-runner.js";
import { createCodeIntelligenceManager } from "../../../src/backend/services/code-intelligence-service.js";
import type { CodeIntelligenceQueryRequest } from "../../../src/shared/types/code-intelligence.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("shared code intelligence manager", () => {
  it("starts one task language server and reuses it across semantic queries", async () => {
    const fixture = await createRustFixture();
    const manager = createCodeIntelligenceManager(createNodeFileSystemAdapter(), {
      runner: createCommandRunner(),
      pathEnv: fixture.toolsDir,
      platform: "linux",
      startupTimeoutMs: 5_000,
      requestTimeoutMs: 5_000
    });

    await manager.activateTask(fixture.repoRoot);
    const ready = await waitForReady(manager, fixture.repoRoot);
    const firstPid = ready.languages[0]?.pid;
    expect(firstPid).toBeTypeOf("number");

    await manager.activateTask(fixture.repoRoot);
    expect((await manager.getStatus(fixture.repoRoot)).languages[0]?.pid).toBe(firstPid);

    const symbols = await manager.query(fixture.repoRoot, request("document_symbols", {
      path: "src/lib.rs"
    }));
    const references = await manager.query(fixture.repoRoot, request("references", {
      path: "src/lib.rs",
      line: 1,
      character: 4
    }));

    expect(symbols).toMatchObject({ status: "resolved", language: "rust" });
    expect(symbols.result).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "demo" })
    ]));
    expect(references).toMatchObject({ status: "resolved", language: "rust" });
    expect(references.result).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/lib.rs" })
    ]));
    expect((await manager.getStatus(fixture.repoRoot)).languages[0]?.pid).toBe(firstPid);

    await manager.shutdown();
    expect((await manager.getStatus(fixture.repoRoot)).languages[0]?.state).toBe("stopped");
  });

  it("synchronizes changed files before the next shared LSP query", async () => {
    const fixture = await createRustFixture();
    const manager = createCodeIntelligenceManager(createNodeFileSystemAdapter(), {
      runner: createCommandRunner(),
      pathEnv: fixture.toolsDir,
      platform: "linux",
      startupTimeoutMs: 5_000,
      requestTimeoutMs: 5_000
    });
    await manager.activateTask(fixture.repoRoot);
    await waitForReady(manager, fixture.repoRoot);

    await fs.writeFile(path.join(fixture.repoRoot, "src/lib.rs"), "pub fn updated() {}\n", "utf8");
    const symbols = await manager.query(fixture.repoRoot, request("document_symbols", {
      path: "src/lib.rs"
    }));

    expect(symbols.status).toBe("resolved");
    expect(symbols.result).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "updated" })
    ]));
    await manager.shutdown();
  });

  it("restarts a task language server once after an unexpected process exit", async () => {
    const fixture = await createRustFixture();
    const manager = createCodeIntelligenceManager(createNodeFileSystemAdapter(), {
      runner: createCommandRunner(),
      pathEnv: fixture.toolsDir,
      platform: "linux",
      startupTimeoutMs: 5_000,
      requestTimeoutMs: 5_000
    });
    await manager.activateTask(fixture.repoRoot);
    const firstPid = (await waitForReady(manager, fixture.repoRoot)).languages[0]?.pid;
    expect(firstPid).toBeTypeOf("number");

    process.kill(firstPid!, "SIGTERM");
    const restarted = await waitForReady(manager, fixture.repoRoot, firstPid);

    expect(restarted.languages[0]?.pid).toBeTypeOf("number");
    expect(restarted.languages[0]?.pid).not.toBe(firstPid);
    await manager.shutdown();
  });
});

async function createRustFixture(): Promise<{ repoRoot: string; toolsDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vcm-shared-lsp-"));
  tempRoots.push(root);
  const repoRoot = path.join(root, "repo");
  const toolsDir = path.join(root, "tools");
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(repoRoot, ".ai/generated"), { recursive: true });
  await fs.mkdir(toolsDir, { recursive: true });
  await fs.writeFile(path.join(repoRoot, "Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "src/lib.rs"), "pub fn demo() {}\n", "utf8");
  await fs.writeFile(path.join(repoRoot, ".ai/generated/module-index.json"), JSON.stringify({ files: ["src/lib.rs"] }), "utf8");
  const serverPath = path.join(toolsDir, "rust-analyzer");
  await fs.writeFile(serverPath, FAKE_LSP_SERVER, "utf8");
  await fs.chmod(serverPath, 0o755);
  return { repoRoot, toolsDir };
}

async function waitForReady(
  manager: ReturnType<typeof createCodeIntelligenceManager>,
  repoRoot: string,
  previousPid?: number
) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const status = await manager.getStatus(repoRoot);
    if (status.languages[0]?.state === "ready" && status.languages[0]?.pid !== previousPid) {
      return status;
    }
    if (status.languages[0]?.state === "server_failed") {
      throw new Error(status.languages[0].error ?? "Fake LSP failed.");
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for shared LSP: ${JSON.stringify(status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function request(
  operation: CodeIntelligenceQueryRequest["operation"],
  fields: Partial<CodeIntelligenceQueryRequest> = {}
): CodeIntelligenceQueryRequest {
  return {
    taskSlug: "demo",
    role: "architect",
    runtimeSessionToken: "runtime-token",
    operation,
    ...fields
  };
}

const FAKE_LSP_SERVER = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("fake-rust-analyzer 1.0");
  process.exit(0);
}
let buffer = Buffer.alloc(0);
const documents = new Map();
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) break;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const length = Number(/Content-Length:\\s*(\\d+)/i.exec(header)?.[1] ?? 0);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) break;
    const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8"));
    buffer = buffer.subarray(bodyStart + length);
    handle(message);
  }
});
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write("Content-Length: " + body.length + "\\r\\n\\r\\n");
  process.stdout.write(body);
}
function respond(id, result) { send({ jsonrpc: "2.0", id, result }); }
function symbolName(uri) {
  const text = documents.get(uri) ?? "";
  return /fn\\s+([A-Za-z0-9_]+)/.exec(text)?.[1] ?? "demo";
}
function location(uri) {
  return { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } } };
}
function handle(message) {
  if (message.method === "initialize") return respond(message.id, { capabilities: {} });
  if (message.method === "textDocument/didOpen") {
    documents.set(message.params.textDocument.uri, message.params.textDocument.text);
    return;
  }
  if (message.method === "textDocument/didChange") {
    documents.set(message.params.textDocument.uri, message.params.contentChanges[0].text);
    return;
  }
  if (message.method === "textDocument/documentSymbol") {
    const uri = message.params.textDocument.uri;
    return respond(message.id, [{ name: symbolName(uri), kind: 12, range: location(uri).range, selectionRange: location(uri).range }]);
  }
  if (message.method === "workspace/symbol") return respond(message.id, []);
  if (["textDocument/definition", "textDocument/implementation", "textDocument/references"].includes(message.method)) {
    return respond(message.id, [location(message.params.textDocument.uri)]);
  }
  if (message.method === "textDocument/hover") return respond(message.id, { contents: "fake hover" });
  if (message.method === "textDocument/prepareCallHierarchy") {
    const uri = message.params.textDocument.uri;
    return respond(message.id, [{ name: symbolName(uri), kind: 12, uri, range: location(uri).range, selectionRange: location(uri).range }]);
  }
  if (message.method === "callHierarchy/incomingCalls" || message.method === "callHierarchy/outgoingCalls") return respond(message.id, []);
  if (message.method === "shutdown") return respond(message.id, null);
  if (message.method === "exit") return process.exit(0);
  if (message.id !== undefined) return respond(message.id, null);
}
`;
