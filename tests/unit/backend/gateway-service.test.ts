import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GatewayStatus, UpdateGatewaySettingsRequest } from "../../../src/shared/types/gateway.js";
import type { ProjectSummary } from "../../../src/shared/types/project.js";
import type { RoleSessionRecord } from "../../../src/shared/types/session.js";
import type { TaskRecord } from "../../../src/shared/types/task.js";
import { createDefaultLaunchTemplate } from "../../../src/shared/types/app-settings.js";
import { createGatewayChannelRegistry, type GatewayChannelAdapter, type GatewayInboundMessage } from "../../../src/backend/gateway/gateway-channel.js";
import { createGatewayService } from "../../../src/backend/gateway/gateway-service.js";
import type {
  WeixinIlinkChannel,
  WeixinIlinkUpdate
} from "../../../src/backend/gateway/channels/weixin-ilink-channel.js";
import {
  normalizeSettings,
  type GatewaySettingsFile,
  type GatewaySettingsService
} from "../../../src/backend/gateway/gateway-settings-service.js";

const NOW = "2026-06-11T00:00:00.000Z";

describe("gateway-service long connection", () => {
  it("polls after QR binding even when Gateway is off and accepts startup/query commands", async () => {
    const settings = createSettings();
    const sentTexts: string[] = [];
    const channel = createChannel([
      { messageId: "m1", fromUserId: "user-1", text: "/status" },
      { messageId: "m2", fromUserId: "user-1", text: "/tasks" },
      { messageId: "m3", fromUserId: "user-1", text: "继续处理任务" },
      { messageId: "m4", fromUserId: "user-1", text: "/create-task mobile-demo" }
    ], sentTexts);
    const service = createService({ settings, channel });

    await service.startQrLogin();
    const qr = await service.checkQrLogin();

    expect(qr.status).toBe("confirmed");
    await waitFor(() => sentTexts.length === 4);
    expect(channel.getUpdatesCalls).toBeGreaterThan(0);
    expect((await service.getStatus()).enabled).toBe(false);
    expect(sentTexts[0]).toContain("Gateway: off / polling");
    expect(sentTexts[1]).toContain("demo-task [running]");
    expect(sentTexts[2]).toContain("Gateway is connected but off.");
    expect(sentTexts[3]).toContain("Gateway is connected but off.");
    service.stop();
  });

  it("keeps polling when the Gateway toggle is turned off after binding", async () => {
    const settings = createSettings({
      enabled: true,
      binding: {
        token: "token-1",
        boundUserId: "user-1",
        loginUserId: "user-1"
      } as Partial<GatewaySettingsFile["binding"]> as GatewaySettingsFile["binding"]
    });
    const sentTexts: string[] = [];
    const channel = createChannel([
      { messageId: "m1", fromUserId: "user-1", text: "/help" }
    ], sentTexts);
    const service = createService({ settings, channel });

    const status = await service.updateSettings({ enabled: false });

    expect(status.enabled).toBe(false);
    expect(status.running).toBe(true);
    await waitFor(() => sentTexts.length === 1);
    expect(sentTexts[0]).toContain("VCM Gateway is connected but off.");
    service.stop();
  });

  it("allows /start while Gateway is off and enables full mobile commands", async () => {
    const settings = createSettings({
      binding: {
        token: "token-1",
        boundUserId: "user-1",
        loginUserId: "user-1"
      } as Partial<GatewaySettingsFile["binding"]> as GatewaySettingsFile["binding"]
    });
    const sentTexts: string[] = [];
    const preferenceUpdates: unknown[] = [];
    const channel = createChannel([
      { messageId: "m1", fromUserId: "user-1", text: "/start" },
      { messageId: "m2", fromUserId: "user-1", text: "/help" }
    ], sentTexts);
    const service = createService({ settings, channel, preferenceUpdates });

    await service.start();

    await waitFor(() => sentTexts.length === 2);
    expect((await service.getStatus()).enabled).toBe(true);
    expect(sentTexts[0]).toContain("Gateway started.");
    expect(sentTexts[1]).toContain("VCM Gateway commands:");
    expect(sentTexts[1]).toContain("/create-task <task-slug> [title]");
    expect(preferenceUpdates).toEqual([]);
    service.stop();
  });

  it("returns the latest cached PM reply when /start enables Gateway", async () => {
    const transcriptDir = await mkdtemp(join(tmpdir(), "vcm-gateway-transcript-"));
    const transcriptPath = join(transcriptDir, "pm.jsonl");
    await writeFile(transcriptPath, [
      assistantTranscriptLine("old-reply", "2026-06-10T23:59:00.000Z", "Old PM reply."),
      assistantTranscriptLine("current-reply", "2026-06-11T00:00:01.000Z", "Current PM reply for the active task.")
    ].join("\n"));
    const settings = createSettings({
      binding: {
        token: "token-1",
        boundUserId: "user-1",
        loginUserId: "user-1"
      } as Partial<GatewaySettingsFile["binding"]> as GatewaySettingsFile["binding"]
    });
    const sentTexts: string[] = [];
    const channel = createChannel([
      { messageId: "m1", fromUserId: "user-1", text: "/start" }
    ], sentTexts);
    const service = createService({ settings, channel });

    try {
      await service.handlePmStop({
        repoRoot: "/repo",
        taskSlug: "demo-task",
        session: createPmSession(transcriptPath)
      });
      const latest = Object.values(settings.current().latestPmReplies)[0];
      expect(latest?.text).toBe("Current PM reply for the active task.");

      await service.start();
      await waitFor(() => sentTexts.length === 1);

      expect(sentTexts[0]).toContain("Gateway started.");
      expect(sentTexts[0]).toContain("Latest PM reply:");
      expect(sentTexts[0]).toContain("Current PM reply for the active task.");
      expect(sentTexts[0]).not.toContain("Old PM reply.");
    } finally {
      service.stop();
      await rm(transcriptDir, { recursive: true, force: true });
    }
  });

  it("keeps failed output translations in memory and retries them with /retry", async () => {
    const transcriptDir = await mkdtemp(join(tmpdir(), "vcm-gateway-transcript-"));
    const transcriptPath = join(transcriptDir, "pm.jsonl");
    await writeFile(transcriptPath, assistantTranscriptLine(
      "current-reply",
      "2026-06-11T00:00:01.000Z",
      "PM English status that needs translation."
    ));
    const settings = createSettings({
      enabled: true,
      binding: {
        token: "token-1",
        boundUserId: "user-1",
        loginUserId: "user-1"
      } as Partial<GatewaySettingsFile["binding"]> as GatewaySettingsFile["binding"]
    });
    const sentTexts: string[] = [];
    const channel = createChannel([
      { messageId: "m1", fromUserId: "user-1", text: "/retry" }
    ], sentTexts);
    let translateCalls = 0;
    const service = createService({
      settings,
      channel,
      async translateGatewayOutput() {
        translateCalls += 1;
        if (translateCalls === 1) {
          throw new Error("translation timeout");
        }
        return "重新翻译后的中文状态。";
      }
    });

    try {
      await service.handlePmStop({
        repoRoot: "/repo",
        taskSlug: "demo-task",
        session: createPmSession(transcriptPath)
      });

      expect(sentTexts[0]).toContain("PM 回复已收到，但翻译失败。");
      expect(sentTexts[0]).toContain("/retry");
      expect(sentTexts[0]).not.toContain("PM English status");
      expect(settings.current().lastMessageStatus?.result).toBe("error");
      expect(settings.current().lastMessageStatus?.error).toBe("translation timeout");

      await service.start();
      await waitFor(() => sentTexts.length === 2);

      expect(sentTexts[1]).toContain("重新翻译成功：");
      expect(sentTexts[1]).toContain("重新翻译后的中文状态。");
    } finally {
      service.stop();
      await rm(transcriptDir, { recursive: true, force: true });
    }
  });

  it("clears expired tokens so status checks do not restart polling", async () => {
    const settings = createSettings({
      enabled: true,
      binding: {
        token: "expired-token",
        boundUserId: "user-1",
        loginUserId: "user-1",
        getUpdatesBuf: "cursor-1"
      } as Partial<GatewaySettingsFile["binding"]> as GatewaySettingsFile["binding"]
    });
    const channel = createFailingChannel(new Error("token expired"));
    const service = createService({ settings, channel });

    await service.start();
    await waitFor(() => settings.current().lastPollStatus.state === "expired");
    expect(settings.current().enabled).toBe(false);
    expect(settings.current().binding.token).toBeNull();
    expect(settings.current().binding.getUpdatesBuf).toBe("");

    const status = await service.getStatus();

    expect(status.running).toBe(false);
    expect(status.binding.tokenConfigured).toBe(false);
    expect(channel.getUpdatesCalls).toBe(1);
    service.stop();
  });

  it("requires Lark pairing before accepting commands", async () => {
    const settings = createSettings({
      channel: "lark",
      binding: {
        appId: "cli_test",
        appSecret: "secret_test",
        pairingCode: "ABCDEFGH",
        pairingCodeExpiresAt: "2999-06-11T00:10:00.000Z"
      } as Partial<GatewaySettingsFile["binding"]> as GatewaySettingsFile["binding"]
    });
    const sentTexts: string[] = [];
    const channel = createLarkTestChannel([
      { messageId: "m1", fromUserId: "ou_1", chatId: "oc_1", chatType: "dm", text: "/status" },
      { messageId: "m2", fromUserId: "ou_1", chatId: "oc_1", chatType: "dm", text: "/bind ABCDEFGH" },
      { messageId: "m3", fromUserId: "ou_1", chatId: "oc_1", chatType: "dm", text: "/status" }
    ], sentTexts);
    const service = createService({ settings, channel });

    await service.start();
    await waitFor(() => sentTexts.length === 3);

    expect(sentTexts[0]).toContain("Lark Gateway is not paired.");
    expect(sentTexts[1]).toContain("Lark Gateway bound.");
    expect(sentTexts[2]).toContain("Gateway: off / polling");
    expect(settings.current().binding.boundUserId).toBe("ou_1");
    expect(settings.current().binding.chatIds.ou_1).toBe("oc_1");
    service.stop();
  });
});

