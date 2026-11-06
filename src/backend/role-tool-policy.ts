import type { RoleName } from "../shared/types/role.js";

const FRONTMATTER_DISALLOWED_TOOLS = [
  "NotebookEdit",
  "WebFetch",
  "WebSearch"
] as const;

const NON_VCM_ROLE_RUNTIME_TOOLS = [
  "AskUserQuestion",
  "CronCreate",
  "CronDelete",
  "CronList",
  "DesignSync",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "KillShell",
  "Monitor",
  "NotebookEdit",
  "PushNotification",
  "RemoteTrigger",
  "ReportFindings",
  "ScheduleWakeup",
  "SendMessage",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Workflow"
] as const;

export const CODE_ROLE_DISALLOWED_TOOLS = [...FRONTMATTER_DISALLOWED_TOOLS];

export const REVIEWER_DISALLOWED_TOOLS = [
  "Agent",
  "Edit",
  ...FRONTMATTER_DISALLOWED_TOOLS
];

// The evidence worker reads and searches but never runs commands, edits code,
// or delegates.
export const EVIDENCE_WORKER_DISALLOWED_TOOLS = [
  "Agent",
  "Bash",
  "Edit",
  ...FRONTMATTER_DISALLOWED_TOOLS
];

export const CODE_ROLE_RUNTIME_DISALLOWED_TOOLS = [...NON_VCM_ROLE_RUNTIME_TOOLS];

export const REVIEWER_RUNTIME_DISALLOWED_TOOLS = [
  "Agent",
  "Edit",
  ...NON_VCM_ROLE_RUNTIME_TOOLS
];

// Architect and Reviewer Agent frontmatter uses a deny list, so their launch
// also removes the runtime tools no VCM workflow role may use.
const RUNTIME_DENY_LIST_ROLE_NAMES = new Set<RoleName>(["architect", "reviewer"]);

export function roleUsesRuntimeDenyList(role: RoleName): boolean {
  return RUNTIME_DENY_LIST_ROLE_NAMES.has(role);
}

export function roleRuntimeDisallowedTools(role: RoleName): readonly string[] {
  if (role === "reviewer") {
    return REVIEWER_RUNTIME_DISALLOWED_TOOLS;
  }
  if (role === "architect" || role === "coder") {
    return CODE_ROLE_RUNTIME_DISALLOWED_TOOLS;
  }
  return [];
}
