import type { DispatchableRole } from "../../shared/types/role.js";

export function renderRoleCommandTemplate(
  taskSlug: string,
  role: DispatchableRole,
  taskRepoRoot = "$VCM_TASK_REPO_ROOT",
  branch = "TBD"
): string {
  return `# ${role} command for ${taskSlug}

## Worktree

Task repo root: ${taskRepoRoot}
Branch: ${branch}
Rule: only edit files under Task repo root.

## Objective

TBD

## Inputs

- Task slug: ${taskSlug}

## Expected Output Artifact

TBD

## Stop Conditions

- Stop and ask the user if the task scope is unclear.
- Stop before making high-risk changes without explicit user approval.
`;
}
