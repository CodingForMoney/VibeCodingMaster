#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import {
  DEFAULT_BACKEND_PORT,
  DEFAULT_FRONTEND_PORT
} from "./shared/constants.js";
import { getDefaultStaticDir, startServer } from "./backend/server.js";

export interface MainOptions {
  dev?: boolean;
  help?: boolean;
  host?: string;
  port?: number;
  open?: boolean;
  version?: boolean;
}

export function parseMainArgs(argv: string[]): MainOptions {
  const options: MainOptions = {};
  for (const arg of argv) {
    if (arg === "--dev") {
      options.dev = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--open") {
      options.open = true;
    } else if (arg === "--version" || arg === "-v") {
      options.version = true;
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
    } else if (arg.startsWith("--port=")) {
      options.port = Number(arg.slice("--port=".length));
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseMainArgs(argv);
  if (options.version) {
    console.log(readPackageVersion());
    return;
  }
  if (options.help) {
    console.log(renderHelp());
    return;
  }

  const backendPort = options.port ?? DEFAULT_BACKEND_PORT;
  const host = options.host ?? "127.0.0.1";
  const backend = await startServer({
    host,
    port: backendPort,
    staticDir: options.dev ? undefined : getDefaultStaticDir(),
    dev: options.dev
  });
  let vite: ViteDevServer | undefined;

  if (options.dev) {
    const { createServer: createViteDevServer } = await import("vite");
    vite = await createViteDevServer({
      server: {
        host,
        port: DEFAULT_FRONTEND_PORT,
        proxy: {
          "/api": backend.url,
          "/ws": {
            target: backend.url.replace("http:", "ws:"),
            ws: true
          }
        }
      }
    });
    await vite.listen();
    vite.printUrls();
  } else {
    console.log(`VibeCodingMaster is running at ${backend.url}`);
  }

  process.once("SIGINT", async () => {
    await vite?.close();
    await backend.close();
    process.exit(0);
  });
}

function readPackageVersion(): string {
  const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    if (typeof packageJson.version === "string" && packageJson.version.trim()) {
      return packageJson.version;
    }
  } catch {
    // Fall through to an explicit unknown version instead of starting the server.
  }
  return "unknown";
}

function renderHelp(): string {
  return `Usage:
  vcm [options]

Options:
  --host=<host>     Host to bind. Default: 127.0.0.1
  --port=<port>     Backend port. Default: ${DEFAULT_BACKEND_PORT}
  --open            Open behavior flag for compatible launchers.
  --dev             Start with Vite dev frontend.
  -v, --version     Print VCM version and exit.
  -h, --help        Print this help and exit.`;
}

function isMainModule(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) {
    return false;
  }

  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(argvPath) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(argvPath) === modulePath;
  }
}

if (isMainModule()) {
  void main();
}
