import type { DispatchRoleCommandResult, TaskStatusReport } from "../../shared/types/api.js";
import type { AppPreferences, UpdateAppPreferencesRequest } from "../../shared/types/app-settings.js";
import type {
  HarnessApplyResult,
  HarnessBootstrapStatusReport,
  HarnessStatusReport,
  StartHarnessBootstrapRequest,
  StartHarnessBootstrapResult
} from "../../shared/types/harness.js";
import type {
  VcmOrchestrationMode,
  VcmOrchestrationState,
  VcmRoleMessage,
  MarkAllMessagesDoneResult,
  DeleteMessageHistoryResult
} from "../../shared/types/message.js";
import type { ProjectSummary, ConnectProjectRequest } from "../../shared/types/project.js";
import type { DispatchableRole, RoleName } from "../../shared/types/role.js";
import type { VcmTaskRoundState } from "../../shared/types/round.js";
import type { RoleSessionRecord, StartRoleSessionRequest } from "../../shared/types/session.js";
import type { CleanupTaskRequest, CleanupTaskResult, CreateTaskRequest, TaskRecord } from "../../shared/types/task.js";
import type {
  SendTranslatedInputRequest,
  TranslateUserInputRequest,
  TranslateUserInputResult,
  TranslationEntry,
  TranslationFailuresResult,
  PollTranslationSessionResult,
  StartTranslationSessionResult,
  TranslationPromptPreview,
  TranslationProviderTestResult,
  TranslationSecretSettings,
  TranslationSettings
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
  getCurrentProject() {
    return request<ProjectSummary | null>("/api/projects/current");
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
  getTaskRoundState(taskSlug: string) {
    return request<VcmTaskRoundState>(`/api/tasks/${encodeURIComponent(taskSlug)}/round`);
  },
  getTranslationSettings() {
    return request<TranslationSettings>("/api/translation/settings");
  },
  updateTranslationSettings(input: Partial<TranslationSettings> & TranslationSecretSettings) {
    return request<TranslationSettings>("/api/translation/settings", {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },
  getTranslationPrompts() {
    return request<TranslationPromptPreview[]>("/api/translation/prompts");
  },
  testTranslationProvider() {
    return request<TranslationProviderTestResult>("/api/translation/test", {
      method: "POST"
    });
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
    const payload = await response.json().catch(() => null) as { error?: { message?: string; hint?: string } } | null;
    const message = payload?.error?.hint
      ? `${payload.error.message} ${payload.error.hint}`
      : payload?.error?.message ?? `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}
