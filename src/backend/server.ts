import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { ArtifactService } from "./services/artifact-service.js";
import { createArtifactService } from "./services/artifact-service.js";
import { createClaudeAdapter } from "./adapters/claude-adapter.js";
import { createCcrGatewayAdapter } from "./adapters/ccr-gateway-adapter.js";
import { createCommandRunner } from "./adapters/command-runner.js";
import { createCommandDispatcher, type CommandDispatcher } from "./services/command-dispatcher.js";
import { createClaudeHookService, type ClaudeHookService } from "./services/claude-hook-service.js";
import { createGitAdapter } from "./adapters/git-adapter.js";
import { createAppSettingsService, type AppSettingsService } from "./services/app-settings-service.js";
import { createCcrIntegrationService, type CcrIntegrationService } from "./services/ccr-integration-service.js";
import { createAutoMemoryService, type AutoMemoryService } from "./services/auto-memory-service.js";
import { createArchitectRestartService, type ArchitectRestartService } from "./services/architect-restart-service.js";
import { createRoleStallDetectorService, type RoleStallDetectorService } from "./services/role-stall-detector-service.js";
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
import { createLarkChannel } from "./gateway/channels/lark-channel.js";
import { createWeixinIlinkChannel } from "./gateway/channels/weixin-ilink-channel.js";
import { createGatewayAuditLog } from "./gateway/gateway-audit-log.js";
import { createGatewayChannelRegistry } from "./gateway/gateway-channel.js";
import { createGatewayService, type GatewayService } from "./gateway/gateway-service.js";
import { createGatewaySettingsService } from "./gateway/gateway-settings-service.js";
import { createJobGuardService } from "./services/job-guard-service.js";
import { createProjectService, type ProjectService } from "./services/project-service.js";
import { createSessionRegistry } from "./runtime/session-registry.js";
import { createSessionService, type SessionService } from "./services/session-service.js";
import { createMessageService, type MessageService } from "./services/message-service.js";
import { createRoundService, type RoundService } from "./services/round-service.js";
import { createRuntimeCoordinatorService, type RuntimeCoordinatorService } from "./services/runtime-coordinator-service.js";
import { createRuntimeRecoveryService, type RuntimeRecoveryService } from "./services/runtime-recovery-service.js";
import { createStatusService, type StatusService } from "./services/status-service.js";
import { createTaskService, type TaskService } from "./services/task-service.js";
import { createTaskCloseService, type TaskCloseService } from "./services/task-close-service.js";
import { createTaskWorkflowService, type TaskWorkflowService } from "./services/task-workflow-service.js";
import { createTaskLaunchService, type TaskLaunchService } from "./services/task-launch-service.js";
import { createTerminalInterruptService, type TerminalInterruptService } from "./services/terminal-interrupt-service.js";
import { createTerminalProcessExitService, type TerminalProcessExitService } from "./services/terminal-process-exit-service.js";
import { createTranslationService, type TranslationService } from "./services/translation-service.js";
import { createUsageAnalyticsService, type UsageAnalyticsService } from "./services/usage-analytics-service.js";
import { createWorkflowControlService, type WorkflowControlService } from "./services/workflow-control-service.js";
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
import { registerRuntimeStateRoutes } from "./api/runtime-state-routes.js";
import { registerSessionRoutes } from "./api/session-routes.js";
import { registerTaskRoutes } from "./api/task-routes.js";
import { registerTranslationRoutes } from "./api/translation-routes.js";
import { registerUsageAnalyticsRoutes } from "./api/usage-analytics-routes.js";
import { registerWorkflowControlRoutes } from "./api/workflow-control-routes.js";
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
  ccrIntegration: CcrIntegrationService;
  projectService: ProjectService;
  taskService: TaskService;
  taskCloseService: TaskCloseService;
  taskWorkflowService: TaskWorkflowService;
  architectRestartService: ArchitectRestartService;
  sessionService: SessionService;
  artifactService: ArtifactService;
  harnessService: HarnessService;
  harnessFeedbackService: HarnessFeedbackService;
  autoMemoryService: AutoMemoryService;
  commandDispatcher: CommandDispatcher;
  claudeHookService: ClaudeHookService;
  roleStallDetector: RoleStallDetectorService;
  messageService: MessageService;
  taskLaunchService: TaskLaunchService;
  gateReviewService: GateReviewService;
  translationWorkerService: TranslationWorkerService;
  roundService: RoundService;
  statusService: StatusService;
  translationService: TranslationService;
  gatewayService: GatewayService;
  runtimeCoordinator: RuntimeCoordinatorService;
  runtimeRecoveryService: RuntimeRecoveryService;
  terminalInterruptService: TerminalInterruptService;
  terminalProcessExitService: TerminalProcessExitService;
  runtime: TerminalRuntime;
  diagnosticsService: DiagnosticsService;
  usageAnalyticsService: UsageAnalyticsService;
  workflowControlService?: WorkflowControlService;
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
  registerAppSettingsRoutes(app, {
    appSettings: deps.appSettings,
    ccrIntegration: deps.ccrIntegration
  });
  registerClaudeHookRoutes(app, { claudeHookService: deps.claudeHookService });
  registerGateReviewRoutes(app, {
    projectService: deps.projectService,
    gateReviewService: deps.gateReviewService
  });
  registerTranslationWorkerRoutes(app, {
    appSettings: deps.appSettings,
    projectService: deps.projectService,
    translationWorkerService: deps.translationWorkerService,
    sessionService: deps.sessionService,
    translationService: deps.translationService
  });
  registerProjectRoutes(app, {
    projectService: deps.projectService,
    runtimeRecoveryService: deps.runtimeRecoveryService
  });
  registerHarnessRoutes(app, {
    appSettings: deps.appSettings,
    projectService: deps.projectService,
    harnessService: deps.harnessService,
    harnessFeedbackService: deps.harnessFeedbackService,
    autoMemoryService: deps.autoMemoryService,
    sessionService: deps.sessionService,
    taskService: deps.taskService
  });
  registerRuntimeStateRoutes(app, {
    projectService: deps.projectService,
    taskService: deps.taskService,
    sessionService: deps.sessionService,
    translationWorkerService: deps.translationWorkerService,
    harnessService: deps.harnessService,
    harnessFeedbackService: deps.harnessFeedbackService,
    autoMemoryService: deps.autoMemoryService,
    runtimeCoordinator: deps.runtimeCoordinator,
    workflowControlService: deps.workflowControlService
  });
  registerTaskRoutes(app, {
    projectService: deps.projectService,
    taskService: deps.taskService,
    taskCloseService: deps.taskCloseService,
    statusService: deps.statusService,
    messageService: deps.messageService,
    taskLaunchService: deps.taskLaunchService,
    roundService: deps.roundService,
    taskWorkflowService: deps.taskWorkflowService,
    architectRestartService: deps.architectRestartService,
    roleStallDetector: deps.roleStallDetector
  });
  registerSessionRoutes(app, {
    projectService: deps.projectService,
    sessionService: deps.sessionService,
    commandDispatcher: deps.commandDispatcher,
    translationService: deps.translationService,
    roundService: deps.roundService,
    architectRestartService: deps.architectRestartService
  });
  registerArtifactRoutes(app, {
    projectService: deps.projectService,
    taskService: deps.taskService,
    artifactService: deps.artifactService,
    sessionService: deps.sessionService
  });
  if (deps.workflowControlService) {
    registerWorkflowControlRoutes(app, {
      projectService: deps.projectService,
      taskService: deps.taskService,
      workflowControlService: deps.workflowControlService
    });
  }
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
  registerUsageAnalyticsRoutes(app, {
    projectService: deps.projectService,
    taskService: deps.taskService,
    usageAnalyticsService: deps.usageAnalyticsService
  });
  registerGatewayRoutes(app, { gatewayService: deps.gatewayService });
  registerTerminalWs(app, {
    runtime: deps.runtime,
    onManualInterrupt: (sessionId) => deps.terminalInterruptService.handleManualInterrupt(sessionId)
  });

  app.addHook("onReady", async () => {
    await deps.ccrIntegration.initialize();
    await cleanupRecentTranslationRuntime(deps);
    deps.terminalProcessExitService.start();
    deps.runtimeCoordinator.start();
    await deps.gatewayService.start();
  });
  app.addHook("onClose", async () => {
    deps.terminalProcessExitService.stop();
    deps.runtimeCoordinator.stop();
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
  const ccrIntegration = createCcrIntegrationService({
    settings: appSettings,
    gateway: createCcrGatewayAdapter()
  });
  const runtime = createNodePtyTerminalRuntime({ fs });
  const registry = createSessionRegistry();
  const workflowControlService = createWorkflowControlService({ fs });
  const artifactService = createArtifactService(fs, { workflowControlService });
  const projectService = createProjectService({ fs, git, appSettings });
  const taskService = createTaskService({ fs, git, artifactService, projectService });
  const taskWorkflowService = createTaskWorkflowService({ fs });
  const sessionService = createSessionService({
    fs,
    runtime,
    registry,
    claude,
    artifactService,
    projectService,
    taskService,
    taskWorkflowService,
    ccrIntegration,
    apiUrl: options.apiUrl
  });
  const harnessService = createHarnessService({
    fs,
    commandRunner: runner,
    git,
    runtime,
    harnessEngineerSessions: sessionService,
    runFixedInstaller: createScriptFixedHarnessInstaller(path.join(appRoot, "scripts/install-vcm-harness.mjs")),
    vcmVersion
  });
  const autoMemoryService = createAutoMemoryService({
    fs,
    git,
    runtime,
    sessionService,
    appSettings,
    async isHarnessEngineerAvailable() {
      return true;
    }
  });
  const harnessFeedbackService = createHarnessFeedbackService({
    fs,
    runtime,
    sessionService,
    autoMemoryService
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
  const architectRestartService = createArchitectRestartService({
    fs,
    taskService,
    sessionService,
    appSettings
  });
  const messageService = createMessageService({
    fs,
    runtime,
    sessionService,
    taskService,
    taskWorkflowService,
    workflowControlService,
    onRouteDelivered: ({ repoRoot, taskSlug, message }) =>
      architectRestartService.recordRouteDelivered(repoRoot, taskSlug, message)
  });
  const taskLaunchService = createTaskLaunchService({
    projectService,
    taskService,
    appSettings,
    sessionService,
    messageService
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
    roundService,
    onArchitecturePlanDisposition: ({ repoRoot, taskSlug, accepted }) =>
      architectRestartService.recordArchitectureGateDisposition(repoRoot, taskSlug, accepted)
  });
  const translationWorkerService = createTranslationWorkerService({
    fs,
    runtime,
    sessionService
  });
  const transcripts = createClaudeTranscriptService();
  const roleStallDetector = createRoleStallDetectorService({
    sessionService,
    roundService
  });
  const translationService = createTranslationService({
    runtime,
    sessionRegistry: registry,
    transcripts,
    sessionService,
    translationWorkerService,
    fs,
    projectService,
    roundService,
    appSettings
  });
  const usageAnalyticsService = createUsageAnalyticsService({ fs });
  const gatewayChannels = createGatewayChannelRegistry([
    createWeixinIlinkChannel(),
    createLarkChannel()
  ]);
  const gatewaySettings = createGatewaySettingsService({
    fs,
    defaultChannel: gatewayChannels.defaultChannel.id,
    defaultBaseUrl: gatewayChannels.defaultChannel.defaultBaseUrl
  });
  const gatewayAudit = createGatewayAuditLog({
    fs,
    auditPath: gatewaySettings.getAuditPath()
  });
  const taskCloseService = createTaskCloseService({
    taskService,
    sessionService,
    translationService,
    roundService,
    projectService,
    taskWorkflowService,
    architectRestartService
  });
  const gatewayService = createGatewayService({
    fs,
    settings: gatewaySettings,
    audit: gatewayAudit,
    channels: gatewayChannels,
    projectService,
    taskService,
    taskCloseService,
    sessionService,
    taskLaunchService,
    translationService,
    roundService,
    runtime,
    appSettings
  });
  const runtimeRecoveryService = createRuntimeRecoveryService({
    fs,
    runtime,
    projectService,
    taskService,
    translationWorkerService
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
    autoMemoryService,
    harnessFeedbackService,
    gatewayService,
    jobGuard: createJobGuardService(),
    translationWorkerService,
    architectRestartService,
    roleStallDetector
  });
  const runtimeCoordinator = createRuntimeCoordinatorService({
    appSettings,
    projectService,
    taskService,
    sessionService,
    translationService,
    harnessService,
    harnessFeedbackService,
    autoMemoryService,
    roundService,
    roleStallDetector,
    gatewayService,
    async getStateRoot(repoRoot) {
      return (await projectService.loadConfig(repoRoot)).stateRoot;
    }
  });
  const terminalInterruptService = createTerminalInterruptService({
    runtime,
    projectService,
    taskService,
    sessionService,
    roundService
  });
  const terminalProcessExitService = createTerminalProcessExitService({
    runtime,
    projectService,
    taskService,
    sessionService,
    roundService
  });
  const diagnosticsService = createDiagnosticsService({
    appRoot,
    runtime,
    gatewayService,
    translationService
  });

  return {
    appSettings,
    ccrIntegration,
    projectService,
    taskService,
    taskCloseService,
    taskWorkflowService,
    architectRestartService,
    sessionService,
    artifactService,
    harnessService,
    harnessFeedbackService,
    autoMemoryService,
    commandDispatcher,
    claudeHookService,
    roleStallDetector,
    messageService,
    taskLaunchService,
    gateReviewService,
    translationWorkerService,
    roundService,
    statusService,
    translationService,
    gatewayService,
    runtimeCoordinator,
    runtimeRecoveryService,
    terminalInterruptService,
    terminalProcessExitService,
    runtime,
    diagnosticsService,
    usageAnalyticsService,
    workflowControlService
  };
}

export function getDefaultStaticDir(): string {
  return path.join(getAppRoot(), "dist-frontend");
}

function getAppRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}
