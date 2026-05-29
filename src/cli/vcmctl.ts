#!/usr/bin/env node
import fs from "node:fs/promises";
import type { RoleName } from "../shared/types/role.js";
import type { SendRoleMessageRequest, VcmMessageType } from "../shared/types/message.js";

interface CliOptions {
  to?: RoleName;
  type?: VcmMessageType;
  body?: string;
  bodyFile?: string;
  artifactRefs: string[];
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "send") {
    const options = parseOptions(rest);
    await sendMessage({
      fromRole: getEnvRole(),
      toRole: requireOption(options.to, "--to"),
      type: options.type ?? "task",
      body: await resolveBody(options),
      artifactRefs: options.artifactRefs
    });
    return;
  }

  if (command === "reply" || command === "result") {
    const options = parseOptions(rest);
    await sendMessage({
      fromRole: getEnvRole(),
      toRole: "project-manager",
      type: command === "result" ? "result" : options.type ?? "question",
      body: await resolveBody(options),
      artifactRefs: options.artifactRefs
    });
    return;
  }

  if (command === "inbox") {
    const response = await fetchJson(`${getApiUrl()}/api/tasks/${encodeURIComponent(getTaskSlug())}/messages`);
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  if (command === "ready") {
    console.log("ready: VCM readiness signaling is planned for a later phase.");
    return;
  }

  throw new Error(`Unknown vcmctl command: ${command}`);
}

async function sendMessage(input: SendRoleMessageRequest): Promise<void> {
  const result = await fetchJson(`${getApiUrl()}/api/tasks/${encodeURIComponent(getTaskSlug())}/messages`, {
    method: "POST",
    body: JSON.stringify(input),
    headers: {
      "content-type": "application/json"
    }
  });
  console.log(JSON.stringify(result, null, 2));
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    artifactRefs: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--to") {
      options.to = requireValue(args, index += 1) as RoleName;
    } else if (arg === "--type") {
      options.type = requireValue(args, index += 1) as VcmMessageType;
    } else if (arg === "--body") {
      options.body = requireValue(args, index += 1);
    } else if (arg === "--body-file") {
      options.bodyFile = requireValue(args, index += 1);
    } else if (arg === "--artifact") {
      options.artifactRefs.push(requireValue(args, index += 1));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

async function resolveBody(options: CliOptions): Promise<string> {
  if (options.bodyFile) {
    return fs.readFile(options.bodyFile, "utf8");
  }
  if (options.body) {
    return options.body;
  }
  throw new Error("Message body is required. Use --body or --body-file.");
}

function requireValue(args: string[], index: number): string {
  const value = args[index];
  if (!value) {
    throw new Error("Missing option value.");
  }
  return value;
}

function requireOption<T>(value: T | undefined, name: string): T {
  if (!value) {
    throw new Error(`Missing required option: ${name}`);
  }
  return value;
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string; hint?: string } } | null;
    const message = payload?.error?.hint
      ? `${payload.error.message} ${payload.error.hint}`
      : payload?.error?.message ?? `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return response.json();
}

function getApiUrl(): string {
  return process.env.VCM_API_URL ?? "http://127.0.0.1:4173";
}

function getTaskSlug(): string {
  return requireEnv("VCM_TASK_SLUG");
}

function getEnvRole(): RoleName {
  return requireEnv("VCM_ROLE") as RoleName;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

function printHelp(): void {
  console.log(`vcmctl

Usage:
  vcmctl send --to coder --type task --body-file /tmp/message.md
  vcmctl reply --type blocked --body "Need clarification."
  vcmctl result --body-file /tmp/result.md --artifact .ai/handoffs/task/implementation-log.md
  vcmctl inbox
`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
