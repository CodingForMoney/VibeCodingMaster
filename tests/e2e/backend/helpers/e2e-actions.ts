import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { TaskWorkspaceState } from "../../../../src/shared/types/api.js";
import type {
  GateReviewGate,
  GateReviewIndex,
  GateReviewRequestInput,
  GateReviewRequestResult,
  GateReviewSettingsUpdateRequest
} from "../../../../src/shared/types/gate-review.js";
import type { AppPreferences, UpdateAppPreferencesRequest } from "../../../../src/shared/types/app-settings.js";
import type { RoleName } from "../../../../src/shared/types/role.js";
import type { RoleSessionRecord } from "../../../../src/shared/types/session.js";
import type { TaskRecord } from "../../../../src/shared/types/task.js";
import type {
  BindGatewayLarkAppRequest,
  CheckGatewayLarkRegistrationResult,
  GatewayStatus,
  SetGatewayConnectionRequest,
  UpdateGatewaySettingsRequest
} from "../../../../src/shared/types/gateway.js";
import type {
  PollTranslationTaskFeedResult,
  StartTranslationSessionResult
} from "../../../../src/shared/types/translation.js";
import { roleLaunchBody } from "./e2e-app.js";
import type { E2eRepo } from "./e2e-repo.js";

export async function connectProject(app: FastifyInstance, repoRoot: string): Promise<void> {
  await injectOk(app, {
    method: "POST",
    url: "/api/projects/connect",
    payload: { repoPath: repoRoot }
  });
}

export async function connectAndCreateTask(app: FastifyInstance, repo: E2eRepo, taskSlug: string): Promise<TaskRecord> {
  await connectProject(app, repo.repoRoot);
  return createTask(app, taskSlug);
}

export async function createTask(app: FastifyInstance, taskSlug: string): Promise<TaskRecord> {
  const response = await injectOk(app, {
    method: "POST",
    url: "/api/tasks",
    payload: { taskSlug, title: "Mock Claude flow" }
  });
  return response.json<TaskRecord>();
}

