import type { DispatchRoleCommandResult, TaskStatusReport } from "../../shared/types/api.js";
import type { HarnessApplyResult, HarnessStatusReport } from "../../shared/types/harness.js";
import type {
  SendRoleMessageRequest,
  SendRoleMessageResult,
  VcmOrchestrationMode,
  VcmOrchestrationState,
  VcmRoleMessage
} from "../../shared/types/message.js";
import type { ProjectSummary, ConnectProjectRequest } from "../../shared/types/project.js";
import type { DispatchableRole, RoleName } from "../../shared/types/role.js";
import type { RoleSessionRecord, StartRoleSessionRequest } from "../../shared/types/session.js";
import type { CreateTaskRequest, TaskRecord } from "../../shared/types/task.js";
import type {
  SendTranslatedInputRequest,
  TranslateUserInputRequest,
  TranslateUserInputResult,
  TranslationEntry,
  TranslationProviderTestResult,
  TranslationSecretSettings,
  TranslationSettings
} from "../../shared/types/translation.js";

export const apiClient = {
  getCurrentProject() {
    return request<ProjectSummary | null>("/api/projects/current");
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
  getHarnessStatus() {
    return request<HarnessStatusReport>("/api/projects/harness");
  },
  applyHarness() {
    return request<HarnessApplyResult>("/api/projects/harness/apply", {
      method: "POST"
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
  sendRoleMessage(taskSlug: string, input: SendRoleMessageRequest) {
    return request<SendRoleMessageResult>(`/api/tasks/${encodeURIComponent(taskSlug)}/messages`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  stageMessage(taskSlug: string, messageId: string) {
    return request<VcmRoleMessage>(`/api/tasks/${encodeURIComponent(taskSlug)}/messages/${messageId}/stage`, {
      method: "POST"
    });
  },
  rejectMessage(taskSlug: string, messageId: string) {
    return request<VcmRoleMessage>(`/api/tasks/${encodeURIComponent(taskSlug)}/messages/${messageId}/reject`, {
      method: "POST"
    });
  },
  getOrchestrationState(taskSlug: string) {
    return request<VcmOrchestrationState>(`/api/tasks/${encodeURIComponent(taskSlug)}/orchestration`);
  },
  updateOrchestrationState(taskSlug: string, input: { mode?: VcmOrchestrationMode; paused?: boolean }) {
    return request<VcmOrchestrationState>(`/api/tasks/${encodeURIComponent(taskSlug)}/orchestration`, {
      method: "PUT",
      body: JSON.stringify(input)
    });
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
  testTranslationProvider() {
    return request<TranslationProviderTestResult>("/api/translation/test", {
      method: "POST"
    });
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