function createService(input: {
  settings: GatewaySettingsService;
  channel: GatewayChannelAdapter & { getUpdatesCalls: number };
  preferenceUpdates?: unknown[];
  translateGatewayOutput?: (input: {
    repoRoot: string;
    taskSlug: string;
    role: "project-manager";
    text: string;
  }) => Promise<string>;
}) {
  const project = createProject();
  const task = createTask();
  return createGatewayService({
    fs: {} as never,
    settings: input.settings,
    audit: {
      async record() {
        return undefined;
      }
    },
    channels: createGatewayChannelRegistry([input.channel]),
    projectService: {
      async getCurrentProject() {
        return project;
      },
      async getRecentRepositoryPaths() {
        return [project.repoRoot];
      },
      async connectProject() {
        return project;
      },
      async pullCurrentProject() {
        return project;
      },
      async loadConfig() {
        return project.config;
      }
    } as never,
    taskService: {
      async listTasks() {
        return [task];
      },
      async loadTask() {
        return task;
      },
      async createTask() {
        return task;
      },
      async cleanupTask() {
        return {
          taskSlug: task.taskSlug,
          removedWorktreePath: task.worktreePath,
          removedStatePaths: [],
          deletedBranch: task.branch,
          cleanedAt: NOW
        };
      }
    } as never,
    sessionService: {
      async getRoleSession() {
        return null;
      },
      async listRoleSessions() {
        return [];
      },
      async startRoleSession() {
        return {};
      },
      async resumeRoleSession() {
        return {};
      },
      async stopRoleSession() {
        return {};
      }
    } as never,
    messageService: {
      async updateOrchestrationState() {
        return {};
      }
    } as never,
    translationService: {
      async translateUserInput() {
        return { englishPreview: "" };
      },
      async translateGatewayOutput(translateInput: {
        repoRoot: string;
        taskSlug: string;
        role: "project-manager";
        text: string;
      }) {
        return input.translateGatewayOutput
          ? input.translateGatewayOutput(translateInput)
          : translateInput.text;
      },
      async stopTask() {
        return undefined;
      }
    } as never,
    roundService: {
      stopTask() {
        return undefined;
      }
    },
    runtime: {
      write() {
        return undefined;
      }
    },
    appSettings: {
      async getPreferences() {
        return {
          launchTemplate: createDefaultLaunchTemplate(),
          translationEnabled: true
        };
      },
      async getGateReviewSettings() {
        return { enabled: false, requiredGates: [] };
      },
      async updatePreferences(update: unknown) {
        input.preferenceUpdates?.push(update);
        return {};
      }
    } as never,
    now: () => NOW
  });
}

