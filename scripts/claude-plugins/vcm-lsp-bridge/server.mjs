#!/usr/bin/env node

import readline from "node:readline";

const SERVER_INFO = { name: "vcm-code-intelligence-bridge", version: "2.0.0" };
const READY_RETRY_MS = 2_000;
const READY_TIMEOUT_MS = 300_000;

const tools = [
  tool("status", "Read the VCM shared language-server state for the active task.", {}),
  tool("document_symbols", "List symbols parsed from one project source file.", {
    path: stringProperty("Repo-relative project source path.")
  }, ["path"]),
  tool("workspace_symbols", "Find project symbols through the shared language server.", {
    language: stringProperty("Project language: rust, typescript, python, go, cpp, or java."),
    query: stringProperty("Symbol-name query.")
  }, ["language", "query"]),
  positionTool("definition", "Resolve the definition at a project source position."),
  positionTool("implementations", "Resolve implementations at a project source position."),
  positionTool("references", "Resolve project references at a project source position."),
  positionTool("incoming_calls", "Resolve callers through LSP call hierarchy."),
  positionTool("outgoing_calls", "Resolve callees through LSP call hierarchy."),
  positionTool("hover", "Read type and documentation information at a project source position.")
];

const lineReader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lineReader.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  void handleMessage(line);
});

async function handleMessage(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) {
    return;
  }
  try {
    if (message.method === "initialize") {
      respond(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
      return;
    }
    if (message.method === "ping") {
      respond(message.id, {});
      return;
    }
    if (message.method === "tools/list") {
      respond(message.id, { tools });
      return;
    }
    if (message.method === "tools/call") {
      const name = String(message.params?.name ?? "");
      if (!tools.some((candidate) => candidate.name === name)) {
        throw new Error(`Unknown VCM code intelligence tool: ${name}`);
      }
      const result = await callBackend(name, message.params?.arguments ?? {});
      respond(message.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: false,
        structuredContent: result
      });
      return;
    }
    respondError(message.id, -32601, `Method not found: ${message.method}`);
  } catch (error) {
    respond(message.id, {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true
    });
  }
}

async function callBackend(operation, args) {
  const apiUrl = requiredEnv("VCM_API_URL");
  const payload = {
    taskSlug: requiredEnv("VCM_TASK_SLUG"),
    role: requiredEnv("VCM_ROLE"),
    runtimeSessionToken: requiredEnv("VCM_RUNTIME_SESSION_TOKEN"),
    operation,
    ...args
  };
  const startedAt = Date.now();
  for (;;) {
    const response = await fetch(`${apiUrl}/api/code-intelligence/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = body?.error?.hint || body?.error?.message || `HTTP ${response.status}`;
      throw new Error(`VCM shared LSP query failed: ${detail}`);
    }
    if (body?.errorCode !== "LSP_INDEXING" || Date.now() - startedAt >= READY_TIMEOUT_MS) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_RETRY_MS));
  }
}

function tool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false
    }
  };
}

function positionTool(name, description) {
  return tool(name, description, {
    path: stringProperty("Repo-relative project source path."),
    line: numberProperty("One-based source line."),
    character: numberProperty("One-based source column; defaults to 1.")
  }, ["path", "line"]);
}

function stringProperty(description) {
  return { type: "string", description };
}

function numberProperty(description) {
  return { type: "integer", minimum: 1, description };
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the VCM code intelligence bridge.`);
  }
  return value;
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
