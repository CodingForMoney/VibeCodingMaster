import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { createServer, type ServerDeps } from "../../../../src/backend/server.js";
import { createNodeFileSystemAdapter } from "../../../../src/backend/adapters/filesystem.js";
import { createCommandRunner } from "../../../../src/backend/adapters/command-runner.js";
import { createGitAdapter } from "../../../../src/backend/adapters/git-adapter.js";
import type { ClaudeAdapter } from "../../../../src/backend/adapters/claude-adapter.js";
import type { CcrGatewayAdapter } from "../../../../src/backend/adapters/ccr-gateway-adapter.js";
import { createAppSettingsService } from "../../../../src/backend/services/app-settings-service.js";
import { createCcrIntegrationService } from "../../../../src/backend/services/ccr-integration-service.js";
import { createArtifactService } from "../../../../src/backend/services/artifact-service.js";
import { createProjectService } from "../../../../src/backend/services/project-service.js";
import { createTaskService } from "../../../../src/backend/services/task-service.js";
import { createTaskWorkflowService } from "../../../../src/backend/services/task-workflow-service.js";
import { createSessionRegistry } from "../../../../src/backend/runtime/session-registry.js";
import { createSessionService } from "../../../../src/backend/services/session-service.js";
import { createHarnessService } from "../../../../src/backend/services/harness-service.js";
import { createHarnessFeedbackService } from "../../../../src/backend/services/harness-feedback-service.js";
import { createAutoMemoryService } from "../../../../src/backend/services/auto-memory-service.js";
import { createArchitectRestartService } from "../../../../src/backend/services/architect-restart-service.js";
import { createCommandDispatcher } from "../../../../src/backend/services/command-dispatcher.js";
import { createStatusService } from "../../../../src/backend/services/status-service.js";
import { createMessageService } from "../../../../src/backend/services/message-service.js";
import { createTaskLaunchService } from "../../../../src/backend/services/task-launch-service.js";
import { createRoundService } from "../../../../src/backend/services/round-service.js";
import { createGateReviewService } from "../../../../src/backend/services/gate-review-service.js";
import { createTranslationWorkerService } from "../../../../src/backend/services/translation-worker-service.js";
import { createClaudeTranscriptService } from "../../../../src/backend/services/claude-transcript-service.js";
import { createTranslationService } from "../../../../src/backend/services/translation-service.js";
import { createGatewayChannelRegistry } from "../../../../src/backend/gateway/gateway-channel.js";
import { createWeixinIlinkChannel } from "../../../../src/backend/gateway/channels/weixin-ilink-channel.js";
import { createGatewaySettingsService } from "../../../../src/backend/gateway/gateway-settings-service.js";
import { createGatewayAuditLog } from "../../../../src/backend/gateway/gateway-audit-log.js";
import { createTaskCloseService } from "../../../../src/backend/services/task-close-service.js";
import { createGatewayService } from "../../../../src/backend/gateway/gateway-service.js";
import { createRuntimeRecoveryService } from "../../../../src/backend/services/runtime-recovery-service.js";
import { createClaudeHookService } from "../../../../src/backend/services/claude-hook-service.js";
import { createTurnReconcilerService } from "../../../../src/backend/services/turn-reconciler-service.js";
import { createRuntimeCoordinatorService } from "../../../../src/backend/services/runtime-coordinator-service.js";
import { createTerminalInterruptService } from "../../../../src/backend/services/terminal-interrupt-service.js";
import { createDiagnosticsService } from "../../../../src/backend/services/diagnostics-service.js";
import { createUsageAnalyticsService } from "../../../../src/backend/services/usage-analytics-service.js";
import { createJobGuardService } from "../../../../src/backend/services/job-guard-service.js";
import { readVcmPackageVersion } from "../../../../src/backend/app-version.js";
import type { RoleName } from "../../../../src/shared/types/role.js";
import {
  isCcrSessionModel,
  type ClaudePermissionMode,
  type SessionEffort,
  type SessionModel
} from "../../../../src/shared/types/session.js";
import { MockClaudeRuntime } from "./mock-claude-runtime.js";
import { MockGatewayChannel } from "./mock-gateway-channel.js";

export interface MockClaudeE2eApp {
  app: FastifyInstance;
  deps: ServerDeps;
  mockRuntime: MockClaudeRuntime;
  mockGateway: MockGatewayChannel;
  tempRoot: string;
  close(options?: { preserveTempRoot?: boolean }): Promise<void>;
}

