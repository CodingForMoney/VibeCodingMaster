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
  HarnessApplyResult,
  HarnessBootstrapStatusReport,
  HarnessStatusReport,
  StartHarnessBootstrapRequest,
  StartHarnessBootstrapResult
} from "../../shared/types/harness.js";
import type {
  CodexReviewExceptionRequest,
  CodexReviewGate,
  CodexReviewIndex,
  CodexReviewReport,
  CodexReviewRequestResult,
  CodexReviewSettingsUpdateRequest
} from "../../shared/types/codex-review.js";
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
import type {
  CodexBootstrapRun,
  CodexFileTranslationJob,
  CodexTranslationQueueItem,
  CodexTranslationSourceFileBrowserResult,
  CodexTranslationState,
  CreateCodexBootstrapRequest,
  CreateCodexFileTranslationRequest,
  CreateCodexMemoryUpdateRequest,
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
  getHarnessStatus() {
    return request<HarnessStatusReport>("/api/projects/harness");
  },
  applyHarness() {
    return request<HarnessApplyResult>("/api/projects/harness/apply", {
      method: "POST"
    });
  },
  getHarnessBootstrapStatus() {
    return request<HarnessBootstrapStatusReport>("/api/projects/harness/bootstrap");
  },
  startHarnessBootstrap(input: StartHarnessBootstrapRequest = {}) {
    return request<StartHarnessBootstrapResult>("/api/projects/harness/bootstrap/start", {
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
  getCodexReviewState(taskSlug: string) {
    return request<CodexReviewIndex>(`/api/tasks/${encodeURIComponent(taskSlug)}/codex-review`);
  },
  updateCodexReviewSettings(taskSlug: string, input: CodexReviewSettingsUpdateRequest) {
    return request<CodexReviewIndex>(`/api/tasks/${encodeURIComponent(taskSlug)}/codex-review/settings`, {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },
  requestCodexReviewGate(taskSlug: string, gate: CodexReviewGate) {
    return request<CodexReviewRequestResult>(`/api/tasks/${encodeURIComponent(taskSlug)}/codex-review/${gate}/request`, {
      method: "POST"
    });
  },
  retryCodexReviewGate(taskSlug: string, gate: CodexReviewGate) {
    return request<CodexReviewRequestResult>(`/api/tasks/${encodeURIComponent(taskSlug)}/codex-review/${gate}/retry`, {
      method: "POST"
    });
  },
  skipCodexReviewGate(taskSlug: string, gate: CodexReviewGate, input: CodexReviewExceptionRequest) {
    return request<CodexReviewIndex>(`/api/tasks/${encodeURIComponent(taskSlug)}/codex-review/${gate}/skip`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  overrideCodexReviewGate(taskSlug: string, gate: CodexReviewGate, input: CodexReviewExceptionRequest) {
    return request<CodexReviewIndex>(`/api/tasks/${encodeURIComponent(taskSlug)}/codex-review/${gate}/override`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  getCodexReviewReport(taskSlug: string, gate: CodexReviewGate) {
    return request<CodexReviewReport>(`/api/tasks/${encodeURIComponent(taskSlug)}/codex-review/${gate}/report`);
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
  getCodexTranslationState() {
    return request<CodexTranslationState>("/api/translation/codex/state");
  },
  browseCodexTranslationSourceFiles(input: { path?: string; query?: string; limit?: number } = {}) {
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
    return request<CodexTranslationSourceFileBrowserResult>(`/api/translation/codex/source-files${suffix}`);
  },
  createCodexFileTranslation(input: CreateCodexFileTranslationRequest) {
    return request<CodexFileTranslationJob>("/api/translation/codex/files", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  readCodexFileTranslation(jobId: string) {
    return request<{ job: CodexFileTranslationJob; output: string; report: string }>(`/api/translation/codex/files/${encodeURIComponent(jobId)}`);
  },
  createCodexBootstrap(input: CreateCodexBootstrapRequest) {
    return request<CodexBootstrapRun>("/api/translation/codex/bootstrap", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  createCodexMemoryUpdate(input: CreateCodexMemoryUpdateRequest) {
    return request<CodexTranslationQueueItem>("/api/translation/codex/memory-update", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  promoteCodexTranslation(jobId: string, targetPath: string) {
    return request<CodexFileTranslationJob>(`/api/translation/codex/files/${encodeURIComponent(jobId)}/promote`, {
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

  const response = await fetch(url, {
    ...init,
    headers
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as {
      error?: {
        message?: string;
        hint?: string;
        runtime?: {
          version?: string;
          pid?: number;
          cwd?: string;
        };
      };
    } | null;
    const message = payload?.error?.hint
      ? `${payload.error.message} ${payload.error.hint}`
      : payload?.error?.message ?? `Request failed: ${response.status}`;
    const runtime = payload?.error?.runtime;
    const runtimeSuffix = runtime
      ? ` [backend ${runtime.version ?? "unknown"} pid=${runtime.pid ?? "unknown"} cwd=${runtime.cwd ?? "unknown"}]`
      : "";
    throw new Error(`${message}${runtimeSuffix}`);
  }

  return response.json() as Promise<T>;
}
