import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { ArtifactService } from "./services/artifact-service.js";
import { createArtifactService } from "./services/artifact-service.js";
import { createClaudeAdapter } from "./adapters/claude-adapter.js";
import { createCommandRunner } from "./adapters/command-runner.js";
import { createCommandDispatcher, type CommandDispatcher } from "./services/command-dispatcher.js";
import { createClaudeHookService, type ClaudeHookService } from "./services/claude-hook-service.js";
import { createGitAdapter } from "./adapters/git-adapter.js";
import { createAppSettingsService, type AppSettingsService } from "./services/app-settings-service.js";
import { createClaudeTranscriptService } from "./services/claude-transcript-service.js";
import { createGateReviewService, type GateReviewService } from "./services/gate-review-service.js";
import { createHarnessFeedbackService, type HarnessFeedbackService } from "./services/harness-feedback-service.js";
import { createTranslationWorkerService, type TranslationWorkerService } from "./services/translation-worker-service.js";
import {
  createHarnessService,
  createScriptFixedHarnessInstaller,
  type HarnessService
} from "./services/harness-service.js";
import { createNodeFileSystemAdapter } from "./adapters/filesystem.js";
import { createNodePtyTerminalRuntime } from "./runtime/node-pty-runtime.js";
import { registerGatewayRoutes } from "./api/gateway-routes.js";
import { registerDiagnosticsRoutes } from "./api/diagnostics-routes.js";
import { createWeixinIlinkChannel } from "./gateway/channels/weixin-ilink-channel.js";
import { createGatewayAuditLog } from "./gateway/gateway-audit-log.js";
import { createGatewayService, type GatewayService } from "./gateway/gateway-service.js";
import { createGatewaySettingsService } from "./gateway/gateway-settings-service.js";
import { createJobGuardService } from "./services/job-guard-service.js";
import { createProjectService, type ProjectService } from "./services/project-service.js";
import { createSessionRegistry } from "./runtime/session-registry.js";
import { createSessionService, type SessionService } from "./services/session-service.js";
import { createMessageService, type MessageService } from "./services/message-service.js";
import { createRoundService, type RoundService } from "./services/round-service.js";
import { createStatusService, type StatusService } from "./services/status-service.js";
import { createTaskService, type TaskService } from "./services/task-service.js";
import { createTranslationService, type TranslationService } from "./services/translation-service.js";
import { createDiagnosticsService, type DiagnosticsService } from "./services/diagnostics-service.js";
import { registerAppSettingsRoutes } from "./api/app-settings-routes.js";
import { registerArtifactRoutes } from "./api/artifact-routes.js";
import { registerClaudeHookRoutes } from "./api/claude-hook-routes.js";
import { registerGateReviewRoutes } from "./api/gate-review-routes.js";
import { registerTranslationWorkerRoutes } from "./api/translation-worker-routes.js";
import { registerHarnessRoutes } from "./api/harness-routes.js";
import { registerMessageRoutes } from "./api/message-routes.js";
import { registerProjectRoutes } from "./api/project-routes.js";
import { registerRoundRoutes } from "./api/round-routes.js";
import { registerSessionRoutes } from "./api/session-routes.js";
import { registerTaskRoutes } from "./api/task-routes.js";
import { registerTranslationRoutes } from "./api/translation-routes.js";
import { registerTerminalWs } from "./ws/terminal-ws.js";
import { toVcmError } from "./errors.js";
import type { TerminalRuntime } from "./runtime/terminal-runtime.js";
import { readVcmPackageVersion } from "./app-version.js";

export interface CreateServerOptions {
  host?: string;
  port?: number;
  staticDir?: string;
  dev?: boolean;
}

export interface ServerDeps {
  appSettings: AppSettingsService;
  projectService: ProjectService;
  taskService: TaskService;
  sessionService: SessionService;
  artifactService: ArtifactService;
  harnessService: HarnessService;
  harnessFeedbackService: HarnessFeedbackService;
  commandDispatcher: CommandDispatcher;
  claudeHookService: ClaudeHookService;
  messageService: MessageService;
  gateReviewService: GateReviewService;
  translationWorkerService: TranslationWorkerService;
  roundService: RoundService;
  statusService: StatusService;
  translationService: TranslationService;
  gatewayService: GatewayService;
  runtime: TerminalRuntime;
  diagnosticsService: DiagnosticsService;
}

