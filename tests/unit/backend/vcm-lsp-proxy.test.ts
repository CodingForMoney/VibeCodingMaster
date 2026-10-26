import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VCM_LSP_PROXY_PATH } from "../../../src/backend/services/lsp-plugin.js";
// @ts-expect-error The proxy is a plain ES module shipped with the LSP plugin.
import { createMessageReader, frameMessage } from "../../../scripts/claude-plugins/vcm-lsp-bridge/vcm-lsp-proxy.mjs";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

// A language server that reports indexing through work-done progress after
// "initialized", and answers references with whether indexing had finished.
const FAKE_SERVER = String.raw`
const indexMs = Number(process.env.FAKE_INDEX_MS);
let buffer = Buffer.alloc(0);
let indexed = false;
let initializeCapabilities;
let createAnswered = false;
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write("Content-Length: " + body.length + "\r\n\r\n");
  process.stdout.write(body);
};
const handle = (message) => {
  if (message.method === "initialize") {
    initializeCapabilities = message.params.capabilities;
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
  } else if (message.method === "initialized") {
    send({ jsonrpc: "2.0", id: "create-1", method: "window/workDoneProgress/create", params: { token: "index" } });
    send({ jsonrpc: "2.0", method: "$/progress", params: { token: "index", value: { kind: "begin", title: "Indexing" } } });
    setTimeout(() => {
      indexed = true;
      send({ jsonrpc: "2.0", method: "$/progress", params: { token: "index", value: { kind: "end" } } });
    }, indexMs);
  } else if (message.id === "create-1") {
    createAnswered = true;
  } else if (message.method === "textDocument/references") {
    send({ jsonrpc: "2.0", id: message.id, result: { indexed } });
  } else if (message.method === "vcm/debug") {
    send({ jsonrpc: "2.0", id: message.id, result: { initializeCapabilities, createAnswered, indexed } });
  }
};
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    handle(JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()));
    buffer = buffer.subarray(end + 4 + length);
  }
});
`;

let tmpDir: string | undefined;
let proxy: ChildProcessWithoutNullStreams | undefined;

afterEach(async () => {
  proxy?.kill();
  proxy = undefined;
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

async function startProxy(env: Record<string, string>) {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "vcm-lsp-proxy-"));
  const serverPath = path.join(tmpDir, "fake-server.cjs");
  await writeFile(serverPath, FAKE_SERVER);
  proxy = spawn(process.execPath, [VCM_LSP_PROXY_PATH, "--", process.execPath, serverPath], {
    env: { ...process.env, VCM_LSP_STARTUP_GRACE_MS: "50", ...env }
  });
  const received: JsonRpcMessage[] = [];
  const waiters: Array<() => void> = [];
  proxy.stdout.on("data", createMessageReader((message: JsonRpcMessage) => {
    received.push(message);
    waiters.splice(0).forEach((wake) => wake());
  }));
  const send = (message: JsonRpcMessage) => proxy!.stdin.write(frameMessage(message));
  const response = async (id: number) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const found = received.find((message) => message.id === id && !message.method);
      if (found) {
        return found;
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    throw new Error(`No response for request ${id}`);
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: { window: {} } } });
  await response(1);
  send({ jsonrpc: "2.0", method: "initialized", params: {} });
  return { send, response, received };
}

const references = (id: number): JsonRpcMessage => ({
  jsonrpc: "2.0",
  id,
  method: "textDocument/references",
  params: { textDocument: { uri: "file:///a.ts" }, position: { line: 0, character: 0 }, context: { includeDeclaration: false } }
});

describe("vcm-lsp-proxy", () => {
  it("enables progress reporting and answers it on behalf of a client that did not ask for it", async () => {
    const client = await startProxy({ FAKE_INDEX_MS: "100" });

    client.send(references(2));
    await client.response(2);
    client.send({ jsonrpc: "2.0", id: 3, method: "vcm/debug" });
    const debug = await client.response(3);

    expect(debug.result).toMatchObject({
      initializeCapabilities: { window: { workDoneProgress: true }, experimental: { serverStatusNotification: true } },
      createAnswered: true
    });
    // The client never asked for progress, so none of it reaches the client.
    expect(client.received.some((message) => message.method === "$/progress")).toBe(false);
    expect(client.received.some((message) => message.method === "window/workDoneProgress/create")).toBe(false);
  });

  it("holds navigation queries until indexing finishes", async () => {
    const client = await startProxy({ FAKE_INDEX_MS: "300" });

    client.send(references(2));
    const answer = await client.response(2);

    expect(answer.result).toEqual({ indexed: true });
  });

  it("fails a navigation query explicitly when indexing does not finish in time", async () => {
    const client = await startProxy({ FAKE_INDEX_MS: "60000", VCM_LSP_READY_TIMEOUT_MS: "200" });

    client.send(references(2));
    const answer = await client.response(2);

    expect(answer.result).toBeUndefined();
    expect(answer.error?.code).toBe(-32803);
    expect(answer.error?.message).toContain("Language server is still indexing (Indexing)");
    // Other requests still pass straight through while indexing continues.
    client.send({ jsonrpc: "2.0", id: 3, method: "vcm/debug" });
    expect((await client.response(3)).result).toMatchObject({ indexed: false });
  });

  it("cancels a held query when the client cancels it", async () => {
    const client = await startProxy({ FAKE_INDEX_MS: "60000" });

    client.send(references(2));
    client.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 2 } });
    const answer = await client.response(2);

    expect(answer.error?.code).toBe(-32800);
  });

  it("exits with the server so Claude Code can restart a crashed server", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "vcm-lsp-proxy-"));
    // stdin stays open, as it does while Claude Code is connected.
    proxy = spawn(process.execPath, [VCM_LSP_PROXY_PATH, "--", process.execPath, "-e", "setTimeout(() => process.exit(3), 100)"]);
    const exitCode = await new Promise<number | null>((resolve) => proxy!.on("exit", resolve));

    expect(exitCode).toBe(3);
  });
});