export interface MockClaudeE2eAppOptions {
  tempRoot?: string;
  ccrGateway?: CcrGatewayAdapter;
  ccrBaseEnv?: NodeJS.ProcessEnv;
}

export async function createMockClaudeE2eApp(options: MockClaudeE2eAppOptions = {}): Promise<MockClaudeE2eApp> {
  const tempRoot = options.tempRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), "vcm-backend-e2e-"));
  await fs.mkdir(tempRoot, { recursive: true });
  const settingsPath = path.join(tempRoot, "settings", "settings.json");
  const gatewaySettingsPath = path.join(tempRoot, "settings", "gateway", "settings.json");
  const gatewayAuditPath = path.join(tempRoot, "settings", "gateway", "audit.jsonl");
  const transcriptRoot = path.join(tempRoot, "transcripts");
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const fsAdapter = createNodeFileSystemAdapter();
  const runner = createCommandRunner();
  const git = createGitAdapter(runner);
  const mockRuntime = new MockClaudeRuntime({ transcriptRoot });
  const claude = createMockClaudeAdapter();
  const appSettings = createAppSettingsService({ fs: fsAdapter, settingsPath });
  const ccrIntegration = createCcrIntegrationService({
    settings: appSettings,
    baseEnv: options.ccrBaseEnv ?? {},
    configDir: path.join(tempRoot, "settings", "claude", "ccr"),
    gateway: options.ccrGateway ?? {
      async probe() {
        return { connectionState: "available", modelAvailable: true };
      }
    }
  });
  const artifactService = createArtifactService(fsAdapter);
  const projectService = createProjectService({ fs: fsAdapter, git, appSettings });
  const taskService = createTaskService({ fs: fsAdapter, git, artifactService, projectService });
  const taskWorkflowService = createTaskWorkflowService({ fs: fsAdapter });
  const registry = createSessionRegistry();
  const sessionService = createSessionService({
    fs: fsAdapter,
    runtime: mockRuntime,
    registry,
    claude,
    artifactService,
    projectService,
    taskService,
    taskWorkflowService,
    ccrIntegration,
    apiUrl: "http://127.0.0.1/mock-vcm",
    isProcessAlive(pid) {
      return mockRuntime.listSessions().some((session) => session.pid === pid && session.status === "running");
    }
  });
  const harnessService = createHarnessService({
    fs: fsAdapter,
    git,
    runtime: mockRuntime,
    harnessEngineerSessions: sessionService,
    async runFixedInstaller() {
      return {
        version: 1,
        changedFiles: [],
        message: "mock fixed harness install"
      };
    },
    vcmVersion: readVcmPackageVersion(appRoot)
  });
  const harnessFeedbackService = createHarnessFeedbackService({
    fs: fsAdapter,
    runtime: mockRuntime,
    sessionService
  });
  const autoMemoryService = createAutoMemoryService({
    fs: fsAdapter,
    git,
    runtime: mockRuntime,
    sessionService,
    appSettings,
    async isHarnessEngineerAvailable() {
      return true;
    }
  });
  const commandDispatcher = createCommandDispatcher({
    runtime: mockRuntime,
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
    fs: fsAdapter,
    taskService,
    sessionService
  });
  const messageService = createMessageService({
    fs: fsAdapter,
    runtime: mockRuntime,
    sessionService,
    taskService,
    taskWorkflowService,
    preDispatchSwitchDelayMs: 0,
    autoDispatchEnterDelayMs: 0,
    dispatchConfirmationEnabled: false,
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
    fs: fsAdapter,
    sessionService,
    settleMs: 0,
    setTimeout(callback) {
      return globalThis.setTimeout(callback, 0);
    },
    clearTimeout(timer) {
      globalThis.clearTimeout(timer);
    },
    onSessionStatusChange: async ({ repoRoot, taskSlug, status }) => {
      await taskService.updateTaskStatus(repoRoot, taskSlug, status);
    }
  });
  const gateReviewService = createGateReviewService({
    fs: fsAdapter,
    runner,
    runtime: mockRuntime,
    projectService,
    taskService,
    appSettings,
    sessionService,
    roundService,
    reportPollIntervalMs: 10,
    reportTimeoutMs: 2_000
  });
  const translationWorkerService = createTranslationWorkerService({
    fs: fsAdapter,
    runtime: mockRuntime,
    sessionService
  });
  const transcripts = createClaudeTranscriptService();
  const translationService = createTranslationService({
    runtime: mockRuntime,
    sessionRegistry: registry,
    transcripts,
    sessionService,
    translationWorkerService,
    fs: fsAdapter,
    projectService,
    roundService,
    appSettings,
    outputBatchDelayMs: 0
  });
  const mockGateway = new MockGatewayChannel();
  const gatewayChannels = createGatewayChannelRegistry([
    mockGateway,
    createWeixinIlinkChannel()
  ]);
  const gatewaySettings = createGatewaySettingsService({
    fs: fsAdapter,
    settingsPath: gatewaySettingsPath,
    auditPath: gatewayAuditPath,
    defaultChannel: gatewayChannels.defaultChannel.id,
    defaultBaseUrl: gatewayChannels.defaultChannel.defaultBaseUrl
  });
  const gatewayAudit = createGatewayAuditLog({
    fs: fsAdapter,
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
    fs: fsAdapter,
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
    runtime: mockRuntime,
    appSettings
  });
  const runtimeRecoveryService = createRuntimeRecoveryService({
    fs: fsAdapter,
    runtime: mockRuntime,
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
    runtime: mockRuntime,
    harnessService,
    autoMemoryService,
    gatewayService,
    jobGuard: createJobGuardService(),
    translationWorkerService,
    architectRestartService,
    retrySetTimeout(callback) {
      return globalThis.setTimeout(callback, 0);
    },
    retryClearTimeout(timer) {
      globalThis.clearTimeout(timer);
    }
  });
  const turnReconciler = createTurnReconcilerService({
    sessionService,
    roundService,
    claudeHookService,
    runtime: mockRuntime
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
    gatewayService,
    turnReconciler,
    async getStateRoot(repoRoot) {
      return (await projectService.loadConfig(repoRoot)).stateRoot;
    },
    setInterval() {
      return Symbol("mock-runtime-coordinator-timer");
    },
    clearInterval() {}
  });
  const terminalInterruptService = createTerminalInterruptService({
    runtime: mockRuntime,
    projectService,
    taskService,
    sessionService,
    roundService
  });
  const diagnosticsService = createDiagnosticsService({
    appRoot,
    runtime: mockRuntime,
    gatewayService,
    translationService
  });
  const usageAnalyticsService = createUsageAnalyticsService({ fs: fsAdapter });

  const deps: ServerDeps = {
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
    runtime: mockRuntime,
    diagnosticsService,
    usageAnalyticsService
  };
  const app = await createServer(deps);
  mockRuntime.setHookDispatcher(async (input, options) => {
    const response = await app.inject({
      method: "POST",
      url: options.stopEndpoint ? "/api/hooks/claude-code/stop" : "/api/hooks/claude-code",
      payload: input
    });
    if (response.statusCode >= 400) {
      throw new Error(`Mock Claude hook failed: ${response.statusCode} ${response.body}`);
    }
    return response.json();
  });

  return {
    app,
    deps,
    mockRuntime,
    mockGateway,
    tempRoot,
    async close(closeOptions = {}) {
      await app.close();
      if (!closeOptions.preserveTempRoot) {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    }
  };
}