export async function writeConfirmedArchitectureBrief(taskRepoRoot: string, taskSlug: string): Promise<void> {
  await fs.writeFile(path.join(taskRepoRoot, ".ai/vcm/handoffs/architecture-brief.md"), [
    `# Architecture Brief: ${taskSlug}`,
    "",
    "Architecture Brief Status: confirmed",
    "",
    "## Accepted Outcome",
    "",
    "Deliver the accepted E2E behavior.",
    "",
    "## Confirmed User Decisions",
    "",
    "Use the behavior stated by the test task.",
    "",
    "## Existing Constraints",
    "",
    "Preserve the current test repository contract.",
    "",
    "## Unresolved User Decisions",
    "",
    "None.",
    "",
    "## User Confirmation",
    "",
    "Confirmed for this E2E scenario.",
    ""
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(taskRepoRoot, ".ai/vcm/handoffs/architecture-evidence.md"), [
    `# Architecture Evidence: ${taskSlug}`,
    "",
    "Architecture Evidence Status: complete",
    "",
    "## Planning Boundary",
    "",
    "Mock E2E feature boundary.",
    "",
    "## Entry Points And Behavior Paths",
    "",
    "Verified by the E2E scenario.",
    "",
    "## State And Lifecycle",
    "",
    "Task-scoped mock runtime.",
    "",
    "## Callers And Consumers",
    "",
    "Mock role flow.",
    "",
    "## External Boundaries",
    "",
    "None.",
    "",
    "## Code And Docs Conflicts",
    "",
    "None.",
    "",
    "## Evidence Commands",
    "",
    "E2E fixture inspection.",
    ""
  ].join("\n"), "utf8");
}

export async function scheduleArchitectRestart(app: FastifyInstance, taskSlug: string): Promise<{
  taskSlug: string;
  sessionId: string;
  status: "scheduled";
}> {
  const response = await injectOk(app, {
    method: "POST",
    url: `/api/tasks/${taskSlug}/sessions/architect/restart-after-planning`,
    payload: {}
  });
  return response.json();
}

export async function startRole(app: FastifyInstance, taskSlug: string, role: RoleName): Promise<RoleSessionRecord> {
  const response = await injectOk(app, {
    method: "POST",
    url: `/api/tasks/${taskSlug}/sessions/${role}/start`,
    payload: roleLaunchBody()
  });
  return response.json<RoleSessionRecord>();
}

export async function restartRole(app: FastifyInstance, taskSlug: string, role: RoleName): Promise<RoleSessionRecord> {
  const response = await injectOk(app, {
    method: "POST",
    url: `/api/tasks/${taskSlug}/sessions/${role}/restart`,
    payload: roleLaunchBody()
  });
  return response.json<RoleSessionRecord>();
}

export async function resumeRole(app: FastifyInstance, taskSlug: string, role: RoleName): Promise<RoleSessionRecord> {
  const response = await injectOk(app, {
    method: "POST",
    url: `/api/tasks/${taskSlug}/sessions/${role}/resume`,
    payload: roleLaunchBody()
  });
  return response.json<RoleSessionRecord>();
}

export async function startHarnessEngineer(app: FastifyInstance, taskSlug: string): Promise<RoleSessionRecord> {
  const response = await injectOk(app, {
    method: "POST",
    url: "/api/projects/harness/engineer/session/start",
    payload: {
      ...roleLaunchBody(),
      taskSlug
    }
  });
  return response.json<RoleSessionRecord>();
}

export async function startTranslation(app: FastifyInstance, taskSlug: string, role: RoleName): Promise<StartTranslationSessionResult> {
  const response = await injectOk(app, {
    method: "POST",
    url: `/api/tasks/${taskSlug}/sessions/${role}/translation/start`
  });
  return response.json<StartTranslationSessionResult>();
}

export async function pollTranslationFeed(app: FastifyInstance, taskSlug: string, after = 1): Promise<PollTranslationTaskFeedResult> {
  const response = await injectOk(app, {
    method: "GET",
    url: `/api/tasks/${taskSlug}/translation/feed?after=${after}&limit=200`
  });
  return response.json<PollTranslationTaskFeedResult>();
}

export async function getWorkspaceState(app: FastifyInstance, taskSlug: string): Promise<TaskWorkspaceState> {
  const response = await injectOk(app, {
    method: "GET",
    url: `/api/tasks/${taskSlug}/workspace-state`
  });
  return response.json<TaskWorkspaceState>();
}

export async function updatePreferences(app: FastifyInstance, input: UpdateAppPreferencesRequest): Promise<AppPreferences> {
  const response = await injectOk(app, {
    method: "PUT",
    url: "/api/settings/preferences",
    payload: input
  });
  return response.json<AppPreferences>();
}

export async function getPreferences(app: FastifyInstance): Promise<AppPreferences> {
  const response = await injectOk(app, {
    method: "GET",
    url: "/api/settings/preferences"
  });
  return response.json<AppPreferences>();
}

export async function updateGateSettings(
  app: FastifyInstance,
  taskSlug: string,
  gates: GateReviewSettingsUpdateRequest["gates"]
): Promise<GateReviewIndex> {
  const response = await injectOk(app, {
    method: "PUT",
    url: `/api/tasks/${taskSlug}/gate-review/settings`,
    payload: { gates }
  });
  return response.json<GateReviewIndex>();
}

export async function requestGateReview(
  app: FastifyInstance,
  taskSlug: string,
  gate: GateReviewGate,
  input: GateReviewRequestInput = {}
): Promise<GateReviewRequestResult> {
  const response = await injectOk(app, {
    method: "POST",
    url: `/api/tasks/${taskSlug}/gate-review/${gate}/request`,
    payload: input
  });
  return response.json<GateReviewRequestResult>();
}

export async function getGateState(app: FastifyInstance, taskSlug: string): Promise<GateReviewIndex> {
  const response = await injectOk(app, {
    method: "GET",
    url: `/api/tasks/${taskSlug}/gate-review`
  });
  return response.json<GateReviewIndex>();
}

export async function closeTask(app: FastifyInstance, taskSlug: string): Promise<unknown> {
  const response = await injectOk(app, {
    method: "POST",
    url: `/api/tasks/${taskSlug}/cleanup`
  });
  return response.json();
}

export async function bindGatewayLarkApp(
  app: FastifyInstance,
  input: BindGatewayLarkAppRequest
): Promise<CheckGatewayLarkRegistrationResult> {
  const response = await injectOk(app, {
    method: "POST",
    url: "/api/gateway/lark-registration/bind",
    payload: input
  });
  return response.json<CheckGatewayLarkRegistrationResult>();
}

export async function setGatewayConnection(
  app: FastifyInstance,
  enabled: boolean
): Promise<GatewayStatus> {
  const response = await injectOk(app, {
    method: "PUT",
    url: "/api/gateway/connection",
    payload: { enabled } satisfies SetGatewayConnectionRequest
  });
  return response.json<GatewayStatus>();
}

export async function updateGatewaySettings(
  app: FastifyInstance,
  input: UpdateGatewaySettingsRequest
): Promise<GatewayStatus> {
  const response = await injectOk(app, {
    method: "PUT",
    url: "/api/gateway/settings",
    payload: input
  });
  return response.json<GatewayStatus>();
}

export async function startTaskHarnessRetrospective(app: FastifyInstance, taskSlug: string): Promise<unknown> {
  const response = await injectOk(app, {
    method: "POST",
    url: "/api/projects/harness/task-retrospective",
    payload: { taskSlug, trigger: "manual" }
  });
  return response.json();
}

export async function injectOk(
  app: FastifyInstance,
  input: Parameters<FastifyInstance["inject"]>[0]
): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>> {
  const response = await app.inject(input);
  if (response.statusCode >= 400) {
    throw new Error(`Expected ${input.method ?? "GET"} ${input.url} to succeed, got ${response.statusCode}: ${response.body}`);
  }
  return response;
}

export async function waitFor(assertion: () => void | boolean | Promise<void | boolean>, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await assertion();
      if (result !== false) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(10);
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error("Timed out waiting for condition.");
}

export async function nextTick(): Promise<void> {
  await sleep(0);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