export async function createServer(deps: ServerDeps, options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    keepAliveTimeout: 10000,
    requestTimeout: 30000
  });
  app.server.headersTimeout = 15000;
  app.server.maxRequestsPerSocket = 100;

  app.setErrorHandler((error, _request, reply) => {
    const vcmError = toVcmError(error);
    reply.status(vcmError.statusCode).send({
      error: {
        code: vcmError.code,
        message: vcmError.message,
        hint: vcmError.hint,
        runtime: deps.diagnosticsService.getErrorRuntimeInfo()
      }
    });
  });

  registerDiagnosticsRoutes(app, { diagnosticsService: deps.diagnosticsService });
  registerAppSettingsRoutes(app, { appSettings: deps.appSettings });
  registerClaudeHookRoutes(app, { claudeHookService: deps.claudeHookService });
  registerGateReviewRoutes(app, {
    projectService: deps.projectService,
    gateReviewService: deps.gateReviewService
  });
  registerTranslationWorkerRoutes(app, {
    projectService: deps.projectService,
    translationWorkerService: deps.translationWorkerService,
    sessionService: deps.sessionService,
    translationService: deps.translationService
  });
  registerProjectRoutes(app, {
    projectService: deps.projectService,
    translationWorkerService: deps.translationWorkerService
  });
  registerHarnessRoutes(app, {
    projectService: deps.projectService,
    harnessService: deps.harnessService,
    harnessFeedbackService: deps.harnessFeedbackService,
    sessionService: deps.sessionService,
    taskService: deps.taskService
  });
  registerTaskRoutes(app, {
    projectService: deps.projectService,
    taskService: deps.taskService,
    sessionService: deps.sessionService,
    statusService: deps.statusService,
    translationService: deps.translationService,
    roundService: deps.roundService
  });
  registerSessionRoutes(app, {
    projectService: deps.projectService,
    sessionService: deps.sessionService,
    commandDispatcher: deps.commandDispatcher,
    translationService: deps.translationService,
    roundService: deps.roundService
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
  registerRoundRoutes(app, {
    projectService: deps.projectService,
    taskService: deps.taskService,
    roundService: deps.roundService
  });
  registerTranslationRoutes(app, {
    projectService: deps.projectService,
    taskService: deps.taskService,
    sessionService: deps.sessionService,
    translationService: deps.translationService
  });
  registerGatewayRoutes(app, { gatewayService: deps.gatewayService });
  registerTerminalWs(app, { runtime: deps.runtime });

  app.addHook("onReady", async () => {
    await cleanupRecentTranslationRuntime(deps);
    await deps.gatewayService.start();
  });
  app.addHook("onClose", async () => {
    await deps.gatewayService.stop();
  });

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

async function cleanupRecentTranslationRuntime(deps: Pick<ServerDeps, "projectService" | "translationWorkerService">): Promise<void> {
  const repoRoots = await deps.projectService.getRecentRepositoryPaths();
  await Promise.all(repoRoots.map((repoRoot) =>
    deps.translationWorkerService.cleanupStartupRuntime(repoRoot)
  ));
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
}

export function createDefaultServerDeps(options: CreateDefaultServerDepsOptions = {}): ServerDeps {
  const fs = createNodeFileSystemAdapter();
  const appRoot = getAppRoot();
  const vcmVersion = readVcmPackageVersion(appRoot);
  const runner = createCommandRunner();
  const git = createGitAdapter(runner);
  const claude = createClaudeAdapter(runner);
  const appSettings = createAppSettingsService({ fs });
  const runtime = createNodePtyTerminalRuntime({ fs });
  const registry = createSessionRegistry();
  const artifactService = createArtifactService(fs);
  const projectService = createProjectService({ fs, git, appSettings });
  const taskService = createTaskService({ fs, git, artifactService, projectService });
  const sessionService = createSessionService({
    fs,
    runtime,
    registry,
    claude,
    artifactService,
    projectService,
    taskService,
    apiUrl: options.apiUrl
  });
  const harnessService = createHarnessService({
    fs,
    git,
    runtime,
    harnessEngineerSessions: sessionService,
    runFixedInstaller: createScriptFixedHarnessInstaller(path.join(appRoot, "scripts/install-vcm-harness.mjs")),
    vcmVersion
  });
  const harnessFeedbackService = createHarnessFeedbackService({
    fs,
    runtime,
    sessionService
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
  const roundService = createRoundService({
    fs,
    sessionService,
    onSessionStatusChange: async ({ repoRoot, taskSlug, status }) => {
      await taskService.updateTaskStatus(repoRoot, taskSlug, status);
    }
  });
  const gateReviewService = createGateReviewService({
    fs,
    runner,
    runtime,
    projectService,
    taskService,
    appSettings,
    sessionService,
    roundService
  });
  const translationWorkerService = createTranslationWorkerService({
    fs,
    runtime,
    sessionService
  });
  const transcripts = createClaudeTranscriptService();
  const translationService = createTranslationService({
    runtime,
    sessionRegistry: registry,
    transcripts,
    sessionService,
    translationWorkerService,
    fs,
    projectService,
    appSettings
  });
  const gatewaySettings = createGatewaySettingsService({ fs });
  const gatewayAudit = createGatewayAuditLog({
    fs,
    auditPath: gatewaySettings.getAuditPath()
  });
  const gatewayService = createGatewayService({
    fs,
    settings: gatewaySettings,
    audit: gatewayAudit,
    channel: createWeixinIlinkChannel(),
    projectService,
    taskService,
    sessionService,
    messageService,
    translationService,
    roundService,
    runtime,
    appSettings
  });
  const claudeHookService = createClaudeHookService({
    projectService,
    taskService,
    sessionService,
    messageService,
    roundService,
    translationService,
    appSettings,
    runtime,
    harnessService,
    harnessFeedbackService,
    gatewayService,
    jobGuard: createJobGuardService(),
    translationWorkerService
  });
  const diagnosticsService = createDiagnosticsService({
    appRoot,
    runtime,
    gatewayService,
    translationService
  });

  return {
    appSettings,
    projectService,
    taskService,
    sessionService,
    artifactService,
    harnessService,
    harnessFeedbackService,
    commandDispatcher,
    claudeHookService,
    messageService,
    gateReviewService,
    translationWorkerService,
    roundService,
    statusService,
    translationService,
    gatewayService,
    runtime,
    diagnosticsService
  };
}

export function getDefaultStaticDir(): string {
  return path.join(getAppRoot(), "dist-frontend");
}

function getAppRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}
