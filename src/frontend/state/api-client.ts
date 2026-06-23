import type { DispatchRoleCommandResult, TaskStatusReport } from "../../shared/types/api.js";
import type { AppPreferences, UpdateAppPreferencesRequest } from "../../shared/types/app-settings.js";
import type {
  CheckGatewayQrLoginRequest,
  CheckGatewayQrLoginResult,
  GatewayStatus,
  StartGatewayQrLoginResult,
  UpdateGatewaySettingsRequest
} from "../../shared/types/gateway.js";
import type { RuntimeDiagnostics } from "../../shared/types/diagnostics.js";
import type {
  HarnessApplyRequest,
  HarnessApplyResult,
  HarnessBootstrapStatusReport,
  HarnessFeedbackDecisionRequest,
  HarnessFeedbackStateReport,
  HarnessFileContent,
  RepositoryDiffReport,
  RestartHarnessBootstrapRequest,
  RunHarnessBootstrapResult,
  HarnessStatusReport,
  StartHarnessBootstrapRequest,
  StartHarnessBootstrapResult,
  UpdateHarnessFileContentRequest,
  UpdateHarnessFileContentResult
} from "../../shared/types/harness.js";
import type {
  GateReviewExceptionRequest,
  GateReviewGate,
  GateReviewIndex,
  GateReviewReport,
  GateReviewRequestResult,
  GateReviewSettingsUpdateRequest
} from "../../shared/types/gate-review.js";
import type {
  VcmOrchestrationMode,
  VcmOrchestrationState,
  VcmRoleMessage,
  MarkAllMessagesDoneResult,
  DeleteMessageHistoryResult
} from "../../shared/types/message.js";
import type { ProjectSummary, ConnectProjectRequest } from "../../shared/types/project.js";
import type { DispatchableRole, RoleName } from "../../shared/types/role.js";
import type { VcmSessionRoundState } from "../../shared/types/round.js";
import type { RoleSessionRecord, StartRoleSessionRequest } from "../../shared/types/session.js";
import type { CleanupTaskRequest, CleanupTaskResult, CreateTaskRequest, TaskRecord } from "../../shared/types/task.js";
import { errorReason } from "./error-format.js";
import type {
  TranslationBootstrapRun,
  FileTranslationJob,
  TranslationQueueItem,
  TranslationSourceFileBrowserResult,
  TranslationState,
  CreateTranslationBootstrapRequest,
  CreateFileTranslationRequest,
  CreateTranslationMemoryUpdateRequest,
  SendTranslatedInputRequest,
  TranslateUserInputRequest,
  TranslateUserInputResult,
  TranslationEntry,
  TranslationFailuresResult,
  PollTranslationSessionResult,
  StartTranslationSessionResult
} from "../../shared/types/translation.js";

