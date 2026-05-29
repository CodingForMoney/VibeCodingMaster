import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteDevServer, type ViteDevServer } from "vite";
import {
  DEFAULT_BACKEND_PORT,
  DEFAULT_FRONTEND_PORT
} from "./shared/constants.js";
import { getDefaultStaticDir, startServer } from "./backend/server.js";

export interface MainOptions {
  dev?: boolean;
  host?: string;
  port?: number;
  open?: boolean;
}

export function parseMainArgs(argv: string[]): MainOptions {
  const options: MainOptions = {};
  for (const arg of argv) {
    if (arg === "--dev") {
      options.dev = true;
    } else if (arg === "--open") {
      options.open = true;
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

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  void main();
}