function createMockClaudeAdapter(): ClaudeAdapter {
  return {
    async isAvailable() {
      return true;
    },
    async getVersion() {
      return "mock-claude-code/0.0.0";
    },
    buildRoleStartCommand(role, command = "claude", permissionMode = "default", claudeSessionId, resume = false, model = "default", effort = "default", settingsOverride, appendSystemPrompt) {
      const args = ["--agent", role];
      const sessionSettings = { ...settingsOverride };
      if (claudeSessionId) {
        args.push(resume ? "--resume" : "--session-id", claudeSessionId);
      }
      if (!isCcrSessionModel(model)) {
        args.push("--model", model);
      }
      if (effort === "ultracode") {
        sessionSettings.ultracode = true;
      } else if (effort !== "default") {
        args.push("--effort", effort);
      }
      if (Object.keys(sessionSettings).length > 0) {
        args.push("--settings", JSON.stringify(sessionSettings));
      }
      if (permissionMode !== "default") {
        args.push("--permission-mode", permissionMode);
      }
      if (appendSystemPrompt) {
        args.push("--append-system-prompt", appendSystemPrompt);
      }
      return {
        command,
        args,
        display: [command, ...args].join(" ")
      };
    }
  };
}

export function roleLaunchBody(input: {
  permissionMode?: ClaudePermissionMode;
  model?: SessionModel;
  effort?: SessionEffort;
} = {}): Record<string, string> {
  return {
    permissionMode: input.permissionMode ?? "bypassPermissions",
    model: input.model ?? "default",
    effort: input.effort ?? "default"
  };
}
