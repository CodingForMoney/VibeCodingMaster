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
import { VcmError } from "../../../src/backend/errors.js";
import type { LarkRegistrationClient } from "../../../src/backend/gateway/channels/lark-registration.js";
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
    await service.setConnectionEnabled(true);

    await service.startQrLogin();
    const qr = await service.checkQrLogin();

    expect(qr.status).toBe("confirmed");
    await waitFor(() => sentTexts.length === 4);
    expect(channel.getUpdatesCalls).toBeGreaterThan(0);
    const status = await service.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.connectionEnabled).toBe(true);
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
    const channel = createManualChannel(sentTexts);
    const service = createService({ settings, channel });
    await service.setConnectionEnabled(true);

    const status = await service.updateSettings({ enabled: false });

    expect(status.enabled).toBe(false);
    expect(status.running).toBe(true);
    expect(status.connectionEnabled).toBe(true);
    // Deliver the command only after the Gateway command toggle is off, so /help
    // reflects the connected-but-off state rather than racing the toggle.
    channel.deliver([{ messageId: "m1", fromUserId: "user-1", text: "/help" }]);
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
    await service.setConnectionEnabled(true);

    await service.start();

    await waitFor(() => sentTexts.length === 2);
    expect((await service.getStatus()).enabled).toBe(true);
    expect(sentTexts[0]).toContain("Gateway started.");
    expect(sentTexts[1]).toContain("VCM Gateway commands:");
    expect(sentTexts[1]).toContain("/create-task <task-slug> [title]");
    expect(preferenceUpdates).toEqual([{
      translationEnabled: true,
      translationAutoSendEnabled: true
    }]);
    service.stop();
  });

  it("desktop Gateway enable turns on translation runtime without changing output mode", async () => {
    const settings = createSettings({
      translationEnabled: false,
      binding: {
        token: "token-1",
        boundUserId: "user-1",
        loginUserId: "user-1"
      } as Partial<GatewaySettingsFile["binding"]> as GatewaySettingsFile["binding"]
    });
    const sentTexts: string[] = [];
    const preferenceUpdates: unknown[] = [];
    const channel = createChannel([], sentTexts);
    const service = createService({ settings, channel, preferenceUpdates });

    const status = await service.updateSettings({ enabled: true });

    expect(status.enabled).toBe(true);
    expect(status.translationEnabled).toBe(true);
    // Enabling the desktop Gateway must not implicitly arm the connection switch.
    expect(status.connectionEnabled).toBe(false);
    expect(status.running).toBe(false);
    expect(preferenceUpdates).toEqual([{
      translationEnabled: true,
      translationAutoSendEnabled: true
    }]);
    service.stop();
  });

  it("restores translation runtime when a persisted Gateway is already enabled", async () => {
    const settings = createSettings({
      enabled: true,
      translationEnabled: true,
      binding: {
        token: "token-1",
        boundUserId: "user-1",
        loginUserId: "user-1"
      } as Partial<GatewaySettingsFile["binding"]> as GatewaySettingsFile["binding"]
    });
    const sentTexts: string[] = [];
    const preferenceUpdates: unknown[] = [];
    const channel = createChannel([], sentTexts);
    const service = createService({
      settings,
      channel,
      preferenceUpdates,
      appPreferences: {
        translationEnabled: false,
        translationAutoSendEnabled: false
      }
    });
    await service.setConnectionEnabled(true);

    const status = await service.getStatus();

    expect(status.enabled).toBe(true);
    expect(status.running).toBe(true);
    expect(preferenceUpdates).toEqual([{
      translationEnabled: true,
      translationAutoSendEnabled: true
    }]);
    service.stop();
  });

  it("forwards gateway chat text to PM without a VCM Gateway marker", async () => {
    const settings = createSettings({
      enabled: true,
      translationEnabled: false,
      binding: {
        token: "token-1",
        boundUserId: "user-1",
        loginUserId: "user-1"
      } as Partial<GatewaySettingsFile["binding"]> as GatewaySettingsFile["binding"]
    });
    const sentTexts: string[] = [];
    const runtimeWrites: string[] = [];
    const channel = createChannel([
      { messageId: "m1", fromUserId: "user-1", text: "please continue" }
    ], sentTexts);
    const service = createService({
      settings,
      channel,
      pmSession: createPmSession(),
      runtimeWrites
    });
    await service.setConnectionEnabled(true);

    await service.start();
    await waitFor(() => runtimeWrites.length === 1);

    expect(runtimeWrites[0]).toContain("please continue");
    expect(runtimeWrites[0]).not.toContain("[VCM Gateway]");
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

      // Arm the connection only after the reply is cached; the phone-driven
      // /start then arrives over the freshly connected poll loop.
      await service.setConnectionEnabled(true);
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
    const channel = createManualChannel(sentTexts);
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
      // Arm first so the disarmed-outbound gate does not suppress the failure
      // notice; the manual channel withholds /retry until the failure is recorded.
      await service.setConnectionEnabled(true);
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

      channel.deliver([{ messageId: "m1", fromUserId: "user-1", text: "/retry" }]);
      await waitFor(() => sentTexts.length === 2);

      expect(sentTexts[1]).toContain("重新翻译成功：");
      expect(sentTexts[1]).toContain("重新翻译后的中文状态。");
    } finally {
      service.stop();
      await rm(transcriptDir, { recursive: true, force: true });
    }
  });

  it("pushes only PM final replies when Gateway handles a PM stop", async () => {
    const transcriptDir = await mkdtemp(join(tmpdir(), "vcm-gateway-transcript-"));
    const transcriptPath = join(transcriptDir, "pm.jsonl");
    await writeFile(transcriptPath, [
      assistantTranscriptLine(
        "tool-progress",
        "2026-06-11T00:00:00.500Z",
        "Intermediate PM text while tools are still running.",
        "tool_use"
      ),
      assistantTranscriptLine(
        "current-reply",
        "2026-06-11T00:00:01.000Z",
        "Final PM reply for the active task.",
        "end_turn"
      )
    ].join("\n"));
    const settings = createSettings({
      enabled: true,
      translationEnabled: true,
      binding: {
        token: "token-1",
        boundUserId: "user-1",
        loginUserId: "user-1"
      } as Partial<GatewaySettingsFile["binding"]> as GatewaySettingsFile["binding"]
    });
    const sentTexts: string[] = [];
    const channel = createChannel([], sentTexts);
    const translatedInputs: string[] = [];
    const service = createService({
      settings,
      channel,
      async translateGatewayOutput(input) {
        translatedInputs.push(input.text);
        return `ZH: ${input.text}`;
      }
    });

    try {
      await service.setConnectionEnabled(true);
      await service.handlePmStop({
        repoRoot: "/repo",
        taskSlug: "demo-task",
        session: createPmSession(transcriptPath)
      });

      expect(translatedInputs).toEqual(["Final PM reply for the active task."]);
      expect(sentTexts[0]).toContain("ZH: Final PM reply for the active task.");
      expect(sentTexts[0]).not.toContain("Intermediate PM text");
      const latest = Object.values(settings.current().latestPmReplies)[0];
      expect(latest?.text).toBe("Final PM reply for the active task.");
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
    await service.setConnectionEnabled(true);

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

  it("uses the most recent active Lark chat without pairing", async () => {
    const settings = createSettings({
      channel: "lark",
      binding: {
        appId: "cli_test",
        appSecret: "secret_test"
      } as Partial<GatewaySettingsFile["binding"]> as GatewaySettingsFile["binding"]
    });
    const sentTexts: string[] = [];
    const channel = createLarkTestChannel([
      { messageId: "m1", fromUserId: "ou_1", chatId: "oc_1", chatType: "dm", text: "/status" },
      { messageId: "m2", fromUserId: "ou_2", chatId: "oc_2", chatType: "group", text: "/status" }
    ], sentTexts);
    const service = createService({ settings, channel });
    await service.setConnectionEnabled(true);

    await waitFor(() => sentTexts.length === 2);

    expect(sentTexts[0]).toContain("Gateway: off / polling");
    expect(sentTexts[0]).toContain("Active Lark chat: yes");
    expect(sentTexts[1]).toContain("Gateway: off / polling");
    expect(settings.current().binding.boundUserId).toBe("ou_2");
    expect(settings.current().binding.chatIds.ou_1).toBe("oc_1");
    expect(settings.current().binding.chatIds.ou_2).toBe("oc_2");
    service.stop();
  });

  it("saves Lark app credentials from QR setup before pairing", async () => {
    const settings = createSettings({ channel: "lark" });
    const sentTexts: string[] = [];
    const channel = createLarkTestChannel([], sentTexts);
    const registration: LarkRegistrationClient = {
      async init(domain) {
        expect(domain).toBe("lark");
      },
      async begin(domain) {
        return {
          domain,
          deviceCode: "device-1",
          qrUrl: "https://accounts.larksuite.com/qr",
          userCode: "ABCD",
          intervalSeconds: 3,
          expiresInSeconds: 600
        };
      },
      async poll(input) {
        expect(input).toEqual({
          domain: "lark",
          deviceCode: "device-1"
        });
        return {
          status: "confirmed",
          appId: "cli_test",
          appSecret: "secret_test",
          domain: "lark",
          openId: "ou_setup",
          botName: "VCM Bot",
          botOpenId: "ou_bot"
        };
      }
    };
    const service = createService({ settings, channel, larkRegistration: registration });
    await service.setConnectionEnabled(true);

    const setup = await service.startLarkRegistration();
    const checked = await service.checkLarkRegistration();

    expect(setup.qrUrl).toBe("https://accounts.larksuite.com/qr");
    expect(checked.status).toBe("confirmed");
    expect(checked.gatewayStatus?.binding.appIdConfigured).toBe(true);
    expect(settings.current().binding.appId).toBe("cli_test");
    expect(settings.current().binding.appSecret).toBe("secret_test");
    expect(settings.current().binding.larkDomain).toBe("lark");
    expect(settings.current().binding.larkOpenId).toBe("ou_setup");
    expect(settings.current().binding.larkBotName).toBe("VCM Bot");
    await waitFor(() => channel.getUpdatesCalls > 0);
    service.stop();
  });

  it("saves manually entered Lark app credentials and starts polling", async () => {
    const settings = createSettings({ channel: "lark" });
    const sentTexts: string[] = [];
    const channel = createLarkTestChannel([], sentTexts);
    const service = createService({ settings, channel });
    await service.setConnectionEnabled(true);

    const result = await service.bindLarkApp({
      appId: "cli_manual",
      appSecret: "secret_manual",
      larkDomain: "lark"
    });

    expect(result.status).toBe("confirmed");
    expect(result.gatewayStatus?.binding.appIdConfigured).toBe(true);
    expect(result.gatewayStatus?.binding.appSecretConfigured).toBe(true);
    expect(result.gatewayStatus?.connectionEnabled).toBe(true);
    expect(result.gatewayStatus?.running).toBe(true);
    expect(settings.current().channel).toBe("lark");
    expect(settings.current().binding.appId).toBe("cli_manual");
    expect(settings.current().binding.appSecret).toBe("secret_manual");
    expect(settings.current().binding.larkDomain).toBe("lark");
    expect(channel.getUpdatesCalls).toBe(1);
    service.stop();
  });

  it("create-task command reuses the shared launch service and reports its orchestration + sessions", async () => {
    // Phase 1 proof point 4 (success side): the gateway no longer composes the
    // roster/mode/loop itself; it surfaces exactly what startTaskRoleSessions
    // returns.
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
      { messageId: "m1", fromUserId: "user-1", text: "/create-task demo-task" }
    ], sentTexts);
    const service = createService({
      settings,
      channel,
      startTaskRoleSessions: async () => ({
        taskSlug: "demo-task",
        orchestration: { taskSlug: "demo-task", mode: "auto", updatedAt: NOW },
        startedRoles: ["project-manager", "architect", "coder", "reviewer"],
        sessions: []
      })
    });
    await service.setConnectionEnabled(true);

    await service.start();
    await waitFor(() => sentTexts.length === 1);

    expect(sentTexts[0]).toContain("Task created and initialized: demo-task");
    expect(sentTexts[0]).toContain("orchestration: auto");
    expect(sentTexts[0]).toContain("sessions: project-manager, architect, coder, reviewer");
    expect(settings.current().currentTaskSlug).toBe("demo-task");
    service.stop();
  });

  it("create-task rewraps a partial start into the byte-identical phone-facing message (parity)", async () => {
    // Phase 1 proof point 4 (priority): a per-role failure from the shared service
    // (TASK_ONE_CLICK_PARTIAL_START) must rewrap to the SAME phone-facing string the
    // inline gateway loop produced before the refactor: "Task was created, but
    // <role> failed to start." plus the per-role cause hint. handleInbound renders
    // a VcmError as "Error: <message> <hint>", so this asserts full byte-identical
    // parity including the preserved cause hint.
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
      { messageId: "m1", fromUserId: "user-1", text: "/create-task demo-task" }
    ], sentTexts);
    const service = createService({
      settings,
      channel,
      startTaskRoleSessions: async () => {
        throw new VcmError({
          code: "TASK_ONE_CLICK_PARTIAL_START",
          message: "architect failed to start.",
          statusCode: 409,
          hint: "spawn failed",
          details: { startedRoles: ["project-manager"], failedRole: "architect" }
        });
      }
    });
    await service.setConnectionEnabled(true);

    await service.start();
    await waitFor(() => sentTexts.length === 1);

    expect(sentTexts[0]).toBe("Error: Task was created, but architect failed to start. spawn failed");
    // The phone stays pointed at the freshly created task even on a partial start.
    expect(settings.current().currentTaskSlug).toBe("demo-task");
    service.stop();
  });

  it("does not start polling after QR binding while the connection switch is disarmed", async () => {
    // PP1: construction defaults to disarmed; QR binding + getStatus self-heal
    // must not start the poll loop.
    const settings = createSettings();
    const sentTexts: string[] = [];
    const channel = createChannel([
      { messageId: "m1", fromUserId: "user-1", text: "/status" }
    ], sentTexts);
    const service = createService({ settings, channel });

    await service.startQrLogin();
    const qr = await service.checkQrLogin();
    const status = await service.getStatus();

    expect(qr.status).toBe("confirmed");
    expect(status.connectionEnabled).toBe(false);
    expect(status.running).toBe(false);
    expect(channel.getUpdatesCalls).toBe(0);
    expect(sentTexts).toEqual([]);
    service.stop();
  });

  it("keeps self-heal paths from connecting while the switch is disarmed", async () => {
    // PP5: boot start, getStatus/reconcile self-heal, and updateSettings must
    // not connect a configured channel while disarmed.
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
      { messageId: "m1", fromUserId: "user-1", text: "/status" }
    ], sentTexts);
    const service = createService({ settings, channel });

    await service.start();
    await service.getStatus();
    await service.updateSettings({ translationEnabled: true });
    const status = await service.getStatus();

    expect(status.running).toBe(false);
    expect(status.connectionEnabled).toBe(false);
    expect(channel.getUpdatesCalls).toBe(0);
    expect(sentTexts).toEqual([]);
    service.stop();
  });

  it("connects and polls only after the connection switch is armed", async () => {
    // PP2: arming with an account configured starts the poll loop.
    const settings = createSettings({
      binding: {
        token: "token-1",
        boundUserId: "user-1",
        loginUserId: "user-1"
      } as Partial<GatewaySettingsFile["binding"]> as GatewaySettingsFile["binding"]
    });
    const sentTexts: string[] = [];
    const channel = createChannel([
      { messageId: "m1", fromUserId: "user-1", text: "/status" }
    ], sentTexts);
    const service = createService({ settings, channel });

    const before = await service.getStatus();
    const armed = await service.setConnectionEnabled(true);
    await waitFor(() => sentTexts.length === 1);

    expect(before.running).toBe(false);
    expect(before.connectionEnabled).toBe(false);
    expect(armed.connectionEnabled).toBe(true);
    expect(armed.running).toBe(true);
    expect(channel.getUpdatesCalls).toBeGreaterThan(0);
    expect(sentTexts[0]).toContain("Gateway: off / polling");
    service.stop();
  });

  it("stops polling when the connection switch is disarmed", async () => {
    // PP3: disarming aborts the poll loop (the Lark WS closes via the same abort).
    const settings = createSettings({
      binding: {
        token: "token-1",
        boundUserId: "user-1",
        loginUserId: "user-1"
      } as Partial<GatewaySettingsFile["binding"]> as GatewaySettingsFile["binding"]
    });
    const sentTexts: string[] = [];
    const channel = createChannel([], sentTexts);
    const service = createService({ settings, channel });

    await service.setConnectionEnabled(true);
    const armed = await service.getStatus();
    const disarmed = await service.setConnectionEnabled(false);

    expect(armed.running).toBe(true);
    expect(disarmed.connectionEnabled).toBe(false);
    expect(disarmed.running).toBe(false);
    expect((await service.getStatus()).running).toBe(false);
    service.stop();
  });

  it("caches the latest PM reply but sends nothing while disarmed", async () => {
    // PP4: a disarmed gateway still records latestPmReplies for later replay but
    // never opens the channel to push.
    const transcriptDir = await mkdtemp(join(tmpdir(), "vcm-gateway-transcript-"));
    const transcriptPath = join(transcriptDir, "pm.jsonl");
    await writeFile(transcriptPath, assistantTranscriptLine(
      "current-reply",
      "2026-06-11T00:00:01.000Z",
      "Final PM reply while disarmed."
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
    const channel = createChannel([], sentTexts);
    const service = createService({ settings, channel });

    try {
      await service.handlePmStop({
        repoRoot: "/repo",
        taskSlug: "demo-task",
        session: createPmSession(transcriptPath)
      });

      expect(sentTexts).toEqual([]);
      const latest = Object.values(settings.current().latestPmReplies)[0];
      expect(latest?.text).toBe("Final PM reply while disarmed.");
    } finally {
      service.stop();
      await rm(transcriptDir, { recursive: true, force: true });
    }
  });
});

