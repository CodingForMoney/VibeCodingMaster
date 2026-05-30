import type { HandoffPaths } from "../../shared/types/artifact.js";
import type { RoleName } from "../../shared/types/role.js";
import type { TaskRecord } from "../../shared/types/task.js";

export function renderRoleMessagingContext(
  task: TaskRecord,
  paths: HandoffPaths,
  role: RoleName,
  vcmctlCommand = "vcmctl"
): string {
  if (role === "project-manager") {
    return `VCM messaging context

Task slug: ${task.taskSlug}
Canonical handoff directory: ${task.handoffDir}

You are the orchestration hub for this task.

Use VCM messaging instead of asking the user to copy commands:
- Send work to architect/coder/reviewer with: ${vcmctlCommand} send --to <role> --type task --body-file <file>
- Ask a question with: ${vcmctlCommand} send --to <role> --type question --body "..."
- Check pending messages with: ${vcmctlCommand} inbox

Recommended workflow gates:
1. architect produces ${paths.architecturePlanPath}
2. coder produces ${paths.implementationLogPath} and ${paths.validationLogPath}
3. reviewer produces ${paths.reviewReportPath}
4. architect performs post-review docs sync / architecture drift check and produces ${paths.docsSyncReportPath}
5. project-manager prepares final acceptance, commit, and PR only after reviewer and docs-sync gates pass

Canonical role command files still exist for durable handoff:
- architect: ${paths.roleCommandPaths.architect}
- coder: ${paths.roleCommandPaths.coder}
- reviewer: ${paths.roleCommandPaths.reviewer}

Hard rules:
- Use only ${task.handoffDir} for this task.
- Do not create or write .ai/handoffs/<other-task>/ for this task.
- Non-trivial blockers or high-risk decisions must be escalated to the user.
- In manual orchestration mode, sent messages wait for user approval before the target role executes them.
`;
  }

  return `VCM messaging context

Task slug: ${task.taskSlug}
Canonical handoff directory: ${task.handoffDir}
Current role: ${role}

When complete, blocked, or unclear, reply to project-manager through VCM:
- ${vcmctlCommand} reply --type result --body-file <file>
- ${vcmctlCommand} reply --type blocked --body "..."
- ${vcmctlCommand} reply --type question --body "..."

Expected handoff artifacts:
- architect planning: ${paths.architecturePlanPath}
- coder work: ${paths.implementationLogPath} and ${paths.validationLogPath}
- reviewer work: ${paths.reviewReportPath}
- architect post-review docs sync: ${paths.docsSyncReportPath}

Hard rules:
- Only reply to project-manager. Do not message other roles directly.
- Use only ${task.handoffDir} for this task.
- Do not create or write .ai/handoffs/<other-task>/ for this task.
- In manual orchestration mode, your replies wait for user approval before project-manager receives them.
`;
}