function createChannel(updates: WeixinIlinkUpdate[], sentTexts: string[]): WeixinIlinkChannel & { getUpdatesCalls: number } {
  let used = false;
  return {
    id: "weixin-ilink",
    label: "Weixin iLink",
    defaultBaseUrl: "https://ilinkai.weixin.qq.com",
    get getUpdatesCalls() {
      return used ? 1 : 0;
    },
    async startQrLogin() {
      return { qrcode: "qr-1", qrcodeUrl: "https://login.example/qr" };
    },
    async checkQrLogin() {
      return {
        status: "confirmed",
        token: "token-1",
        loginUserId: "user-1",
        accountId: "account-1",
        baseUrl: "https://ilinkai.weixin.qq.com"
      };
    },
    async getUpdates(input) {
      if (!used) {
        used = true;
        return { cursor: "cursor-1", updates };
      }
      return new Promise((resolve) => {
        input.signal?.addEventListener("abort", () => {
          resolve({ cursor: "cursor-2", updates: [] });
        });
      });
    },
    async sendText(input) {
      sentTexts.push(input.text);
      return "ok";
    }
  };
}

function createLarkTestChannel(updates: GatewayInboundMessage[], sentTexts: string[]): GatewayChannelAdapter & { getUpdatesCalls: number } {
  let used = false;
  return {
    id: "lark",
    label: "Lark",
    defaultBaseUrl: "lark://open-platform",
    get getUpdatesCalls() {
      return used ? 1 : 0;
    },
    async getUpdates(input) {
      if (!used) {
        used = true;
        return { cursor: "cursor-1", updates };
      }
      return new Promise((resolve) => {
        input.signal?.addEventListener("abort", () => {
          resolve({ cursor: "cursor-2", updates: [] });
        });
      });
    },
    async sendText(input) {
      sentTexts.push(input.text);
      return input.chatId ?? "ok";
    }
  };
}