export const apiClient = {
  getAppPreferences() {
    return request<AppPreferences>("/api/settings/preferences");
  },
  updateAppPreferences(input: UpdateAppPreferencesRequest) {
    return request<AppPreferences>("/api/settings/preferences", {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },
  getRuntimeDiagnostics() {
    return request<RuntimeDiagnostics>("/api/diagnostics/runtime");
  },
  getCurrentProject() {
    return request<ProjectSummary | null>("/api/projects/current");
  },
  pullCurrentProject() {
    return request<ProjectSummary>("/api/projects/current/pull", {
      method: "POST"
    });
  },
  getRecentRepositoryPaths() {
    return request<string[]>("/api/projects/recent");
  },
  connectProject(input: ConnectProjectRequest) {
    return request<ProjectSummary>("/api/projects/connect", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  listTasks() {
    return request<TaskRecord[]>("/api/tasks");
  },
  createTask(input: CreateTaskRequest) {
    return request<TaskRecord>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  cleanupTask(taskSlug: string, input: CleanupTaskRequest = {}) {
    return request<CleanupTaskResult>(`/api/tasks/${encodeURIComponent(taskSlug)}/cleanup`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  getHarnessStatus(taskSlug: string) {
    const params = new URLSearchParams({ taskSlug });
    return request<HarnessStatusReport>(`/api/projects/harness?${params.toString()}`);
  },
  applyHarness(input: HarnessApplyRequest) {
    return request<HarnessApplyResult>("/api/projects/harness/apply", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  getHarnessFileContent(taskSlug: string, filePath: string) {
    const params = new URLSearchParams({ path: filePath, taskSlug });
    return request<HarnessFileContent>(`/api/projects/harness/file?${params.toString()}`);
  },
  updateHarnessFileContent(taskSlug: string, filePath: string, input: UpdateHarnessFileContentRequest) {
    const params = new URLSearchParams({ path: filePath, taskSlug });
    return request<UpdateHarnessFileContentResult>(`/api/projects/harness/file?${params.toString()}`, {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },
  getRepositoryDiff(taskSlug: string, commitSha?: string | null) {
    const params = new URLSearchParams({ taskSlug });
    if (commitSha) {
      params.set("commit", commitSha);
    }
    return request<RepositoryDiffReport>(`/api/projects/harness/repository-diff?${params.toString()}`);
  },
  getHarnessBootstrapStatus(taskSlug: string) {
    const params = new URLSearchParams({ taskSlug });
    return request<HarnessBootstrapStatusReport>(`/api/projects/harness/bootstrap?${params.toString()}`);
  },
  startHarnessBootstrap(input: StartHarnessBootstrapRequest = {}) {
    return request<StartHarnessBootstrapResult>("/api/projects/harness/bootstrap/start", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  restartHarnessBootstrap(input: RestartHarnessBootstrapRequest = {}) {
    return request<StartHarnessBootstrapResult>("/api/projects/harness/bootstrap/restart", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  stopHarnessBootstrap() {
    return request<HarnessBootstrapStatusReport>("/api/projects/harness/bootstrap/stop", {
      method: "POST"
    });
  },
  runHarnessBootstrap(input: { taskSlug: string }) {
    return request<RunHarnessBootstrapResult>("/api/projects/harness/bootstrap/run", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  getHarnessEngineerSession() {
    return request<RoleSessionRecord | null>("/api/projects/harness/engineer/session");
  },
  ensureHarnessEngineerSession(input: StartRoleSessionRequest = {}) {
    return request<RoleSessionRecord>("/api/projects/harness/engineer/session/ensure", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  startHarnessEngineerSession(input: StartRoleSessionRequest = {}) {
    return request<RoleSessionRecord>("/api/projects/harness/engineer/session/start", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  resumeHarnessEngineerSession(input: StartRoleSessionRequest = {}) {
    return request<RoleSessionRecord>("/api/projects/harness/engineer/session/resume", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  restartHarnessEngineerSession(input: StartRoleSessionRequest = {}) {
    return request<RoleSessionRecord>("/api/projects/harness/engineer/session/restart", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  stopHarnessEngineerSession() {
    return request<RoleSessionRecord>("/api/projects/harness/engineer/session/stop", {
      method: "POST"
    });
  },
  notifyHarnessEngineerHarnessUpdated() {
    return request<RoleSessionRecord>("/api/projects/harness/engineer/session/notify-harness", {
      method: "POST"
    });
  },
  getHarnessFeedbackState(taskSlug?: string | null) {
    const params = new URLSearchParams();
    if (taskSlug) {
      params.set("taskSlug", taskSlug);
    }
    const query = params.toString();
    return request<HarnessFeedbackStateReport>(`/api/projects/harness/feedback${query ? `?${query}` : ""}`);
  },
  decideHarnessFeedback(input: HarnessFeedbackDecisionRequest) {
    return request<HarnessFeedbackStateReport>("/api/projects/harness/feedback/decision", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  getTaskStatus(taskSlug: string) {
    return request<TaskStatusReport>(`/api/tasks/${encodeURIComponent(taskSlug)}/status`);
  },
  listSessions(taskSlug: string) {
    return request<RoleSessionRecord[]>(`/api/tasks/${encodeURIComponent(taskSlug)}/sessions`);
  },
  startRoleSession(taskSlug: string, role: RoleName, input: StartRoleSessionRequest = {}) {
    return request<RoleSessionRecord>(`/api/tasks/${encodeURIComponent(taskSlug)}/sessions/${role}/start`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  stopRoleSession(taskSlug: string, role: RoleName) {
    return request<RoleSessionRecord>(`/api/tasks/${encodeURIComponent(taskSlug)}/sessions/${role}/stop`, {
      method: "POST"
    });
  },
  restartRoleSession(taskSlug: string, role: RoleName, input: StartRoleSessionRequest = {}) {
    return request<RoleSessionRecord>(`/api/tasks/${encodeURIComponent(taskSlug)}/sessions/${role}/restart`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  resumeRoleSession(taskSlug: string, role: RoleName, input: StartRoleSessionRequest = {}) {
    return request<RoleSessionRecord>(`/api/tasks/${encodeURIComponent(taskSlug)}/sessions/${role}/resume`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  notifyRoleHarnessUpdated(taskSlug: string, role: RoleName) {
    return request<RoleSessionRecord>(`/api/tasks/${encodeURIComponent(taskSlug)}/sessions/${role}/notify-harness`, {
      method: "POST"
    });
  },
  dispatchRoleCommand(taskSlug: string, role: DispatchableRole) {
    return request<DispatchRoleCommandResult>(`/api/tasks/${encodeURIComponent(taskSlug)}/sessions/${role}/dispatch`, {
      method: "POST"
    });
  },
  listMessages(taskSlug: string) {
    return request<VcmRoleMessage[]>(`/api/tasks/${encodeURIComponent(taskSlug)}/messages`);
  },
  markAllMessagesDone(taskSlug: string) {
    return request<MarkAllMessagesDoneResult>(`/api/tasks/${encodeURIComponent(taskSlug)}/messages/mark-all-done`, {
      method: "POST"
    });
  },
  deleteMessageHistory(taskSlug: string) {
    return request<DeleteMessageHistoryResult>(`/api/tasks/${encodeURIComponent(taskSlug)}/messages/history`, {
      method: "DELETE"
    });
  },
  getOrchestrationState(taskSlug: string) {
    return request<VcmOrchestrationState>(`/api/tasks/${encodeURIComponent(taskSlug)}/orchestration`);
  },
  updateOrchestrationState(taskSlug: string, input: { mode?: VcmOrchestrationMode }) {
    return request<VcmOrchestrationState>(`/api/tasks/${encodeURIComponent(taskSlug)}/orchestration`, {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },
  getSessionRoundState(taskSlug: string) {
    return request<VcmSessionRoundState>(`/api/tasks/${encodeURIComponent(taskSlug)}/round`);
  },
  getGateReviewState(taskSlug: string) {
    return request<GateReviewIndex>(`/api/tasks/${encodeURIComponent(taskSlug)}/gate-review`);
  },
  updateGateReviewSettings(taskSlug: string, input: GateReviewSettingsUpdateRequest) {
    return request<GateReviewIndex>(`/api/tasks/${encodeURIComponent(taskSlug)}/gate-review/settings`, {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },
  requestGateReviewGate(taskSlug: string, gate: GateReviewGate) {
    return request<GateReviewRequestResult>(`/api/tasks/${encodeURIComponent(taskSlug)}/gate-review/${gate}/request`, {
      method: "POST"
    });
  },
  retryGateReviewGate(taskSlug: string, gate: GateReviewGate) {
    return request<GateReviewRequestResult>(`/api/tasks/${encodeURIComponent(taskSlug)}/gate-review/${gate}/retry`, {
      method: "POST"
    });
  },
  skipGateReviewGate(taskSlug: string, gate: GateReviewGate, input: GateReviewExceptionRequest) {
    return request<GateReviewIndex>(`/api/tasks/${encodeURIComponent(taskSlug)}/gate-review/${gate}/skip`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  overrideGateReviewGate(taskSlug: string, gate: GateReviewGate, input: GateReviewExceptionRequest) {
    return request<GateReviewIndex>(`/api/tasks/${encodeURIComponent(taskSlug)}/gate-review/${gate}/override`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  getGateReviewReport(taskSlug: string, gate: GateReviewGate) {
    return request<GateReviewReport>(`/api/tasks/${encodeURIComponent(taskSlug)}/gate-review/${gate}/report`);
  },
  startTranslationSession(taskSlug: string, role: RoleName) {
    return request<StartTranslationSessionResult>(`/api/tasks/${encodeURIComponent(taskSlug)}/sessions/${role}/translation/start`, {
      method: "POST"
    });
  },
  pollTranslationSession(sessionId: string, after: number, limit?: number) {
    const params = new URLSearchParams({ after: String(after) });
    if (limit !== undefined) {
      params.set("limit", String(limit));
    }
    return request<PollTranslationSessionResult>(`/api/translation/sessions/${encodeURIComponent(sessionId)}/events?${params.toString()}`);
  },
  translateUserInput(taskSlug: string, role: RoleName, input: TranslateUserInputRequest) {
    return request<TranslateUserInputResult>(`/api/tasks/${encodeURIComponent(taskSlug)}/sessions/${role}/translation/input`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  sendTranslatedInput(taskSlug: string, role: RoleName, input: SendTranslatedInputRequest) {
    return request<{ ok: true }>(`/api/tasks/${encodeURIComponent(taskSlug)}/sessions/${role}/translation/send`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  clearTranslationSession(sessionId: string) {
    return request<{ ok: true }>(`/api/translation/sessions/${encodeURIComponent(sessionId)}/clear`, {
      method: "POST"
    });
  },
  stopTranslationSession(sessionId: string) {
    return request<{ ok: true }>(`/api/translation/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: "POST"
    });
  },
  notifyTranslatorHarnessUpdated() {
    return request<RoleSessionRecord>("/api/projects/translation/session/notify-harness", {
      method: "POST"
    });
  },
  retryTranslation(sessionId: string, translationId: string) {
    return request<TranslationEntry>(`/api/translation/sessions/${encodeURIComponent(sessionId)}/retry/${encodeURIComponent(translationId)}`, {
      method: "POST"
    });
  },
  ignoreTranslationFailures(sessionId: string) {
    return request<TranslationFailuresResult>(`/api/translation/sessions/${encodeURIComponent(sessionId)}/failures/ignore`, {
      method: "POST"
    });
  },
  retryTranslationFailures(sessionId: string) {
    return request<TranslationFailuresResult>(`/api/translation/sessions/${encodeURIComponent(sessionId)}/failures/retry`, {
      method: "POST"
    });
  },
  getTranslationState() {
    return request<TranslationState>("/api/translation/state");
  },
  getTranslatorSession() {
    return request<RoleSessionRecord | null>("/api/translation/session");
  },
  ensureTranslatorSession(input: StartRoleSessionRequest = {}) {
    return request<RoleSessionRecord>("/api/translation/session/ensure", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  startTranslatorSession(input: StartRoleSessionRequest = {}) {
    return request<RoleSessionRecord>("/api/translation/session/start", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  resumeTranslatorSession(input: StartRoleSessionRequest = {}) {
    return request<RoleSessionRecord>("/api/translation/session/resume", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  restartTranslatorSession(input: StartRoleSessionRequest = {}) {
    return request<RoleSessionRecord>("/api/translation/session/restart", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  stopTranslatorSession() {
    return request<RoleSessionRecord>("/api/translation/session/stop", {
      method: "POST"
    });
  },
  browseTranslationSourceFiles(input: { path?: string; query?: string; limit?: number } = {}) {
    const params = new URLSearchParams();
    if (input.path) {
      params.set("path", input.path);
    }
    if (input.query) {
      params.set("query", input.query);
    }
    if (input.limit !== undefined) {
      params.set("limit", String(input.limit));
    }
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request<TranslationSourceFileBrowserResult>(`/api/translation/source-files${suffix}`);
  },
  createFileTranslation(input: CreateFileTranslationRequest) {
    return request<FileTranslationJob>("/api/translation/files", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  readFileTranslation(jobId: string) {
    return request<{ job: FileTranslationJob; output: string; report: string }>(`/api/translation/files/${encodeURIComponent(jobId)}`);
  },
  createTranslationBootstrap(input: CreateTranslationBootstrapRequest) {
    return request<TranslationBootstrapRun>("/api/translation/bootstrap", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  createTranslationMemoryUpdate(input: CreateTranslationMemoryUpdateRequest) {
    return request<TranslationQueueItem>("/api/translation/memory-update", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  promoteTranslation(jobId: string, targetPath: string) {
    return request<FileTranslationJob>(`/api/translation/files/${encodeURIComponent(jobId)}/promote`, {
      method: "POST",
      body: JSON.stringify({ targetPath })
    });
  },
  getGatewayStatus() {
    return request<GatewayStatus>("/api/gateway/status");
  },
  updateGatewaySettings(input: UpdateGatewaySettingsRequest) {
    return request<GatewayStatus>("/api/gateway/settings", {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },
  startGatewayQrLogin() {
    return request<StartGatewayQrLoginResult>("/api/gateway/qr/start", {
      method: "POST"
    });
  },
  checkGatewayQrLogin(input: CheckGatewayQrLoginRequest = {}) {
    return request<CheckGatewayQrLoginResult>("/api/gateway/qr/check", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  resetGatewayBinding() {
    return request<GatewayStatus>("/api/gateway/binding/reset", {
      method: "POST"
    });
  }
};

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const method = (init.method ?? "GET").toUpperCase();
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers
    });
  } catch (error) {
    throw new Error(`${method} ${url} could not reach the VCM backend. Reason: ${errorReason(error)}`);
  }

  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    const payload = parseErrorPayload(rawBody);
    const statusText = response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
    const backendReason = payload?.error?.hint
      ? `${payload.error.message ?? "Backend error."} ${payload.error.hint}`
      : payload?.error?.message;
    const bodyReason = backendReason ?? formatNonJsonErrorBody(rawBody);
    const runtime = payload?.error?.runtime;
    const runtimeSuffix = runtime
      ? ` [backend ${runtime.version ?? "unknown"} pid=${runtime.pid ?? "unknown"} cwd=${runtime.cwd ?? "unknown"}]`
      : "";
    throw new Error(`${method} ${url} returned HTTP ${statusText}. ${bodyReason}${runtimeSuffix}`);
  }

  return response.json() as Promise<T>;
}

function parseErrorPayload(rawBody: string): {
  error?: {
    message?: string;
    hint?: string;
    runtime?: {
      version?: string;
      pid?: number;
      cwd?: string;
    };
  };
} | null {
  if (!rawBody.trim()) {
    return null;
  }
  try {
    return JSON.parse(rawBody) as {
      error?: {
        message?: string;
        hint?: string;
        runtime?: {
          version?: string;
          pid?: number;
          cwd?: string;
        };
      };
    };
  } catch {
    return null;
  }
}

function formatNonJsonErrorBody(rawBody: string): string {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return "The response body was empty.";
  }
  return `Non-JSON response body: ${trimmed.slice(0, 500)}`;
}
