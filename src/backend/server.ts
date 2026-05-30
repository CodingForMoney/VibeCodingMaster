import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { ArtifactService } from "./services/artifact-service.js";
import { createArtifactService } from "./services/artifact-service.js";
import { createClaudeAdapter } from "./adapters/claude-adapter.js";
import { createCommandRunner } from "./adapters/command-runner.js";
import { createCommandDispatcher, type CommandDispatcher } from "./services/command-dispatcher.js";
import { createGitAdapter } from "./adapters/git-adapter.js";
import { createHarnessService, type HarnessService } from "./services/harness-service.js";
import { createNodeFileSystemAdapter } from "./adapters/filesystem.js";
import { createNodePtyTerminalRuntime } from "./runtime/node-pty-runtime.js";
import { createProjectService, type ProjectService } from "./services/project-service.js";
import { createSessionRegistry } from "./runtime/session-registry.js";
import { createSessionService, type SessionService } from "./services/session-service.js";
import { createMessageService, type MessageService } from "./services/message-service.js";
import { createStatusService, type StatusService } from "./services/status-service.js";
import { createTaskService, type TaskService } from "./services/task-service.js";
import { registerArtifactRoutes } from "./api/artifact-routes.js";
import { registerHarnessRoutes } from "./api/harness-routes.js";
import { registerMessageRoutes } from "./api/message-routes.js";
import { registerProjectRoutes } from "./api/project-routes.js";
import { registerSessionRoutes } from "./api/session-routes.js";
import { registerTaskRoutes } from "./api/task-routes.js";
import { registerTerminalWs } from "./ws/terminal-ws.js";
import { toVcmError } from "./errors.js";
import type { TerminalRuntime } from "./runtime/terminal-runtime.js";

export interface CreateServerOptions {
  host?: string;
  port?: number;
  staticDir?: string;
  dev?: boolean;
}

export interface ServerDeps {
  projectService: ProjectService;
  taskService: TaskService;
  sessionService: SessionService;
  artifactService: ArtifactService;
  harnessService: HarnessService;
  commandDispatcher: CommandDispatcher;
  messageService: MessageService;
  statusService: StatusService;
  runtime: TerminalRuntime;
}

export async function createServer(deps: ServerDeps, options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false
  });

  app.setErrorHandler((error, _request, reply) => {
    const vcmError = toVcmError(error);
    reply.status(vcmError.statusCode).send({
      error: {
        code: vcmError.code,
        message: vcmError.message,
        hint: vcmError.hint
      }
    });
  });

  registerProjectRoutes(app, { projectService: deps.projectService });
  registerHarnessRoutes(app, {
    projectService: deps.projectService,
    harnessService: deps.harnessService
  });
  registerTaskRoutes(app, {
    projectService: deps.projectService,
    taskService: deps.taskService,
    statusService: deps.statusService
  });
  registerSessionRoutes(app, {
    projectService: deps.projectService,
    sessionService: deps.sessionService,
    commandDispatcher: deps.commandDispatcher
  });
  registerArtifactRoutes(app, {
    projectService: deps.projectService,
    taskService: deps.taskService,
    artifactService: deps.artifactService
  });
  registerMessageRoutes(app, {
    projectService: deps.projectService,
    taskService: deps.taskService,
    messageService: deps.messageService
  });
  registerTerminalWs(app, { runtime: deps.runtime });

  if (options.staticDir) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: "/"
    });
    app.setNotFoundHandler((_request, reply) => {
      reply.sendFile("index.html");
    });
  }

  return app;
}

export async function startServer(options: CreateServerOptions = {}): Promise<{ url: string; close(): Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4173;
  const deps = createDefaultServerDeps({
    apiUrl: `http://${host}:${port}`
  });
  const app = await createServer(deps, options);
  await app.listen({ host, port });

  return {
    url: `http://${host}:${port}`,
    close() {
      return app.close();
    }
  };
}

export interface CreateDefaultServerDepsOptions {
  apiUrl?: string;
  vcmctlCommand?: string;
}

export function createDefaultServerDeps(options: CreateDefaultServerDepsOptions = {}): ServerDeps {
  const fs = createNodeFileSystemAdapter();
  const runner = createCommandRunner();
  const git = createGitAdapter(runner);
  const claude = createClaudeAdapter(runner);
  const runtime = createNodePtyTerminalRuntime({ fs });
  const registry = createSessionRegistry();
  const artifactService = createArtifactService(fs);
  const harnessService = createHarnessService({ fs });
  const projectService = createProjectService({ fs, git, claude });
  const taskService = createTaskService({ fs, git, artifactService, projectService });
  const sessionService = createSessionService({
    fs,
    runtime,
    registry,
    claude,
    artifactService,
    projectService,
    taskService,
    apiUrl: options.apiUrl,
    vcmctlCommand: options.vcmctlCommand ?? resolveVcmctlCommand()
  });
  const commandDispatcher = createCommandDispatcher({
    runtime,
    sessionService,
    taskService,
    artifactService
  });
  const statusService = createStatusService({
    taskService,
    sessionService,
    artifactService
  });
  const messageService = createMessageService({
    fs,
    runtime,
    sessionService,
    taskService
  });

  return {
    projectService,
    taskService,
    sessionService,
    artifactService,
    harnessService,
    commandDispatcher,
    messageService,
    statusService,
    runtime
  };
}

export function getDefaultStaticDir(): string {
  return path.join(getAppRoot(), "dist-frontend");
}

function resolveVcmctlCommand(): string {
  const appRoot = getAppRoot();
  const currentModulePath = fileURLToPath(import.meta.url);
  const sourceCli = path.join(appRoot, "src", "cli", "vcmctl.ts");
  const tsxCli = path.join(appRoot, "node_modules", "tsx", "dist", "cli.mjs");
  if (currentModulePath.includes(`${path.sep}src${path.sep}`) && existsSync(tsxCli) && existsSync(sourceCli)) {
    return `${quoteShellArg(process.execPath)} ${quoteShellArg(tsxCli)} ${quoteShellArg(sourceCli)}`;
  }

  const distCli = path.join(appRoot, "dist", "cli", "vcmctl.js");
  if (existsSync(distCli)) {
    return `${quoteShellArg(process.execPath)} ${quoteShellArg(distCli)}`;
  }

  if (existsSync(tsxCli) && existsSync(sourceCli)) {
    return `${quoteShellArg(process.execPath)} ${quoteShellArg(tsxCli)} ${quoteShellArg(sourceCli)}`;
  }

  return "vcmctl";
}

function getAppRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