function createFailingChannel(error: Error): WeixinIlinkChannel & { getUpdatesCalls: number } {
  let calls = 0;
  return {
    id: "weixin-ilink",
    label: "Weixin iLink",
    defaultBaseUrl: "https://ilinkai.weixin.qq.com",
    get getUpdatesCalls() {
      return calls;
    },
    async startQrLogin() {
      return { qrcode: "qr-1", qrcodeUrl: "https://login.example/qr" };
    },
    async checkQrLogin() {
      return {
        status: "confirmed",
        token: "token-1",
        loginUserId: "user-1",
        accountId: "account-1",
        baseUrl: "https://ilinkai.weixin.qq.com"
      };
    },
    async getUpdates() {
      calls += 1;
      throw error;
    },
    async sendText() {
      return "ok";
    }
  };
}

function createSettings(initial: Partial<GatewaySettingsFile> = {}): GatewaySettingsService & { current(): GatewaySettingsFile } {
  let current = normalizeSettings(initial, NOW);
  return {
    async loadSettings() {
      return current;
    },
    async updateSettings(input: UpdateGatewaySettingsRequest) {
      current = normalizeSettings({
        ...current,
        enabled: input.enabled ?? current.enabled,
        channel: input.channel ?? current.channel,
        translationEnabled: input.translationEnabled ?? current.translationEnabled,
        currentProjectId: input.currentProjectId !== undefined ? input.currentProjectId : current.currentProjectId,
        currentTaskSlug: input.currentTaskSlug !== undefined ? input.currentTaskSlug : current.currentTaskSlug,
        binding: {
          ...current.binding,
          baseUrl: input.baseUrl !== undefined ? input.baseUrl ?? current.binding.baseUrl : current.binding.baseUrl,
          appId: input.larkAppId !== undefined ? input.larkAppId : current.binding.appId,
          appSecret: input.larkAppSecret !== undefined ? input.larkAppSecret : current.binding.appSecret,
          homeChatId: input.larkHomeChatId !== undefined ? input.larkHomeChatId : current.binding.homeChatId
        },
        updatedAt: NOW
      }, NOW);
      return current;
    },
    async saveSettings(settings) {
      current = normalizeSettings(settings, NOW);
      return current;
    },
    async resetBinding() {
      current = normalizeSettings({}, NOW);
      return current;
    },
    expose(settings, running = false): GatewayStatus {
      return {
        version: 1,
        enabled: settings.enabled,
        running,
        channel: settings.channel,
        translationEnabled: settings.translationEnabled,
        currentProjectId: settings.currentProjectId,
        currentTaskSlug: settings.currentTaskSlug,
        binding: {
          accountId: settings.binding.accountId,
          baseUrl: settings.binding.baseUrl,
          boundUserId: settings.binding.boundUserId,
          loginUserId: settings.binding.loginUserId,
          tokenConfigured: Boolean(settings.binding.token),
          appId: settings.binding.appId,
          appIdConfigured: Boolean(settings.binding.appId),
          appSecretConfigured: Boolean(settings.binding.appSecret),
          homeChatId: settings.binding.homeChatId,
          pairingCodeExpiresAt: settings.binding.pairingCodeExpiresAt
        },
        pendingConfirmations: settings.pendingConfirmations,
        lastPollStatus: settings.lastPollStatus,
        lastMessageStatus: settings.lastMessageStatus,
        updatedAt: settings.updatedAt
      };
    },
    getSettingsPath() {
      return "/gateway/settings.json";
    },
    getAuditPath() {
      return "/gateway/audit.jsonl";
    },
    current() {
      return current;
    }
  };
}

