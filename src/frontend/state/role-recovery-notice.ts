import type { VcmRoleRecoveryState } from "../../shared/types/round.js";

export function getRoleRecoveryNoticeKey(taskSlug: string, recovery: VcmRoleRecoveryState): string {
  return `${taskSlug}:${recovery.role}:${recovery.lastFailureAt}`;
}

export function formatRoleRecoveryNotice(recovery: VcmRoleRecoveryState, nowMs = Date.now()): string {
  const role = formatRoleRecoveryRole(recovery.role);
  if (recovery.waitReason === "usage-limit") {
    if (recovery.status === "retrying") {
      return `Claude 额度应已恢复，正在继续 ${role}`;
    }
    const reset = recovery.limitResetAt
      ? `预计 ${formatLocalTime(recovery.limitResetAt)} 恢复`
      : "恢复时间未知";
    return `Claude 额度已用完 · ${role} 暂停 · ${reset} · ${formatRetryDelay(recovery.nextRetryAt, nowMs)}自动继续`;
  }
  const reason = formatRoleRecoveryReason(recovery);
  if (recovery.status === "retrying") {
    return `CC 出错，正在重试 ${role}${reason} · 第 ${recovery.attempt}/${recovery.maxAttempts} 次`;
  }
  return `CC 出错，重试中 ${role}${reason} · 第 ${recovery.attempt}/${recovery.maxAttempts} 次 · ${formatRetryDelay(recovery.nextRetryAt, nowMs)}`;
}

export function formatRoleRecoveryFailureMessage(recovery: VcmRoleRecoveryState, roleLabel: string): string {
  if (recovery.waitReason === "usage-limit") {
    return `The Claude usage limit for ${roleLabel} did not reset within eight days of waiting.`;
  }
  const reason = formatRoleRecoveryReason(recovery);
  if (recovery.retryable === false) {
    return `CC stopped for ${roleLabel}: ${formatRoleRecoveryError(recovery)} cannot be fixed by retrying.`;
  }
  return `CC retry failed after ${recovery.maxAttempts} attempts for ${roleLabel}${reason}.`;
}

function formatRoleRecoveryReason(recovery: VcmRoleRecoveryState): string {
  if (!recovery.error || recovery.error === "unknown") {
    return "";
  }
  return ` · ${recovery.error}`;
}

function formatRoleRecoveryError(recovery: VcmRoleRecoveryState): string {
  return recovery.error && recovery.error !== "unknown"
    ? recovery.error
    : "this error";
}

function formatRoleRecoveryRole(role: string): string {
  return role
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatRetryDelay(nextRetryAt: string | undefined, nowMs: number): string {
  if (!nextRetryAt) {
    return "即将重试";
  }
  const delayMs = Date.parse(nextRetryAt) - nowMs;
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return "即将重试";
  }
  const minutes = Math.ceil(delayMs / 60_000);
  if (minutes < 120) {
    return `${minutes} 分钟后`;
  }
  return `约 ${Math.round(minutes / 60)} 小时后`;
}

// The reset in the viewer's local time, with the date when it is not today.
function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(undefined, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
