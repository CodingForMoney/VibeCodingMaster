#!/usr/bin/env node
// Stdio proxy between Claude Code's LSP client and one language server.
//
// Usage: node vcm-lsp-proxy.mjs -- <server-command> [server-args...]
//
// A language server that is still loading or indexing answers navigation
// queries with partial or empty results, which reads as "no references".
// The proxy tracks the server's work-done progress (and rust-analyzer's
// quiescence status), holds navigation queries until the server is idle, and
// fails a query with an explicit "still indexing" error when the server does
// not become idle in time. Every other message passes through unchanged.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NAVIGATION_METHODS = new Set([
  "textDocument/definition",
  "textDocument/declaration",
  "textDocument/typeDefinition",
  "textDocument/implementation",
  "textDocument/references",
  "textDocument/hover",
  "textDocument/documentSymbol",
  "textDocument/prepareCallHierarchy",
  "callHierarchy/incomingCalls",
  "callHierarchy/outgoingCalls",
  "workspace/symbol"
]);

const READY_TIMEOUT_MS = positiveNumber(process.env.VCM_LSP_READY_TIMEOUT_MS, 180_000);
// Servers announce indexing shortly after "initialized"; a query sent before
// any progress appears waits this long for indexing to start.
const STARTUP_GRACE_MS = positiveNumber(process.env.VCM_LSP_STARTUP_GRACE_MS, 2_000);
const REQUEST_FAILED = -32803;
const REQUEST_CANCELLED = -32800;

function positiveNumber(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Parses Content-Length framed JSON-RPC messages from a byte stream.
export function createMessageReader(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Unframed bytes cannot be routed; drop the header and resynchronize.
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) {
        return;
      }
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      onMessage(JSON.parse(body));
    }
  };
}

export function frameMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

// Readiness state shared by both directions of the proxy.
export function createReadinessTracker(options = {}) {
  const now = options.now ?? Date.now;
  const activeProgress = new Map();
  let quiescent = true;
  let initializedAt;
  let progressSeen = false;
  const listeners = new Set();

  function notify() {
    for (const listener of [...listeners]) {
      listener();
    }
  }

  return {
    markInitialized() {
      initializedAt = now();
    },
    progressBegin(token, title) {
      progressSeen = true;
      activeProgress.set(String(token), title || "indexing");
      notify();
    },
    progressEnd(token) {
      activeProgress.delete(String(token));
      notify();
    },
    serverStatus(isQuiescent) {
      progressSeen = true;
      quiescent = isQuiescent;
      notify();
    },
    // Remaining startup grace in ms, or 0 once it no longer applies.
    graceRemaining() {
      if (progressSeen || initializedAt === undefined) {
        return 0;
      }
      return Math.max(0, initializedAt + (options.startupGraceMs ?? STARTUP_GRACE_MS) - now());
    },
    isBusy() {
      return activeProgress.size > 0 || !quiescent;
    },
    busyReason() {
      const titles = [...new Set(activeProgress.values())];
      if (!quiescent) {
        titles.push("server not quiescent");
      }
      return titles.join(", ") || "starting up";
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export function startProxy({ command, args, input, output, errorOutput, readyTimeoutMs = READY_TIMEOUT_MS, startupGraceMs = STARTUP_GRACE_MS }) {
  const server = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  const readiness = createReadinessTracker({ startupGraceMs });
  const pending = new Map();
  let clientWantsProgress = false;
  let clientWantsServerStatus = false;

  const toClient = (message) => output.write(frameMessage(message));
  const toServer = (message) => {
    if (server.stdin.writable) {
      server.stdin.write(frameMessage(message));
    }
  };

  server.stderr.pipe(errorOutput);
  server.on("error", (error) => {
    errorOutput.write(`vcm-lsp-proxy: cannot start ${command}: ${error.message}\n`);
    process.exitCode = 1;
    output.end?.();
  });
  server.on("exit", (code, signal) => {
    for (const entry of pending.values()) {
      entry.dispose();
    }
    process.exitCode = code ?? (signal ? 1 : 0);
    output.end?.();
  });

  function releaseWhenReady(message) {
    const key = String(message.id);
    let timer;
    let graceTimer;
    let unsubscribe = () => undefined;
    const dispose = () => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      unsubscribe();
      pending.delete(key);
    };
    const attempt = () => {
      const grace = readiness.graceRemaining();
      if (grace > 0) {
        clearTimeout(graceTimer);
        graceTimer = setTimeout(attempt, grace);
        return;
      }
      if (!readiness.isBusy()) {
        dispose();
        toServer(message);
      }
    };
    pending.set(key, {
      dispose,
      cancel() {
        dispose();
        toClient({ jsonrpc: "2.0", id: message.id, error: { code: REQUEST_CANCELLED, message: "Request cancelled." } });
      }
    });
    unsubscribe = readiness.onChange(attempt);
    timer = setTimeout(() => {
      dispose();
      toClient({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: REQUEST_FAILED,
          message: `Language server is still indexing (${readiness.busyReason()}) after ${Math.round(readyTimeoutMs / 1000)}s; ${message.method} results would be incomplete. Retry after indexing finishes, or record the relationship as unresolved.`
        }
      });
    }, readyTimeoutMs);
    attempt();
  }

  input.on("data", createMessageReader((message) => {
    if (message.method === "initialize" && message.params) {
      const capabilities = message.params.capabilities ?? {};
      clientWantsProgress = capabilities.window?.workDoneProgress === true;
      clientWantsServerStatus = capabilities.experimental?.serverStatusNotification === true;
      message.params.capabilities = {
        ...capabilities,
        window: { ...capabilities.window, workDoneProgress: true },
        experimental: { ...capabilities.experimental, serverStatusNotification: true }
      };
    }
    if (message.method === "initialized") {
      readiness.markInitialized();
    }
    if (message.method === "$/cancelRequest" && pending.has(String(message.params?.id))) {
      pending.get(String(message.params.id)).cancel();
      return;
    }
    if (message.id !== undefined && NAVIGATION_METHODS.has(message.method)) {
      releaseWhenReady(message);
      return;
    }
    toServer(message);
  }));
  input.on("end", () => server.stdin.end());

  server.stdout.on("data", createMessageReader((message) => {
    if (message.method === "window/workDoneProgress/create") {
      if (!clientWantsProgress) {
        toServer({ jsonrpc: "2.0", id: message.id, result: null });
        return;
      }
    } else if (message.method === "$/progress") {
      const value = message.params?.value;
      if (value?.kind === "begin") {
        readiness.progressBegin(message.params.token, value.title);
      } else if (value?.kind === "end") {
        readiness.progressEnd(message.params.token);
      }
      if (!clientWantsProgress) {
        return;
      }
    } else if (message.method === "experimental/serverStatus") {
      readiness.serverStatus(message.params?.quiescent !== false);
      if (!clientWantsServerStatus) {
        return;
      }
    }
    toClient(message);
  }));

  return { server, readiness };
}

const separator = process.argv.indexOf("--");
if (separator >= 0 && process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(separator + 1);
  if (!command) {
    process.stderr.write("usage: vcm-lsp-proxy.mjs -- <server-command> [args...]\n");
    process.exit(2);
  }
  const { server } = startProxy({ command, args, input: process.stdin, output: process.stdout, errorOutput: process.stderr });
  // Exit with the server so Claude Code sees the crash and restarts it; an open
  // stdin would otherwise keep the proxy alive with no server behind it.
  server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  server.on("error", () => process.exit(1));
}