function createService(input: {
  settings: GatewaySettingsService;
  channel: GatewayChannelAdapter & { getUpdatesCalls: number };
  preferenceUpdates?: unknown[];
  appPreferences?: {
    translationEnabled?: boolean;
    translationAutoSendEnabled?: boolean;
  };
  pmSession?: RoleSessionRecord | null;
  runtimeWrites?: string[];
  translateGatewayOutput?: (input: {
    repoRoot: string;
    taskSlug: string;
    role: "project-manager";
    text: string;
  }) => Promise<string>;
  startTaskRoleSessions?: () => Promise<unknown>;
  larkRegistration?: LarkRegistrationClient;
}) {
  const project = createProject();
  const task = createTask();
  let appPreferences = {
    launchTemplate: createDefaultLaunchTemplate(),
    translationEnabled: input.appPreferences?.translationEnabled ?? true,
    translationAutoSendEnabled: input.appPreferences?.translationAutoSendEnabled ?? false
  };
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
        return input.pmSession ?? null;
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
    taskLaunchService: {
      startTaskRoleSessions: input.startTaskRoleSessions ?? (async () => ({
        taskSlug: task.taskSlug,
        orchestration: { taskSlug: task.taskSlug, mode: "auto", updatedAt: NOW },
        startedRoles: [],
        sessions: []
      }))
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
      write(_sessionId: string, data: string) {
        input.runtimeWrites?.push(data);
        return undefined;
      }
    },
    appSettings: {
      async getPreferences() {
        return appPreferences as never;
      },
      async getGateReviewSettings() {
        return { enabled: false, requiredGates: [] };
      },
      async updatePreferences(update: Record<string, unknown>) {
        input.preferenceUpdates?.push(update);
        appPreferences = {
          ...appPreferences,
          ...update
        };
        return appPreferences as never;
      }
    } as never,
    larkRegistration: input.larkRegistration,
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

// A channel whose inbound updates are delivered on demand via `deliver(...)`,
// so a test can record an outbound push (e.g. a failed PM translation) before
// the next inbound command (e.g. /retry) reaches the poll loop.
function createManualChannel(sentTexts: string[]): WeixinIlinkChannel & {
  getUpdatesCalls: number;
  deliver(updates: WeixinIlinkUpdate[]): void;
} {
  let getUpdatesCalls = 0;
  const queued: WeixinIlinkUpdate[][] = [];
  let waiting: ((result: { cursor: string; updates: WeixinIlinkUpdate[] }) => void) | null = null;
  return {
    id: "weixin-ilink",
    label: "Weixin iLink",
    defaultBaseUrl: "https://ilinkai.weixin.qq.com",
    get getUpdatesCalls() {
      return getUpdatesCalls;
    },
    deliver(updates) {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ cursor: "cursor-1", updates });
      } else {
        queued.push(updates);
      }
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
      getUpdatesCalls += 1;
      const next = queued.shift();
      if (next) {
        return { cursor: "cursor-1", updates: next };
      }
      return new Promise((resolve) => {
        waiting = resolve;
        input.signal?.addEventListener("abort", () => {
          waiting = null;
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
          baseUrl: input.baseUrl !== undefined ? input.baseUrl ?? current.binding.baseUrl : current.binding.baseUrl
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
    expose(settings, running = false, connectionEnabled = false): GatewayStatus {
      return {
        version: 1,
        enabled: settings.enabled,
        running,
        connectionEnabled,
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
          homeChatId: settings.binding.homeChatId
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

function createPmSession(transcriptPath?: string): RoleSessionRecord {
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

function assistantTranscriptLine(
  uuid: string,
  timestamp: string,
  text: string,
  stopReason = "end_turn"
): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    timestamp,
    message: {
      stop_reason: stopReason,
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