function createProject(): ProjectSummary {
  return {
    repoRoot: "/repo",
    branch: "main",
    isDirty: false,
    shortHeadCommit: "abc123",
    config: {
      version: 1,
      repoRoot: "/repo",
      defaultRoles: ["project-manager", "architect", "coder", "reviewer"],
      handoffRoot: ".ai/vcm/handoffs",
      stateRoot: ".ai/vcm",
      terminalBackend: "node-pty",
      claudeCommand: "claude"
    },
    warnings: []
  };
}

function createTask(): TaskRecord {
  return {
    version: 1,
    taskSlug: "demo-task",
    title: "Demo task",
    createdAt: NOW,
    updatedAt: NOW,
    repoRoot: "/repo",
    worktreePath: "/repo/.claude/worktrees/demo-task",
    branch: "feature/demo-task",
    handoffDir: ".ai/vcm/handoffs",
    status: "running",
    cleanupStatus: "active"
  };
}

function createPmSession(transcriptPath: string): RoleSessionRecord {
  return {
    id: "pm-session",
    claudeSessionId: "claude-pm-session",
    transcriptPath,
    taskSlug: "demo-task",
    role: "project-manager",
    status: "running",
    activityStatus: "idle",
    command: "claude",
    permissionMode: "default",
    cwd: "/repo",
    terminalBackend: "node-pty",
    startedAt: "2026-06-11T00:00:00.000Z",
    updatedAt: NOW,
    lastTurnStartedAt: "2026-06-11T00:00:00.000Z",
    lastTurnEndedAt: "2026-06-11T00:00:02.000Z"
  };
}

function assistantTranscriptLine(uuid: string, timestamp: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    timestamp,
    message: {
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text
        }
      ]
    }
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
